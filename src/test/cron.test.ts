import { describe, it, expect, beforeEach, vi } from 'vitest'
import { and, eq } from 'drizzle-orm'
import { createTestDb, makeEnv, insertMonitor } from './setup'
import { heartbeatTokens, monitorDailyRollups, monitors, settings, statusLogs } from '../db/schema'
import { persistCheckObservations } from '../services/check-storage'

vi.mock('../services/checker', () => ({
  MAX_CHECK_DEADLINE_MS: 60_000,
  checkHttp: vi.fn().mockResolvedValue({ status: 'up', statusCode: 200, responseTimeMs: 42, message: 'OK' }),
  checkDns: vi.fn().mockResolvedValue({ status: 'up', responseTimeMs: 10, message: 'DNS OK (1 record)' }),
}))
vi.mock('../services/heartbeat-checker', () => ({
  checkHeartbeat: vi.fn().mockReturnValue({ status: 'up', message: 'Heartbeat received', logKey: undefined }),
}))
vi.mock('../services/alert-manager', () => ({
  MAX_NOTIFICATION_DRAIN_D1_QUERIES: 13,
  MIN_NOTIFICATION_DRAIN_D1_QUERIES: 7,
  processAlert: vi.fn().mockResolvedValue(undefined),
  drainNotificationDeliveries: vi.fn().mockResolvedValue(undefined),
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
    await insertMonitor(db, {
      lastCheckedAt: now - 10,
      nextCheckAt: now + 50,
      interval: 60,
    })

    const { runCron } = await import('../cron')
    await runCron(makeEnv(d1))

    const logs = await db.select().from(statusLogs)
    expect(logs).toHaveLength(0)
    const { drainNotificationDeliveries } = await import('../services/alert-manager')
    expect(drainNotificationDeliveries).toHaveBeenCalledOnce()
  })

  it('checks monitors whose interval has elapsed', async () => {
    const { db, d1 } = ctx
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(db, {
      lastCheckedAt: now - 90,
      nextCheckAt: now - 30,
      interval: 60,
    })

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

    // A bounded reconciliation batch must not suspend routine monitoring.
    expect(result.checked).toBe(1)
    const [legacyLog] = await db.select().from(statusLogs)
      .where(and(
        eq(statusLogs.monitorId, monitorId),
        eq(statusLogs.source, 'legacy'),
      ))
    expect(legacyLog.source).toBe('legacy')
    const [rollup] = await db.select().from(monitorDailyRollups)
      .where(eq(monitorDailyRollups.monitorId, monitorId))
    expect(rollup.checks).toBe(1)
    expect(rollup.upCount).toBe(1)
  })

  it('continues monitoring during the explicit empty catch-up pass', async () => {
    const { db, d1 } = ctx
    await insertMonitor(db)
    await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_catchup_v1'))
    await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_cursor_v1'))

    const { runCron } = await import('../cron')
    const result = await runCron(makeEnv(d1))

    expect(result.checked).toBe(1)
    expect(await db.select().from(statusLogs)).toHaveLength(1)
    const marker = await db.query.settings.findFirst({
      where: eq(settings.key, '_schema_legacy_gap_catchup_v1'),
    })
    expect(marker?.value).toBe('1')
  })

  it('reconciles legacy logs in restartable bounded batches and invalidates history', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(1_800_100_000 * 1000))
    try {
    const { db, d1 } = ctx
    const monitorId = await insertMonitor(db, { active: false })
    const checkedAt = 1_800_000_000 - (1_800_000_000 % 86400) + 100
    await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_catchup_v1'))
    await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_cursor_v1'))
    await db.insert(statusLogs).values(Array.from({ length: 30 }, (_, index) => ({
      id: `legacy-${String(index).padStart(2, '0')}`,
      monitorId,
      status: index % 3 === 0 ? 'down' as const : 'up' as const,
      checkedAt: checkedAt + index,
      responseTimeMs: index,
      source: null,
    })))

    const {
      LEGACY_CATCHUP_INTERVAL_SECONDS,
      runCron,
    } = await import('../cron')
    const env = makeEnv(d1)
    await runCron(env)

    let logs = await db.select().from(statusLogs)
      .where(eq(statusLogs.monitorId, monitorId))
    expect(logs.filter((log) => log.source === 'legacy')).toHaveLength(25)
    expect(logs.filter((log) => log.source === null)).toHaveLength(5)
    let [rollup] = await db.select().from(monitorDailyRollups)
      .where(eq(monitorDailyRollups.monitorId, monitorId))
    expect(rollup.checks).toBe(25)
    let monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) })
    expect(monitor?.historyRevision).toBe(2)

    // Catch-up is deliberately paced so worst-case row writes stay safely
    // below D1 Free's daily 100k write quota.
    await runCron(env)
    expect((await db.select().from(statusLogs)
      .where(eq(statusLogs.source, 'legacy')))).toHaveLength(25)
    const maxDailyCatchupWrites = Math.ceil(
      86400 / LEGACY_CATCHUP_INTERVAL_SECONDS,
    ) * (25 * 4 + 2)
    expect(maxDailyCatchupWrites).toBeLessThan(100_000)

    // This row sorts behind the persisted cursor and simulates a late commit
    // from the legacy Worker.
    await db.insert(statusLogs).values({
      id: 'late-legacy',
      monitorId,
      status: 'up',
      checkedAt: checkedAt - 1,
      responseTimeMs: 5,
      source: null,
    })

    await vi.advanceTimersByTimeAsync(
      (LEGACY_CATCHUP_INTERVAL_SECONDS + 1) * 1000,
    )
    await runCron(env)

    logs = await db.select().from(statusLogs)
      .where(eq(statusLogs.monitorId, monitorId))
    expect(logs.filter((log) => log.source === 'legacy')).toHaveLength(30)
    expect(logs.filter((log) => log.source === null)).toHaveLength(1)
    const [secondRollup] = await db.select().from(monitorDailyRollups)
      .where(eq(monitorDailyRollups.monitorId, monitorId))
    expect(secondRollup.checks).toBe(30)
    monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) })
    expect(monitor?.historyRevision).toBe(3)

    // A short batch does not complete catch-up. The next pass must perform the
    // no-cursor fallback and recover the late row behind the high-water mark.
    expect(await db.query.settings.findFirst({
      where: eq(settings.key, '_schema_legacy_gap_catchup_v1'),
    })).toBeUndefined()
    await vi.advanceTimersByTimeAsync(
      (LEGACY_CATCHUP_INTERVAL_SECONDS + 1) * 1000,
    )
    await runCron(env)

    logs = await db.select().from(statusLogs)
      .where(eq(statusLogs.monitorId, monitorId))
    expect(logs.every((log) => log.source === 'legacy')).toBe(true)
    const [thirdRollup] = await db.select().from(monitorDailyRollups)
      .where(eq(monitorDailyRollups.monitorId, monitorId))
    expect(thirdRollup.checks).toBe(31)
    monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, monitorId) })
    expect(monitor?.historyRevision).toBe(4)
    expect(await db.query.settings.findFirst({
      where: eq(settings.key, '_schema_legacy_gap_catchup_v1'),
    })).toBeUndefined()

    // Completion is persisted only on a subsequent explicitly empty pass.
    await vi.advanceTimersByTimeAsync(
      (LEGACY_CATCHUP_INTERVAL_SECONDS + 1) * 1000,
    )
    await runCron(env)
    const marker = await db.query.settings.findFirst({
      where: eq(settings.key, '_schema_legacy_gap_catchup_v1'),
    })
    expect(marker?.value).toBe('1')
    } finally {
      vi.useRealTimers()
    }
  })

  it('never lets retention delete legacy rows before catch-up processes them', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2035-01-01T00:00:00Z'))
    try {
      const { db, d1 } = ctx
      const monitorId = await insertMonitor(db, { active: false })
      const now = Math.floor(Date.now() / 1000)
      await db.update(settings)
        .set({ value: '1' })
        .where(eq(settings.key, 'retention_days'))
      await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_catchup_v1'))
      await db.delete(settings).where(eq(settings.key, '_schema_legacy_gap_cursor_v1'))
      await db.insert(statusLogs).values(Array.from({ length: 30 }, (_, index) => ({
        id: `retention-legacy-${String(index).padStart(2, '0')}`,
        monitorId,
        status: 'up' as const,
        checkedAt: now - 2 * 86400 + index,
        responseTimeMs: 10,
        source: null,
      })))

      const { runCron } = await import('../cron')
      await runCron(makeEnv(d1))

      const remaining = await db.select().from(statusLogs)
        .where(eq(statusLogs.monitorId, monitorId))
      expect(remaining).toHaveLength(5)
      expect(remaining.every((row) => row.source === null)).toBe(true)
      const [rollup] = await db.select().from(monitorDailyRollups)
        .where(eq(monitorDailyRollups.monitorId, monitorId))
      expect(rollup.checks).toBe(25)
    } finally {
      vi.useRealTimers()
    }
  })

  it('paces retention batches durably across Worker cold starts', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2035-01-01T00:00:00Z'))
    try {
      const { db, d1 } = ctx
      const monitorId = await insertMonitor(db, { active: false })
      const now = Math.floor(Date.now() / 1000)
      await db.update(settings)
        .set({ value: '1' })
        .where(eq(settings.key, 'retention_days'))
      await db.insert(statusLogs).values(Array.from({ length: 450 }, (_, index) => ({
        id: `retention-paced-${String(index).padStart(3, '0')}`,
        monitorId,
        status: 'up' as const,
        checkedAt: now - 2 * 86400 + index,
        responseTimeMs: 10,
        source: 'cron' as const,
      })))

      let cron = await import('../cron')
      await cron.runCron(makeEnv(d1))
      expect(await db.$count(statusLogs)).toBe(250)

      // A second invocation has no in-memory coordination requirement: the
      // persisted marker is the only guard used by cleanupRetention, so this
      // assertion also applies when that invocation lands on a fresh isolate.
      await cron.runCron(makeEnv(d1))
      expect(await db.$count(statusLogs)).toBe(250)

      await vi.advanceTimersByTimeAsync(
        (cron.RETENTION_INTERVAL_SECONDS + 1) * 1000,
      )
      await cron.runCron(makeEnv(d1))
      expect(await db.$count(statusLogs)).toBe(50)

      const maxDailyRetentionDeletes =
        Math.ceil(86400 / cron.RETENTION_INTERVAL_SECONDS)
        * cron.RETENTION_DELETE_LIMIT
      expect(maxDailyRetentionDeletes).toBe(4_800)
    } finally {
      vi.useRealTimers()
    }
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
    for (let run = 0; run < 10; run += 1) {
      await runCron(env)
    }

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

  it('rejects a stale inbound cron result after a newer push commits', async () => {
    const { db, d1 } = ctx
    const heartbeatId = await insertMonitor(db, {
      type: 'heartbeat',
      heartbeatInterval: 60,
    })
    const httpId = await insertMonitor(db, {
      type: 'http',
      url: 'https://slow.example.com',
    })
    const initialPingAt = Math.floor(Date.now() / 1000) - 120
    await db.insert(heartbeatTokens).values({
      monitorId: heartbeatId,
      token: crypto.randomUUID(),
      lastPingAt: initialPingAt,
    })

    const { checkHttp } = await import('../services/checker')
    const { checkHeartbeat } = await import('../services/heartbeat-checker')
    const { processAlert } = await import('../services/alert-manager')
    let resolveHttp!: (value: {
      status: 'up'
      statusCode: number
      responseTimeMs: number
      message: string
    }) => void
    vi.mocked(checkHttp).mockImplementationOnce(() => new Promise((resolve) => {
      resolveHttp = resolve
    }))
    vi.mocked(checkHeartbeat).mockReturnValueOnce({
      status: 'down',
      message: 'Heartbeat missed',
      logKey: undefined,
    })

    const env = makeEnv(d1)
    const { runCron } = await import('../cron')
    const cronPromise = runCron(env)
    await vi.waitFor(() => expect(checkHttp).toHaveBeenCalled())

    const pushedMonitor = await db.query.monitors.findFirst({
      where: eq(monitors.id, heartbeatId),
    })
    const pushedAt = Math.floor(Date.now() / 1000) + 5
    await persistCheckObservations(env, [{
      monitor: pushedMonitor!,
      status: 'up',
      message: 'Heartbeat received',
      checkedAt: pushedAt,
      source: 'heartbeat',
    }])

    resolveHttp({
      status: 'up',
      statusCode: 200,
      responseTimeMs: 10,
      message: 'OK',
    })
    const result = await cronPromise

    const heartbeat = await db.query.monitors.findFirst({
      where: eq(monitors.id, heartbeatId),
    })
    expect(heartbeat).toMatchObject({
      lastCheckedAt: pushedAt,
      nextCheckAt: pushedAt + 60,
      dayChecks: 1,
      dayUpCount: 1,
      dayDownCount: 0,
    })
    expect(result.checked).toBe(1)
    expect(result.deferred).toBe(1)
    expect(vi.mocked(processAlert).mock.calls.some(
      ([input]) => input.monitor.id === heartbeatId,
    )).toBe(false)
    expect(vi.mocked(processAlert).mock.calls.some(
      ([input]) => input.monitor.id === httpId,
    )).toBe(true)
  })
})

describe('cron — CRIT-4: failed alert transitions retry promptly', () => {
  it('persists the check but pulls nextCheckAt forward when processAlert throws', async () => {
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
    expect(mon.nextCheckAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 60)

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
