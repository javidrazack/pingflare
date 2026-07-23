import { and, eq, gte, lte } from 'drizzle-orm'
import type { Db } from '../db'

let cachedLocale: string | null = null
let cachedLocaleAt = 0
const LOCALE_TTL_MS = 5 * 60 * 1000
import { alertState, incidents, maintenanceWindows, monitorNotifications, monitors, notificationChannels, settings } from '../db/schema'
import type { Monitor, AlertState, NotificationChannel } from '../db/schema'
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

  const activeMaintenance = await db.query.maintenanceWindows.findFirst({
    where: and(
      eq(maintenanceWindows.monitorId, monitor.id),
      lte(maintenanceWindows.startAt, now),
      gte(maintenanceWindows.endAt, now)
    )
  })

  if (activeMaintenance) {
    await db.update(monitors).set({
      lastCheckedAt: now,
    }).where(eq(monitors.id, monitor.id))
    return
  }

  let state = await db.query.alertState.findFirst({
    where: eq(alertState.monitorId, monitor.id),
  })

  if (!state) {
    await db.insert(alertState).values({ monitorId: monitor.id })
    state = {
      monitorId: monitor.id,
      consecutiveFailures: 0,
      consecutiveMissed: 0,
      alertSentAt: null,
      consecutiveAlerts: 0,
      lastReminderAt: null,
      surgePausedUntil: null,
    }
  }

  const channels = await getChannels(db, monitor.id)
  const locale = await getLocale(db)
  const prevStatus = monitor.lastStatus

  if (status === 'down') {
    const newFailures = (monitor.type === 'heartbeat'
      ? state.consecutiveMissed
      : state.consecutiveFailures) + 1

    if (monitor.type === 'heartbeat') {
      await db.update(alertState)
        .set({ consecutiveMissed: newFailures })
        .where(eq(alertState.monitorId, monitor.id))
    } else {
      await db.update(alertState)
        .set({ consecutiveFailures: newFailures })
        .where(eq(alertState.monitorId, monitor.id))
    }

    const tolerance = monitor.type === 'heartbeat'
      ? (monitor.toleranceMissed ?? 1)
      : (monitor.toleranceFailures ?? 1)

    if (newFailures < tolerance) {
      await updateMonitorStatus(db, monitor.id, now, prevStatus)
      return
    }

    if (state.surgePausedUntil && now < state.surgePausedUntil) {
      await updateMonitorStatus(db, monitor.id, now, 'down')
      return
    }

    if (prevStatus !== 'down') {
      const payload: NotificationPayload = {
        type: 'alert',
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: 'down',
        message,
        responseTimeMs,
        locale,
      }
      await dispatchToChannels(channels, payload, encryptionKey)
      await openIncident(db, monitor.id, now)
      await db.update(alertState)
        .set({ alertSentAt: now, consecutiveAlerts: (state.consecutiveAlerts ?? 0) + 1, lastReminderAt: now })
        .where(eq(alertState.monitorId, monitor.id))

      const limit = monitor.surgeProtectionLimit
      if (limit && (state.consecutiveAlerts + 1) >= limit) {
        const pauseUntil = now + 3600
        await db.update(alertState)
          .set({ surgePausedUntil: pauseUntil })
          .where(eq(alertState.monitorId, monitor.id))
      }
    } else {
      if (monitor.reminderIntervalHours && state.alertSentAt) {
        const reminderThreshold = (state.lastReminderAt ?? state.alertSentAt) + monitor.reminderIntervalHours * 3600
        if (now >= reminderThreshold) {
          const incident = await getOpenIncident(db, monitor.id)
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
    await updateMonitorStatus(db, monitor.id, now, 'down')

  } else {
    const wasDown = prevStatus === 'down'
    const orphanedIncident = !wasDown ? await getOpenIncident(db, monitor.id) : null

    if (wasDown || orphanedIncident) {
      const payload: NotificationPayload = {
        type: 'recovery',
        monitor: { id: monitor.id, name: monitor.name, type: monitor.type, url: monitor.url },
        status: 'up',
        message,
        responseTimeMs,
        locale,
      }
      await dispatchToChannels(channels, payload, encryptionKey)
      await closeIncident(db, monitor.id, now)
    }

    const needsReset = state.consecutiveFailures !== 0
      || state.consecutiveMissed !== 0
      || state.alertSentAt !== null
      || state.consecutiveAlerts !== 0
      || state.lastReminderAt !== null
      || state.surgePausedUntil !== null

    if (needsReset) {
      await db.update(alertState)
        .set({
          consecutiveFailures: 0,
          consecutiveMissed: 0,
          alertSentAt: null,
          consecutiveAlerts: 0,
          lastReminderAt: null,
          surgePausedUntil: null,
        })
        .where(eq(alertState.monitorId, monitor.id))
    }
    await updateMonitorStatus(db, monitor.id, now, 'up')
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

async function dispatchToChannels(channels: NotificationChannel[], payload: NotificationPayload, encryptionKey?: string) {
  const results = await Promise.allSettled(channels.map(ch => sendNotification(ch, payload, encryptionKey)))
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason)
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} notification channel(s) failed`)
  }
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
  now: number,
  status: 'pending' | 'up' | 'down'
) {
  await db.update(monitors)
    .set({ lastCheckedAt: now, lastStatus: status })
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
