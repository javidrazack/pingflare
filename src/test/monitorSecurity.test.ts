import { describe, expect, it, vi } from 'vitest'
import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import monitorRoutes from '../routes/monitors'
import { checkHttp } from '../services/checker'
import { createTestDb, ENCRYPTION_KEY, makeAuthHeader, makeEnv } from './setup'
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
