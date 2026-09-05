import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }))
import worker from '../index'
import { createTestDb, insertMonitor, makeAuthHeader, makeEnv } from './setup'
import { displayStatus } from '../services/monitor-freshness'
import { createLocalRateLimiter } from '../services/local-rate-limiter'

describe('operational controls', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string
  beforeEach(async () => { ctx = await createTestDb(); auth = await makeAuthHeader() })
  afterEach(() => { ctx.raw.close(); vi.useRealTimers() })
  function request(path: string, method = 'GET', body?: unknown, authorization = auth) {
    return worker.fetch(new Request(`http://localhost/api${path}`, {
      method, headers: { Authorization: authorization, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), makeEnv(ctx.d1))
  }

  it('reports actual schedule demand and overdue checks without modifying monitors', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertMonitor(ctx.db, { interval: 60, nextCheckAt: now - 300 })
    await insertMonitor(ctx.db, { interval: 300, nextCheckAt: now + 300 })
    await insertMonitor(ctx.db, { type: 'agent', heartbeatInterval: 60, nextCheckAt: now + 60 })
    await insertMonitor(ctx.db, { active: false, interval: 60 })
    const response = await request('/operations')
    expect(response.status).toBe(200)
    const data = await response.json() as any
    expect(data).toMatchObject({ active: 3, total: 4, overdue: 1, scheduledPerMinute: 1.2, inboundPerMinute: 1 })
    expect(data.scheduler.stale).toBe(true)
    expect((await request('/operations', 'GET', undefined, '')).status).toBe(401)
  })

  it('bounds dashboard payloads, separates stale from pending, and orders the uptime watchlist', async () => {
    const now = Math.floor(Date.now() / 1000)
    const day = now - now % 86400
    for (let i = 0; i < 23; i++) await insertMonitor(ctx.db, {
      name: `Overdue ${i}`, lastStatus: 'up', lastCheckedAt: now - 600, nextCheckAt: now - 500,
      headers: JSON.stringify({ Authorization: 'must-not-appear' }),
    })
    await insertMonitor(ctx.db, { name: 'Pending' })
    await insertMonitor(ctx.db, { name: 'Paused', active: false, lastStatus: 'down' })
    for (let i = 0; i < 7; i++) await insertMonitor(ctx.db, {
      name: `Healthy ${i}`, lastStatus: 'up', lastCheckedAt: now, nextCheckAt: now + 60,
      statsDay: day, dayChecks: 100, dayUpCount: 90 + i,
    })
    const dashboard = await (await request('/operations/dashboard')).json() as any
    expect(dashboard.summary).toEqual({ total: 32, up: 7, down: 0, pending: 1, stale: 23 })
    expect(dashboard.items).toHaveLength(20)
    expect(JSON.stringify(dashboard)).not.toContain('must-not-appear')
    const watch = await (await request('/operations/watchlist')).json() as any
    expect(watch.items).toHaveLength(5)
    expect(watch.items.map((m: any) => m.uptime)).toEqual([90, 91, 92, 93, 94])
    expect(watch.items[0].active).toBe(true)
  })

  it('atomically schedules bounded repeats and rejects invalid occurrences', async () => {
    const id = await insertMonitor(ctx.db)
    const now = Math.floor(Date.now() / 1000)
    const occurrences = [0, 7].map(day => ({ startAt: now + 60 + day * 86400, endAt: now + 3600 + day * 86400 }))
    const body = { ...occurrences[0], reason: 'Updates', occurrences }
    expect((await request(`/monitors/${id}/maintenance`, 'POST', body)).status).toBe(200)
    const windows = await (await request(`/monitors/${id}/maintenance`)).json() as any[]
    expect(windows).toHaveLength(2)
    expect((await request(`/monitors/${id}/maintenance`, 'POST', { ...body, occurrences: [...occurrences, { startAt: now, endAt: now - 1 }] })).status).toBe(400)
    expect(await (await request(`/monitors/${id}/maintenance`)).json()).toHaveLength(2)
    await request(`/monitors/${id}/maintenance/${windows[0].id}`, 'DELETE')
    expect(await (await request(`/monitors/${id}/maintenance`)).json()).toHaveLength(1)
  })

  it('searches literal underscores, percent signs and backslashes', async () => {
    await insertMonitor(ctx.db, { name: 'api_prod%\\node' })
    await insertMonitor(ctx.db, { name: 'apiXprod' })
    for (const search of ['api_prod', '%', '\\']) {
      const response = await request(`/monitors?page=1&search=${encodeURIComponent(search)}`)
      expect(response.status).toBe(200)
      expect((await response.json() as any).items).toHaveLength(1)
    }
  })

  it('revokes on logout, does not extend refresh, and invalidates on password changes', async () => {
    const refreshed = await request('/auth/refresh', 'POST')
    expect((await refreshed.json() as any).token).toBe(auth.slice(7))
    const changed = await worker.fetch(new Request('http://localhost/api/operations', {
      headers: { Authorization: auth },
    }), { ...makeEnv(ctx.d1), ADMIN_PASS: 'changed-password' })
    expect(changed.status).toBe(401)
    expect((await request('/auth/logout', 'POST')).status).toBe(200)
    expect((await request('/operations')).status).toBe(401)
    expect((await request('/auth/refresh', 'POST')).status).toBe(401)
  })

  it('expires sessions and preserves the distinction between a database outage and invalid credentials', async () => {
    const env = makeEnv(ctx.d1)
    const prepare = vi.spyOn(env.DB, 'prepare').mockImplementationOnce(() => { throw new Error('DB unavailable') })
    const response = await worker.fetch(new Request('http://localhost/api/operations', { headers: { Authorization: auth } }), env)
    expect(response.status).toBe(503)
    prepare.mockRestore()
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 25 * 3600_000)
    expect((await request('/auth/refresh', 'POST')).status).toBe(401)
  })

  it('retains only 200 provider receipts and does not retry in-flight work', async () => {
    const id = await insertMonitor(ctx.db, { name: 'API' })
    ctx.raw.prepare("INSERT INTO notification_channels (id, name, type) VALUES ('channel', 'Email', 'email')").run()
    ctx.raw.prepare(`INSERT INTO notification_deliveries
      (id, dedupe_key, monitor_id, event_type, payload, remaining_channel_ids, next_attempt_at)
      VALUES ('delivery', 'test', ?, 'alert', '{}', '["channel"]', 1)`).run(id)
    const update = ctx.raw.prepare('UPDATE notification_deliveries SET delivered_count = delivered_count + 1, updated_at = ? WHERE id = ?')
    for (let i = 0; i < 205; i++) update.run(100 + i, 'delivery')
    expect(ctx.raw.prepare('SELECT COUNT(*) AS n FROM delivery_receipts').get()).toEqual({ n: 200 })
    const inbox = await (await request('/operations/deliveries')).json() as any
    expect(inbox.receipts).toHaveLength(50)
    expect(inbox.receipts[0]).toMatchObject({ monitorName: 'API', channelName: 'Email', deliveredAt: 304 })
    const now = Math.floor(Date.now() / 1000)
    ctx.raw.prepare('UPDATE notification_deliveries SET claim_until = ?, next_attempt_at = ?').run(now + 60, now + 600)
    expect((await (await request('/operations/deliveries/delivery/retry', 'POST')).json() as any).changed).toBe(false)
    ctx.raw.prepare('UPDATE notification_deliveries SET claim_until = NULL').run()
    expect((await (await request('/operations/deliveries/delivery/retry', 'POST')).json() as any).changed).toBe(true)
  })
})

describe('freshness and local limits', () => {
  it('never classifies paused, pending or overdue checks as healthy', () => {
    const m = { active: true, lastStatus: 'up' as const, lastCheckedAt: 100, nextCheckAt: 160 }
    expect(displayStatus(m, 180)).toBe('up')
    expect(displayStatus(m, 251)).toBe('stale')
    expect(displayStatus({ ...m, active: false }, 251)).toBe('paused')
    expect(displayStatus({ ...m, lastCheckedAt: null }, 251)).toBe('pending')
  })
  it('bounds unique keys without evicting live limits and frees expired capacity', async () => {
    vi.useFakeTimers()
    const limiter = createLocalRateLimiter(1, 2)
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'b' })).toEqual({ success: true })
    expect(await limiter.limit({ key: 'c' })).toEqual({ success: false })
    expect(await limiter.limit({ key: 'a' })).toEqual({ success: false })
    vi.advanceTimersByTime(60_001)
    expect(await limiter.limit({ key: 'c' })).toEqual({ success: true })
    vi.useRealTimers()
  })
})
