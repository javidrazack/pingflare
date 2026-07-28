import { Hono } from 'hono'
import { eq, desc, and, gte, inArray } from 'drizzle-orm'
import { getDb, statusPages, statusPageMonitors, monitors, statusLogs, incidents, incidentReports, incidentUpdates, incidentMonitors } from '../db'
import { verifyPassword } from '../utils'
import { getMonitorAnalytics } from '../services/history-rollups'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
const D1_ID_CHUNK_SIZE = 90

function publicPageInfo(page: typeof statusPages.$inferSelect) {
  return {
    name: page.name,
    description: page.description,
    protected: !!page.passwordHash,
    logoUrl: page.logoUrl,
    brandColor: page.brandColor,
    theme: page.theme,
    showResponseTime: page.showResponseTime,
    showUptime: page.showUptime,
    historyDays: page.historyDays,
    seoTitle: page.seoTitle,
    seoDescription: page.seoDescription,
  }
}

router.get('/:slug', async (c) => {
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  c.header('Cache-Control', 'no-store')

  if (page.passwordHash) {
    const provided = c.req.header('x-status-password')
    const pageInfo = publicPageInfo(page)
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
        page: publicPageInfo(page),
        monitors: [],
        incidents: [],
      })
    }

    monitorRows = []
    for (let offset = 0; offset < monitorIds.length; offset += D1_ID_CHUNK_SIZE) {
      monitorRows.push(...await db.select().from(monitors)
        .where(inArray(monitors.id, monitorIds.slice(offset, offset + D1_ID_CHUNK_SIZE))))
    }
  }

  if (monitorIds.length === 0) {
    return c.json({
      page: publicPageInfo(page),
      monitors: [],
      incidents: [],
    })
  }

  const now = Math.floor(Date.now() / 1000)
  const historyDays = Math.min(365, Math.max(1, page.historyDays))
  const history = await getMonitorAnalytics(c.env, monitorIds, historyDays, now, c.req.url)
  c.header('X-Pingflare-Aggregate-Cache', history.cacheStatus)

  const monitorData = monitorRows.map(m => {
    const analytics = history.analytics[m.id]
    return {
      id: m.id,
      name: m.name,
      status: m.lastStatus,
      uptime90d: analytics?.uptimes['90'] ?? null,
      daily: analytics?.daily ?? [],
    }
  })

  monitorData.sort((a, b) => monitorIds.indexOf(a.id) - monitorIds.indexOf(b.id))

  const incMonitorRows: (typeof incidentMonitors.$inferSelect)[] = []
  for (let offset = 0; offset < monitorIds.length; offset += D1_ID_CHUNK_SIZE) {
    incMonitorRows.push(...await db.select().from(incidentMonitors)
      .where(inArray(incidentMonitors.monitorId, monitorIds.slice(offset, offset + D1_ID_CHUNK_SIZE))))
  }
  const incidentIds = [...new Set(incMonitorRows.map(r => r.incidentId))]

  let incidentData: object[] = []
  if (incidentIds.length > 0) {
    const since14d = now - 14 * 86400
    const incidentCandidates: (typeof incidentReports.$inferSelect)[] = []
    for (let offset = 0; offset < incidentIds.length; offset += D1_ID_CHUNK_SIZE) {
      incidentCandidates.push(...await db.select().from(incidentReports)
        .where(and(
          inArray(incidentReports.id, incidentIds.slice(offset, offset + D1_ID_CHUNK_SIZE)),
          eq(incidentReports.visibility, 'published'),
        ))
        .orderBy(desc(incidentReports.startedAt))
        .limit(20))
    }
    const incRows = incidentCandidates
      .sort((left, right) => right.startedAt - left.startedAt)
      .slice(0, 20)

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
    page: publicPageInfo(page),
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
  c.header('Cache-Control', 'no-store')

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
  const historyDays = Math.min(365, Math.max(1, page.historyDays))
  const history = await getMonitorAnalytics(c.env, [monitorId], historyDays, now, c.req.url)
  const analytics = history.analytics[monitorId]
  c.header('X-Pingflare-Aggregate-Cache', history.cacheStatus)

  const since24h = now - 86400
  const logs24h = await db.select()
    .from(statusLogs)
    .where(and(eq(statusLogs.monitorId, monitorId), gte(statusLogs.checkedAt, since24h)))
    .orderBy(desc(statusLogs.checkedAt))
    .limit(200)

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
    uptime1: analytics?.uptimes['1'] ?? null,
    uptime7: analytics?.uptimes['7'] ?? null,
    uptime30: analytics?.uptimes['30'] ?? null,
    uptime90: analytics?.uptimes['90'] ?? null,
    avgResponseMs: analytics?.avgResponseMs ?? null,
    daily: analytics?.daily ?? [],
    logs: logs24h.map(l => ({
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
