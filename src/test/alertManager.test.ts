import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eq, isNull } from 'drizzle-orm'
import { createTestDb, insertMonitor } from './setup'
import {
  alertState,
  incidents,
  monitorNotifications,
  monitors,
  notificationChannels,
} from '../db/schema'

vi.mock('../notifications', () => ({
  sendNotification: vi.fn(),
}))

describe('processAlert reliability', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  it('uses one conditional reset for a steady healthy observation', async () => {
    const ctx = await createTestDb()
    const id = await insertMonitor(ctx.db, { lastStatus: 'up' })
    const monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const prepare = vi.spyOn(ctx.d1, 'prepare')
    const { processAlert } = await import('../services/alert-manager')

    await processAlert({
      db: ctx.db,
      monitor: monitor!,
      status: 'up',
      message: 'HTTP 200',
    })

    expect(prepare).toHaveBeenCalledTimes(1)
  })

  it('breaks a tolerated failure streak when a pending monitor recovers', async () => {
    const ctx = await createTestDb()
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending', toleranceFailures: 2 })
    const { processAlert } = await import('../services/alert-manager')

    const firstMonitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    await processAlert({
      db: ctx.db,
      monitor: firstMonitor!,
      status: 'down',
      message: 'Timeout',
    })
    await processAlert({
      db: ctx.db,
      monitor: firstMonitor!,
      status: 'up',
      message: 'HTTP 200',
    })

    const monitorAfterRecovery = await ctx.db.query.monitors.findFirst({
      where: eq(monitors.id, id),
    })
    expect(monitorAfterRecovery?.lastStatus).toBe('up')
    const [recoveredState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(recoveredState.consecutiveFailures).toBe(0)

    await processAlert({
      db: ctx.db,
      monitor: monitorAfterRecovery!,
      status: 'down',
      message: 'Timeout again',
    })

    const [stateAfterLaterFailure] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(stateAfterLaterFailure.consecutiveFailures).toBe(1)
    expect(await ctx.db.select().from(incidents)).toHaveLength(0)
  })

  it('commits down state and an incident when a notification provider fails', async () => {
    const ctx = await createTestDb()
    const id = await insertMonitor(ctx.db, { lastStatus: 'pending' })
    const channelId = crypto.randomUUID()
    await ctx.db.insert(notificationChannels).values({
      id: channelId,
      name: 'Failing webhook',
      type: 'webhook',
      config: '{}',
    })
    await ctx.db.insert(monitorNotifications).values({ monitorId: id, channelId })
    const monitor = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    const { sendNotification } = await import('../notifications')
    vi.mocked(sendNotification).mockRejectedValueOnce(new Error('provider unavailable'))
    const { processAlert } = await import('../services/alert-manager')

    await expect(processAlert({
      db: ctx.db,
      monitor: monitor!,
      status: 'down',
      message: 'Timeout',
    })).resolves.toBeUndefined()

    const updated = await ctx.db.query.monitors.findFirst({ where: eq(monitors.id, id) })
    expect(updated?.lastStatus).toBe('down')
    const openIncidents = await ctx.db.select().from(incidents)
      .where(isNull(incidents.resolvedAt))
    expect(openIncidents).toHaveLength(1)
    expect(openIncidents[0].monitorId).toBe(id)

    const [failedDeliveryState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(failedDeliveryState.alertSentAt).toBeNull()

    await processAlert({
      db: ctx.db,
      monitor: updated!,
      status: 'down',
      message: 'Still unavailable',
    })

    expect(sendNotification).toHaveBeenCalledTimes(2)
    const [retriedDeliveryState] = await ctx.db.select().from(alertState)
      .where(eq(alertState.monitorId, id))
    expect(retriedDeliveryState.alertSentAt).not.toBeNull()
  })
})
