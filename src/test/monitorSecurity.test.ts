import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import monitorRoutes from '../routes/monitors'
import { checkHttp } from '../services/checker'
import {
  createTestDb,
  ENCRYPTION_KEY,
  insertMonitor,
  makeAuthHeader,
  makeEnv,
} from './setup'
import { monitors } from '../db/schema'

describe('monitor credential protection', () => {
  it('encrypts credentials, redacts API responses, preserves blank edits, and decrypts for checks', async () => {
    const { d1, db } = await createTestDb()
    const env = makeEnv(d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/monitors', monitorRoutes)

    const createResponse = await app.fetch(new Request('http://localhost/api/monitors', {
      method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Protected monitor',
        type: 'http',
        url: 'https://example.com',
        authType: 'basic',
        authUsername: 'api-user',
        authPassword: 'api-password',
      }),
    }), env)
    expect(createResponse.status).toBe(201)
    const created = await createResponse.json() as { id: string; authPassword: string | null }
    expect(created.authPassword).toBeNull()

    const [stored] = await db.select().from(monitors).where(eq(monitors.id, created.id))
    expect(stored.authPassword).toMatch(/^enc:/)

    const updateResponse = await app.fetch(new Request(`http://localhost/api/monitors/${created.id}`, {
      method: 'PUT',
      headers: { Authorization: auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ authType: 'basic', authPassword: '' }),
    }), env)
    expect(updateResponse.status).toBe(200)
    const [afterUpdate] = await db.select().from(monitors).where(eq(monitors.id, created.id))
    expect(afterUpdate.authPassword).toBe(stored.authPassword)

    const fetchMock = vi.fn().mockResolvedValue(new Response('', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const result = await checkHttp(afterUpdate, 'en', ENCRYPTION_KEY)
    expect(result.status).toBe('up')
    const requestInit = fetchMock.mock.calls[0][1] as RequestInit
    expect((requestInit.headers as Record<string, string>).Authorization)
      .toBe(`Basic ${btoa('api-user:api-password')}`)
    vi.unstubAllGlobals()
  })
})

describe('monitor scheduling edits', () => {
  it('recomputes the due cursor and invalidates in-flight observations', async () => {
    const { d1, db } = await createTestDb()
    const env = makeEnv(d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/monitors', monitorRoutes)
    const lastCheckedAt = 1_800_000_000
    const id = await insertMonitor(db, {
      interval: 86400,
      lastCheckedAt,
      nextCheckAt: lastCheckedAt + 86400,
      observationRevision: 'before-edit',
    })

    const updateResponse = await app.fetch(new Request(
      `http://localhost/api/monitors/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ interval: 60 }),
      },
    ), env)
    expect(updateResponse.status).toBe(200)
    let [updated] = await db.select().from(monitors).where(eq(monitors.id, id))
    expect(updated.nextCheckAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
    expect(updated.observationRevision).not.toBe('before-edit')
    const revisionAfterEdit = updated.observationRevision

    await db.update(monitors)
      .set({ nextCheckAt: Math.floor(Date.now() / 1000) + 86400 })
      .where(eq(monitors.id, id))
    const targetUpdateResponse = await app.fetch(new Request(
      `http://localhost/api/monitors/${id}`,
      {
        method: 'PUT',
        headers: { Authorization: auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: 'https://new-target.example.com' }),
      },
    ), env)
    expect(targetUpdateResponse.status).toBe(200)
    ;[updated] = await db.select().from(monitors).where(eq(monitors.id, id))
    expect(updated.url).toBe('https://new-target.example.com')
    expect(updated.nextCheckAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))

    const resetResponse = await app.fetch(new Request(
      `http://localhost/api/monitors/${id}/reset-stats`,
      {
        method: 'POST',
        headers: { Authorization: auth },
      },
    ), env)
    expect(resetResponse.status).toBe(200)
    ;[updated] = await db.select().from(monitors).where(eq(monitors.id, id))
    expect(updated).toMatchObject({
      lastStatus: 'pending',
      lastCheckedAt: null,
      nextCheckAt: 0,
    })
    expect(updated.observationRevision).not.toBe(revisionAfterEdit)
  })

  it('rejects destructive history cascades before they exceed the D1 write envelope', async () => {
    const { d1, db } = await createTestDb()
    const env = makeEnv(d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/monitors', monitorRoutes)
    const id = await insertMonitor(db)
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
      SELECT 'destructive-budget-' || value, ?, 'up', value, 'cron'
      FROM sequence
    `).bind(id).run()

    const deleteResponse = await app.fetch(new Request(
      `http://localhost/api/monitors/${id}`,
      { method: 'DELETE', headers: { Authorization: auth } },
    ), env)
    expect(deleteResponse.status).toBe(409)
    expect(await deleteResponse.json()).toMatchObject({
      code: 'D1_DESTRUCTIVE_WRITE_BUDGET_EXCEEDED',
    })

    const resetResponse = await app.fetch(new Request(
      `http://localhost/api/monitors/${id}/reset-stats`,
      { method: 'POST', headers: { Authorization: auth } },
    ), env)
    expect(resetResponse.status).toBe(409)
    expect(await db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })).toBeDefined()
    expect((await d1.prepare(
      'SELECT COUNT(*) AS count FROM status_logs WHERE monitor_id = ?',
    ).bind(id).first<{ count: number }>())?.count).toBe(10001)
  })
})
