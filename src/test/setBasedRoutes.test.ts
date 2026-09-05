import { describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import incidentRoutes from '../routes/incidentReports'
import settingsRoutes from '../routes/settings'
import statusPageRoutes from '../routes/statusPages'
import {
  incidentMonitors,
  incidentReportEvents,
  incidents,
  monitors,
  settings,
  statusPageMonitors,
} from '../db/schema'
import { createTestDb, makeAuthHeader, makeEnv } from './setup'

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

async function apiRequest(
  app: Hono,
  env: ReturnType<typeof makeEnv>,
  path: string,
  auth: string,
  method: 'POST' | 'PUT',
  body: unknown,
) {
  return app.fetch(new Request(`http://localhost${path}`, {
    method,
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  }), env)
}

async function seedMonitors(
  db: Awaited<ReturnType<typeof createTestDb>>['db'],
  count: number,
): Promise<string[]> {
  const ids = Array.from(
    { length: count },
    (_, index) => `set-monitor-${String(index).padStart(3, '0')}`,
  )
  await db.insert(monitors).values(ids.map((id, index) => ({
    id,
    name: `Set Monitor ${index}`,
    type: 'http' as const,
    url: 'https://example.com',
  })))
  return ids
}

describe('set-based high-cardinality route writes', () => {
  it('creates and replaces incident links in bounded D1 queries', async () => {
    const ctx = await createTestDb()
    const monitorIds = await seedMonitors(ctx.db, 180)
    const now = Math.floor(Date.now() / 1000)
    const eventIds = Array.from(
      { length: 100 },
      (_, index) => `set-event-${String(index).padStart(3, '0')}`,
    )
    await ctx.db.insert(incidents).values(eventIds.map((id, index) => ({
      id,
      monitorId: monitorIds[index],
      startedAt: now - index,
      resolvedAt: now,
      durationSeconds: index,
    })))
    const tracked = trackPreparedStatements(ctx.d1)
    const env = makeEnv(tracked.d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/incidents', incidentRoutes)

    const createdResponse = await apiRequest(
      app,
      env,
      '/api/incidents',
      auth,
      'POST',
      {
        title: 'Large incident',
        status: 'investigating',
        monitorIds,
        eventIds,
      },
    )
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string }
    expect(await ctx.db.select().from(incidentMonitors)
      .where(eq(incidentMonitors.incidentId, created.id))).toHaveLength(180)
    expect(await ctx.db.select().from(incidentReportEvents)
      .where(eq(incidentReportEvents.incidentId, created.id))).toHaveLength(100)
    expect(tracked.statements.length).toBeLessThan(10)

    tracked.statements.length = 0
    const updatedResponse = await apiRequest(
      app,
      env,
      `/api/incidents/${created.id}`,
      auth,
      'PUT',
      {
        title: 'Updated large incident',
        monitorIds: [...monitorIds].reverse(),
        eventIds: [...eventIds].reverse(),
      },
    )
    expect(updatedResponse.status).toBe(200)
    expect(await ctx.db.select().from(incidentMonitors)
      .where(eq(incidentMonitors.incidentId, created.id))).toHaveLength(180)
    expect(await ctx.db.select().from(incidentReportEvents)
      .where(eq(incidentReportEvents.incidentId, created.id))).toHaveLength(100)
    expect(tracked.statements.length).toBeLessThan(10)
  })

  it('preserves ordering for 180 status-page monitors with bounded queries', async () => {
    const ctx = await createTestDb()
    const monitorIds = await seedMonitors(ctx.db, 180)
    const tracked = trackPreparedStatements(ctx.d1)
    const env = makeEnv(tracked.d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/status-pages', statusPageRoutes)

    const createdResponse = await apiRequest(
      app,
      env,
      '/api/status-pages',
      auth,
      'POST',
      {
        name: 'Large status page',
        slug: 'large-status-page',
        monitorIds,
      },
    )
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as { id: string }
    let links = await ctx.db.select().from(statusPageMonitors)
      .where(eq(statusPageMonitors.pageId, created.id))
      .orderBy(asc(statusPageMonitors.sortOrder))
    expect(links.map((link) => link.monitorId)).toEqual(monitorIds)
    expect(tracked.statements.length).toBeLessThan(6)

    tracked.statements.length = 0
    const reversed = [...monitorIds].reverse()
    const updatedResponse = await apiRequest(
      app,
      env,
      `/api/status-pages/${created.id}`,
      auth,
      'PUT',
      { monitorIds: reversed },
    )
    expect(updatedResponse.status).toBe(200)
    links = await ctx.db.select().from(statusPageMonitors)
      .where(eq(statusPageMonitors.pageId, created.id))
      .orderBy(asc(statusPageMonitors.sortOrder))
    expect(links.map((link) => link.monitorId)).toEqual(reversed)
    expect(tracked.statements.length).toBeLessThan(8)
  })

  it('upserts 100 settings in one statement and rejects larger requests', async () => {
    const ctx = await createTestDb()
    const tracked = trackPreparedStatements(ctx.d1)
    const env = makeEnv(tracked.d1)
    const auth = await makeAuthHeader()
    const app = new Hono()
    app.route('/api/settings', settingsRoutes)
    const initialSettings = await ctx.db.select().from(settings)
    const values = Object.fromEntries(Array.from(
      { length: 100 },
      (_, index) => [`setting-${index}`, `value-${index}`],
    ))

    const response = await apiRequest(
      app,
      env,
      '/api/settings',
      auth,
      'PUT',
      values,
    )
    expect(response.status).toBe(200)
    expect(await ctx.db.select().from(settings))
      .toHaveLength(initialSettings.length + 100)
    expect(tracked.statements.length).toBe(3) // includes session revocation lookup

    tracked.statements.length = 0
    const tooMany = { ...values, overflow: 'rejected' }
    const rejected = await apiRequest(
      app,
      env,
      '/api/settings',
      auth,
      'PUT',
      tooMany,
    )
    expect(rejected.status).toBe(400)
    expect(tracked.statements).toHaveLength(1) // authentication only
  })
})
