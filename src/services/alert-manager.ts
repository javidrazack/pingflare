import { and, asc, eq, gte, inArray, isNull, lte, ne, or, sql } from 'drizzle-orm'
import type { Db } from '../db'
import {
  alertState,
  incidents,
  maintenanceWindows,
  monitorNotifications,
  monitors,
  notificationChannels,
  notificationDeliveries,
  settings,
} from '../db/schema'
import type {
  AlertState,
  Monitor,
  NotificationChannel,
  NotificationDelivery,
} from '../db/schema'
import { sendNotification } from '../notifications'
import type { NotificationPayload } from '../notifications'

let cachedLocale: string | null = null
let cachedLocaleAt = 0

const LOCALE_TTL_MS = 5 * 60 * 1000
const NOTIFICATION_TIMEOUT_MS = 12_000
const DELIVERY_CLAIM_SECONDS = 30
const MAX_PROVIDER_ATTEMPTS_PER_DRAIN = 2
const ATTEMPTS_BEFORE_ROTATION = 3
const INITIAL_RETRY_SECONDS = 30
const MAX_RETRY_SECONDS = 60 * 60
const MAX_ROWS_SCANNED_PER_DRAIN = 2

// With two rows scanned, the worst path is two independent final successes:
// claim + subject + channel + progress + state + delete for each, then COUNT.
export const MAX_NOTIFICATION_DRAIN_D1_QUERIES = 13
export const MIN_NOTIFICATION_DRAIN_D1_QUERIES = 7

type DeliveryEventType = 'alert' | 'recovery' | 'reminder'

interface DeliveryStateTarget {
  eventType: DeliveryEventType
  monitorId: string
  createdAt: number
}

interface DeliverySubject {
  lastStatus: Monitor['lastStatus']
  surgeProtectionLimit: number | null
  alertSentAt: number | null
  maintenanceEndAt: number | null
}

export interface AlertContext {
  db: Db
  monitor: Monitor
  observationRevision?: string
  status: 'up' | 'down'
  message: string
  responseTimeMs?: number | null
  encryptionKey?: string
}

type CurrentAlertContext = AlertContext & { observationRevision: string }

export interface NotificationDrainResult {
  attempted: number
  delivered: number
  deferred: number
}

export async function processAlert(ctx: AlertContext): Promise<void> {
  const observationRevision = ctx.observationRevision
    ?? ctx.monitor.observationRevision
  const currentMonitor = await getCurrentMonitor(
    ctx.db,
    ctx.monitor.id,
    observationRevision,
  )
  if (!currentMonitor) return
  const currentCtx = { ...ctx, monitor: currentMonitor, observationRevision }
  const now = Math.floor(Date.now() / 1000)
  if (currentCtx.status === 'up') {
    await processHealthyObservation(currentCtx, now)
  } else {
    await processFailedObservation(currentCtx, now)
  }
}

function observationIsCurrent(monitorId: string, observationRevision: string) {
  return sql`EXISTS (
    SELECT 1
    FROM ${monitors}
    WHERE ${monitors.id} = ${monitorId}
      AND ${monitors.observationRevision} = ${observationRevision}
  )`
}

async function getCurrentMonitor(
  db: Db,
  monitorId: string,
  observationRevision: string,
): Promise<Monitor | undefined> {
  return db.query.monitors.findFirst({
    where: and(
      eq(monitors.id, monitorId),
      eq(monitors.observationRevision, observationRevision),
    ),
  })
}

async function recordFailedObservation(
  ctx: CurrentAlertContext,
  heartbeatFailure: boolean,
): Promise<AlertState | undefined> {
  const failureIncrement = heartbeatFailure ? 0 : 1
  const missedIncrement = heartbeatFailure ? 1 : 0
  return ctx.db.get<AlertState>(sql`
    INSERT INTO ${alertState} (
      monitor_id, consecutive_failures, consecutive_missed,
      consecutive_alerts
    )
    SELECT
      ${ctx.monitor.id}, ${failureIncrement}, ${missedIncrement}, 0
    FROM ${monitors}
    WHERE ${monitors.id} = ${ctx.monitor.id}
      AND ${monitors.observationRevision} = ${ctx.observationRevision}
    ON CONFLICT(monitor_id) DO UPDATE SET
      consecutive_failures = ${alertState.consecutiveFailures} + ${failureIncrement},
      consecutive_missed = ${alertState.consecutiveMissed} + ${missedIncrement}
    WHERE ${observationIsCurrent(ctx.monitor.id, ctx.observationRevision)}
    RETURNING
      monitor_id AS monitorId,
      consecutive_failures AS consecutiveFailures,
      consecutive_missed AS consecutiveMissed,
      alert_sent_at AS alertSentAt,
      consecutive_alerts AS consecutiveAlerts,
      last_reminder_at AS lastReminderAt,
      surge_paused_until AS surgePausedUntil
  `)
}

async function recordHealthyObservation(
  ctx: CurrentAlertContext,
): Promise<AlertState | undefined> {
  return ctx.db.get<AlertState>(sql`
    INSERT INTO ${alertState} (
      monitor_id, consecutive_failures, consecutive_missed,
      consecutive_alerts
    )
    SELECT ${ctx.monitor.id}, 0, 0, 0
    FROM ${monitors}
    WHERE ${monitors.id} = ${ctx.monitor.id}
      AND ${monitors.observationRevision} = ${ctx.observationRevision}
    ON CONFLICT(monitor_id) DO UPDATE SET
      consecutive_failures = 0,
      consecutive_missed = 0
    WHERE ${observationIsCurrent(ctx.monitor.id, ctx.observationRevision)}
    RETURNING
      monitor_id AS monitorId,
      consecutive_failures AS consecutiveFailures,
      consecutive_missed AS consecutiveMissed,
      alert_sent_at AS alertSentAt,
      consecutive_alerts AS consecutiveAlerts,
      last_reminder_at AS lastReminderAt,
      surge_paused_until AS surgePausedUntil
  `)
}

async function getPotentialDownDelivery(
  db: Db,
  monitorId: string,
  now: number,
): Promise<NotificationDelivery | undefined> {
  const [row] = await db.select()
    .from(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.monitorId, monitorId),
      inArray(notificationDeliveries.eventType, ['alert', 'reminder']),
      or(
        sql`${notificationDeliveries.deliveredCount} > 0`,
        sql`${notificationDeliveries.claimUntil} > ${now}`,
      ),
    ))
    .orderBy(
      sql`CASE WHEN ${notificationDeliveries.eventType} = 'alert' THEN 0 ELSE 1 END`,
      asc(notificationDeliveries.createdAt),
    )
    .limit(1)
  return row
}

async function processHealthyObservation(ctx: CurrentAlertContext, now: number): Promise<void> {
  const { db, monitor, message, responseTimeMs, observationRevision } = ctx

  const state = await recordHealthyObservation(ctx)
  if (!state) return
  let potentialDownDelivery: NotificationDelivery | undefined

  // Preserve the hot paths used by almost every check. A failed recovery is
  // represented by alertSentAt. A claimed DOWN delivery is the other durable
  // signal: the provider may complete after an earlier healthy invocation
  // flipped the monitor UP but crashed before recording that delivery.
  if (monitor.lastStatus === 'up' && !state.alertSentAt) {
    potentialDownDelivery = await getPotentialDownDelivery(db, monitor.id, now)
    if (potentialDownDelivery) {
      // Continue through the conservative partial-delivery repair below.
    } else {
      // Repair a crash between the prior status update and incident close.
      await closeIncidents(db, monitor.id, now, observationRevision)
      return
    }
  }
  if (monitor.lastStatus === 'pending' && !state.alertSentAt) {
    await updateMonitorStatus(db, monitor.id, 'up', observationRevision)
    await closeIncidents(db, monitor.id, now, observationRevision)
    return
  }

  // Monitor truth and incident truth must not depend on an external provider.
  await updateMonitorStatus(db, monitor.id, 'up', observationRevision)
  await closeIncidents(db, monitor.id, now, observationRevision)

  // A claimed row may already be inside provider I/O. Treat it conservatively
  // as potentially delivered and delay recovery until its claim expires. For
  // unclaimed partial fan-out, apply delivery state before deleting the row so
  // a crash can never erase the only proof that a DOWN notification was sent.
  potentialDownDelivery ??= await getPotentialDownDelivery(db, monitor.id, now)
  if (
    potentialDownDelivery?.eventType === 'alert'
    && !potentialDownDelivery.stateApplied
  ) {
    const applied = await applyDeliveryState(db, potentialDownDelivery, {
      lastStatus: 'up',
      surgeProtectionLimit: monitor.surgeProtectionLimit,
      alertSentAt: state.alertSentAt,
      maintenanceEndAt: null,
    }, {
      observationRevision,
      allowAlertWhileUp: true,
    })
    if (!applied) return
  }
  await cancelUnclaimedDeliveries(
    db,
    monitor.id,
    ['alert', 'reminder'],
    now,
    observationRevision,
  )
  const recoveryState = potentialDownDelivery
    ? await getAlertState(db, monitor.id)
    : state

  const activeMaintenance = await getActiveMaintenance(db, monitor.id, now)
  if (activeMaintenance) {
    await cancelUnclaimedDeliveries(
      db,
      monitor.id,
      ['recovery'],
      now,
      observationRevision,
    )
    await resetAlertState(db, monitor.id, observationRevision)
    return
  }
  if (!recoveryState?.alertSentAt) {
    await clearSettledAlertState(db, monitor.id, observationRevision)
    return
  }

  const payload: NotificationPayload = {
    type: 'recovery',
    monitor: {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      url: monitor.url,
    },
    status: 'up',
    message,
    responseTimeMs,
  }
  await enqueueNotification(
    db,
    monitor,
    'recovery',
    `recovery:${monitor.id}:${recoveryState.alertSentAt}`,
    payload,
    now,
    observationRevision,
    potentialDownDelivery?.claimUntil
      ? Math.max(now, potentialDownDelivery.claimUntil) + 1
      : now,
  )
}

async function processFailedObservation(ctx: CurrentAlertContext, now: number): Promise<void> {
  const { db, monitor, message, responseTimeMs, observationRevision } = ctx

  if (await getActiveMaintenance(db, monitor.id, now)) return

  const heartbeatFailure = monitor.type === 'heartbeat'
  let state = await recordFailedObservation(ctx, heartbeatFailure)
  if (!state) return

  const failures = heartbeatFailure
    ? state.consecutiveMissed
    : state.consecutiveFailures
  const tolerance = heartbeatFailure
    ? (monitor.toleranceMissed ?? 1)
    : (monitor.toleranceFailures ?? 1)
  if (failures < tolerance) return

  const openIncidentBeforeTransition = await getOpenIncident(db, monitor.id)
  // A fresh outage invalidates an undelivered recovery from the prior outage.
  // Reset durable alert state before cancelling that recovery: if the Worker
  // dies between those writes, a later failed observation can still enqueue
  // the new outage. A missing incident repairs a crash after an earlier status
  // flip but before this reset.
  const [reopened] = await db.update(monitors)
    .set({ lastStatus: 'down' })
    .where(and(
      eq(monitors.id, monitor.id),
      eq(monitors.lastStatus, 'up'),
      eq(monitors.observationRevision, observationRevision),
    ))
    .returning({ id: monitors.id })
  const repairsIncompleteReopen = monitor.lastStatus === 'down'
    && state.alertSentAt !== null
    && !openIncidentBeforeTransition
  if (reopened || repairsIncompleteReopen) {
    ;[state] = await db.update(alertState)
      .set({
        alertSentAt: null,
        consecutiveAlerts: 0,
        lastReminderAt: null,
        surgePausedUntil: null,
      })
      .where(and(
        eq(alertState.monitorId, monitor.id),
        observationIsCurrent(monitor.id, observationRevision),
      ))
      .returning()
    if (!state) return
    await cancelUnclaimedDeliveries(
      db,
      monitor.id,
      ['recovery'],
      now,
      observationRevision,
    )
  } else {
    await db.update(monitors)
      .set({ lastStatus: 'down' })
      .where(and(
        eq(monitors.id, monitor.id),
        eq(monitors.lastStatus, 'pending'),
        eq(monitors.observationRevision, observationRevision),
      ))
  }

  const incident = await ensureOpenIncident(
    db,
    monitor.id,
    now,
    observationRevision,
  )
  if (!incident) return

  if (state.surgePausedUntil && now < state.surgePausedUntil) return

  if (!state.alertSentAt) {
    const payload: NotificationPayload = {
      type: 'alert',
      monitor: {
        id: monitor.id,
        name: monitor.name,
        type: monitor.type,
        url: monitor.url,
      },
      status: 'down',
      message,
      responseTimeMs,
      incidentStartedAt: incident.startedAt,
    }
    await enqueueNotification(
      db,
      monitor,
      'alert',
      `alert:${monitor.id}:${incident.id}`,
      payload,
      now,
      observationRevision,
    )
    return
  }

  if (!monitor.reminderIntervalHours) return
  const reminderDueAt = (state.lastReminderAt ?? state.alertSentAt)
    + monitor.reminderIntervalHours * 3600
  if (now < reminderDueAt) return

  const payload: NotificationPayload = {
    type: 'reminder',
    monitor: {
      id: monitor.id,
      name: monitor.name,
      type: monitor.type,
      url: monitor.url,
    },
    status: 'down',
    message,
    responseTimeMs,
    incidentStartedAt: incident.startedAt,
  }
  await enqueueNotification(
    db,
    monitor,
    'reminder',
    `reminder:${monitor.id}:${state.alertSentAt}:${reminderDueAt}`,
    payload,
    now,
    observationRevision,
  )
}

async function enqueueNotification(
  db: Db,
  monitor: Monitor,
  eventType: DeliveryEventType,
  dedupeKey: string,
  payload: NotificationPayload,
  now: number,
  observationRevision: string,
  nextAttemptAt = now,
): Promise<void> {
  const [channels, locale] = await Promise.all([
    getChannels(db, monitor.id),
    getLocale(db),
  ])
  payload.locale = locale

  // No configured channel is a valid policy and must not create an empty row
  // that can never make progress.
  if (channels.length === 0) {
    await applyDeliveryState(
      db,
      { eventType, monitorId: monitor.id, createdAt: now },
      {
        lastStatus: eventType === 'recovery' ? 'up' : 'down',
        surgeProtectionLimit: monitor.surgeProtectionLimit,
        alertSentAt: null,
        maintenanceEndAt: null,
      }, { observationRevision },
    )
    return
  }

  await db.run(sql`
    INSERT INTO ${notificationDeliveries} (
      id, dedupe_key, monitor_id, event_type, payload,
      remaining_channel_ids, attempts, delivered_count, state_applied,
      next_attempt_at, claim_token, claim_until, last_error, created_at,
      updated_at
    )
    SELECT
      ${crypto.randomUUID()}, ${dedupeKey}, ${monitor.id}, ${eventType},
      ${JSON.stringify(payload)}, ${JSON.stringify(channels.map(channel => channel.id))},
      0, 0, 0, ${nextAttemptAt}, NULL, NULL, NULL, ${now}, ${now}
    FROM ${monitors}
    WHERE ${monitors.id} = ${monitor.id}
      AND ${monitors.observationRevision} = ${observationRevision}
    ON CONFLICT(dedupe_key) DO NOTHING
  `)
}

/**
 * Drains a globally bounded amount of provider work for one Worker invocation.
 * Call this once after all observations for a cron/request have been enqueued.
 */
export async function drainNotificationDeliveries(
  db: Db,
  encryptionKey?: string,
  now = Math.floor(Date.now() / 1000),
  maxProviderAttempts = MAX_PROVIDER_ATTEMPTS_PER_DRAIN,
): Promise<NotificationDrainResult> {
  const requestedAttempts = Number.isFinite(maxProviderAttempts)
    ? Math.trunc(maxProviderAttempts)
    : MAX_PROVIDER_ATTEMPTS_PER_DRAIN
  const attemptLimit = Math.max(
    1,
    Math.min(MAX_PROVIDER_ATTEMPTS_PER_DRAIN, requestedAttempts),
  )
  const rowScanLimit = Math.min(MAX_ROWS_SCANNED_PER_DRAIN, attemptLimit)
  let attempted = 0
  let delivered = 0
  let rowsScanned = 0

  while (
    attempted < attemptLimit
    && rowsScanned < rowScanLimit
  ) {
    const claimToken = crypto.randomUUID()
    const row = await claimNextDelivery(db, claimToken, now)
    if (!row) break
    rowsScanned += 1

    const remaining = parseChannelIds(row.remainingChannelIds)
    if (!remaining) {
      await deferClaimedDelivery(
        db,
        row,
        claimToken,
        row.attempts + 1,
        now + MAX_RETRY_SECONDS,
        'Invalid remaining channel list',
      )
      continue
    }

    const subject = await getDeliverySubject(db, row.monitorId, now)
    if (!subject) {
      await deleteClaimedDelivery(db, row.id, claimToken)
      continue
    }
    if (
      row.eventType !== 'recovery'
      && subject.maintenanceEndAt !== null
      && subject.maintenanceEndAt >= now
    ) {
      await releaseClaim(
        db,
        row.id,
        claimToken,
        subject.maintenanceEndAt + 1,
        now,
      )
      continue
    }

    let stateApplied = row.stateApplied
    const deliveryEnded = remaining.length === 0
      || (
        row.eventType !== 'recovery'
        && subject.lastStatus === 'up'
        && row.deliveredCount > 0
      )
    if (
      row.eventType === 'recovery'
      && subject.lastStatus === 'down'
      && row.deliveredCount > 0
    ) {
      await reconcileLateRecoveryDelivery(db, row, claimToken, now)
      continue
    }
    if (
      row.eventType !== 'recovery'
      && subject.lastStatus === 'up'
      && row.deliveredCount > 0
    ) {
      await reconcileLateDownDelivery(db, row, subject, claimToken, now)
      // The helper either staged recovery and deleted this row, or released
      // the claim because the monitor changed back to DOWN. In both cases the
      // original snapshot must not continue through the stale relevance path.
      continue
    }
    if (deliveryEnded && row.deliveredCount > 0 && !stateApplied) {
      stateApplied = await applyDeliveryState(db, row, subject)
      if (stateApplied) {
        await db.update(notificationDeliveries)
          .set({ stateApplied: true, updatedAt: now })
          .where(and(
            eq(notificationDeliveries.id, row.id),
            eq(notificationDeliveries.claimToken, claimToken),
          ))
      }
    }

    if (!isDeliveryRelevant(row, subject, stateApplied)) {
      await deleteClaimedDelivery(db, row.id, claimToken)
      continue
    }

    if (remaining.length === 0) {
      if (!stateApplied) {
        stateApplied = await applyDeliveryState(db, row, subject)
      }
      if (stateApplied) {
        await deleteClaimedDelivery(db, row.id, claimToken)
      } else {
        await releaseClaim(db, row.id, claimToken, now + INITIAL_RETRY_SECONDS, now)
      }
      continue
    }

    const activeChannels = await db.select()
      .from(notificationChannels)
      .where(and(
        sql`${notificationChannels.id} IN (
          SELECT value FROM json_each(${JSON.stringify(remaining)})
        )`,
        eq(notificationChannels.active, true),
      ))
    const channelById = new Map(activeChannels.map(channel => [channel.id, channel]))
    const activeRemaining = remaining.filter(id => channelById.has(id))
    const channel = channelById.get(activeRemaining[0])
    if (!channel) {
      stateApplied = stateApplied || await applyDeliveryState(db, row, subject)
      if (stateApplied) {
        await deleteClaimedDelivery(db, row.id, claimToken)
      } else {
        await updateClaimedProgress(db, row.id, claimToken, {
          remainingChannelIds: '[]',
          attempts: 0,
          nextAttemptAt: now + INITIAL_RETRY_SECONDS,
          lastError: null,
          updatedAt: now,
          claimToken: null,
          claimUntil: null,
        })
      }
      continue
    }

    attempted += 1
    try {
      await sendWithTimeout(channel, parsePayload(row.payload), encryptionKey)
      delivered += 1
      const nextRemaining = activeRemaining.slice(1)
      const nextDeliveredCount = row.deliveredCount + 1

      await updateClaimedProgress(db, row.id, claimToken, {
        remainingChannelIds: JSON.stringify(nextRemaining),
        attempts: 0,
        deliveredCount: nextDeliveredCount,
        nextAttemptAt: now,
        lastError: null,
        updatedAt: now,
      })

      if (nextRemaining.length === 0 && !stateApplied) {
        stateApplied = await applyDeliveryState(db, row, subject)
      }

      if (nextRemaining.length === 0 && stateApplied) {
        await deleteClaimedDelivery(db, row.id, claimToken)
      } else {
        await updateClaimedProgress(db, row.id, claimToken, {
          stateApplied,
          claimToken: null,
          claimUntil: null,
          nextAttemptAt: now,
          updatedAt: now,
        })
      }
    } catch (error) {
      const nextAttempts = row.attempts + 1
      const rotate = nextAttempts >= ATTEMPTS_BEFORE_ROTATION && activeRemaining.length > 1
      const nextRemaining = rotate
        ? [...activeRemaining.slice(1), activeRemaining[0]]
        : activeRemaining
      const storedAttempts = rotate ? 0 : nextAttempts
      const retryAt = now + retryDelaySeconds(nextAttempts)
      const errorMessage = error instanceof Error ? error.message : String(error)
      console.error(`[alerts] notification channel ${channel.id} failed`, error)
      await deferClaimedDelivery(
        db,
        row,
        claimToken,
        storedAttempts,
        retryAt,
        errorMessage,
        nextRemaining,
      )
    }
  }

  const [pending] = await db.select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
  return {
    attempted,
    delivered,
    deferred: Number(pending?.count ?? 0),
  }
}

/**
 * A provider may finish a DOWN send after a healthy observation has already
 * flipped the monitor UP. Preserve that externally visible ordering by
 * recording DOWN evidence and staging a recovery before deleting the old row.
 * Each step is idempotent: a crash leaves the claimed DOWN row to drive the
 * same repair after its lease expires.
 */
async function reconcileLateDownDelivery(
  db: Db,
  row: NotificationDelivery,
  subject: DeliverySubject,
  claimToken: string,
  now: number,
): Promise<boolean> {
  const evidenceApplied = await applyDeliveryState(
    db,
    {
      eventType: 'alert',
      monitorId: row.monitorId,
      createdAt: row.createdAt,
    },
    subject,
    { allowAlertWhileUp: true },
  )
  if (!evidenceApplied) {
    await releaseClaim(db, row.id, claimToken, now + 1, now)
    return false
  }

  const downPayload = parsePayload(row.payload)
  const recoveryPayload: NotificationPayload = {
    type: 'recovery',
    monitor: downPayload.monitor,
    status: 'up',
    message: 'Recovered',
    locale: downPayload.locale,
  }
  const recoveryKey = `recovery:${row.monitorId}:${row.createdAt}`
  const queued = await db.get<{ id: string }>(sql`
    INSERT INTO ${notificationDeliveries} (
      id, dedupe_key, monitor_id, event_type, payload,
      remaining_channel_ids, attempts, delivered_count, state_applied,
      next_attempt_at, claim_token, claim_until, last_error, created_at,
      updated_at
    )
    SELECT
      ${crypto.randomUUID()}, ${recoveryKey}, ${row.monitorId}, 'recovery',
      ${JSON.stringify(recoveryPayload)},
      COALESCE((
        SELECT json_group_array(channel_id)
        FROM (
          SELECT ${notificationChannels.id} AS channel_id
          FROM ${monitorNotifications}
          INNER JOIN ${notificationChannels}
            ON ${notificationChannels.id} = ${monitorNotifications.channelId}
          WHERE ${monitorNotifications.monitorId} = ${row.monitorId}
            AND ${notificationChannels.active} = 1
          ORDER BY ${notificationChannels.id}
        )
      ), '[]'),
      0, 0, 0, ${now}, NULL, NULL, NULL, ${now}, ${now}
    FROM ${monitors}
    WHERE ${monitors.id} = ${row.monitorId}
      AND ${monitors.lastStatus} = 'up'
    ON CONFLICT(dedupe_key) DO UPDATE SET
      updated_at = ${notificationDeliveries.updatedAt}
    RETURNING id
  `)
  if (!queued) {
    await releaseClaim(db, row.id, claimToken, now + 1, now)
    return false
  }

  await deleteClaimedDelivery(db, row.id, claimToken)
  return true
}

/**
 * Mirror the late-DOWN repair: if a recovery provider call completed after a
 * new outage became authoritative, retain or stage a corrective DOWN delivery
 * before deleting the stale recovery. This keeps the last externally visible
 * notification aligned with current monitor truth.
 */
async function reconcileLateRecoveryDelivery(
  db: Db,
  row: NotificationDelivery,
  claimToken: string,
  now: number,
): Promise<boolean> {
  const existingUnsentAlert = await db.query.notificationDeliveries.findFirst({
    columns: { id: true },
    where: and(
      eq(notificationDeliveries.monitorId, row.monitorId),
      eq(notificationDeliveries.eventType, 'alert'),
      ne(notificationDeliveries.id, row.id),
      eq(notificationDeliveries.deliveredCount, 0),
      ne(notificationDeliveries.remainingChannelIds, '[]'),
    ),
  })
  if (existingUnsentAlert) {
    await deleteClaimedDelivery(db, row.id, claimToken)
    return true
  }

  const recoveryPayload = parsePayload(row.payload)
  const correctivePayload: NotificationPayload = {
    type: 'alert',
    monitor: recoveryPayload.monitor,
    status: 'down',
    message: 'Down again',
    locale: recoveryPayload.locale,
  }
  const correctiveKey = `corrective-alert:${row.id}`
  const queued = await db.get<{ id: string }>(sql`
    INSERT INTO ${notificationDeliveries} (
      id, dedupe_key, monitor_id, event_type, payload,
      remaining_channel_ids, attempts, delivered_count, state_applied,
      next_attempt_at, claim_token, claim_until, last_error, created_at,
      updated_at
    )
    SELECT
      ${crypto.randomUUID()}, ${correctiveKey}, ${row.monitorId}, 'alert',
      ${JSON.stringify(correctivePayload)},
      COALESCE((
        SELECT json_group_array(channel_id)
        FROM (
          SELECT ${notificationChannels.id} AS channel_id
          FROM ${monitorNotifications}
          INNER JOIN ${notificationChannels}
            ON ${notificationChannels.id} = ${monitorNotifications.channelId}
          WHERE ${monitorNotifications.monitorId} = ${row.monitorId}
            AND ${notificationChannels.active} = 1
          ORDER BY ${notificationChannels.id}
        )
      ), '[]'),
      0, 0, 1, ${now}, NULL, NULL, NULL, ${now}, ${now}
    FROM ${monitors}
    WHERE ${monitors.id} = ${row.monitorId}
      AND ${monitors.lastStatus} = 'down'
    ON CONFLICT(dedupe_key) DO UPDATE SET
      updated_at = ${notificationDeliveries.updatedAt}
    RETURNING id
  `)
  if (!queued) {
    await releaseClaim(db, row.id, claimToken, now + 1, now)
    return false
  }

  await deleteClaimedDelivery(db, row.id, claimToken)
  return true
}

async function claimNextDelivery(
  db: Db,
  claimToken: string,
  now: number,
): Promise<NotificationDelivery | undefined> {
  const [row] = await db.update(notificationDeliveries)
    .set({
      claimToken,
      claimUntil: now + DELIVERY_CLAIM_SECONDS,
      updatedAt: now,
    })
    .where(sql`${notificationDeliveries.id} = (
      SELECT ${notificationDeliveries.id}
      FROM ${notificationDeliveries}
      WHERE ${notificationDeliveries.nextAttemptAt} <= ${now}
        AND (
          ${notificationDeliveries.claimUntil} IS NULL
          OR ${notificationDeliveries.claimUntil} <= ${now}
        )
        AND NOT EXISTS (
          SELECT 1
          FROM notification_deliveries AS in_flight
          WHERE in_flight.monitor_id = ${notificationDeliveries.monitorId}
            AND in_flight.id <> ${notificationDeliveries.id}
            AND in_flight.claim_until > ${now}
        )
      ORDER BY
        ${notificationDeliveries.nextAttemptAt},
        ${notificationDeliveries.createdAt}
      LIMIT 1
    )`)
    .returning()
  return row
}

async function getDeliverySubject(
  db: Db,
  monitorId: string,
  now: number,
): Promise<DeliverySubject | undefined> {
  const [row] = await db.select({
    lastStatus: monitors.lastStatus,
    surgeProtectionLimit: monitors.surgeProtectionLimit,
    alertSentAt: alertState.alertSentAt,
    maintenanceEndAt: sql<number | null>`(
      SELECT MAX(${maintenanceWindows.endAt})
      FROM ${maintenanceWindows}
      WHERE ${maintenanceWindows.monitorId} = ${monitors.id}
        AND ${maintenanceWindows.startAt} <= ${now}
        AND ${maintenanceWindows.endAt} >= ${now}
    )`,
  })
    .from(monitors)
    .leftJoin(alertState, eq(alertState.monitorId, monitors.id))
    .where(eq(monitors.id, monitorId))
    .limit(1)
  return row
}

function isDeliveryRelevant(
  row: NotificationDelivery,
  subject: DeliverySubject,
  stateApplied: boolean,
): boolean {
  if (row.eventType === 'recovery') {
    return subject.lastStatus === 'up' && (stateApplied || subject.alertSentAt !== null)
  }
  if (subject.lastStatus !== 'down') return false
  if (row.eventType === 'alert') {
    return stateApplied
      || subject.alertSentAt === null
      || subject.alertSentAt === row.createdAt
  }
  return stateApplied || subject.alertSentAt !== null
}

async function applyDeliveryState(
  db: Db,
  target: DeliveryStateTarget,
  subject: DeliverySubject,
  options: {
    observationRevision?: string
    allowAlertWhileUp?: boolean
  } = {},
): Promise<boolean> {
  const revisionGuard = options.observationRevision
    ? observationIsCurrent(target.monitorId, options.observationRevision)
    : undefined
  if (target.eventType === 'alert') {
    const limit = subject.surgeProtectionLimit
    const [applied] = await db.update(alertState)
      .set({
        alertSentAt: sql`CASE
          WHEN ${alertState.alertSentAt} IS NULL THEN ${target.createdAt}
          ELSE ${alertState.alertSentAt}
        END`,
        consecutiveAlerts: sql`CASE
          WHEN ${alertState.alertSentAt} IS NULL
            THEN ${alertState.consecutiveAlerts} + 1
          ELSE ${alertState.consecutiveAlerts}
        END`,
        lastReminderAt: sql`CASE
          WHEN ${alertState.alertSentAt} IS NULL THEN ${target.createdAt}
          ELSE ${alertState.lastReminderAt}
        END`,
        surgePausedUntil: limit
          ? sql`CASE
              WHEN ${alertState.alertSentAt} IS NOT NULL
                THEN ${alertState.surgePausedUntil}
              WHEN ${alertState.consecutiveAlerts} + 1 >= ${limit}
                THEN ${target.createdAt + 3600}
              ELSE NULL
            END`
          : null,
      })
      .where(and(
        eq(alertState.monitorId, target.monitorId),
        options.allowAlertWhileUp
          ? undefined
          : sql`EXISTS (
              SELECT 1
              FROM ${monitors}
              WHERE ${monitors.id} = ${target.monitorId}
                AND ${monitors.lastStatus} = 'down'
            )`,
        revisionGuard,
        or(
          isNull(alertState.alertSentAt),
          eq(alertState.alertSentAt, target.createdAt),
        ),
      ))
      .returning({ monitorId: alertState.monitorId })
    return Boolean(applied)
  }

  if (target.eventType === 'reminder') {
    const [applied] = await db.update(alertState)
      .set({
        lastReminderAt: sql`MAX(
          COALESCE(${alertState.lastReminderAt}, 0),
          ${target.createdAt}
        )`,
      })
      .where(and(
        eq(alertState.monitorId, target.monitorId),
        sql`${alertState.alertSentAt} IS NOT NULL`,
        sql`EXISTS (
          SELECT 1
          FROM ${monitors}
          WHERE ${monitors.id} = ${target.monitorId}
            AND ${monitors.lastStatus} = 'down'
        )`,
        revisionGuard,
      ))
      .returning({ monitorId: alertState.monitorId })
    return Boolean(applied)
  }

  const [applied] = await db.update(alertState)
    .set({
      consecutiveFailures: 0,
      consecutiveMissed: 0,
      alertSentAt: null,
      consecutiveAlerts: 0,
      lastReminderAt: null,
      surgePausedUntil: null,
    })
    .where(and(
      eq(alertState.monitorId, target.monitorId),
      sql`EXISTS (
        SELECT 1
        FROM ${monitors}
        WHERE ${monitors.id} = ${target.monitorId}
          AND ${monitors.lastStatus} = 'up'
      )`,
      revisionGuard,
    ))
    .returning({ monitorId: alertState.monitorId })
  return Boolean(applied)
}

async function sendWithTimeout(
  channel: NotificationChannel,
  payload: NotificationPayload,
  encryptionKey?: string,
): Promise<void> {
  const controller = new AbortController()
  return new Promise<void>((resolve, reject) => {
    const timeoutError = new Error(`Notification channel ${channel.id} timed out`)
    const timer = setTimeout(() => {
      controller.abort(timeoutError)
      reject(timeoutError)
    }, NOTIFICATION_TIMEOUT_MS)

    sendNotification(channel, payload, encryptionKey, controller.signal).then(
      () => {
        clearTimeout(timer)
        resolve()
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

async function ensureOpenIncident(
  db: Db,
  monitorId: string,
  now: number,
  observationRevision: string,
) {
  await db.run(sql`
    INSERT INTO ${incidents} (id, monitor_id, started_at)
    SELECT ${crypto.randomUUID()}, ${monitorId}, ${now}
    FROM ${monitors}
    WHERE ${monitors.id} = ${monitorId}
      AND ${monitors.observationRevision} = ${observationRevision}
    ON CONFLICT DO NOTHING
  `)

  return getOpenIncident(db, monitorId)
}

async function closeIncidents(
  db: Db,
  monitorId: string,
  now: number,
  observationRevision: string,
): Promise<void> {
  await db.update(incidents)
    .set({
      resolvedAt: now,
      durationSeconds: sql`MAX(0, ${now} - ${incidents.startedAt})`,
    })
    .where(and(
      eq(incidents.monitorId, monitorId),
      isNull(incidents.resolvedAt),
      observationIsCurrent(monitorId, observationRevision),
    ))
}

async function updateMonitorStatus(
  db: Db,
  monitorId: string,
  status: Monitor['lastStatus'],
  observationRevision: string,
): Promise<void> {
  await db.update(monitors)
    .set({ lastStatus: status })
    .where(and(
      eq(monitors.id, monitorId),
      eq(monitors.observationRevision, observationRevision),
      ne(monitors.lastStatus, status),
    ))
}

async function clearSettledAlertState(
  db: Db,
  monitorId: string,
  observationRevision: string,
): Promise<void> {
  await db.update(alertState)
    .set({
      consecutiveFailures: 0,
      consecutiveMissed: 0,
      consecutiveAlerts: 0,
      lastReminderAt: null,
      surgePausedUntil: null,
    })
    .where(and(
      eq(alertState.monitorId, monitorId),
      isNull(alertState.alertSentAt),
      observationIsCurrent(monitorId, observationRevision),
    ))
}

async function resetAlertState(
  db: Db,
  monitorId: string,
  observationRevision: string,
): Promise<void> {
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
      eq(alertState.monitorId, monitorId),
      observationIsCurrent(monitorId, observationRevision),
    ))
}

async function getAlertState(db: Db, monitorId: string): Promise<AlertState | undefined> {
  return db.query.alertState.findFirst({
    where: eq(alertState.monitorId, monitorId),
  })
}

async function getOpenIncident(db: Db, monitorId: string) {
  return db.query.incidents.findFirst({
    where: and(
      eq(incidents.monitorId, monitorId),
      isNull(incidents.resolvedAt),
    ),
    orderBy: asc(incidents.startedAt),
  })
}

async function getActiveMaintenance(db: Db, monitorId: string, now: number) {
  return db.query.maintenanceWindows.findFirst({
    where: and(
      eq(maintenanceWindows.monitorId, monitorId),
      lte(maintenanceWindows.startAt, now),
      gte(maintenanceWindows.endAt, now),
    ),
  })
}

async function getChannels(db: Db, monitorId: string): Promise<NotificationChannel[]> {
  const rows = await db
    .select({ channel: notificationChannels })
    .from(monitorNotifications)
    .innerJoin(
      notificationChannels,
      eq(monitorNotifications.channelId, notificationChannels.id),
    )
    .where(and(
      eq(monitorNotifications.monitorId, monitorId),
      eq(notificationChannels.active, true),
    ))
    .orderBy(asc(notificationChannels.id))
  return rows.map(row => row.channel)
}

async function cancelUnclaimedDeliveries(
  db: Db,
  monitorId: string,
  eventTypes: DeliveryEventType[],
  now: number,
  observationRevision: string,
): Promise<NotificationDelivery[]> {
  return db.delete(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.monitorId, monitorId),
      inArray(notificationDeliveries.eventType, eventTypes),
      or(
        isNull(notificationDeliveries.claimUntil),
        lte(notificationDeliveries.claimUntil, now),
      ),
      observationIsCurrent(monitorId, observationRevision),
    ))
    .returning()
}

async function deleteClaimedDelivery(
  db: Db,
  id: string,
  claimToken: string,
): Promise<void> {
  await db.delete(notificationDeliveries)
    .where(and(
      eq(notificationDeliveries.id, id),
      eq(notificationDeliveries.claimToken, claimToken),
    ))
}

async function releaseClaim(
  db: Db,
  id: string,
  claimToken: string,
  nextAttemptAt: number,
  now: number,
): Promise<void> {
  await updateClaimedProgress(db, id, claimToken, {
    claimToken: null,
    claimUntil: null,
    nextAttemptAt,
    updatedAt: now,
  })
}

async function deferClaimedDelivery(
  db: Db,
  row: NotificationDelivery,
  claimToken: string,
  attempts: number,
  nextAttemptAt: number,
  lastError: string,
  remainingChannelIds?: string[],
): Promise<void> {
  await updateClaimedProgress(db, row.id, claimToken, {
    attempts,
    nextAttemptAt,
    lastError: lastError.slice(0, 2000),
    remainingChannelIds: remainingChannelIds
      ? JSON.stringify(remainingChannelIds)
      : row.remainingChannelIds,
    claimToken: null,
    claimUntil: null,
    updatedAt: Math.floor(Date.now() / 1000),
  })
}

async function updateClaimedProgress(
  db: Db,
  id: string,
  claimToken: string,
  values: Partial<typeof notificationDeliveries.$inferInsert>,
): Promise<void> {
  await db.update(notificationDeliveries)
    .set(values)
    .where(and(
      eq(notificationDeliveries.id, id),
      eq(notificationDeliveries.claimToken, claimToken),
    ))
}

function retryDelaySeconds(attempts: number): number {
  return Math.min(
    MAX_RETRY_SECONDS,
    INITIAL_RETRY_SECONDS * 2 ** Math.min(Math.max(0, attempts - 1), 7),
  )
}

function parseChannelIds(value: string): string[] | null {
  try {
    const parsed: unknown = JSON.parse(value)
    if (
      !Array.isArray(parsed)
      || parsed.length > 10_000
      || parsed.some(id => typeof id !== 'string' || id.length === 0)
    ) return null
    return [...new Set(parsed)]
  } catch {
    return null
  }
}

function parsePayload(value: string): NotificationPayload {
  const parsed: unknown = JSON.parse(value)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid notification payload')
  }
  return parsed as NotificationPayload
}

export async function getLocale(db: Db): Promise<string> {
  const now = Date.now()
  if (
    cachedLocale
    && now >= cachedLocaleAt
    && now - cachedLocaleAt < LOCALE_TTL_MS
  ) return cachedLocale
  const row = await db.query.settings.findFirst({
    where: eq(settings.key, 'locale'),
  })
  cachedLocale = row?.value ?? 'en'
  cachedLocaleAt = now
  return cachedLocale
}
