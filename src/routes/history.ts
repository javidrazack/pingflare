import { Hono } from 'hono'
import { and, desc, eq, gte } from 'drizzle-orm'
import { getDb, incidents, monitors, statusLogs } from '../db'
import { requireAuth } from '../middleware/auth'
import { getMonitorAnalytics } from '../services/history-rollups'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)
router.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'private, no-store')
})

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

function roundedPercent(up: number, total: number): number | null {
  return total > 0 ? Math.round((up / total) * 10000) / 100 : null
}

router.get('/uptime-summary', async (c) => {
  const db = getDb(c.env.DB)
  const days = boundedInt(c.req.query('days'), 30, 1, 365)
  const monitorRows = await db.select({ id: monitors.id }).from(monitors)
  const result = await getMonitorAnalytics(c.env, monitorRows.map((row) => row.id), days, undefined, c.req.url)
  const uptimes: Record<string, number | null> = {}
  for (const id of monitorRows.map((row) => row.id)) {
    const analytics = result.analytics[id]
    uptimes[id] = analytics ? roundedPercent(analytics.up, analytics.count) : null
  }
  c.header('X-Pingflare-Aggregate-Cache', result.cacheStatus)
  return c.json({ days, uptimes })
})

router.get('/:id/logs', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const hoursParam = c.req.query('hours')
  const hours = hoursParam !== undefined ? boundedInt(hoursParam, 24, 1, 2160) : null
  const limit = boundedInt(c.req.query('limit'), 500, 1, 1000)
  const since = hours !== null && hours > 0
    ? Math.floor(Date.now() / 1000) - hours * 3600
    : null

  const rows = await db.select()
    .from(statusLogs)
    .where(since !== null
      ? and(eq(statusLogs.monitorId, id), gte(statusLogs.checkedAt, since))
      : eq(statusLogs.monitorId, id))
    .orderBy(desc(statusLogs.checkedAt))
    .limit(limit)

  return c.json(rows)
})

router.get('/:id/check-count', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare(`
    SELECT
      COALESCE((SELECT SUM(checks) FROM monitor_daily_rollups WHERE monitor_id = ?), 0)
      + COALESCE((SELECT day_checks FROM monitors WHERE id = ?), 0) AS count
  `).bind(id, id).first<{ count: number }>()
  return c.json({ count: Number(row?.count ?? 0) })
})

router.get('/:id/incidents', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const limit = boundedInt(c.req.query('limit'), 50, 1, 200)

  const rows = await db.select()
    .from(incidents)
    .where(eq(incidents.monitorId, id))
    .orderBy(desc(incidents.startedAt))
    .limit(limit)

  return c.json(rows)
})

router.get('/:id/analytics', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = boundedInt(c.req.query('days'), 90, 1, 365)
  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const result = await getMonitorAnalytics(c.env, [id], days, undefined, c.req.url)
  c.header('X-Pingflare-Aggregate-Cache', result.cacheStatus)
  return c.json(result.analytics[id])
})

// Compatibility endpoints retained for existing clients. New clients should use
// the single /analytics call to avoid four separate aggregate requests.
router.get('/:id/uptime', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = boundedInt(c.req.query('days'), 90, 1, 365)
  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const result = await getMonitorAnalytics(c.env, [id], days, undefined, c.req.url)
  const analytics = result.analytics[id]
  c.header('X-Pingflare-Aggregate-Cache', result.cacheStatus)
  return c.json({
    uptime: analytics ? roundedPercent(analytics.up, analytics.count) : null,
    days,
    total: analytics?.count ?? 0,
    up: analytics?.up ?? 0,
  })
})

router.get('/:id/daily', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = boundedInt(c.req.query('days'), 90, 1, 365)
  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const result = await getMonitorAnalytics(c.env, [id], days, undefined, c.req.url)
  c.header('X-Pingflare-Aggregate-Cache', result.cacheStatus)
  return c.json(result.analytics[id]?.daily ?? [])
})

export default router
