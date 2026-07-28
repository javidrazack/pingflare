import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { and, eq, isNull } from 'drizzle-orm'
import { createTestDb, insertMonitor } from './setup'
import {
  alertState,
  incidents,
  maintenanceWindows,
  monitorNotifications,
  monitors,
  notificationChannels,
  notificationDeliveries,
} from '../db/schema'
import { sendNotification } from '../notifications'

vi.mock('../notifications', () => ({
  sendNotification: vi.fn(),
}))

type TestDb = Awaited<ReturnType<typeof createTestDb>>

async function attachChannel(
  ctx: TestDb,
  monitorId: string,
  id = crypto.randomUUID(),
  active = true,
): Promise<string> {
  await ctx.db.insert(notificationChannels).values({
    id,
    name: `Webhook ${id}`,
    type: 'webhook',
    config: JSON.stringify({ url: 'https://example.com/hook' }),
    active,
  })
  await ctx.db.insert(monitorNotifications).values({
    monitorId,
    channelId: id,
  })
  return id
}

async function getMonitor(ctx: TestDb, id: string) {
  const monitor = await ctx.db.query.monitors.findFirst({
    where: eq(monitors.id, id),
  })
  if (!monitor) throw new Error(`Missing monitor ${id}`)
  return monitor
}

describe('processAlert reliability', () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
    vi.mocked(sendNotification).mockResolvedValue(undefined)
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('keeps steady-up and pending-up alert work bounded', async () => {
    const ctx = await createTestDb()
    const steadyId = await insertMonitor(ctx.db, { lastStatus: 'up' })
    const pendingId = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    const { processAlert } = await import('../services/alert-manager')

    const steadyMonitor = await getMonitor(ctx, steadyId)
    const steadyPrepare = vi.spyOn(ctx.d1, 'prepare')
    await processAlert({
      db: ctx.db,
      monitor: steadyMonitor,
      status: 'up',
      message: 'HTTP 200',
    })
    expect(steadyPrepare).toHaveBeenCalledTimes(4)
    steadyPrepare.mockRestore()

    const pendingMonitor = await getMonitor(ctx, pendingId)
    const pendingPrepare = vi.spyOn(ctx.d1, 'prepare')
    await processAlert({
      db: ctx.db,
      monitor: pendingMonitor,
      status: 'up',
      message: 'HTTP 200',
    })
    expect(pendingPrepare).toHaveBeenCalledTimes(4)
    expect((await getMonitor(ctx, pendingId)).lastStatus).toBe('up')
  })

  it('persists a failed alert and retries it without duplicating the incident', async () => {
    const ctx = await createTestDb()
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    await attachChannel(ctx, id)
    const monitor = await getMonitor(ctx, id)
    const { sendNotification } = await import('../notifications')
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error('provider unavailable'))
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    const now = Math.floor(Date.now() / 1000)

    await Promise.all([
      processAlert({ db: ctx.db, monitor, status: 'down', message: 'Timeout' }),
      processAlert({ db: ctx.db, monitor, status: 'down', message: 'Timeout' }),
    ])

    expect(sendNotification).not.toHaveBeenCalled()
    expect((await getMonitor(ctx, id)).lastStatus).toBe('down')
    expect(await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))).toHaveLength(1)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(1)

    const firstDrain = await drainNotificationDeliveries(ctx.db, undefined, now)
    expect(firstDrain).toMatchObject({ attempted: 1, delivered: 0, deferred: 1 })
    const [failedState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(failedState.alertSentAt).toBeNull()

    const secondDrain = await drainNotificationDeliveries(ctx.db, undefined, now + 31)
    expect(secondDrain).toMatchObject({ attempted: 1, delivered: 1, deferred: 0 })
    expect(sendNotification).toHaveBeenCalledTimes(2)
    const [deliveredState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(deliveredState.alertSentAt).not.toBeNull()
  })

  it('keeps failed recovery delivery retryable while marking the monitor up', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 120,
      lastReminderAt: now - 120,
      consecutiveFailures: 2,
      consecutiveAlerts: 1,
    })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: now - 120,
    })
    const monitor = await getMonitor(ctx, id)
    const { sendNotification } = await import('../notifications')
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error('provider unavailable'))
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor,
      status: 'up',
      message: 'HTTP 200',
    })

    expect((await getMonitor(ctx, id)).lastStatus).toBe('up')
    expect(await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))).toHaveLength(0)

    await drainNotificationDeliveries(ctx.db, undefined, now)
    let [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBe(now - 120)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(1)

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Still healthy',
    })
    await drainNotificationDeliveries(ctx.db, undefined, now + 31)

    ;[state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBeNull()
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
    expect(sendNotification).toHaveBeenCalledTimes(2)
  })

  it('advances a reminder only after a configured channel succeeds', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const previousReminder = now - 7200
    const id = await insertMonitor(ctx.db, {
      lastStatus: 'down',
      reminderIntervalHours: 1,
    })
    await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: previousReminder,
      lastReminderAt: previousReminder,
      consecutiveFailures: 1,
      consecutiveAlerts: 1,
    })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: previousReminder,
    })
    const { sendNotification } = await import('../notifications')
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error('provider unavailable'))
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Still down',
    })
    const [delivery] = await ctx.db.select().from(notificationDeliveries)
    expect(delivery).toBeDefined()
    expect(
      await drainNotificationDeliveries(
        ctx.db,
        undefined,
        delivery.nextAttemptAt,
      ),
    ).toMatchObject({ attempted: 1, delivered: 0, deferred: 1 })

    let [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.lastReminderAt).toBe(previousReminder)

    expect(
      await drainNotificationDeliveries(
        ctx.db,
        undefined,
        delivery.nextAttemptAt + 31,
      ),
    ).toMatchObject({ attempted: 1, delivered: 1, deferred: 0 })
    ;[state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.lastReminderAt).toBeGreaterThan(previousReminder)
  })

  it('deduplicates concurrent recovery transitions from stale monitor snapshots', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 60,
      lastReminderAt: now - 60,
    })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: now - 60,
    })
    const staleMonitor = await getMonitor(ctx, id)
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    const { sendNotification } = await import('../notifications')

    await Promise.all([
      processAlert({ db: ctx.db, monitor: staleMonitor, status: 'up', message: 'OK' }),
      processAlert({ db: ctx.db, monitor: staleMonitor, status: 'up', message: 'OK' }),
    ])

    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(1)
    const drainResults = await Promise.all([
      drainNotificationDeliveries(ctx.db, undefined, now),
      drainNotificationDeliveries(ctx.db, undefined, now),
    ])
    expect(drainResults.reduce((sum, result) => sum + result.attempted, 0)).toBe(1)
    expect(sendNotification).toHaveBeenCalledTimes(1)
  })

  it('marks healthy and closes orphan incidents during maintenance', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 90,
      lastReminderAt: now - 90,
      consecutiveFailures: 1,
      consecutiveAlerts: 1,
    })
    const incidentId = crypto.randomUUID()
    await ctx.db.insert(incidents).values({
      id: incidentId,
      monitorId: id,
      startedAt: now - 90,
    })
    await ctx.db.insert(maintenanceWindows).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startAt: now - 60,
      endAt: now + 60,
    })
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Recovered during maintenance',
    })

    expect((await getMonitor(ctx, id)).lastStatus).toBe('up')
    const [incident] = await ctx.db.select().from(incidents)
      .where(eq(incidents.id, incidentId))
    expect(incident.resolvedAt).toBe(now)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBeNull()

    await ctx.db.delete(maintenanceWindows)
      .where(eq(maintenanceWindows.monitorId, id))
    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Still healthy after maintenance',
    })
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
  })

  it('bounds a drain to two provider attempts and eventually delivers every channel', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    for (let index = 0; index < 5; index += 1) {
      await attachChannel(ctx, id, `channel-${index}`)
    }
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    const { sendNotification } = await import('../notifications')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Timeout',
    })

    expect((await drainNotificationDeliveries(
      ctx.db,
      undefined,
      now,
      1,
    )).attempted).toBe(1)
    const [partialState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(partialState.alertSentAt).toBeNull()
    const [partialDelivery] = await ctx.db.select().from(notificationDeliveries)
    expect(JSON.parse(partialDelivery.remainingChannelIds)).toHaveLength(4)
    expect((await drainNotificationDeliveries(ctx.db, undefined, now)).attempted).toBe(2)
    expect((await drainNotificationDeliveries(ctx.db, undefined, now)).attempted).toBe(2)
    expect(sendNotification).toHaveBeenCalledTimes(5)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
  })

  it('caps a two-row successful drain at thirteen D1 queries', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const { drainNotificationDeliveries, processAlert } = await import('../services/alert-manager')

    for (let index = 0; index < 2; index += 1) {
      const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
      await attachChannel(ctx, id, `budget-channel-${index}`)
      await processAlert({
        db: ctx.db,
        monitor: await getMonitor(ctx, id),
        status: 'down',
        message: 'Timeout',
      })
    }

    const prepare = vi.spyOn(ctx.d1, 'prepare')
    const result = await drainNotificationDeliveries(ctx.db, undefined, now)

    expect(result).toMatchObject({ attempted: 2, delivered: 2, deferred: 0 })
    expect(prepare).toHaveBeenCalledTimes(13)
  })

  it('removes deleted or inactive queued channels instead of retrying forever', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    const inactiveId = await attachChannel(ctx, id, 'inactive-later')
    const deletedId = await attachChannel(ctx, id, 'deleted-later')
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Timeout',
    })
    await ctx.db.update(notificationChannels)
      .set({ active: false })
      .where(eq(notificationChannels.id, inactiveId))
    await ctx.db.delete(notificationChannels)
      .where(eq(notificationChannels.id, deletedId))

    const result = await drainNotificationDeliveries(ctx.db, undefined, now)
    expect(result.attempted).toBe(0)
    expect(result.deferred).toBe(0)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).not.toBeNull()
  })

  it('aborts a timed-out provider and keeps its delivery pending', async () => {
    vi.useFakeTimers()
    const nowMs = Date.now()
    vi.setSystemTime(nowMs)
    const ctx = await createTestDb()
    const now = Math.floor(nowMs / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    await attachChannel(ctx, id)
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    const { sendNotification } = await import('../notifications')
    let receivedSignal: AbortSignal | undefined
    vi.mocked(sendNotification).mockImplementation(
      async (_channel, _payload, _encryptionKey, signal) => {
        receivedSignal = signal
        await new Promise<void>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
      },
    )

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Timeout',
    })

    const drain = drainNotificationDeliveries(ctx.db, undefined, now)
    await vi.advanceTimersByTimeAsync(12_001)
    const result = await drain

    expect(result).toMatchObject({ attempted: 1, delivered: 0, deferred: 1 })
    expect(receivedSignal?.aborted).toBe(true)
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(1)
  })

  it('repairs a missing incident for an already-down monitor', async () => {
    const ctx = await createTestDb()
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    const { processAlert } = await import('../services/alert-manager')
    const monitor = await getMonitor(ctx, id)

    await Promise.all([
      processAlert({ db: ctx.db, monitor, status: 'down', message: 'Still down' }),
      processAlert({ db: ctx.db, monitor, status: 'down', message: 'Still down' }),
    ])

    const openIncidents = await ctx.db.select().from(incidents)
      .where(and(
        eq(incidents.monitorId, id),
        isNull(incidents.resolvedAt),
      ))
    expect(openIncidents).toHaveLength(1)
  })

  it('repairs an orphan incident on a steady healthy observation', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'up' })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: now - 60,
    })
    const { processAlert } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Still healthy',
    })

    expect(await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))).toHaveLength(0)
  })

  it('defers a queued alert while maintenance is active', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    await attachChannel(ctx, id)
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Timeout',
    })
    await ctx.db.insert(maintenanceWindows).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startAt: now - 1,
      endAt: now + 300,
    })

    const result = await drainNotificationDeliveries(ctx.db, undefined, now)
    expect(result.attempted).toBe(0)
    expect(sendNotification).not.toHaveBeenCalled()
    const [delivery] = await ctx.db.select().from(notificationDeliveries)
    expect(delivery.nextAttemptAt).toBe(now + 301)
  })

  it('orders recovery after a claimed down send that finishes late', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    await attachChannel(ctx, id)
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    let releaseDown!: () => void
    vi.mocked(sendNotification)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseDown = resolve
      }))
      .mockResolvedValueOnce(undefined)

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Timeout',
    })
    const downDrain = drainNotificationDeliveries(ctx.db, undefined, now)
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1))

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Recovered',
    })
    releaseDown()
    await downDrain
    await drainNotificationDeliveries(ctx.db, undefined, now + 31)

    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['alert', 'recovery'])
    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBeNull()
    expect((await getMonitor(ctx, id)).lastStatus).toBe('up')
  })

  it('repairs claimed down delivery evidence after a healthy-path crash', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    const channelId = await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({ monitorId: id })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: now - 60,
    })
    await ctx.db.insert(notificationDeliveries).values({
      id: crypto.randomUUID(),
      dedupeKey: `alert:${id}:claimed`,
      monitorId: id,
      eventType: 'alert',
      payload: JSON.stringify({
        type: 'alert',
        monitor: { id, name: 'Test Monitor', type: 'http' },
        status: 'down',
        message: 'Timeout',
      }),
      remainingChannelIds: JSON.stringify([channelId]),
      claimToken: 'provider-in-flight',
      claimUntil: now + 30,
      nextAttemptAt: now,
      createdAt: now - 10,
      updatedAt: now,
    })
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    const originalPrepare = ctx.d1.prepare.bind(ctx.d1)
    const crash = vi.spyOn(ctx.d1, 'prepare').mockImplementation((query: string) => {
      if (query.toLowerCase().includes('from "notification_deliveries"')) {
        throw new Error('simulated crash after status update')
      }
      return originalPrepare(query)
    })

    await expect(processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Recovered',
    })).rejects.toThrow('simulated crash')
    expect((await getMonitor(ctx, id)).lastStatus).toBe('up')
    crash.mockRestore()

    // The provider completed its already-claimed DOWN request after the crash.
    // The next drain must stage and send recovery before removing that row;
    // there may be no other observation for a long-interval monitor.
    await ctx.db.update(notificationDeliveries).set({
      remainingChannelIds: '[]',
      deliveredCount: 1,
      claimToken: null,
      claimUntil: null,
    }).where(eq(notificationDeliveries.eventType, 'alert'))
    await drainNotificationDeliveries(ctx.db, undefined, now + 31)

    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBeNull()
    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['recovery'])
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
  })

  it('keeps claimed-down recovery without an active channel within 12 queries', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2040-01-01T00:00:00Z'))
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    const channelId = await attachChannel(ctx, id, 'inactive-recovery', false)
    await ctx.db.insert(alertState).values({ monitorId: id })
    await ctx.db.insert(incidents).values({
      id: crypto.randomUUID(),
      monitorId: id,
      startedAt: now - 60,
    })
    await ctx.db.insert(notificationDeliveries).values({
      id: crypto.randomUUID(),
      dedupeKey: `alert:${id}:claimed-no-channel`,
      monitorId: id,
      eventType: 'alert',
      payload: JSON.stringify({
        type: 'alert',
        monitor: { id, name: 'Test Monitor', type: 'http' },
        status: 'down',
        message: 'Timeout',
      }),
      remainingChannelIds: JSON.stringify([channelId]),
      claimToken: 'provider-in-flight',
      claimUntil: now + 30,
      nextAttemptAt: now,
      createdAt: now - 10,
      updatedAt: now,
    })
    const { processAlert } = await import('../services/alert-manager')
    const monitor = await getMonitor(ctx, id)
    const prepare = vi.spyOn(ctx.d1, 'prepare')

    await processAlert({
      db: ctx.db,
      monitor,
      status: 'up',
      message: 'Recovered',
    })

    expect(prepare).toHaveBeenCalledTimes(12)
    expect((await getMonitor(ctx, id)).lastStatus).toBe('up')
    expect(await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))).toHaveLength(0)
    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).toBeNull()
  })

  it('serializes a new alert behind an in-flight recovery', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'up' })
    const channelId = await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 120,
    })
    await ctx.db.insert(notificationDeliveries).values({
      id: crypto.randomUUID(),
      dedupeKey: `recovery:${id}:${now - 120}`,
      monitorId: id,
      eventType: 'recovery',
      payload: JSON.stringify({
        type: 'recovery',
        monitor: { id, name: 'Test Monitor', type: 'http' },
        status: 'up',
        message: 'Recovered',
      }),
      remainingChannelIds: JSON.stringify([channelId]),
      nextAttemptAt: now,
      createdAt: now - 10,
      updatedAt: now,
    })
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')
    let releaseRecovery!: () => void
    vi.mocked(sendNotification)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        releaseRecovery = resolve
      }))
      .mockResolvedValue(undefined)

    const recoveryDrain = drainNotificationDeliveries(ctx.db, undefined, now)
    await vi.waitFor(() => expect(sendNotification).toHaveBeenCalledTimes(1))

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'down',
      message: 'Down again',
    })
    const competingDrain = await drainNotificationDeliveries(ctx.db, undefined, now)
    expect(competingDrain.attempted).toBe(0)
    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['recovery'])

    releaseRecovery()
    await recoveryDrain
    await drainNotificationDeliveries(ctx.db, undefined, now + 31)

    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['recovery', 'alert'])
    expect((await getMonitor(ctx, id)).lastStatus).toBe('down')
    const [state] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(state.alertSentAt).not.toBeNull()
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
  })

  it('sends a corrective alert after a recovery completes late', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    const channelId = await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 120,
    })
    await ctx.db.insert(notificationDeliveries).values({
      id: crypto.randomUUID(),
      dedupeKey: `recovery:${id}:${now - 120}`,
      monitorId: id,
      eventType: 'recovery',
      payload: JSON.stringify({
        type: 'recovery',
        monitor: { id, name: 'Test Monitor', type: 'http' },
        status: 'up',
        message: 'Recovered',
      }),
      remainingChannelIds: '[]',
      deliveredCount: 1,
      nextAttemptAt: now,
      createdAt: now - 10,
      updatedAt: now,
    })
    const { drainNotificationDeliveries } = await import('../services/alert-manager')

    await drainNotificationDeliveries(ctx.db, undefined, now)

    // The recovery itself is assumed to have completed outside this drain.
    // Its stale row must drive a new DOWN send so the recipient's final view
    // agrees with the authoritative monitor status.
    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['alert'])
    expect(await ctx.db.select().from(notificationDeliveries)).toHaveLength(0)
  })

  it('recovers promptly when a partially delivered reminder is cancelled', async () => {
    const ctx = await createTestDb()
    const now = Math.floor(Date.now() / 1000)
    const id = await insertMonitor(ctx.db, { lastStatus: 'down' })
    await attachChannel(ctx, id)
    await ctx.db.insert(alertState).values({
      monitorId: id,
      alertSentAt: now - 600,
      lastReminderAt: now - 300,
    })
    await ctx.db.insert(notificationDeliveries).values({
      id: crypto.randomUUID(),
      dedupeKey: `reminder:${id}:partial`,
      monitorId: id,
      eventType: 'reminder',
      payload: JSON.stringify({
        type: 'reminder',
        monitor: { id, name: 'Test Monitor', type: 'http' },
        status: 'down',
        message: 'Still down',
      }),
      remainingChannelIds: '[]',
      deliveredCount: 1,
      nextAttemptAt: now,
      createdAt: now - 60,
      updatedAt: now - 60,
    })
    const {
      drainNotificationDeliveries,
      processAlert,
    } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: await getMonitor(ctx, id),
      status: 'up',
      message: 'Recovered',
    })
    await drainNotificationDeliveries(ctx.db, undefined, now)

    expect(vi.mocked(sendNotification).mock.calls.map(call => call[1].type))
      .toEqual(['recovery'])
  })
})
