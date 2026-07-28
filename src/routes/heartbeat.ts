import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, heartbeatTokens, monitors } from '../db'
import {
  drainNotificationDeliveries,
  getLocale,
  processAlert,
} from '../services/alert-manager'
import { persistInboundObservationWithRetry } from '../services/check-storage'
import { msgHeartbeatReceived } from '../notifications/messages'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()

async function handleHeartbeat(c: Context<{ Bindings: Env }>) {
  const db = getDb(c.env.DB)
  const token = c.req.param('token')!
  const now = Math.floor(Date.now() / 1000)

  const hb = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.token, token),
  })

  if (!hb) return c.json({ error: 'Unknown heartbeat token' }, 404)

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, hb.monitorId),
  })

  if (!monitor || monitor.type !== 'heartbeat' || !monitor.active) {
    return c.json({ error: 'Heartbeat monitor not active' }, 400)
  }

  const locale = await getLocale(db)
  const receivedMsg = msgHeartbeatReceived(locale)

  const observation = {
    monitor,
    status: 'up',
    message: 'notify.heartbeatReceived',
    responseTimeMs: null,
    checkedAt: now,
    source: 'heartbeat',
    resultCode: 'heartbeat_received',
    inboundGuard: {
      lastCheckedAt: monitor.lastCheckedAt,
      lastPingAt: hb.lastPingAt,
    },
  } as const
  const persisted = await persistInboundObservationWithRetry(
    c.env,
    observation,
    (current, checkedAt) => current.type === 'heartbeat'
      ? { ...observation, monitor: current, checkedAt }
      : null,
  )
  if (persisted.acceptedObservations.length === 0) {
    return c.json({ error: 'Heartbeat monitor changed while the ping was processed' }, 409)
  }

  const acceptedObservation = persisted.acceptedObservations[0]
  await processAlert({
    db,
    monitor: acceptedObservation.monitor,
    observationRevision: acceptedObservation.observationRevision,
    status: 'up',
    message: receivedMsg,
    encryptionKey: c.env.ENCRYPTION_KEY,
  })
  const backgroundDrain = drainNotificationDeliveries(db, c.env.ENCRYPTION_KEY).catch((error) => {
    console.error('[heartbeat] notification delivery drain failed:', error)
  })
  try {
    c.executionCtx.waitUntil(backgroundDrain)
  } catch {
    // Node/self-hosted Hono contexts have no execution context. The promise is
    // still allowed to finish, and cron remains the durable fallback.
  }

  return new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '0' },
  })
}

router.on(['GET', 'POST'], '/:token', handleHeartbeat)
router.on(['GET', 'POST'], '/:token/*', handleHeartbeat)

export default router
