import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import infrastructureRouter from '../routes/infrastructure'
import { createTestDb, insertMonitor, makeAuthHeader, makeEnv } from './setup'

function snapshot(cpu: number, ram: number, disk: number, evaluatedAt: number): string {
  return JSON.stringify({
    cpu,
    ram,
    disk,
    docker: [],
    status: 'up',
    message: 'Agent metrics OK',
    evaluatedAt,
  })
}

describe('/api/infrastructure/overview', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string
  let app: Hono

  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
    app = new Hono()
    app.route('/api/infrastructure', infrastructureRouter)
  })

  it('summarizes fleet pressure and freshness without container data', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertMonitor(ctx.db, {
      name: 'Healthy node',
      type: 'agent',
      url: null,
      lastStatus: 'up',
      lastCheckedAt: now,
      cpuThreshold: 90,
      ramThreshold: 90,
      diskThreshold: 90,
      lastMetrics: snapshot(20, 30, 40, now),
    })
    await insertMonitor(ctx.db, {
      name: 'Pressure node',
      type: 'agent',
      url: null,
      lastStatus: 'up',
      lastCheckedAt: now,
      cpuThreshold: 90,
      lastMetrics: snapshot(80, 30, 40, now),
    })
    await insertMonitor(ctx.db, {
      name: 'Stale node',
      type: 'agent',
      url: null,
      lastStatus: 'up',
      lastCheckedAt: now - 600,
      lastMetrics: snapshot(10, 20, 30, now - 600),
    })

    const response = await app.fetch(new Request('http://localhost/api/infrastructure/overview', {
      headers: { Authorization: auth },
    }), makeEnv(ctx.d1))
    expect(response.status).toBe(200)
    const body = await response.json() as {
      summary: { total: number; reporting: number; pressure: number; stale: number }
      nodes: Array<{ name: string; state: string; docker?: unknown }>
      issues: Array<{ name: string }>
    }
    expect(body.summary).toEqual({
      total: 3,
      reporting: 2,
      pressure: 1,
      stale: 1,
    })
    expect(body.nodes.every((node) => node.docker === undefined)).toBe(true)
    expect(body.issues.map((node) => node.name)).toEqual(['Stale node', 'Pressure node'])
  })

  it('requires dashboard authentication', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/infrastructure/overview'),
      makeEnv(ctx.d1),
    )
    expect(response.status).toBe(401)
  })
})
