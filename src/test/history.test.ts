import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createTestDb, makeEnv, makeAuthHeader, insertMonitor } from './setup'
import historyRouter from '../routes/history'
import { statusLogs, incidents } from '../db/schema'

function buildApp(d1: D1Database) {
  const env = makeEnv(d1)
  const app = new Hono()
  app.route('/api/monitors', historyRouter)
  return { app, env }
}

async function get(app: Hono, env: ReturnType<typeof makeEnv>, path: string, auth: string) {
  return app.fetch(
    new Request(`http://localhost${path}`, { headers: { Authorization: auth } }),
    env,
  )
}

function nowSecs() { return Math.floor(Date.now() / 1000) }

async function insertLog(
  db: ReturnType<typeof import('../db').getDb>,
  monitorId: string,
  status: 'up' | 'down',
  checkedAt: number,
  responseTimeMs = 100,
) {
  await db.insert(statusLogs).values({
    id: crypto.randomUUID(),
    monitorId,
    status,
    message: status === 'up' ? 'OK' : 'Error',
    responseTimeMs,
    checkedAt,
  })
}

describe('/api/monitors/:id/logs', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('returns 401 without auth', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await app.fetch(new Request('http://localhost/api/monitors/x/logs'), env)
    expect(res.status).toBe(401)
  })

  it('returns recent logs ordered newest first', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    await insertLog(db, id, 'up', now - 60)
    await insertLog(db, id, 'down', now - 30)
    await insertLog(db, id, 'up', now)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/logs`, auth)
    expect(res.status).toBe(200)
    const rows = await res.json() as { checkedAt: number }[]
    expect(rows).toHaveLength(3)
    expect(rows[0].checkedAt).toBeGreaterThanOrEqual(rows[1].checkedAt)
  })

  it('filters by hours parameter', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    await insertLog(db, id, 'up', now - 7200)
    await insertLog(db, id, 'up', now - 1800)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/logs?hours=1`, auth)
    const rows = await res.json() as unknown[]
    expect(rows).toHaveLength(1)
  })
})

describe('/api/monitors/:id/uptime', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('returns null uptime when no logs exist', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/uptime`, auth)
    const body = await res.json() as { uptime: unknown }
    expect(body.uptime).toBeNull()
  })

  it('calculates uptime correctly via SQL aggregation', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    await insertLog(db, id, 'up', now - 30)
    await insertLog(db, id, 'up', now - 60)
    await insertLog(db, id, 'up', now - 90)
    await insertLog(db, id, 'down', now - 120)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/uptime`, auth)
    const body = await res.json() as { uptime: number; total: number; up: number }
    expect(body.uptime).toBe(75)
    expect(body.total).toBe(4)
    expect(body.up).toBe(3)
  })

  it('respects the days parameter', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    await insertLog(db, id, 'up', now - 86400 * 5)
    await insertLog(db, id, 'down', now - 86400 * 10)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/uptime?days=7`, auth)
    const body = await res.json() as { uptime: number; total: number }
    expect(body.total).toBe(1)
    expect(body.uptime).toBe(100)
  })
})

describe('/api/monitors/:id/daily', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('returns 404 for unknown monitor', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await get(app, env, '/api/monitors/no-such-id/daily', auth)
    expect(res.status).toBe(404)
  })

  it('returns 90 days of data points', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/daily`, auth)
    const rows = await res.json() as { date: string; uptime: number | null }[]
    expect(rows).toHaveLength(90)
    expect(rows.every(r => r.date.match(/^\d{4}-\d{2}-\d{2}$/))).toBe(true)
  })

  it('aggregates daily uptime correctly', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    const todayMidnight = now - (now % 86400)

    await insertLog(db, id, 'up', todayMidnight + 100)
    await insertLog(db, id, 'up', todayMidnight + 200)
    await insertLog(db, id, 'up', todayMidnight + 300)
    await insertLog(db, id, 'down', todayMidnight + 400)

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/daily`, auth)
    const rows = await res.json() as { date: string; uptime: number | null }[]
    const today = new Date(now * 1000).toISOString().slice(0, 10)
    const todayRow = rows.find(r => r.date === today)
    expect(todayRow?.uptime).toBe(75)
  })
})

describe('/api/monitors/:id/incidents', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('returns incidents for the monitor ordered newest first', async () => {
    const { db, d1 } = ctx
    const id = await insertMonitor(db)
    const now = nowSecs()
    await db.insert(incidents).values({ id: crypto.randomUUID(), monitorId: id, startedAt: now - 3600 })
    await db.insert(incidents).values({ id: crypto.randomUUID(), monitorId: id, startedAt: now - 7200 })

    const { app, env } = buildApp(d1)
    const res = await get(app, env, `/api/monitors/${id}/incidents`, auth)
    const rows = await res.json() as { startedAt: number }[]
    expect(rows).toHaveLength(2)
    expect(rows[0].startedAt).toBeGreaterThan(rows[1].startedAt)
  })
})
