import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDb, insertMonitor, makeEnv } from './setup'
import { monitorDailyRollups, monitors, statusLogs } from '../db/schema'
import { persistCheckObservations } from '../services/check-storage'

describe('persistCheckObservations', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    ctx = await createTestDb()
  })

  it('updates exact counters and emits Analytics Engine telemetry', async () => {
    const id = await insertMonitor(ctx.db)
    const monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const writeDataPoint = vi.fn()
    const env = {
      ...makeEnv(ctx.d1),
      CHECK_ANALYTICS: { writeDataPoint },
    }

    await persistCheckObservations(env, [{
      monitor: monitor!,
      status: 'up',
      message: 'HTTP 200',
      responseTimeMs: 42,
      checkedAt: 1_800_000_100,
      source: 'cron',
      resultCode: 'http_200',
    }])

    const updated = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(updated).toMatchObject({
      lastCheckedAt: 1_800_000_100,
      dayChecks: 1,
      dayUpCount: 1,
      dayDownCount: 0,
      dayResponseCount: 1,
      dayResponseSumMs: 42,
      dayResponseMinMs: 42,
      dayResponseMaxMs: 42,
    })
    const logs = await ctx.db.select().from(statusLogs)
    expect(logs).toHaveLength(1)
    expect(logs[0].source).toBe('cron')
    expect(writeDataPoint).toHaveBeenCalledOnce()
  })

  it('keeps steady diagnostics sparse while retaining every exact check', async () => {
    const id = await insertMonitor(ctx.db)
    const first = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const env = makeEnv(ctx.d1)
    const checkedAt = 1_800_000_100

    await persistCheckObservations(env, [{
      monitor: first!,
      status: 'up',
      message: 'HTTP 200',
      responseTimeMs: 40,
      checkedAt,
      source: 'cron',
    }])
    await ctx.db.update(monitors).set({ lastStatus: 'up' }).where(eq(monitors.id, id))
    const second = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    await persistCheckObservations(env, [{
      monitor: second!,
      status: 'up',
      message: 'HTTP 200',
      responseTimeMs: 60,
      checkedAt: checkedAt + 30,
      source: 'cron',
    }])

    const updated = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(updated).toMatchObject({
      dayChecks: 2,
      dayUpCount: 2,
      dayResponseCount: 2,
      dayResponseSumMs: 100,
      dayResponseMinMs: 40,
      dayResponseMaxMs: 60,
    })
    expect(await ctx.db.select().from(statusLogs)).toHaveLength(1)
  })

  it('archives a completed UTC day and resets the live counters atomically', async () => {
    const id = await insertMonitor(ctx.db)
    const env = makeEnv(ctx.d1)
    const firstDay = 1_800_000_000 - (1_800_000_000 % 86400)
    let monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })

    await persistCheckObservations(env, [{
      monitor: monitor!,
      status: 'down',
      message: 'Timeout',
      responseTimeMs: null,
      checkedAt: firstDay + 100,
      source: 'cron',
    }])
    monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    await persistCheckObservations(env, [{
      monitor: monitor!,
      status: 'up',
      message: 'HTTP 200',
      responseTimeMs: 25,
      checkedAt: firstDay + 86400 + 100,
      source: 'cron',
    }])

    const archived = await ctx.db.select().from(monitorDailyRollups)
    expect(archived).toHaveLength(1)
    expect(archived[0]).toMatchObject({
      monitorId: id,
      day: firstDay,
      checks: 1,
      upCount: 0,
      downCount: 1,
    })
    const updated = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(updated).toMatchObject({
      historyRevision: 2,
      statsDay: firstDay + 86400,
      dayChecks: 1,
      dayUpCount: 1,
      dayDownCount: 0,
      dayResponseSumMs: 25,
    })
  })
})
