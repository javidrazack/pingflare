import { displayStatus } from '../services/monitor-freshness'
import { Hono, type Context } from 'hono'
import { eq, desc, and, gte, sql } from 'drizzle-orm'
import { getDb, statusPages, statusPageMonitors, monitors, statusLogs, incidents, incidentReports, incidentUpdates, incidentMonitors } from '../db'
import { verifyPassword } from '../utils'
import { getMonitorAnalytics } from '../services/history-rollups'
import {
  PUBLIC_STATUS_BASE_READ_RESERVATION,
  PUBLIC_STATUS_MONITOR_LIMIT,
  PublicD1ReadBudgetExceededError,
  requirePublicD1ReadBudget,
  reservePublicIncidentFeedReadBudget,
  reservePublicD1ReadBudget,
} from '../services/d1-budget'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
const STATUS_ACCESS_TTL_SECONDS = 10 * 60
const STATUS_ACCESS_HEADER = 'x-pingflare-status-access'
let cachedStatusAccessSecret: string | null = null
let cachedStatusAccessKey: Promise<CryptoKey> | null = null

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
}

function base64UrlDecode(value: string): Uint8Array | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
    return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0))
  } catch {
    return null
  }
}

async function statusAccessKey(secret: string): Promise<CryptoKey> {
  if (cachedStatusAccessSecret !== secret || !cachedStatusAccessKey) {
    cachedStatusAccessSecret = secret
    cachedStatusAccessKey = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    )
  }
  return cachedStatusAccessKey
}

function statusAccessMessage(
  slug: string,
  expiresAt: number,
  passwordHash: string,
): Uint8Array {
  return new TextEncoder().encode(`${slug}\n${expiresAt}\n${passwordHash}`)
}

async function createStatusAccessToken(
  secret: string,
  slug: string,
  passwordHash: string,
  now: number,
): Promise<string> {
  const expiresAt = now + STATUS_ACCESS_TTL_SECONDS
  const signature = await crypto.subtle.sign(
    'HMAC',
    await statusAccessKey(secret),
    statusAccessMessage(slug, expiresAt, passwordHash),
  )
  return `${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`
}

async function verifyStatusAccessToken(
  secret: string,
  slug: string,
  passwordHash: string,
  token: string | undefined,
  now: number,
): Promise<boolean> {
  if (!token) return false
  const [expiresText, encodedSignature, extra] = token.split('.')
  const expiresAt = Number(expiresText)
  const signature = encodedSignature ? base64UrlDecode(encodedSignature) : null
  if (
    extra !== undefined
    || !Number.isInteger(expiresAt)
    || expiresAt < now
    || expiresAt > now + STATUS_ACCESS_TTL_SECONDS
    || !signature
  ) return false
  return crypto.subtle.verify(
    'HMAC',
    await statusAccessKey(secret),
    signature,
    statusAccessMessage(slug, expiresAt, passwordHash),
  )
}

async function authorizeProtectedPage(
  c: Context<{ Bindings: Env }>,
  page: typeof statusPages.$inferSelect,
  includePageInfo: boolean,
): Promise<Response | null> {
  if (!page.passwordHash) return null
  const now = Math.floor(Date.now() / 1000)
  if (await verifyStatusAccessToken(
    c.env.JWT_SECRET,
    page.slug,
    page.passwordHash,
    c.req.header(STATUS_ACCESS_HEADER),
    now,
  )) return null

  const provided = c.req.header('x-status-password')
  const protectedBody = includePageInfo
    ? { protected: true, page: publicPageInfo(page) }
    : { protected: true }
  if (!provided) {
    return c.json({ error: 'password_required', ...protectedBody }, 401)
  }
  if (!(await verifyPassword(provided, page.passwordHash))) {
    return c.json({ error: 'wrong_password', ...protectedBody }, 401)
  }
  c.header(
    STATUS_ACCESS_HEADER,
    await createStatusAccessToken(
      c.env.JWT_SECRET,
      page.slug,
      page.passwordHash,
      now,
    ),
  )
  return null
}

async function rejectRateLimitedPublicRequest(
  c: Context<{ Bindings: Env }>,
): Promise<Response | null> {
  const slug = c.req.param('slug')
  const visitor = c.req.header('cf-connecting-ip')
    ?? c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    ?? 'unknown'
  const { success } = await c.env.PUBLIC_STATUS_RATE_LIMITER.limit({
    key: `${visitor}:${slug}`,
  })
  if (success) return null
  c.header('Retry-After', '60')
  c.header('Cache-Control', 'no-store')
  return c.json({ error: 'Too many status page requests' }, 429)
}

function publicBudgetExhaustedResponse(
  c: Context<{ Bindings: Env }>,
): Response {
  const now = Math.floor(Date.now() / 1000)
  c.header('Retry-After', String(86400 - (now % 86400)))
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'Public status quota is reserved for monitoring until the next UTC day',
    code: 'PUBLIC_D1_READ_BUDGET_EXHAUSTED',
  }, 429)
}

function publicIncidentHistoryLimitResponse(
  c: Context<{ Bindings: Env }>,
): Response {
  c.header('Cache-Control', 'no-store')
  return c.json({
    error: 'This status page has too many historical incident links for a reliable Free-plan query; archive old manual incident associations',
    code: 'PUBLIC_INCIDENT_FEED_HISTORY_LIMIT',
  }, 503)
}

async function rejectExhaustedPublicBudget(
  c: Context<{ Bindings: Env }>,
): Promise<Response | null> {
  return await reservePublicD1ReadBudget(
    c.env.DB,
    PUBLIC_STATUS_BASE_READ_RESERVATION,
  )
    ? null
    : publicBudgetExhaustedResponse(c)
}

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
  const limited = await rejectRateLimitedPublicRequest(c)
  if (limited) return limited
  const slug = c.req.param('slug')

  const db = getDb(c.env.DB)
  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  c.header('Cache-Control', 'no-store')

  const unauthorized = await authorizeProtectedPage(c, page, true)
  if (unauthorized) return unauthorized
  const budgetLimited = await rejectExhaustedPublicBudget(c)
  if (budgetLimited) return budgetLimited

  let monitorIds: string[]
  let monitorRows: typeof monitors.$inferSelect[]

  if (page.showAllMonitors) {
    monitorRows = await db.select().from(monitors)
      .where(eq(monitors.active, true))
      .limit(PUBLIC_STATUS_MONITOR_LIMIT + 1)
    if (monitorRows.length > PUBLIC_STATUS_MONITOR_LIMIT) {
      return c.json({
        error: `Show-all pages support at most ${PUBLIC_STATUS_MONITOR_LIMIT} active monitors on the Free plan; select an explicit monitor set`,
      }, 422)
    }
    monitorRows.sort((a, b) => a.name.localeCompare(b.name))
    monitorIds = monitorRows.map(r => r.id)
  } else {
    const pageMonitorRows = await db.select().from(statusPageMonitors)
      .where(eq(statusPageMonitors.pageId, page.id))
      .limit(PUBLIC_STATUS_MONITOR_LIMIT + 1)
    if (pageMonitorRows.length > PUBLIC_STATUS_MONITOR_LIMIT) {
      return c.json({
        error: `Status pages support at most ${PUBLIC_STATUS_MONITOR_LIMIT} monitors on the Free plan`,
      }, 422)
    }
    pageMonitorRows.sort((a, b) => a.sortOrder - b.sortOrder)
    monitorIds = pageMonitorRows.map(r => r.monitorId)

    if (monitorIds.length === 0) {
      return c.json({
        page: publicPageInfo(page),
        monitors: [],
        incidents: [],
      })
    }

    monitorRows = await db.select().from(monitors)
      .where(sql`${monitors.id} IN (SELECT value FROM json_each(${JSON.stringify(monitorIds)}))`)
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
  const incidentFeedBudget = await reservePublicIncidentFeedReadBudget(
    c.env.DB,
    monitorIds,
  )
  if (incidentFeedBudget.kind === 'daily_budget') {
    return publicBudgetExhaustedResponse(c)
  }
  if (incidentFeedBudget.kind === 'history_limit') {
    return publicIncidentHistoryLimitResponse(c)
  }

  let history: Awaited<ReturnType<typeof getMonitorAnalytics>>
  try {
    history = await getMonitorAnalytics(
      c.env,
      monitorIds,
      historyDays,
      now,
      c.req.url,
      monitorRows,
      (estimatedRows) => requirePublicD1ReadBudget(c.env.DB, estimatedRows),
    )
  } catch (error) {
    if (error instanceof PublicD1ReadBudgetExceededError) {
      return publicBudgetExhaustedResponse(c)
    }
    throw error
  }
  c.header('X-Pingflare-Aggregate-Cache', history.cacheStatus)

  const monitorData = monitorRows.map(m => {
    const analytics = history.analytics[m.id]
    return {
      id: m.id,
      name: m.name,
      status: displayStatus(m),
      lastCheckedAt: m.lastCheckedAt,
      uptime90d: analytics?.uptimes['90'] ?? null,
      daily: analytics?.daily ?? [],
    }
  })

  const monitorOrder = new Map(monitorIds.map((id, index) => [id, index]))
  monitorData.sort((left, right) =>
    (monitorOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (monitorOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER))

  let incidentData: object[] = []
  const monitorIdsJson = JSON.stringify(monitorIds)
  const since14d = now - 14 * 86400
  // Start from the page's monitor links so unrelated reports are never walked.
  // The trigger-maintained link counter was reserved before this query, making
  // both the association scan and report lookups part of the global D1 budget.
  const incidentResult = await c.env.DB.prepare(`
    SELECT DISTINCT
      report.id,
      report.title,
      report.status,
      report.visibility,
      report.impact,
      report.published_at AS publishedAt,
      report.started_at AS startedAt,
      report.resolved_at AS resolvedAt
    FROM json_each(?) AS page_monitor
    JOIN incident_monitors AS report_link
      INDEXED BY idx_incident_monitors_monitor
      ON report_link.monitor_id = page_monitor.value
    JOIN incident_reports AS report
      ON report.id = report_link.incident_id
    WHERE report.visibility = 'published'
      AND (report.resolved_at IS NULL OR report.resolved_at >= ?)
    ORDER BY report.started_at DESC, report.id DESC
    LIMIT 20
  `).bind(
    monitorIdsJson,
    since14d,
  ).all<typeof incidentReports.$inferSelect>()
  const incRows = incidentResult.results

  const visibleIncidentIds = incRows.map(inc => inc.id)
  if (visibleIncidentIds.length > 0) {
    const visibleIdsJson = JSON.stringify(visibleIncidentIds)
    const incidentReadReservation =
      incidentFeedBudget.candidateLinks
      + visibleIncidentIds.length * 40
      + 50
    if (!(await reservePublicD1ReadBudget(c.env.DB, incidentReadReservation))) {
      return publicBudgetExhaustedResponse(c)
    }
    const [incMonitorRows, allUpdates] = await Promise.all([
      c.env.DB.prepare(`
        SELECT
          report_link.incident_id AS incidentId,
          report_link.monitor_id AS monitorId
        FROM json_each(?) AS page_monitor
        JOIN incident_monitors AS report_link
          INDEXED BY idx_incident_monitors_monitor
          ON report_link.monitor_id = page_monitor.value
        WHERE report_link.incident_id IN (
          SELECT value FROM json_each(?)
        )
      `).bind(monitorIdsJson, visibleIdsJson)
        .all<typeof incidentMonitors.$inferSelect>()
        .then((result) => result.results),
      c.env.DB.prepare(`
        SELECT
          update_row.id,
          update_row.incident_id AS incidentId,
          update_row.message,
          update_row.status,
          update_row.created_at AS createdAt
        FROM json_each(?) AS incident_id
        JOIN incident_updates AS update_row
          ON update_row.rowid IN (
            SELECT recent_update.rowid
            FROM incident_updates AS recent_update
              INDEXED BY idx_incident_updates_incident_created_id
            WHERE recent_update.incident_id = incident_id.value
            ORDER BY recent_update.created_at DESC, recent_update.id DESC
            LIMIT 20
          )
        ORDER BY update_row.created_at DESC, update_row.id DESC
      `).bind(visibleIdsJson).all<typeof incidentUpdates.$inferSelect>()
        .then((result) => result.results),
    ])

    for (const inc of incRows) {
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
  const limited = await rejectRateLimitedPublicRequest(c)
  if (limited) return limited
  const db = getDb(c.env.DB)
  const slug = c.req.param('slug')
  const monitorId = c.req.param('monitorId')

  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  c.header('Cache-Control', 'no-store')

  const unauthorized = await authorizeProtectedPage(c, page, false)
  if (unauthorized) return unauthorized

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
  const budgetLimited = await rejectExhaustedPublicBudget(c)
  if (budgetLimited) return budgetLimited

  const now = Math.floor(Date.now() / 1000)
  const historyDays = Math.min(365, Math.max(1, page.historyDays))
  let history: Awaited<ReturnType<typeof getMonitorAnalytics>>
  try {
    history = await getMonitorAnalytics(
      c.env,
      [monitorId],
      historyDays,
      now,
      c.req.url,
      [monitor],
      (estimatedRows) => requirePublicD1ReadBudget(c.env.DB, estimatedRows),
    )
  } catch (error) {
    if (error instanceof PublicD1ReadBudgetExceededError) {
      return publicBudgetExhaustedResponse(c)
    }
    throw error
  }
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
    .orderBy(desc(incidents.startedAt), desc(incidents.id))
    .limit(20)

  return c.json({
    name: monitor.name,
    type: monitor.type,
    url: monitor.url,
    tags: monitor.tags,
    lastStatus: displayStatus(monitor),
    lastCheckedAt: monitor.lastCheckedAt,
    uptime1: analytics?.uptimes['1'] ?? null,
    uptime7: analytics?.uptimes['7'] ?? null,
    uptime30: analytics?.uptimes['30'] ?? null,
    uptime90: analytics?.uptimes['90'] ?? null,
    avgResponseMs: analytics?.avgResponseMs ?? null,
    historyDays,
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
