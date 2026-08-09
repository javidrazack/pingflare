import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, monitors, heartbeatTokens } from '../db'
import {
  drainNotificationDeliveries,
  processAlert,
} from '../services/alert-manager'
import { persistInboundObservationWithRetry } from '../services/check-storage'
import {
  containerNeedsAttention,
  evaluateAgentPayload,
  parseAgentPayload,
} from '../services/agent-status'
import { buildAgentInstaller } from '../services/agent-installer'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
const MAX_AGENT_PAYLOAD_BYTES = 64 * 1024

router.get('/install/:token', async (c) => {
  const db = getDb(c.env.DB)
  const tokenRecord = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.token, c.req.param('token')),
  })

  if (!tokenRecord) {
    return c.text('Invalid token', 404)
  }

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, tokenRecord.monitorId),
  })

  if (!monitor || monitor.type !== 'agent' || !monitor.active) {
    return c.text('Not an active agent monitor', 400)
  }

  const script = buildAgentInstaller(tokenRecord.token, new URL(c.req.url).origin)
  return new Response(script, {
    headers: {
      'Content-Type': 'text/x-shellscript; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

router.post('/push/:token', async (c) => {
  const db = getDb(c.env.DB)
  const token = c.req.param('token')

  const tokenRecord = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.token, token),
  })

  if (!tokenRecord) {
    return c.text('Invalid token', 404)
  }

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, tokenRecord.monitorId),
  })

  if (!monitor || monitor.type !== 'agent' || !monitor.active) {
    return c.text('Not an active agent monitor', 400)
  }

  let rawBody: unknown
  try {
    rawBody = await readJsonBodyWithLimit(c.req.raw, MAX_AGENT_PAYLOAD_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: 'Agent payload is too large' }, 413)
    }
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }
  const body = parseAgentPayload(rawBody)
  if (!body) {
    return c.json({ error: 'Invalid agent payload' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)

  const unhealthyContainers = body.docker.filter(containerNeedsAttention).length
  const buildObservation = (
    subject: typeof monitor,
    checkedAt = now,
  ) => {
    if (!subject || subject.type !== 'agent') return null
    const evaluated = evaluateAgentPayload(subject, body)
    const snapshot = {
      ...body,
      status: evaluated.status,
      message: evaluated.message,
      evaluatedAt: checkedAt,
    }
    return {
      monitor: subject,
      status: evaluated.status,
      message: evaluated.message,
      responseTimeMs: null,
      checkedAt,
      source: 'agent' as const,
      resultCode: evaluated.status === 'up' ? 'agent_ok' : 'agent_threshold',
      lastMetrics: JSON.stringify(snapshot),
      inboundGuard: {
        lastCheckedAt: subject.lastCheckedAt,
        lastPingAt: tokenRecord.lastPingAt,
      },
      agentMetrics: {
        cpu: body.cpu,
        ram: body.ram,
        disk: body.disk,
        unhealthyContainers,
      },
    }
  }
  const observation = buildObservation(monitor)!
  const persisted = await persistInboundObservationWithRetry(
    c.env,
    observation,
    buildObservation,
  )
  if (persisted.acceptedObservations.length === 0) {
    return c.json({ error: 'Agent monitor changed while the payload was processed' }, 409)
  }

  const acceptedObservation = persisted.acceptedObservations[0]
  await processAlert({
    db,
    monitor: acceptedObservation.monitor,
    observationRevision: acceptedObservation.observationRevision,
    status: acceptedObservation.status,
    message: acceptedObservation.message,
    encryptionKey: c.env.ENCRYPTION_KEY,
  })
  const backgroundDrain = drainNotificationDeliveries(db, c.env.ENCRYPTION_KEY).catch((error) => {
    console.error('[agent] notification delivery drain failed:', error)
  })
  try {
    c.executionCtx.waitUntil(backgroundDrain)
  } catch {
    // Node/self-hosted Hono contexts have no execution context. The promise is
    // still allowed to finish, and cron remains the durable fallback.
  }

  return c.json({ ok: true })
})

export default router
