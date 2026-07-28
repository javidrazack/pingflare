import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import { createTestDb, insertMonitor, makeEnv } from './setup'
import {
  heartbeatTokens,
  incidents,
  monitorDailyRollups,
  monitors,
  statusLogs,
} from '../db/schema'
import {
  persistCheckObservations,
  persistInboundObservationWithRetry,
} from '../services/check-storage'
import { processAlert } from '../services/alert-manager'

vi.mock('../notifications', () => ({
  sendNotification: vi.fn(),
}))

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

    const persisted = await persistCheckObservations(env, [{
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
      nextCheckAt: 1_800_000_160,
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
    expect(persisted.acceptedObservations).toHaveLength(1)
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

  it('never moves the persisted scheduling cursor backward', async () => {
    const id = await insertMonitor(ctx.db, {
      interval: 60,
      lastCheckedAt: 1_800_000_200,
      nextCheckAt: 1_800_000_260,
    })
    const monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })

    const persisted = await persistCheckObservations(makeEnv(ctx.d1), [{
      monitor: monitor!,
      status: 'up',
      message: 'Late result',
      responseTimeMs: 10,
      checkedAt: 1_800_000_100,
      source: 'cron',
    }])

    const updated = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(updated).toMatchObject({
      lastCheckedAt: 1_800_000_200,
      nextCheckAt: 1_800_000_260,
      dayChecks: 0,
    })
    expect(persisted.acceptedObservations).toHaveLength(0)
  })

  it('prevents an older accepted workflow from finishing after a newer observation', async () => {
    const id = await insertMonitor(ctx.db, {
      lastStatus: 'pending',
      lastCheckedAt: null,
    })
    const original = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const env = makeEnv(ctx.d1)

    const older = await persistCheckObservations(env, [{
      monitor: original!,
      status: 'down',
      message: 'Missed',
      checkedAt: 2_000,
      source: 'cron',
    }])
    const afterOlder = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const newer = await persistCheckObservations(env, [{
      monitor: afterOlder!,
      status: 'up',
      message: 'Received',
      checkedAt: 2_001,
      source: 'heartbeat',
    }])

    await processAlert({
      db: ctx.db,
      monitor: newer.acceptedObservations[0].monitor,
      observationRevision: newer.acceptedObservations[0].observationRevision,
      status: 'up',
      message: 'Received',
    })
    await processAlert({
      db: ctx.db,
      monitor: older.acceptedObservations[0].monitor,
      observationRevision: older.acceptedObservations[0].observationRevision,
      status: 'down',
      message: 'Missed',
    })

    const finalMonitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(finalMonitor).toMatchObject({
      lastCheckedAt: 2_001,
      lastStatus: 'up',
      observationRevision: newer.acceptedObservations[0].observationRevision,
    })
    expect(await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))).toHaveLength(0)
  })

  it('retries a real inbound push once when cron wins the revision CAS', async () => {
    const id = await insertMonitor(ctx.db, {
      type: 'heartbeat',
      url: null,
      heartbeatInterval: 60,
    })
    await ctx.db.insert(heartbeatTokens).values({
      monitorId: id,
      token: 'inbound-race-token',
    })
    const stale = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    const env = makeEnv(ctx.d1)

    await persistCheckObservations(env, [{
      monitor: stale!,
      status: 'down',
      message: 'Heartbeat missed',
      checkedAt: 2_000,
      source: 'cron',
    }])

    const inbound = {
      monitor: stale!,
      status: 'up' as const,
      message: 'Heartbeat received',
      checkedAt: 2_001,
      source: 'heartbeat' as const,
      inboundGuard: {
        lastCheckedAt: stale!.lastCheckedAt,
        lastPingAt: null,
      },
    }
    const persisted = await persistInboundObservationWithRetry(
      env,
      inbound,
      (current, checkedAt) => current.type === 'heartbeat'
        ? { ...inbound, monitor: current, checkedAt }
        : null,
    )

    expect(persisted.acceptedObservations).toHaveLength(1)
    const current = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    expect(current).toMatchObject({
      lastCheckedAt: 2_001,
      dayChecks: 2,
      dayUpCount: 1,
      dayDownCount: 1,
    })
    const token = await ctx.db.query.heartbeatTokens.findFirst({
      where: eq(heartbeatTokens.monitorId, id),
    })
    expect(token?.lastPingAt).toBe(2_001)
  })

  it('advances a valid inbound push when cron wins with a one-second newer timestamp', async () => {
    const id = await insertMonitor(ctx.db, {
      type: 'heartbeat',
      url: null,
      heartbeatInterval: 60,
    })
    await ctx.db.insert(heartbeatTokens).values({
      monitorId: id,
      token: 'inverse-inbound-race-token',
    })
    const stale = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    const env = makeEnv(ctx.d1)

    await persistCheckObservations(env, [{
      monitor: stale!,
      status: 'down',
      message: 'Heartbeat missed',
      checkedAt: 2_001,
      source: 'cron',
    }])

    const inbound = {
      monitor: stale!,
      status: 'up' as const,
      message: 'Heartbeat received',
      checkedAt: 2_000,
      source: 'heartbeat' as const,
      inboundGuard: {
        lastCheckedAt: stale!.lastCheckedAt,
        lastPingAt: null,
      },
    }
    const persisted = await persistInboundObservationWithRetry(
      env,
      inbound,
      (current, checkedAt) => current.type === 'heartbeat'
        ? { ...inbound, monitor: current, checkedAt }
        : null,
    )

    expect(persisted.acceptedObservations).toHaveLength(1)
    expect(persisted.acceptedObservations[0].checkedAt).toBeGreaterThanOrEqual(2_001)
    const current = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    expect(current).toMatchObject({
      lastStatus: 'pending',
      dayChecks: 2,
      dayUpCount: 1,
      dayDownCount: 1,
    })
    const token = await ctx.db.query.heartbeatTokens.findFirst({
      where: eq(heartbeatTokens.monitorId, id),
    })
    expect(token?.lastPingAt).toBeGreaterThanOrEqual(2_001)
  })

  it('does not retry an older payload after a newer inbound push changes the ping cursor', async () => {
    const id = await insertMonitor(ctx.db, {
      type: 'heartbeat',
      url: null,
      heartbeatInterval: 60,
    })
    await ctx.db.insert(heartbeatTokens).values({
      monitorId: id,
      token: 'newer-inbound-wins-token',
    })
    const stale = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    const env = makeEnv(ctx.d1)

    await persistCheckObservations(env, [{
      monitor: stale!,
      status: 'up',
      message: 'Newer inbound',
      checkedAt: 2_001,
      source: 'heartbeat',
      inboundGuard: {
        lastCheckedAt: stale!.lastCheckedAt,
        lastPingAt: null,
      },
    }])

    const older = {
      monitor: stale!,
      status: 'down' as const,
      message: 'Older inbound',
      checkedAt: 2_000,
      source: 'heartbeat' as const,
      inboundGuard: {
        lastCheckedAt: stale!.lastCheckedAt,
        lastPingAt: null,
      },
    }
    const persisted = await persistInboundObservationWithRetry(
      env,
      older,
      (current, checkedAt) => ({ ...older, monitor: current, checkedAt }),
    )

    expect(persisted.acceptedObservations).toHaveLength(0)
    const current = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    expect(current).toMatchObject({
      lastCheckedAt: 2_001,
      dayChecks: 1,
      dayUpCount: 1,
      dayDownCount: 0,
    })
  })
})
