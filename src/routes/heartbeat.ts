import { Hono } from 'hono'
import type { Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, heartbeatTokens, monitors } from '../db'
import { processAlert, getLocale } from '../services/alert-manager'
import { persistCheckObservations } from '../services/check-storage'
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

  await persistCheckObservations(c.env, [{
    monitor,
    status: 'up',
    message: 'notify.heartbeatReceived',
    responseTimeMs: null,
    checkedAt: now,
    source: 'heartbeat',
    resultCode: 'heartbeat_received',
  }], [
    c.env.DB.prepare(
      'UPDATE heartbeat_tokens SET last_ping_at = ? WHERE token = ?',
    ).bind(now, token),
  ])

  await processAlert({
    db,
    monitor,
    status: 'up',
    message: receivedMsg,
    encryptionKey: c.env.ENCRYPTION_KEY,
  })

  return new Response(null, {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': '0' },
  })
}

router.on(['GET', 'POST'], '/:token', handleHeartbeat)
router.on(['GET', 'POST'], '/:token/*', handleHeartbeat)

export default router
