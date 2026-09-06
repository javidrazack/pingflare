import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { verifyAdminToken, InvalidSessionError } from '../services/admin-session'
import { getDb, monitors } from '../db'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()

router.get('/', async (c) => {
  const authHeader = c.req.header('Authorization')
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) return c.json({ error: 'Unauthorized' }, 401)

  try {
    await verifyAdminToken(token, c.env)
  } catch (error) {
    return c.json({ error: 'Session validation failed' }, error instanceof InvalidSessionError ? 401 : 503)
  }

  const database = getDb(c.env.DB)

  return streamSSE(c, async (stream) => {
    let alive = true
    stream.onAbort(() => { alive = false })

    const snapshot = (await database.select().from(monitors))
      .map(monitor => ({ ...monitor, authPassword: null, authToken: null }))
    await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(snapshot) })

    let ticks = 0
    // Bound each stream below the D1 invocation budget; clients reconnect.
    while (alive && ticks < 10) {
      await stream.sleep(30_000)
      if (!alive) break

      try { await verifyAdminToken(token, c.env) }
      catch { break }

      ticks++
      await stream.writeSSE({ event: 'heartbeat', data: JSON.stringify({ ts: Date.now() }) })

      if (ticks % 2 === 0) {
        const updated = (await database.select().from(monitors))
          .map(monitor => ({ ...monitor, authPassword: null, authToken: null }))
        await stream.writeSSE({ event: 'snapshot', data: JSON.stringify(updated) })
      }
    }
  })
})

export default router
