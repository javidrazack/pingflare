import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, makeEnv, insertMonitor } from './setup'
import { heartbeatTokens, monitorDailyRollups, monitors, settings, statusLogs } from '../db/schema'

vi.mock('../services/checker', () => ({
  checkHttp: vi.fn().mockResolvedValue({ status: 'up', statusCode: 200, responseTimeMs: 42, message: 'OK' }),
  checkDns: vi.fn().mockResolvedValue({ status: 'up', responseTimeMs: 10, message: 'DNS OK (1 record)' }),
}))
vi.mock('../services/heartbeat-checker', () => ({
  checkHeartbeat: vi.fn().mockReturnValue({ status: 'up', message: 'Heartbeat received', logKey: undefined }),
}))
vi.mock('../services/alert-manager', () => ({
  processAlert: vi.fn().mockResolvedValue(undefined),
  getLocale: vi.fn().mockResolvedValue('en'),
}))
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  text: () => Promise.resolve('colo=GRU\nloc=BR\nip=1.2.3.4\n'),
}))

describe('cron — due selection', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    vi.clearAllMocks()
    ctx = await createTestDb()
  })

  it('checks monitors with no lastCheckedAt', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db)

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('up')
  })

  it('skips monitors checked within their interval', async () => {
    const { db, d1 } = ctx
    const now = Math.floor(Date.now() / 1000)
    await insertMonitor(db, { lastCheckedAt: now - 10, interval: 60 })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(0)
  })

  it('checks monitors whose interval has elapsed', async () => {
    const { db, d1 } = ctx
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(db, { lastCheckedAt: now - 90, interval: 60 })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].monitorId).toBe(id)
  })

  it('does not check inactive monitors', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db, { active: false })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(0)
  })

  it('skips an overlapping invocation while the scheduler lease is held', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db)
    const now = Math.floor(Date.now() / 1000)
    await d1.prepare(`
      INSERT INTO scheduler_leases (name, holder, lease_until, updated_at)
      VALUES ('monitor-cron', 'other-run', ?, ?)
    `).bind(now + 60, now).run()

    const { runCron } = await import('../cron')
    const result = await runCron(makeEnv(d1))

    expect(result.skippedBecauseLeased).toBe(true)
    expect(await db.select().from(statusLogs)).toHaveLength(0)
  })

  it('catches up writes made by the legacy Worker between migration and deploy', async () => {
    const { db, d1 } = ctx
    const monitorId = await insertMonitor(db)
    const checkedAt = Math.floor(Date.now() / 1000) - 30
    await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_catchup_v1'))
    await db.insert(statusLogs).values({
      id: crypto.randomUUID(),
      monitorId,
      status: 'up',
      checkedAt,
      responseTimeMs: 25,
      source: null,
    })

    const { runCron } = await import('../cron')
    const result = await runCron(makeEnv(d1))

    expect(result.checked).toBe(0)
    const [legacyLog] = await db.select().from(statusLogs)
      .where(eq(statusLogs.monitorId, monitorId))
    expect(legacyLog.source).toBe('legacy')
    const [rollup] = await db.select().from(monitorDailyRollups)
      .where(eq(monitorDailyRollups.monitorId, monitorId))
    expect(rollup.checks).toBe(1)
    expect(rollup.upCount).toBe(1)
  })
})

describe('cron — batch insert and concurrency', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    vi.clearAllMocks()
    ctx = await createTestDb()
  })

  it('drains a large due set across query-budgeted runs', async () => {
    const { db, d1 } = ctx
    const count = 25
    const ids: string[] = []
    for (let i = 0; i < count; i++) {
      ids.push(await insertMonitor(db))
    }

    const { runCron } = await import('../cron')
    const env = makeEnv(d1)
    await runCron(env)
    await runCron(env)
    await runCron(env)
    await runCron(env)
    await runCron(env)

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(count)
    expect(new Set(logs.map(l => l.monitorId))).toEqual(new Set(ids))
  })

  it('handles mixed http and heartbeat monitors in the same run', async () => {
    const { db, d1 } = ctx
    const httpId = await insertMonitor(db, { type: 'http', url: 'https://example.com' })
    const hbId = await insertMonitor(db, { type: 'heartbeat', heartbeatInterval: 60 })
    await db.insert(heartbeatTokens).values({
      monitorId: hbId,
      token: crypto.randomUUID(),
      lastPingAt: Math.floor(Date.now() / 1000) - 10,
    })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(2)
    expect(new Set(logs.map(l => l.monitorId))).toEqual(new Set([httpId, hbId]))
  })

  it('handles dns monitor and writes up log', async () => {
    const { db, d1 } = ctx
    const dnsId = await insertMonitor(db, {
      type: 'dns',
      dnsHostname: 'example.com',
      dnsRecordType: 'A',
      dnsResolverUrl: 'https://freedns.controld.com/p0',
    })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].monitorId).toBe(dnsId)
    expect(logs[0].status).toBe('up')
    expect(logs[0].message).toBe('DNS OK (1 record)')
  })
})

describe('cron — CRIT-4: scheduling cursor always advances', () => {
  it('updates lastCheckedAt even when processAlert throws', async () => {
    const { processAlert } = await import('../services/alert-manager')
    vi.mocked(processAlert).mockRejectedValueOnce(new Error('simulated DB throttle'))

    const ctx = await createTestDb()
    const { db, d1 } = ctx
    const monId = await insertMonitor(db)

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const [mon] = await db.select().from(monitors).where(eq(monitors.id, monId))
    expect(mon.lastCheckedAt).not.toBeNull()
    expect(mon.lastCheckedAt).toBeGreaterThan(0)

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
  })
})

describe('cron — down status and internal errors', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    vi.clearAllMocks()
    ctx = await createTestDb()
  })

  it('writes a down log when checkHttp returns down', async () => {
    const { checkHttp } = await import('../services/checker')
    vi.mocked(checkHttp).mockResolvedValueOnce({ status: 'down', responseTimeMs: 0, message: 'Timeout' })

    const { db, d1 } = ctx
    await insertMonitor(db)

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].status).toBe('down')
    expect(logs[0].message).toBe('Timeout')
  })

  it('writes an error log and continues when checkHttp throws', async () => {
    const { checkHttp } = await import('../services/checker')
    vi.mocked(checkHttp).mockRejectedValueOnce(new Error('Connection refused'))

    const { db, d1 } = ctx
    const failId = await insertMonitor(db)
    const okId = await insertMonitor(db)

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(2)
    const failLog = logs.find(l => l.monitorId === failId)
    const okLog = logs.find(l => l.monitorId === okId)
    expect(failLog?.status).toBe('down')
    expect(failLog?.message).toContain('Internal error')
    expect(okLog?.status).toBe('up')
  })
})
