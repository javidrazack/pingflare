import { Hono } from 'hono'
import { eq, desc, and, gte, count, sql } from 'drizzle-orm'
import { getDb, statusLogs, incidents, monitors } from '../db'
import { requireAuth } from '../middleware/auth'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
}

router.get('/uptime-summary', async (c) => {
  const db = getDb(c.env.DB)
  const days = boundedInt(c.req.query('days'), 30, 1, 365)
  const since = Math.floor(Date.now() / 1000) - days * 86400
  const rows = await db.select({
    monitorId: statusLogs.monitorId,
    ups: sql<number>`SUM(CASE WHEN ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups'),
    total: count(),
  })
    .from(statusLogs)
    .where(gte(statusLogs.checkedAt, since))
    .groupBy(statusLogs.monitorId)

  const uptimes: Record<string, number | null> = {}
  for (const row of rows) {
    uptimes[row.monitorId] = row.total > 0
      ? Math.round((row.ups / row.total) * 10000) / 100
      : null
  }
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
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const [{ total }] = await db.select({ total: count() }).from(statusLogs).where(eq(statusLogs.monitorId, id))
  return c.json({ count: total })
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

router.get('/:id/uptime', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = boundedInt(c.req.query('days'), 90, 1, 365)
  const since = Math.floor(Date.now() / 1000) - days * 86400

  const [agg] = await db.select({
    ups: sql<number>`SUM(CASE WHEN ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups'),
    total: count(),
  })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, id), gte(statusLogs.checkedAt, since)))

  if (!agg || !agg.total) return c.json({ uptime: null, days })

  return c.json({ uptime: Math.round((agg.ups / agg.total) * 10000) / 100, days, total: agg.total, up: agg.ups })
})

router.get('/:id/daily', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const days = boundedInt(c.req.query('days'), 90, 1, 365)
  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const now = Math.floor(Date.now() / 1000)
  const since = now - days * 86400
  const dayExpr = sql<string>`strftime('%Y-%m-%d', datetime(${statusLogs.checkedAt}, 'unixepoch'))`

  const rows = await db.select({
    day: dayExpr.as('day'),
    ups: sql<number>`SUM(CASE WHEN ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups'),
    total: sql<number>`COUNT(*)`.as('total'),
  })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, id), gte(statusLogs.checkedAt, since)))
    .groupBy(dayExpr)

  const dayMap: Record<string, { ups: number; total: number }> = {}
  for (const row of rows) dayMap[row.day] = { ups: row.ups, total: row.total }

  const result: { date: string; uptime: number | null }[] = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10)
    const e = dayMap[d]
    result.push({ date: d, uptime: e ? Math.round((e.ups / e.total) * 1000) / 10 : null })
  }

  return c.json(result)
})

export default router
