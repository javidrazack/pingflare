import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, monitors, heartbeatTokens, statusLogs, alertState } from '../db'
import { processAlert } from '../services/alert-manager'
import { evaluateAgentPayload, parseAgentPayload } from '../services/agent-status'
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

  if (!monitor || monitor.type !== 'agent') {
    return c.text('Not an agent monitor', 400)
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

  if (!monitor || monitor.type !== 'agent') {
    return c.text('Not an agent monitor', 400)
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

  const { status, message } = evaluateAgentPayload(monitor, body)
  const snapshot = { ...body, status, message, evaluatedAt: now }

  await db.update(heartbeatTokens)
    .set({ lastPingAt: now })
    .where(eq(heartbeatTokens.monitorId, monitor.id))
  await db.update(monitors)
    .set({ lastMetrics: JSON.stringify(snapshot), lastCheckedAt: now })
    .where(eq(monitors.id, monitor.id))
  await db.insert(statusLogs).values({
    id: crypto.randomUUID(),
    monitorId: monitor.id,
    status,
    message,
    responseTimeMs: null,
    checkedAt: now,
  })

  await processAlert({
    db,
    monitor,
    status,
    message,
    encryptionKey: c.env.ENCRYPTION_KEY,
  })

  return c.json({ ok: true })
})

export default router
