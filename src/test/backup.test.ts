import { describe, it, expect, beforeEach, vi } from 'vitest'
import { Hono } from 'hono'
import { createTestDb, makeEnv, makeAuthHeader, insertMonitor } from './setup'
import backupRouter from '../routes/backup'
import { getDb, monitors, notificationChannels, settings, statusPages } from '../db'

function buildApp(d1: D1Database) {
  const env = makeEnv(d1)
  const app = new Hono()
  app.route('/api/backup', backupRouter)
  return { app, env }
}

async function doGet(app: Hono, env: ReturnType<typeof makeEnv>, auth: string) {
  const req = new Request('http://localhost/api/backup', {
    headers: { Authorization: auth },
  })
  return app.fetch(req, env)
}

async function doRestore(app: Hono, env: ReturnType<typeof makeEnv>, auth: string, body: unknown) {
  const payload = JSON.stringify(body)
  const req = new Request('http://localhost/api/backup/restore', {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'Content-Length': String(new TextEncoder().encode(payload).length),
    },
    body: payload,
  })
  return app.fetch(req, env)
}

describe('GET /api/backup', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('returns 401 without auth', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await app.fetch(new Request('http://localhost/api/backup'), env)
    expect(res.status).toBe(401)
  })

  it('exports all data with version 3', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db, { name: 'My Monitor' })

    const { app, env } = buildApp(d1)
    const res = await doGet(app, env, auth)
    expect(res.status).toBe(200)

    const data = await res.json() as Record<string, unknown>
    expect(data.version).toBe(3)
    expect(Array.isArray(data.monitors)).toBe(true)
    expect((data.monitors as unknown[]).length).toBe(1)
  })
})

describe('POST /api/backup/restore', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
  })

  it('rejects wrong backup version', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await doRestore(app, env, auth, { version: 99 })
    expect(res.status).toBe(400)
  })

  it('rejects invalid JSON', async () => {
    const { app, env } = buildApp(ctx.d1)
    const req = new Request('http://localhost/api/backup/restore', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': '3' },
      body: 'bad',
    })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(400)
  })

  it('rejects oversized payload via Content-Length', async () => {
    const { app, env } = buildApp(ctx.d1)
    const req = new Request('http://localhost/api/backup/restore', {
      method: 'POST',
      headers: {
        Authorization: auth,
        'Content-Type': 'application/json',
        'Content-Length': String(600 * 1024),
      },
      body: '{}',
    })
    const res = await app.fetch(req, env)
    expect(res.status).toBe(413)
  })

  it('rejects invalid field types', async () => {
    const { app, env } = buildApp(ctx.d1)
    const res = await doRestore(app, env, auth, { version: 1, monitors: 'not-an-array' })
    expect(res.status).toBe(400)
  })

  it('restores monitors from a valid backup', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db, { name: 'Original' })

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json()

    // Wipe and restore
    await doRestore(app, env, auth, backup)

    const restored = await db.select().from(monitors)
    expect(restored).toHaveLength(1)
    expect(restored[0].name).toBe('Original')
    expect(restored[0].lastCheckedAt).toBeNull()
    expect(restored[0].lastStatus).toBe('pending')
  })

  it('restores settings correctly', async () => {
    const { db, d1 } = ctx
    await db.insert(settings).values({ key: 'custom_key', value: 'custom_value' }).onConflictDoUpdate({ target: settings.key, set: { value: 'custom_value' } })

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json() as Record<string, unknown>
    expect((backup.settings as Record<string, string>).custom_key).toBe('custom_value')

    await doRestore(app, env, auth, backup)

    const restoredSettings = await db.select().from(settings)
    const customSetting = restoredSettings.find(s => s.key === 'custom_key')
    expect(customSetting?.value).toBe('custom_value')
  })

  it('restores notification channels and monitor-channel links', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db, { name: 'Linked Monitor' })
    const channelId = crypto.randomUUID()
    await db.insert(notificationChannels).values({
      id: channelId,
      name: 'My Channel',
      type: 'webhook',
      config: '{"url":"https://hook.example.com"}',
      active: true,
      isDefault: false,
    })
    const { monitorNotifications } = await import('../db/schema')
    await db.insert(monitorNotifications).values({ monitorId: monId, channelId })

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json() as Record<string, unknown>

    const monitorsData = backup.monitors as Array<Record<string, unknown>>
    expect(monitorsData[0].channelIds).toContain(channelId)

    await doRestore(app, env, auth, backup)

    const channels = await db.select().from(notificationChannels)
    expect(channels).toHaveLength(1)
    expect(channels[0].id).toBe(channelId)
  })

  it('restores status pages with monitor links', async () => {
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)
    const pageId = crypto.randomUUID()
    const { statusPages: sp, statusPageMonitors: spm } = await import('../db/schema')
    await db.insert(sp).values({ id: pageId, name: 'My Page', slug: 'my-page' })
    await db.insert(spm).values({ pageId, monitorId: monId, sortOrder: 0 })

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json()

    await doRestore(app, env, auth, backup)

    const pages = await db.select().from(statusPages)
    expect(pages).toHaveLength(1)
    expect(pages[0].slug).toBe('my-page')
  })

  it('is idempotent — restoring the same backup twice yields the same state', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db, { name: 'Idempotent' })

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json()

    await doRestore(app, env, auth, backup)
    const res2 = await doRestore(app, env, auth, backup)
    expect(res2.status).toBe(200)

    const mons = await db.select().from(monitors)
    expect(mons).toHaveLength(1)
    expect(mons[0].name).toBe('Idempotent')
  })

  it('restores many monitors with a fixed number of D1 statements', async () => {
    const { db, d1 } = ctx
    for (let index = 0; index < 30; index += 1) {
      await insertMonitor(db, { name: `Monitor ${index}` })
    }

    const { app, env } = buildApp(d1)
    const exportRes = await doGet(app, env, auth)
    const backup = await exportRes.json()
    const batchSpy = vi.spyOn(d1, 'batch')

    const restoreRes = await doRestore(app, env, auth, backup)

    expect(restoreRes.status).toBe(200)
    expect(batchSpy).toHaveBeenCalledTimes(1)
    expect(batchSpy.mock.calls[0][0]).toHaveLength(13)
    expect(await db.select().from(monitors)).toHaveLength(30)
  })

  it('rejects a restore before an oversized history cascade mutates data', async () => {
    const { db, d1 } = ctx
    const monitorId = await insertMonitor(db, { name: 'Retained monitor' })
    await d1.prepare(`
      WITH
      digit(value) AS (
        VALUES (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)
      ),
      sequence(value) AS (
        SELECT
          1 + one.value + 10 * ten.value + 100 * hundred.value
          + 1000 * thousand.value + 10000 * ten_thousand.value
        FROM digit AS one
        CROSS JOIN digit AS ten
        CROSS JOIN digit AS hundred
        CROSS JOIN digit AS thousand
        CROSS JOIN digit AS ten_thousand
        ORDER BY 1
        LIMIT 10001
      )
      INSERT INTO status_logs (id, monitor_id, status, checked_at, source)
      SELECT 'restore-budget-' || value, ?, 'up', value, 'cron'
      FROM sequence
    `).bind(monitorId).run()

    const { app, env } = buildApp(d1)
    const backup = await (await doGet(app, env, auth)).json()
    const restore = await doRestore(app, env, auth, backup)

    expect(restore.status).toBe(409)
    expect(await restore.json()).toMatchObject({
      code: 'D1_DESTRUCTIVE_WRITE_BUDGET_EXCEEDED',
    })
    expect(await db.select().from(monitors)).toHaveLength(1)
    expect((await d1.prepare(
      'SELECT COUNT(*) AS count FROM status_logs WHERE monitor_id = ?',
    ).bind(monitorId).first<{ count: number }>())?.count).toBe(10001)
  })
})
