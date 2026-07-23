import { Hono } from 'hono'
import { eq, desc, and, gte, inArray, sql } from 'drizzle-orm'
import { getDb, statusPages, statusPageMonitors, monitors, statusLogs, incidents, incidentReports, incidentUpdates, incidentMonitors } from '../db'
import { verifyPassword } from '../utils'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()

async function getDailyStats(
  db: ReturnType<typeof getDb>,
  monitorIds: string[],
  since90d: number,
) {
  if (monitorIds.length === 0) return []
  const dayExpr = sql<string>`strftime('%Y-%m-%d', datetime(${statusLogs.checkedAt}, 'unixepoch'))`
  return db.select({
    monitorId: statusLogs.monitorId,
    day: dayExpr.as('day'),
    ups: sql<number>`SUM(CASE WHEN ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups'),
    total: sql<number>`COUNT(*)`.as('total'),
  })
    .from(statusLogs)
    .where(and(inArray(statusLogs.monitorId, monitorIds), gte(statusLogs.checkedAt, since90d)))
    .groupBy(statusLogs.monitorId, dayExpr)
}

router.get('/:slug', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  c.header('Cache-Control', page.passwordHash
    ? 'private, no-store'
    : 'public, max-age=30, stale-while-revalidate=60')

  if (page.passwordHash) {
    const provided = c.req.header('x-status-password')
    const pageInfo = { name: page.name, description: page.description }
    if (!provided) return c.json({ error: 'password_required', protected: true, page: pageInfo }, 401)
    if (!(await verifyPassword(provided, page.passwordHash))) return c.json({ error: 'wrong_password', protected: true, page: pageInfo }, 401)
  }

  let monitorIds: string[]
  let monitorRows: typeof monitors.$inferSelect[]

  if (page.showAllMonitors) {
    monitorRows = await db.select().from(monitors).where(eq(monitors.active, true))
    monitorRows.sort((a, b) => a.name.localeCompare(b.name))
    monitorIds = monitorRows.map(r => r.id)
  } else {
    const pageMonitorRows = await db.select().from(statusPageMonitors)
      .where(eq(statusPageMonitors.pageId, page.id))
    pageMonitorRows.sort((a, b) => a.sortOrder - b.sortOrder)
    monitorIds = pageMonitorRows.map(r => r.monitorId)

    if (monitorIds.length === 0) {
      return c.json({
        page: { name: page.name, description: page.description, protected: !!page.passwordHash },
        monitors: [],
        incidents: [],
      })
    }

    monitorRows = await db.select().from(monitors).where(inArray(monitors.id, monitorIds))
  }

  if (monitorIds.length === 0) {
    return c.json({
      page: { name: page.name, description: page.description, protected: !!page.passwordHash },
      monitors: [],
      incidents: [],
    })
  }

  const now = Math.floor(Date.now() / 1000)
  const since90d = now - 90 * 86400

  const dailyRows = await getDailyStats(db, monitorIds, since90d)

  const daysByMonitor: Record<string, Record<string, { ups: number; total: number }>> = {}
  const uptimeByMonitor: Record<string, { ups: number; total: number }> = {}

  for (const row of dailyRows) {
    if (!daysByMonitor[row.monitorId]) daysByMonitor[row.monitorId] = {}
    daysByMonitor[row.monitorId][row.day] = { ups: row.ups, total: row.total }

    if (!uptimeByMonitor[row.monitorId]) uptimeByMonitor[row.monitorId] = { ups: 0, total: 0 }
    uptimeByMonitor[row.monitorId].ups += row.ups
    uptimeByMonitor[row.monitorId].total += row.total
  }

  const monitorData = monitorRows.map(m => {
    const days = daysByMonitor[m.id] ?? {}
    const agg = uptimeByMonitor[m.id]
    const uptime90d = agg ? Math.round((agg.ups / agg.total) * 10000) / 100 : null

    const daily = []
    for (let i = 89; i >= 0; i--) {
      const d = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10)
      const e = days[d]
      daily.push({ date: d, uptime: e ? Math.round((e.ups / e.total) * 1000) / 10 : null })
    }

    return { id: m.id, name: m.name, status: m.lastStatus, uptime90d, daily }
  })

  monitorData.sort((a, b) => monitorIds.indexOf(a.id) - monitorIds.indexOf(b.id))

  const incMonitorRows = await db.select().from(incidentMonitors)
    .where(inArray(incidentMonitors.monitorId, monitorIds))
  const incidentIds = [...new Set(incMonitorRows.map(r => r.incidentId))]

  let incidentData: object[] = []
  if (incidentIds.length > 0) {
    const since14d = now - 14 * 86400
    const incRows = await db.select().from(incidentReports)
      .where(inArray(incidentReports.id, incidentIds))
      .orderBy(desc(incidentReports.startedAt))
      .limit(20)

    const visibleIncidentIds = incRows
      .filter(inc => !inc.resolvedAt || inc.resolvedAt >= since14d)
      .map(inc => inc.id)
    const allUpdates = visibleIncidentIds.length > 0
      ? await db.select().from(incidentUpdates)
        .where(inArray(incidentUpdates.incidentId, visibleIncidentIds))
        .orderBy(desc(incidentUpdates.createdAt))
      : []

    for (const inc of incRows) {
      if (inc.resolvedAt && inc.resolvedAt < since14d) continue
      const updates = allUpdates.filter(update => update.incidentId === inc.id)
      const affectedMonitorIds = incMonitorRows
        .filter(r => r.incidentId === inc.id)
        .map(r => r.monitorId)
      incidentData.push({ ...inc, updates, monitorIds: affectedMonitorIds })
    }
  }

  return c.json({
    page: { name: page.name, description: page.description, protected: !!page.passwordHash },
    monitors: monitorData,
    incidents: incidentData,
  })
})

router.get('/:slug/monitors/:monitorId', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')
  const monitorId = c.req.param('monitorId')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  c.header('Cache-Control', page.passwordHash
    ? 'private, no-store'
    : 'public, max-age=30, stale-while-revalidate=60')

  if (page.passwordHash) {
    const provided = c.req.header('x-status-password')
    if (!provided) return c.json({ error: 'password_required', protected: true }, 401)
    if (!(await verifyPassword(provided, page.passwordHash))) return c.json({ error: 'wrong_password', protected: true }, 401)
  }

  let monitor: typeof monitors.$inferSelect | undefined
  if (page.showAllMonitors) {
    monitor = await db.query.monitors.findFirst({
      where: and(eq(monitors.id, monitorId), eq(monitors.active, true)),
    })
  } else {
    const rows = await db.select().from(statusPageMonitors)
      .where(and(eq(statusPageMonitors.pageId, page.id), eq(statusPageMonitors.monitorId, monitorId)))
    if (rows.length > 0) {
      monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) })
    }
  }
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  const now = Math.floor(Date.now() / 1000)
  const since90d = now - 90 * 86400
  const dayExpr = sql<string>`strftime('%Y-%m-%d', datetime(${statusLogs.checkedAt}, 'unixepoch'))`

  const dailyAgg = await db.select({
    day: dayExpr.as('day'),
    ups: sql<number>`SUM(CASE WHEN ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups'),
    total: sql<number>`COUNT(*)`.as('total'),
  })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, since90d)))
    .groupBy(dayExpr)

  const dayMap: Record<string, { ups: number; total: number }> = {}
  let totalUps = 0, totalAll = 0
  for (const row of dailyAgg) {
    dayMap[row.day] = { ups: row.ups, total: row.total }
    totalUps += row.ups
    totalAll += row.total
  }

  const daily = []
  for (let i = 89; i >= 0; i--) {
    const d = new Date((now - i * 86400) * 1000).toISOString().slice(0, 10)
    const e = dayMap[d]
    daily.push({ date: d, uptime: e ? Math.round((e.ups / e.total) * 1000) / 10 : null })
  }

  const since24h = now - 86400
  const logs24h = await db.select()
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, since24h)))
    .orderBy(desc(statusLogs.checkedAt))

  const withTime = logs24h.filter(l => l.responseTimeMs !== null)
  const avgResponseMs = withTime.length > 0
    ? Math.round(withTime.reduce((s, l) => s + l.responseTimeMs!, 0) / withTime.length)
    : null

  const since7d = now - 7 * 86400
  const since30d = now - 30 * 86400
  const [uptimeAgg] = await db.select({
    ups1: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since24h} AND ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups1'),
    total1: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since24h} THEN 1 ELSE 0 END)`.as('total1'),
    ups7: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since7d} AND ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups7'),
    total7: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since7d} THEN 1 ELSE 0 END)`.as('total7'),
    ups30: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since30d} AND ${statusLogs.status} = 'up' THEN 1 ELSE 0 END)`.as('ups30'),
    total30: sql<number>`SUM(CASE WHEN ${statusLogs.checkedAt} >= ${since30d} THEN 1 ELSE 0 END)`.as('total30'),
  })
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, since90d)))

  const percent = (ups: number | null, total: number | null): number | null =>
    total && ups !== null ? Math.round((ups / total) * 10000) / 100 : null

  const monitorIncidents = await db.select().from(incidents)
    .where(eq(incidents.monitorId, monitorId))
    .orderBy(desc(incidents.startedAt))
    .limit(20)

  return c.json({
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    tags: monitor.tags,
    lastStatus: monitor.lastStatus,
    lastCheckedAt: monitor.lastCheckedAt,
    uptime1: percent(uptimeAgg?.ups1 ?? null, uptimeAgg?.total1 ?? null),
    uptime7: percent(uptimeAgg?.ups7 ?? null, uptimeAgg?.total7 ?? null),
    uptime30: percent(uptimeAgg?.ups30 ?? null, uptimeAgg?.total30 ?? null),
    uptime90: totalAll > 0 ? Math.round((totalUps / totalAll) * 10000) / 100 : null,
    avgResponseMs,
    daily,
    logs: logs24h.slice(0, 200).map(l => ({
      checkedAt: l.checkedAt,
      status: l.status,
      responseTimeMs: l.responseTimeMs,
      message: l.message,
    })),
    incidents: monitorIncidents.map(i => ({
      startedAt: i.startedAt,
      resolvedAt: i.resolvedAt,
      durationSeconds: i.durationSeconds,
    })),
  })
})

export default router
