import { describe, it, expect, beforeEach } from 'vitest'
import { Hono } from 'hono'
import { createTestDb, makeEnv, insertMonitor } from './setup'
import publicStatusRouter from '../routes/publicStatus'
import { statusLogs, statusPages, statusPageMonitors } from '../db/schema'

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

async function insertPage(db: ReturnType<typeof import('../db').getDb>, slug: string, monitorIds: string[] = []) {
  const pageId = crypto.randomUUID()
  await db.insert(statusPages).values({ id: pageId, name: 'Test Page', slug })
  for (let i = 0; i < monitorIds.length; i++) {
    await db.insert(statusPageMonitors).values({ pageId, monitorId: monitorIds[i], sortOrder: i })
  }
  return pageId
}

async function insertLog(
  db: ReturnType<typeof import('../db').getDb>,
  monitorId: string,
  status: 'up' | 'down',
  checkedAt: number,
) {
  await db.insert(statusLogs).values({
    id: crypto.randomUUID(),
    monitorId,
    status,
    checkedAt,
    message: status,
  })
}

describe('GET /api/public/status/:slug', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    ctx = await createTestDb()
  })

  it('returns 404 for unknown slug', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await getSlug(app, env, 'no-such-page')
    expect(res.status).toBe(404)
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

    await insertLog(db, monId, 'up', now - 60)
    await insertLog(db, monId, 'up', now - 120)
    await insertLog(db, monId, 'down', now - 180)

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

    await insertLog(db, monId, 'up', todayMidnight + 100)
    await insertLog(db, monId, 'up', todayMidnight + 200)
    await insertLog(db, monId, 'up', todayMidnight + 300)
    await insertLog(db, monId, 'down', todayMidnight + 400)

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
    expect(res.headers.get('Cache-Control')).toContain('max-age=30')
    expect(res.headers.get('Cache-Control')).toContain('stale-while-revalidate')
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
  })
})

describe('GET /api/public/status/:slug/monitors/:monitorId', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
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
    expect(res.headers.get('Cache-Control')).toContain('max-age=30')
  })

  it('returns 90 daily data points for the monitor', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)
    await insertPage(db, 'ninety-page', [monId])

    const { app, env } = buildApp(d1)
    const res = await app.fetch(
      new Request(`http://localhost/api/public/status/ninety-page/monitors/${monId}`),
      env,
    )
    const body = await res.json() as { daily: unknown[] }
    expect(body.daily).toHaveLength(90)
  })
})
