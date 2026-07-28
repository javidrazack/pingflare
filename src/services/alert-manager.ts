import { and, eq, gte, lte, sql } from 'drizzle-orm'
import type { Db } from '../db'

let cachedLocale: string | null = null
let cachedLocaleAt = 0
const LOCALE_TTL_MS = 5 * 60 * 1000
const NOTIFICATION_TIMEOUT_MS = 15_000
import { alertState, incidents, maintenanceWindows, monitorNotifications, monitors, notificationChannels, settings } from '../db/schema'
import type { Monitor, NotificationChannel } from '../db/schema'
import { sendNotification } from '../notifications'
import type { NotificationPayload } from '../notifications'

export interface AlertContext {
  db: Db
  monitor: Monitor
  status: 'up' | 'down'
  message: string
  responseTimeMs?: number | null
  encryptionKey?: string
}

export async function processAlert(ctx: AlertContext): Promise<void> {
  const { db, monitor, status, message, responseTimeMs, encryptionKey } = ctx
  const now = Math.floor(Date.now() / 1000)
  const prevStatus = monitor.lastStatus

  // Every successful observation must break a sub-tolerance failure streak.
  // Keep this to one conditional write and avoid an alert-state read.
  if (status === 'up') {
    await db.update(alertState)
      .set({
        consecutiveFailures: 0,
        consecutiveMissed: 0,
        alertSentAt: null,
        consecutiveAlerts: 0,
        lastReminderAt: null,
        surgePausedUntil: null,
      })
      .where(and(
        eq(alertState.monitorId, monitor.id),
        sql`(
          ${alertState.consecutiveFailures} <> 0
          OR ${alertState.consecutiveMissed} <> 0
          OR ${alertState.alertSentAt} IS NOT NULL
          OR ${alertState.consecutiveAlerts} <> 0
          OR ${alertState.lastReminderAt} IS NOT NULL
          OR ${alertState.surgePausedUntil} IS NOT NULL
        )`,
      ))
    if (prevStatus === 'up') return
  }

  const activeMaintenance = await db.query.maintenanceWindows.findFirst({
    where: and(
      eq(maintenanceWindows.monitorId, monitor.id),
      lte(maintenanceWindows.startAt, now),
      gte(maintenanceWindows.endAt, now)
    )
  })

  if (activeMaintenance) {
    return
  }

  if (status === 'up' && prevStatus === 'pending') {
    await updateMonitorStatus(db, monitor.id, 'up')
    return
  }

  if (status === 'down') {
    const heartbeatFailure = monitor.type === 'heartbeat'
    const [state] = await db.insert(alertState)
      .values({
        monitorId: monitor.id,
        consecutiveFailures: heartbeatFailure ? 0 : 1,
        consecutiveMissed: heartbeatFailure ? 1 : 0,
      })
      .onConflictDoUpdate({
        target: alertState.monitorId,
        set: heartbeatFailure
          ? { consecutiveMissed: sql`${alertState.consecutiveMissed} + 1` }
          : { consecutiveFailures: sql`${alertState.consecutiveFailures} + 1` },
      })
      .returning()
    const newFailures = heartbeatFailure
      ? state.consecutiveMissed
      : state.consecutiveFailures

    const tolerance = monitor.type === 'heartbeat'
      ? (monitor.toleranceMissed ?? 1)
      : (monitor.toleranceFailures ?? 1)

    if (newFailures < tolerance) {
      return
    }

    if (state.surgePausedUntil && now < state.surgePausedUntil) {
      if (prevStatus !== 'down') await updateMonitorStatus(db, monitor.id, 'down')
      return
    }

    const retryingUndeliveredAlert = prevStatus === 'down' && state.alertSentAt === null
    if (prevStatus !== 'down' || retryingUndeliveredAlert) {
      const [channels, locale] = await Promise.all([
        getChannels(db, monitor.id),
        getLocale(db),
      ])
      const payload: NotificationPayload = {
        type: 'alert',
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: 'down',
        message,
        responseTimeMs,
        locale,
      }
      await openIncident(db, monitor.id, now)
      if (prevStatus !== 'down') await updateMonitorStatus(db, monitor.id, 'down')
      const deliveredCount = await dispatchToChannels(channels, payload, encryptionKey)
      // No configured channels is a valid notification policy. When channels
      // exist, leave alertSentAt null after a total provider failure so the
      // next down observation retries the initial alert.
      if (channels.length === 0 || deliveredCount > 0) {
        const nextConsecutiveAlerts = (state.consecutiveAlerts ?? 0) + 1
        const limit = monitor.surgeProtectionLimit
        await db.update(alertState)
          .set({
            alertSentAt: now,
            consecutiveAlerts: nextConsecutiveAlerts,
            lastReminderAt: now,
            surgePausedUntil: limit && nextConsecutiveAlerts >= limit ? now + 3600 : null,
          })
          .where(eq(alertState.monitorId, monitor.id))
      }
    } else {
      if (monitor.reminderIntervalHours && state.alertSentAt) {
        const reminderThreshold = (state.lastReminderAt ?? state.alertSentAt) + monitor.reminderIntervalHours * 3600
        if (now >= reminderThreshold) {
          const [incident, channels, locale] = await Promise.all([
            getOpenIncident(db, monitor.id),
            getChannels(db, monitor.id),
            getLocale(db),
          ])
          const payload: NotificationPayload = {
            type: 'reminder',
            monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
            status: 'down',
            message,
            responseTimeMs,
            incidentStartedAt: incident?.startedAt,
            locale,
          }
          await dispatchToChannels(channels, payload, encryptionKey)
          await db.update(alertState)
            .set({ lastReminderAt: now })
            .where(eq(alertState.monitorId, monitor.id))
        }
      }
    }
  } else {
    const wasDown = prevStatus === 'down'
    if (wasDown) {
      const [channels, locale] = await Promise.all([
        getChannels(db, monitor.id),
        getLocale(db),
      ])
      const payload: NotificationPayload = {
        type: 'recovery',
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: 'up',
        message,
        responseTimeMs,
        locale,
      }
      await closeIncident(db, monitor.id, now)
      await updateMonitorStatus(db, monitor.id, 'up')
      await dispatchToChannels(channels, payload, encryptionKey)
    } else {
      await updateMonitorStatus(db, monitor.id, 'up')
    }
  }
}

async function getChannels(db: Db, monitorId: string): Promise<NotificationChannel[]> {
  const rows = await db
    .select({ channel: notificationChannels })
    .from(monitorNotifications)
    .innerJoin(notificationChannels, eq(monitorNotifications.channelId, notificationChannels.id))
    .where(eq(monitorNotifications.monitorId, monitorId))
  return rows.filter(r => r.channel.active).map(r => r.channel)
}

async function dispatchToChannels(
  channels: NotificationChannel[],
  payload: NotificationPayload,
  encryptionKey?: string,
): Promise<number> {
  const results = await Promise.allSettled(channels.map((channel) =>
    withTimeout(
      Promise.resolve().then(() => sendNotification(channel, payload, encryptionKey)),
      NOTIFICATION_TIMEOUT_MS,
      `Notification channel ${channel.id} timed out`,
    )
  ))
  let deliveredCount = 0
  for (let index = 0; index < results.length; index += 1) {
    const result = results[index]
    if (result.status === 'rejected') {
      console.error(`[alerts] notification channel ${channels[index]?.id ?? index} failed`, result.reason)
    } else {
      deliveredCount += 1
    }
  }
  return deliveredCount
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function openIncident(db: Db, monitorId: string, now: number) {
  if (await getOpenIncident(db, monitorId)) return
  await db.insert(incidents).values({
    id: crypto.randomUUID(),
    monitorId,
    startedAt: now,
  })
}

async function updateMonitorStatus(
  db: Db,
  monitorId: string,
  status: 'pending' | 'up' | 'down'
) {
  await db.update(monitors)
    .set({ lastStatus: status })
    .where(eq(monitors.id, monitorId))
}

async function getOpenIncident(db: Db, monitorId: string) {
  return db.query.incidents.findFirst({
    where: (i, { and, eq, isNull }) => and(eq(i.monitorId, monitorId), isNull(i.resolvedAt)),
  })
}

async function closeIncident(db: Db, monitorId: string, now: number) {
  const incident = await getOpenIncident(db, monitorId)
  if (!incident) return
  await db.update(incidents)
    .set({ resolvedAt: now, durationSeconds: now - incident.startedAt })
    .where(eq(incidents.id, incident.id))
}

export async function getLocale(db: Db): Promise<string> {
  if (cachedLocale && Date.now() - cachedLocaleAt < LOCALE_TTL_MS) return cachedLocale
  const row = await db.query.settings.findFirst({ where: eq(settings.key, 'locale') })
  cachedLocale = row?.value ?? 'en'
  cachedLocaleAt = Date.now()
  return cachedLocale
}
