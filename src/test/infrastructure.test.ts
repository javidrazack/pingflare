import { beforeEach, describe, expect, it } from 'vitest'
import { Hono } from 'hono'
import infrastructureRouter from '../routes/infrastructure'
import { createTestDb, insertMonitor, makeAuthHeader, makeEnv } from './setup'

function snapshot(
  cpu: number,
  ram: number,
  disk: number,
  evaluatedAt: number,
  docker: Array<{ id: string; name: string; status: string; health?: string }> = [],
  status: 'up' | 'down' = 'up',
): string {
  return JSON.stringify({
    cpu,
    ram,
    disk,
    docker,
    status,
    message: status === 'up' ? 'Agent metrics OK' : 'Agent metrics need attention',
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
      nodes: Array<{
        name: string
        state: string
        docker?: unknown
        strongestSignal: { kind: string; severity: string; value?: number; threshold?: number; ageSeconds?: number; staleAfterSeconds?: number }
      }>
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
    expect(body.nodes.find((node) => node.name === 'Pressure node')?.strongestSignal).toEqual({
      kind: 'resource',
      severity: 'warning',
      resource: 'cpu',
      value: 80,
      threshold: 90,
    })
    const staleSignal = body.nodes.find((node) => node.name === 'Stale node')?.strongestSignal
    expect(staleSignal).toMatchObject({
      kind: 'stale',
      severity: 'critical',
      staleAfterSeconds: 180,
    })
    expect(staleSignal?.ageSeconds).toBeGreaterThanOrEqual(600)
  })

  it('returns the exact strongest critical resource or Docker signal', async () => {
    const now = Math.floor(Date.now() / 1000)
    await insertMonitor(ctx.db, {
      name: 'Hot node',
      type: 'agent',
      url: null,
      lastStatus: 'down',
      lastCheckedAt: now,
      cpuThreshold: 90,
      ramThreshold: 90,
      lastMetrics: snapshot(94, 92, 40, now, [], 'down'),
    })
    await insertMonitor(ctx.db, {
      name: 'Container node',
      type: 'agent',
      url: null,
      lastStatus: 'down',
      lastCheckedAt: now,
      lastMetrics: snapshot(20, 30, 40, now, [
        { id: 'web', name: 'web', status: 'running', health: 'unhealthy' },
        { id: 'jobs', name: 'jobs', status: 'exited' },
      ], 'down'),
    })

    const response = await app.fetch(new Request('http://localhost/api/infrastructure/overview', {
      headers: { Authorization: auth },
    }), makeEnv(ctx.d1))
    const body = await response.json() as {
      nodes: Array<{ name: string; strongestSignal: unknown; docker?: unknown }>
    }

    expect(body.nodes.find((node) => node.name === 'Hot node')?.strongestSignal).toEqual({
      kind: 'resource',
      severity: 'critical',
      resource: 'cpu',
      value: 94,
      threshold: 90,
    })
    expect(body.nodes.find((node) => node.name === 'Container node')?.strongestSignal).toEqual({
      kind: 'docker',
      severity: 'critical',
      containerName: 'jobs',
      containerStatus: 'exited',
      containerHealth: null,
      affectedContainers: 2,
    })
    expect(body.nodes.every((node) => node.docker === undefined)).toBe(true)
  })

  it('requires dashboard authentication', async () => {
    const response = await app.fetch(
      new Request('http://localhost/api/infrastructure/overview'),
      makeEnv(ctx.d1),
    )
    expect(response.status).toBe(401)
  })
})
