import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDb, makeEnv, insertMonitor, insertCheckObservation } from './setup'
import publicStatusRouter from '../routes/publicStatus'
import {
  incidentMonitors,
  incidentReports,
  incidentUpdates,
  incidents,
  monitorDailyRollups,
  monitors,
  quotaBudgets,
  statusPages,
  statusPageMonitors,
} from '../db/schema'
import { clearAggregateMemoryCache } from '../services/response-cache'
import {
  PUBLIC_D1_READ_BUDGET_PER_DAY,
  PUBLIC_INCIDENT_FEED_FIXED_READS,
  PUBLIC_INCIDENT_FEED_READS_PER_LINK,
  PUBLIC_STATUS_BASE_READ_RESERVATION,
  reservePublicD1ReadBudget,
} from '../services/d1-budget'

function buildApp(d1: D1Database) {
  const env = makeEnv(d1)
  const app = new Hono()
  app.route('/api/public/status', publicStatusRouter)
  return { app, env }
}

async function getSlug(app: Hono, env: ReturnType<typeof makeEnv>, slug: string, headers?: Record<string, string>) {
  return app.fetch(
    new Request(`http://localhost/api/public/status/${slug}`, { headers }),
    env,
  )
}

function nowSecs() { return Math.floor(Date.now() / 1000) }

async function insertPage(
  db: ReturnType<typeof import('../db').getDb>,
  slug: string,
  monitorIds: string[] = [],
  overrides: Partial<typeof statusPages.$inferInsert> = {},
) {
  const pageId = crypto.randomUUID()
  await db.insert(statusPages).values({ id: pageId, name: 'Test Page', slug, ...overrides })
  for (let i = 0; i < monitorIds.length; i++) {
    await db.insert(statusPageMonitors).values({ pageId, monitorId: monitorIds[i], sortOrder: i })
  }
  return pageId
}

function trackPreparedStatements(d1: D1Database): {
  d1: D1Database
  statements: string[]
} {
  const statements: string[] = []
  return {
    d1: new Proxy(d1, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (query: string) => {
            statements.push(query)
            return target.prepare(query)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
    statements,
  }
}

async function insertLog(
  db: ReturnType<typeof import('../db').getDb>,
  d1: D1Database,
  monitorId: string,
  status: 'up' | 'down',
  checkedAt: number,
) {
  await insertCheckObservation(db, d1, monitorId, status, checkedAt)
}

describe('GET /api/public/status/:slug', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    clearAggregateMemoryCache()
    ctx = await createTestDb()
  })

  it('returns 404 for unknown slug', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await getSlug(app, env, 'no-such-page')
    expect(res.status).toBe(404)
  })

  it('rate-limits summary and detail routes before issuing any D1 query', async () => {
    const tracked = trackPreparedStatements(ctx.d1)
    const env = {
      ...makeEnv(tracked.d1),
      PUBLIC_STATUS_RATE_LIMITER: {
        limit: vi.fn().mockResolvedValue({ success: false }),
      },
    }
    const app = new Hono()
    app.route('/api/public/status', publicStatusRouter)

    const summary = await getSlug(app, env, 'protected-from-abuse', {
      'cf-connecting-ip': '203.0.113.10',
    })
    const detail = await getSlug(
      app,
      env,
      'protected-from-abuse/monitors/monitor-id',
      { 'cf-connecting-ip': '203.0.113.10' },
    )

    expect(summary.status).toBe(429)
    expect(detail.status).toBe(429)
    expect(summary.headers.get('Retry-After')).toBe('60')
    expect(detail.headers.get('Retry-After')).toBe('60')
    expect(tracked.statements).toHaveLength(0)
  })

  it('returns page info with empty monitor list', async () => {
    const { db, d1 } = ctx
    await insertPage(db, 'empty-page')

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'empty-page')
    expect(res.status).toBe(200)
    const body = await res.json() as { page: { name: string }; monitors: unknown[] }
    expect(body.page.name).toBe('Test Page')
    expect(body.monitors).toHaveLength(0)
  })

  it('returns monitor list with correct uptime calculation', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db, { name: 'Monitored' })
    await insertPage(db, 'my-page', [monId])

    const now = nowSecs()

    await insertLog(db, d1, monId, 'down', now - 180)
    await insertLog(db, d1, monId, 'up', now - 120)
    await insertLog(db, d1, monId, 'up', now - 60)

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'my-page')
    expect(res.status).toBe(200)

    const body = await res.json() as { monitors: Array<{ id: string; uptime90d: number; daily: unknown[] }> }
    expect(body.monitors).toHaveLength(1)
    expect(body.monitors[0].id).toBe(monId)
    expect(body.monitors[0].uptime90d).toBeCloseTo(66.67, 1)
    expect(body.monitors[0].daily).toHaveLength(90)
  })

  it('daily aggregation only includes today for today-only logs', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)
    await insertPage(db, 'daily-page', [monId])

    const now = nowSecs()
    const todayMidnight = now - (now % 86400)

    await insertLog(db, d1, monId, 'up', todayMidnight + 100)
    await insertLog(db, d1, monId, 'up', todayMidnight + 200)
    await insertLog(db, d1, monId, 'up', todayMidnight + 300)
    await insertLog(db, d1, monId, 'down', todayMidnight + 400)

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'daily-page')
    const body = await res.json() as { monitors: Array<{ daily: Array<{ date: string; uptime: number | null }> }> }

    const today = new Date(now * 1000).toISOString().slice(0, 10)
    const todayEntry = body.monitors[0].daily.find(d => d.date === today)
    expect(todayEntry?.uptime).toBe(75)

    const nonNullDays = body.monitors[0].daily.filter(d => d.date !== today && d.uptime !== null)
    expect(nonNullDays).toHaveLength(0)
  })

  it('sets Cache-Control header on successful response', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)
    await insertPage(db, 'cached-page', [monId])

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'cached-page')
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('keeps D1 query count bounded at the 180-monitor steady ceiling', async () => {
    const { db, d1 } = ctx
    const now = nowSecs()
    const monitorIds = Array.from(
      { length: 180 },
      (_, index) => `monitor-${String(index).padStart(3, '0')}`,
    )
    await db.insert(monitors).values(monitorIds.map((id, index) => ({
      id,
      name: `Monitor ${String(index).padStart(3, '0')}`,
      type: 'http' as const,
      url: 'https://example.com',
    })))
    await insertPage(db, 'large-page', monitorIds)
    const today = now - (now % 86400)
    await db.insert(monitorDailyRollups).values({
      monitorId: monitorIds[179],
      day: today - 10 * 86400,
      checks: 1,
      upCount: 1,
      downCount: 0,
    })

    const incidentIds = monitorIds.map((_, index) =>
      `incident-${String(index).padStart(3, '0')}`)
    await db.insert(incidentReports).values(incidentIds.map((id, index) => ({
      id,
      title: `Incident ${index}`,
      status: 'investigating' as const,
      visibility: 'published' as const,
      impact: 'minor' as const,
      startedAt: now - (179 - index),
    })))
    await db.insert(incidentMonitors).values(incidentIds.map((incidentId, index) => ({
      incidentId,
      monitorId: monitorIds[index],
    })))
    const visibleIncidentIds = incidentIds.slice(-20)
    await db.insert(incidentMonitors).values(
      visibleIncidentIds.flatMap((incidentId) =>
        monitorIds
          .filter((_, monitorIndex) => incidentId !== incidentIds[monitorIndex])
          .map((monitorId) => ({ incidentId, monitorId }))),
    )
    await db.insert(incidentUpdates).values(
      visibleIncidentIds.flatMap((incidentId, incidentIndex) =>
        Array.from({ length: 30 }, (_, updateIndex) => ({
          id: `${incidentId}-update-${String(updateIndex).padStart(2, '0')}`,
          incidentId,
          message: `Update ${updateIndex}`,
          status: 'monitoring' as const,
          createdAt: now + incidentIndex * 100 + updateIndex,
        }))),
    )

    const tracked = trackPreparedStatements(d1)
    const { app, env } = buildApp(tracked.d1)
    const res = await getSlug(app, env, 'large-page')
    expect(res.status).toBe(200)

    const body = await res.json() as {
      monitors: Array<{ id: string; uptime90d: number | null }>
      incidents: Array<{
        id: string
        updates: Array<{ id: string }>
        monitorIds: string[]
      }>
    }
    expect(body.monitors.map(monitor => monitor.id)).toEqual(monitorIds)
    expect(body.monitors[179].uptime90d).toBe(100)
    expect(body.incidents).toHaveLength(20)
    expect(body.incidents[0].id).toBe(incidentIds[179])
    expect(body.incidents.every(incident =>
      incident.monitorIds.length === 180
      && incident.updates.length === 20)).toBe(true)
    const [publicBudget] = await db.select().from(quotaBudgets)
    expect(publicBudget.used).toBe(
      PUBLIC_STATUS_BASE_READ_RESERVATION
      + 180 * 88 + 10
      + 3_760 * PUBLIC_INCIDENT_FEED_READS_PER_LINK
      + PUBLIC_INCIDENT_FEED_FIXED_READS
      + 3_760 + 20 * 40 + 50,
    )
    expect(tracked.statements.filter(statement =>
      statement.includes('monitor_daily_rollups'))).toHaveLength(2)
    expect(tracked.statements.filter(statement =>
      statement.includes('incident_monitors'))).toHaveLength(2)
    expect(tracked.statements.filter(statement =>
      statement.includes('incident_reports'))).toHaveLength(1)
    expect(tracked.statements.filter(statement =>
      statement.includes('json_each')).length).toBeGreaterThanOrEqual(6)
  })

  it('bounds incident reads through monitor links and indexed update ordering', async () => {
    const { db, d1, raw } = ctx
    const monitorId = await insertMonitor(db)
    await insertPage(db, 'bounded-incidents', [monitorId])
    const now = nowSecs()
    await db.insert(incidentReports).values({
      id: 'visible-report',
      title: 'Visible report',
      status: 'monitoring',
      visibility: 'published',
      impact: 'minor',
      startedAt: now,
    })
    await db.insert(incidentMonitors).values({
      incidentId: 'visible-report',
      monitorId,
    })

    raw.exec(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      numbers(value) AS (
        SELECT
          a.value
          + b.value * 10
          + c.value * 100
          + d.value * 1000
          + e.value * 10000
        FROM digits AS a
        CROSS JOIN digits AS b
        CROSS JOIN digits AS c
        CROSS JOIN digits AS d
        CROSS JOIN digits AS e
      )
      INSERT INTO incident_reports (
        id, title, status, visibility, impact, started_at
      )
      SELECT
        'unrelated-' || printf('%05d', value),
        'Unrelated',
        'resolved',
        'published',
        'minor',
        ${now + 100}
      FROM numbers
      WHERE value < 40000;

      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      numbers(value) AS (
        SELECT
          a.value
          + b.value * 10
          + c.value * 100
          + d.value * 1000
          + e.value * 10000
        FROM digits AS a
        CROSS JOIN digits AS b
        CROSS JOIN digits AS c
        CROSS JOIN digits AS d
        CROSS JOIN digits AS e
      )
      INSERT INTO incident_updates (
        id, incident_id, message, status, created_at
      )
      SELECT
        'same-time-' || printf('%05d', value),
        'visible-report',
        'Update',
        'monitoring',
        ${now}
      FROM numbers
      WHERE value < 40000;
    `)

    const feedPlan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT DISTINCT report.id
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
    `).all(JSON.stringify([monitorId]), now - 14 * 86400) as Array<{ detail: string }>
    const updatePlan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT id
      FROM incident_updates
        INDEXED BY idx_incident_updates_incident_created_id
      WHERE incident_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT 20
    `).all('visible-report') as Array<{ detail: string }>
    expect(feedPlan.some(({ detail }) =>
      detail.includes('idx_incident_monitors_monitor'))).toBe(true)
    expect(feedPlan.some(({ detail }) =>
      /SCAN (?:incident_reports|report)(?:\\s|$)/.test(detail))).toBe(false)
    expect(updatePlan.some(({ detail }) =>
      detail.includes('idx_incident_updates_incident_created_id'))).toBe(true)
    expect(updatePlan.some(({ detail }) => detail.includes('TEMP B-TREE'))).toBe(false)

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'bounded-incidents')
    expect(res.status).toBe(200)
    const body = await res.json() as {
      incidents: Array<{ id: string; updates: Array<{ id: string }> }>
    }
    expect(body.incidents).toHaveLength(1)
    expect(body.incidents[0].updates).toHaveLength(20)
    expect(body.incidents[0].updates[0].id).toBe('same-time-39999')
  })

  it('reserves the global read budget only after a public page is authorized', async () => {
    const { db, d1 } = ctx
    await insertPage(db, 'budget-page')
    expect(await reservePublicD1ReadBudget(
      d1,
      PUBLIC_D1_READ_BUDGET_PER_DAY - PUBLIC_STATUS_BASE_READ_RESERVATION,
    )).toBe(true)

    const { app, env } = buildApp(d1)
    expect((await getSlug(app, env, 'does-not-exist')).status).toBe(404)
    let [budget] = await db.select().from(quotaBudgets)
    expect(budget.used).toBe(
      PUBLIC_D1_READ_BUDGET_PER_DAY - PUBLIC_STATUS_BASE_READ_RESERVATION,
    )

    expect((await getSlug(app, env, 'budget-page')).status).toBe(200)
    ;[budget] = await db.select().from(quotaBudgets)
    expect(budget.used).toBe(PUBLIC_D1_READ_BUDGET_PER_DAY)

    const exhausted = await getSlug(app, env, 'budget-page')
    expect(exhausted.status).toBe(429)
    expect(await exhausted.json()).toMatchObject({
      code: 'PUBLIC_D1_READ_BUDGET_EXHAUSTED',
    })
  })

  it('reports a permanent incident-history cap separately from the daily budget', async () => {
    const { db, d1, raw } = ctx
    const monitorId = await insertMonitor(db)
    await insertPage(db, 'oversized-incident-history', [monitorId])
    raw.prepare(`
      INSERT INTO incident_feed_monitor_counts (monitor_id, link_count)
      VALUES (?, 20001)
    `).run(monitorId)

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'oversized-incident-history')
    expect(res.status).toBe(503)
    expect(res.headers.get('Retry-After')).toBeNull()
    expect(await res.json()).toMatchObject({
      code: 'PUBLIC_INCIDENT_FEED_HISTORY_LIMIT',
    })
  })

  it('returns 401 for password-protected page without password', async () => {
    const { db, d1 } = ctx
    const { hashPassword } = await import('../utils')
    const hash = await hashPassword('secret123')
    const pageId = crypto.randomUUID()
    await db.insert(statusPages).values({
      id: pageId, name: 'Protected', slug: 'protected-page', passwordHash: hash,
    })

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'protected-page')
    expect(res.status).toBe(401)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('password_required')
  })

  it('returns 200 for password-protected page with correct password via header', async () => {
    const { db, d1 } = ctx
    const { hashPassword } = await import('../utils')
    const hash = await hashPassword('secret123')
    const pageId = crypto.randomUUID()
    await db.insert(statusPages).values({
      id: pageId, name: 'Protected', slug: 'pw-header-page', passwordHash: hash,
    })

    const { app, env } = buildApp(d1)
    const res = await getSlug(app, env, 'pw-header-page', { 'x-status-password': 'secret123' })
    expect(res.status).toBe(200)
    const access = res.headers.get('X-Pingflare-Status-Access')
    expect(access).toBeTruthy()

    const poll = await getSlug(app, env, 'pw-header-page', {
      'x-pingflare-status-access': access!,
      'x-status-password': 'intentionally-wrong',
    })
    expect(poll.status).toBe(200)

    const tampered = await getSlug(app, env, 'pw-header-page', {
      'x-pingflare-status-access': `${access}tampered`,
    })
    expect(tampered.status).toBe(401)
  })
})

describe('GET /api/public/status/:slug/monitors/:monitorId', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    clearAggregateMemoryCache()
    ctx = await createTestDb()
  })

  it('returns 404 for unknown slug', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await app.fetch(
      new Request('http://localhost/api/public/status/no-page/monitors/no-mon'),
      env,
    )
    expect(res.status).toBe(404)
  })

  it('returns Cache-Control header on monitor detail', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db, { name: 'Detail Monitor' })
    await insertPage(db, 'detail-page', [monId])

    const { app, env } = buildApp(d1)
    const res = await app.fetch(
      new Request(`http://localhost/api/public/status/detail-page/monitors/${monId}`),
      env,
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
  })

  it('returns the configured daily chart window for the monitor', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)
    await insertPage(db, 'thirty-page', [monId], { historyDays: 30 })

    const { app, env } = buildApp(d1)
    const res = await app.fetch(
      new Request(`http://localhost/api/public/status/thirty-page/monitors/${monId}`),
      env,
    )
    const body = await res.json() as { historyDays: number; daily: unknown[] }
    expect(body.historyDays).toBe(30)
    expect(body.daily).toHaveLength(30)
  })

  it('uses the bounded monitor-start index for automatic incident history', async () => {
    const { db, d1, raw } = ctx
    const monitorId = await insertMonitor(db)
    const unrelatedMonitorId = await insertMonitor(db)
    await insertPage(db, 'indexed-detail', [monitorId])
    const now = nowSecs()
    raw.exec(`
      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      numbers(value) AS (
        SELECT
          a.value
          + b.value * 10
          + c.value * 100
          + d.value * 1000
          + e.value * 10000
        FROM digits AS a
        CROSS JOIN digits AS b
        CROSS JOIN digits AS c
        CROSS JOIN digits AS d
        CROSS JOIN digits AS e
      )
      INSERT INTO incidents (
        id, monitor_id, started_at, resolved_at, duration_seconds
      )
      SELECT
        'unrelated-auto-' || printf('%05d', value),
        '${unrelatedMonitorId}',
        ${now - 1000},
        ${now - 900},
        100
      FROM numbers
      WHERE value < 40000;

      WITH digits(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      )
      INSERT INTO incidents (
        id, monitor_id, started_at, resolved_at, duration_seconds
      )
      SELECT
        'target-auto-' || printf('%02d', value),
        '${monitorId}',
        ${now} + value,
        ${now} + value + 1,
        1
      FROM digits
      WHERE value < 10;
    `)

    const plan = raw.prepare(`
      EXPLAIN QUERY PLAN
      SELECT *
      FROM incidents
      WHERE monitor_id = ?
      ORDER BY started_at DESC, id DESC
      LIMIT 20
    `).all(monitorId) as Array<{ detail: string }>
    expect(plan.some(({ detail }) =>
      detail.includes('idx_incidents_monitor_started_id'))).toBe(true)
    expect(plan.some(({ detail }) => detail.includes('TEMP B-TREE'))).toBe(false)

    const { app, env } = buildApp(d1)
    const res = await app.fetch(
      new Request(`http://localhost/api/public/status/indexed-detail/monitors/${monitorId}`),
      env,
    )
    expect(res.status).toBe(200)
    const body = await res.json() as { incidents: unknown[] }
    expect(body.incidents).toHaveLength(10)
  })
})
