import { describe, expect, it, vi } from 'vitest'
import { createTestDb, insertMonitor, makeEnv } from './setup'
import {
  alertState,
  heartbeatTokens,
  incidents,
  monitorNotifications,
  notificationChannels,
  notificationDeliveries,
} from '../db/schema'

vi.mock('../services/checker', () => ({
  MAX_CHECK_DEADLINE_MS: 60_000,
  checkHttp: vi.fn(),
  checkDns: vi.fn(),
  checkPing: vi.fn(),
}))
vi.mock('../services/heartbeat-checker', () => ({
  checkHeartbeat: vi.fn().mockReturnValue({
    status: 'up',
    message: 'Heartbeat received',
    logKey: undefined,
  }),
}))
vi.mock('../notifications', () => ({
  sendNotification: vi.fn().mockResolvedValue(undefined),
}))
vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
  ok: true,
  text: () => Promise.resolve('colo=GRU\nloc=BR\nip=1.2.3.4\n'),
}))

describe('cron D1 query admission', () => {
  it('defers the third hidden recovery before the 50-query limit', async () => {
    const { db, d1 } = await createTestDb()
    const now = Math.floor(Date.now() / 1000)

    for (let index = 0; index < 3; index += 1) {
      const monitorId = await insertMonitor(db, {
        type: 'heartbeat',
        url: null,
        heartbeatInterval: 60,
        lastStatus: 'up',
        lastCheckedAt: now - 120,
        nextCheckAt: now - 60,
      })
      const channelId = `budget-channel-${index}`
      await db.insert(heartbeatTokens).values({
        monitorId,
        token: `budget-token-${index}`,
        lastPingAt: now - 5,
      })
      await db.insert(alertState).values({ monitorId })
      await db.insert(notificationChannels).values({
        id: channelId,
        name: `Inactive ${index}`,
        type: 'webhook',
        config: JSON.stringify({ url: 'https://example.com/hook' }),
        active: false,
      })
      await db.insert(monitorNotifications).values({ monitorId, channelId })
      await db.insert(incidents).values({
        id: `budget-incident-${index}`,
        monitorId,
        startedAt: now - 300,
      })
      await db.insert(notificationDeliveries).values({
        id: `budget-delivery-${index}`,
        dedupeKey: `alert:${monitorId}:claimed`,
        monitorId,
        eventType: 'alert',
        payload: JSON.stringify({
          type: 'alert',
          monitor: { id: monitorId, name: `Heartbeat ${index}`, type: 'heartbeat' },
          status: 'down',
          message: 'Missed',
        }),
        remainingChannelIds: JSON.stringify([channelId]),
        claimToken: `claim-${index}`,
        claimUntil: now + 30,
        nextAttemptAt: now,
        createdAt: now - 10,
        updatedAt: now,
      })
    }

    const prepare = vi.spyOn(d1, 'prepare')
    const { runCron } = await import('../cron')
    const result = await runCron(makeEnv(d1))

    expect(result.checked).toBe(2)
    expect(result.deferred).toBe(1)
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(50)
  })
})
