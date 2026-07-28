import { and, eq, inArray, lte, sql } from 'drizzle-orm'
import { alertState, getDb, heartbeatTokens, monitors } from './db'
import { checkHttp, checkDns, checkPing, MAX_CHECK_DEADLINE_MS } from './services/checker'
import { checkHeartbeat } from './services/heartbeat-checker'
import { parseAgentSnapshot } from './services/agent-status'
import {
  drainNotificationDeliveries,
  getLocale,
  MAX_NOTIFICATION_DRAIN_D1_QUERIES,
  MIN_NOTIFICATION_DRAIN_D1_QUERIES,
  processAlert,
} from './services/alert-manager'
import { persistCheckObservations, type CheckObservation } from './services/check-storage'
import type { Env } from './index'

let cachedOrigin: { colo: string; countryCode: string } | null = null
let cachedOriginAt = 0
const ORIGIN_TTL_MS = 5 * 60 * 1000
export const RETENTION_INTERVAL_SECONDS = 60 * 60
export const RETENTION_DELETE_LIMIT = 200
const RETENTION_NEXT_AT_MARKER = '_retention_cleanup_next_at_v1'
const SCHEDULER_LEASE_SECONDS = Math.ceil(MAX_CHECK_DEADLINE_MS / 1000) + 60
const MAX_CHECKS_PER_RUN = 8
const CHECK_CONCURRENCY = 6
const WORKER_D1_QUERY_BUDGET = 50
// Outside the admission loop, a worst-case cron uses nine D1 queries:
// acquire/release lease, due selection, retention pacing/delete, inbound
// heartbeat prefetch, alert-state prefetch, locale lookup, and the final lease
// renewal. Two additional slots are held for the batched alert retry marker
// and its one fallback attempt. Legacy catch-up plus per-batch renewals are
// counted dynamically.
const MAX_FIXED_CRON_D1_QUERIES = 11
const OBSERVATION_D1_QUERY_BUDGET =
  WORKER_D1_QUERY_BUDGET
  - MIN_NOTIFICATION_DRAIN_D1_QUERIES
  - MAX_FIXED_CRON_D1_QUERIES
const MAX_ESTIMATED_OBSERVATION_QUERIES = 15
const LEGACY_CATCHUP_MARKER = '_schema_legacy_gap_catchup_v1'
const LEGACY_CATCHUP_CURSOR = '_schema_legacy_gap_cursor_v1'
const LEGACY_CATCHUP_NEXT_AT = '_schema_legacy_gap_next_at_v1'
const LEGACY_CATCHUP_BATCH_SIZE = 25
export const LEGACY_CATCHUP_INTERVAL_SECONDS = 5 * 60

export interface CronResult {
  checked: number
  deferred: number
  diagnosticsWritten: number
  skippedBecauseLeased: boolean
}

async function getWorkerOrigin(): Promise<{ colo: string; countryCode: string } | null> {
  if (cachedOrigin && Date.now() - cachedOriginAt < ORIGIN_TTL_MS) return cachedOrigin
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) })
    const text = await res.text()
    const colo = text.match(/^colo=(.+)$/m)?.[1] ?? null
    const countryCode = text.match(/^loc=(.+)$/m)?.[1] ?? null
    if (!colo || !countryCode) return null
    cachedOrigin = { colo, countryCode }
    cachedOriginAt = Date.now()
    return cachedOrigin
  } catch {
    return null
  }
}

async function acquireSchedulerLease(env: Env, holder: string, now: number): Promise<boolean> {
  const row = await env.DB.prepare(`
    INSERT INTO scheduler_leases (name, holder, lease_until, updated_at)
    VALUES ('monitor-cron', ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      holder = excluded.holder,
      lease_until = excluded.lease_until,
      updated_at = excluded.updated_at
    WHERE scheduler_leases.lease_until <= excluded.updated_at
    RETURNING holder
  `).bind(holder, now + SCHEDULER_LEASE_SECONDS, now).first<{ holder: string }>()
  return row?.holder === holder
}

async function releaseSchedulerLease(env: Env, holder: string): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM scheduler_leases WHERE name = 'monitor-cron' AND holder = ?`,
  ).bind(holder).run()
}

async function renewSchedulerLease(env: Env, holder: string): Promise<boolean> {
  const now = Math.floor(Date.now() / 1000)
  const row = await env.DB.prepare(`
    UPDATE scheduler_leases
    SET lease_until = ?, updated_at = ?
    WHERE name = 'monitor-cron' AND holder = ?
    RETURNING holder
  `).bind(now + SCHEDULER_LEASE_SECONDS, now, holder).first<{ holder: string }>()
  return row?.holder === holder
}

async function cleanupRetention(env: Env, now: number): Promise<void> {
  const marker = JSON.stringify({
    nextAt: now + RETENTION_INTERVAL_SECONDS,
    token: crypto.randomUUID(),
  })

  // Persist pacing in D1 rather than module memory so cold starts cannot drain
  // one batch per minute. The conditional marker claim and token-gated delete
  // use the same two-query budget as the previous setting lookup plus delete.
  // D1 batches are atomic, so a failed delete cannot consume the hourly claim.
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
      WHERE CASE
        WHEN json_valid(settings.value)
          THEN COALESCE(
            CAST(json_extract(settings.value, '$.nextAt') AS INTEGER),
            0
          )
        ELSE 0
      END <= ?
    `).bind(
      RETENTION_NEXT_AT_MARKER,
      marker,
      now,
    ),
    env.DB.prepare(`
      DELETE FROM status_logs
      WHERE id IN (
        SELECT id FROM status_logs
        WHERE source IS NOT NULL
          AND checked_at < ? - (
            COALESCE((
              SELECT CASE
                WHEN json_valid(value) THEN
                  CASE
                    WHEN json_type(value) IN ('integer', 'real')
                      THEN MAX(1, CAST(value AS INTEGER))
                    ELSE 90
                  END
                ELSE 90
              END
              FROM settings
              WHERE key = 'retention_days'
            ), 90) * 86400
          )
          AND EXISTS (
            SELECT 1
            FROM settings
            WHERE key = ?
              AND value = ?
          )
        ORDER BY checked_at
        LIMIT ?
      )
    `).bind(
      now,
      RETENTION_NEXT_AT_MARKER,
      marker,
      RETENTION_DELETE_LIMIT,
    ),
  ])
}

interface LegacyCatchupCursor {
  checkedAt: number
  id: string
}

interface LegacyCatchupResult {
  queriesUsed: number
}

function parseLegacyCatchupCursor(value: string | undefined): LegacyCatchupCursor | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Partial<LegacyCatchupCursor>
    return Number.isFinite(parsed.checkedAt) && typeof parsed.id === 'string'
      ? { checkedAt: Number(parsed.checkedAt), id: parsed.id }
      : null
  } catch {
    return null
  }
}

/**
 * Reconciles legacy-Worker writes in small, transactionally restartable
 * batches. The persisted high-water mark prevents each cron from rescanning
 * the already-processed prefix, while the source update makes every batch
 * idempotent if the invocation is retried.
 */
async function catchUpLegacyStatusLogs(
  env: Env,
  now: number,
): Promise<LegacyCatchupResult> {
  const settingsResult = await env.DB.prepare(`
    SELECT key, value
    FROM settings
    WHERE key IN (?, ?, ?)
  `).bind(
    LEGACY_CATCHUP_MARKER,
    LEGACY_CATCHUP_CURSOR,
    LEGACY_CATCHUP_NEXT_AT,
  )
    .all<{ key: string; value: string }>()
  const values = new Map(settingsResult.results.map((row) => [row.key, row.value]))
  if (values.get(LEGACY_CATCHUP_MARKER) === '1') {
    return { queriesUsed: 1 }
  }
  const nextAt = Number(values.get(LEGACY_CATCHUP_NEXT_AT) ?? 0)
  if (Number.isFinite(nextAt) && nextAt > now) {
    return { queriesUsed: 1 }
  }

  const cursor = parseLegacyCatchupCursor(values.get(LEGACY_CATCHUP_CURSOR))
  const batchQuery = cursor
    ? env.DB.prepare(`
        SELECT id, checked_at AS checkedAt
        FROM status_logs
        WHERE source IS NULL
          AND (checked_at > ? OR (checked_at = ? AND id > ?))
        ORDER BY checked_at, id
        LIMIT ?
      `).bind(cursor.checkedAt, cursor.checkedAt, cursor.id, LEGACY_CATCHUP_BATCH_SIZE)
    : env.DB.prepare(`
        SELECT id, checked_at AS checkedAt
        FROM status_logs
        WHERE source IS NULL
        ORDER BY checked_at, id
        LIMIT ?
      `).bind(LEGACY_CATCHUP_BATCH_SIZE)
  const batchResult = await batchQuery.all<{ id: string; checkedAt: number }>()
  let rows = batchResult.results
  let selectionQueries = 2 // settings + high-water/no-cursor batch query

  // A high-water cursor can skip a late legacy write whose ordering key falls
  // behind it. Before declaring the catch-up complete, explicitly rescan the
  // whole remaining source=NULL set. This is still bounded by the batch limit.
  if (rows.length === 0 && cursor) {
    const fallbackResult = await env.DB.prepare(`
      SELECT id, checked_at AS checkedAt
      FROM status_logs
      WHERE source IS NULL
      ORDER BY checked_at, id
      LIMIT ?
    `).bind(LEGACY_CATCHUP_BATCH_SIZE)
      .all<{ id: string; checkedAt: number }>()
    rows = fallbackResult.results
    selectionQueries += 1
  }

  if (rows.length === 0) {
    await env.DB.prepare(`
      INSERT INTO settings (key, value)
      SELECT ?, '1'
      WHERE NOT EXISTS (
        SELECT 1 FROM status_logs WHERE source IS NULL
      )
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(LEGACY_CATCHUP_MARKER).run()
    return { queriesUsed: selectionQueries + 1 }
  }

  const idsJson = JSON.stringify(rows.map((row) => row.id))
  const last = rows[rows.length - 1]
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`
      INSERT INTO monitor_daily_rollups (
        monitor_id, day, checks, up_count, down_count,
        response_count, response_sum_ms, response_min_ms, response_max_ms
      )
      SELECT
        monitor_id,
        checked_at - (checked_at % 86400),
        COUNT(*),
        SUM(CASE WHEN status = 'up' THEN 1 ELSE 0 END),
        SUM(CASE WHEN status = 'down' THEN 1 ELSE 0 END),
        SUM(CASE WHEN response_time_ms IS NOT NULL THEN 1 ELSE 0 END),
        COALESCE(SUM(response_time_ms), 0),
        MIN(response_time_ms),
        MAX(response_time_ms)
      FROM status_logs
      WHERE source IS NULL
        AND id IN (SELECT value FROM json_each(?))
      GROUP BY monitor_id, checked_at - (checked_at % 86400)
      ON CONFLICT (monitor_id, day) DO UPDATE SET
        checks = checks + excluded.checks,
        up_count = up_count + excluded.up_count,
        down_count = down_count + excluded.down_count,
        response_count = response_count + excluded.response_count,
        response_sum_ms = response_sum_ms + excluded.response_sum_ms,
        response_min_ms = CASE
          WHEN excluded.response_min_ms IS NULL THEN response_min_ms
          WHEN response_min_ms IS NULL THEN excluded.response_min_ms
          ELSE MIN(response_min_ms, excluded.response_min_ms)
        END,
        response_max_ms = CASE
          WHEN excluded.response_max_ms IS NULL THEN response_max_ms
          WHEN response_max_ms IS NULL THEN excluded.response_max_ms
          ELSE MAX(response_max_ms, excluded.response_max_ms)
        END
    `).bind(idsJson),
    env.DB.prepare(`
      UPDATE monitors
      SET history_revision = history_revision + 1
      WHERE id IN (
        SELECT DISTINCT monitor_id
        FROM status_logs
        WHERE source IS NULL
          AND id IN (SELECT value FROM json_each(?))
      )
    `).bind(idsJson),
    env.DB.prepare(`
      INSERT INTO settings (key, value)
      VALUES (?, ?), (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(
      LEGACY_CATCHUP_CURSOR,
      JSON.stringify({
        checkedAt: Number(last.checkedAt),
        id: last.id,
      }),
      LEGACY_CATCHUP_NEXT_AT,
      String(now + LEGACY_CATCHUP_INTERVAL_SECONDS),
    ),
    env.DB.prepare(`
      UPDATE status_logs
      SET source = 'legacy'
      WHERE source IS NULL
        AND id IN (SELECT value FROM json_each(?))
    `).bind(idsJson),
  ]

  await env.DB.batch(statements)
  return { queriesUsed: selectionQueries + statements.length }
}

function internalErrorObservation(
  monitor: typeof monitors.$inferSelect,
  checkedAt: number,
  error: unknown,
  origin: { colo: string; countryCode: string } | null,
  lastPingAt?: number | null,
): CheckObservation {
  const message = `Internal error: ${String(error)}`
  return {
    monitor,
    status: 'down',
    message,
    responseTimeMs: null,
    checkedAt,
    source: 'cron',
    resultCode: 'internal_error',
    colo: origin?.colo,
    countryCode: origin?.countryCode,
    inboundGuard: monitor.type === 'heartbeat' || monitor.type === 'agent'
      ? { lastCheckedAt: monitor.lastCheckedAt, lastPingAt: lastPingAt ?? null }
      : undefined,
  }
}

function estimatedObservationQueries(
  observation: CheckObservation,
  currentAlertState: typeof alertState.$inferSelect | undefined,
): number {
  let queries = 2 // archive-if-needed + authoritative monitor update
  const previous = observation.monitor
  const writesDiagnostic = !previous.lastCheckedAt
    || previous.lastStatus !== observation.status
    || observation.message.startsWith('Internal error:')
    || Math.floor(previous.lastCheckedAt / 600) !== Math.floor(observation.checkedAt / 600)
  if (writesDiagnostic) queries += 1

  if (observation.status === 'up') {
    if (previous.lastStatus === 'up' && !currentAlertState?.alertSentAt) {
      // A claimed or partially delivered DOWN row can turn an apparently
      // steady UP check into the full recovery repair path. Budget that path
      // conservatively; admission happens before processAlert can discover it.
      return queries + 12
    }
    if (previous.lastStatus === 'pending' && !currentAlertState?.alertSentAt) {
      // The steady path plus the pending -> up status update.
      return queries + 4
    }
    // Recovery, partial-delivery repair, and the no-channel policy path.
    return queries + 12
  }
  // Fresh outage/reopen, incident repair, and the no-channel policy path.
  return queries + 12
}

interface FailedAlertObservation {
  monitorId: string
  observationRevision: string
}

/**
 * Alert-state writes happen after the observation batch so they can remain
 * idempotent and revision-guarded. If one fails, pull the monitor's durable
 * scheduling cursor forward instead of leaving a long-interval outage without
 * an incident or notification until its next regular check.
 *
 * All failures are marked with one JSON1 update. A second attempt covers a
 * transient D1 error on the marker write itself; if both writes fail, throwing
 * keeps the cron invocation visibly failed rather than claiming success.
 */
async function rescheduleFailedAlertObservations(
  env: Env,
  failures: FailedAlertObservation[],
  retryAt: number,
): Promise<void> {
  if (failures.length === 0) return
  const payload = JSON.stringify(failures)
  const markForRetry = () => env.DB.prepare(`
    UPDATE monitors
    SET next_check_at = MIN(next_check_at, ?)
    WHERE EXISTS (
      SELECT 1
      FROM json_each(?) AS failed
      WHERE json_extract(failed.value, '$.monitorId') = monitors.id
        AND json_extract(failed.value, '$.observationRevision')
          = monitors.observation_revision
    )
  `).bind(retryAt, payload).run()

  try {
    await markForRetry()
  } catch (firstError) {
    console.error('[cron] failed to mark alert observations for retry; retrying:', firstError)
    await markForRetry()
  }
}

export async function runCron(env: Env): Promise<CronResult> {
  const holder = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  if (!(await acquireSchedulerLease(env, holder, now))) {
    return { checked: 0, deferred: 0, diagnosticsWritten: 0, skippedBecauseLeased: true }
  }

  try {
    const db = getDb(env.DB)
    const catchup = await catchUpLegacyStatusLogs(env, now)
    const due = await db.select()
      .from(monitors)
      .where(and(
        eq(monitors.active, true),
        lte(monitors.nextCheckAt, now),
      ))
      .orderBy(monitors.nextCheckAt, monitors.createdAt)
      .limit(MAX_CHECKS_PER_RUN)

    await cleanupRetention(env, now)
    if (due.length === 0) {
      await drainNotificationDeliveries(db, env.ENCRYPTION_KEY).catch((error) => {
        console.error('[cron] notification delivery drain failed:', error)
      })
      return { checked: 0, deferred: 0, diagnosticsWritten: 0, skippedBecauseLeased: false }
    }

    const inboundIds = due
      .filter((monitor) => monitor.type === 'heartbeat' || monitor.type === 'agent')
      .map((monitor) => monitor.id)
    const [inboundRows, alertRows] = await Promise.all([
      inboundIds.length > 0
        ? db.select().from(heartbeatTokens).where(inArray(heartbeatTokens.monitorId, inboundIds))
        : Promise.resolve([]),
      db.select().from(alertState)
        .where(sql`${alertState.monitorId} IN (
          SELECT value FROM json_each(${JSON.stringify(due.map(monitor => monitor.id))})
        )`),
    ])
    const lastPingByMonitor = new Map(inboundRows.map((row) => [row.monitorId, row.lastPingAt]))
    const alertStateByMonitor = new Map(alertRows.map((row) => [row.monitorId, row]))

    const [origin, locale] = await Promise.all([getWorkerOrigin(), getLocale(db)])
    const observations: CheckObservation[] = []
    let estimatedQueriesUsed = catchup.queriesUsed
    let offset = 0

    while (offset < due.length) {
      const renewalQueries = 1
      const remainingQueryBudget = OBSERVATION_D1_QUERY_BUDGET
        - estimatedQueriesUsed
        - renewalQueries
      const safeBatchSize = Math.min(
        CHECK_CONCURRENCY,
        due.length - offset,
        Math.floor(remainingQueryBudget / MAX_ESTIMATED_OBSERVATION_QUERIES),
      )
      if (safeBatchSize <= 0) break

      if (!(await renewSchedulerLease(env, holder))) {
        throw new Error('Scheduler lease ownership was lost before a check batch')
      }

      const batch = await Promise.all(due.slice(offset, offset + safeBatchSize).map(async (monitor) => {
        try {
          if (monitor.type === 'http') {
            const result = await checkHttp(monitor, locale, env.ENCRYPTION_KEY)
            const sslStatus = monitor.sslCheckEnabled && monitor.url?.startsWith('https://')
              ? (result.sslError ? 'error' : (result.status === 'up' ? 'ok' : monitor.sslStatus))
              : undefined
            return {
              monitor,
              status: result.status,
              message: result.message,
              responseTimeMs: result.responseTimeMs,
              checkedAt: now,
              source: 'cron',
              resultCode: result.statusCode ? `http_${result.statusCode}` : result.status,
              sslStatus,
              colo: origin?.colo,
              countryCode: origin?.countryCode,
            } satisfies CheckObservation
          }

          if (monitor.type === 'dns') {
            const result = await checkDns(monitor)
            return {
              monitor,
              status: result.status,
              message: result.message,
              responseTimeMs: result.responseTimeMs,
              checkedAt: now,
              source: 'cron',
              resultCode: result.status === 'up' ? 'dns_ok' : 'dns_error',
              colo: origin?.colo,
              countryCode: origin?.countryCode,
            } satisfies CheckObservation
          }

          if (monitor.type === 'ping') {
            const result = await checkPing(monitor)
            return {
              monitor,
              status: result.status,
              message: result.message,
              responseTimeMs: result.responseTimeMs,
              checkedAt: now,
              source: 'cron',
              resultCode: result.status === 'up' ? 'ping_ok' : 'ping_error',
              colo: origin?.colo,
              countryCode: origin?.countryCode,
            } satisfies CheckObservation
          }

          const capturedLastPingAt = lastPingByMonitor.get(monitor.id) ?? null
          const heartbeatResult = checkHeartbeat(
            monitor,
            capturedLastPingAt,
            now,
            locale,
          )
          const agentSnapshot = monitor.type === 'agent' && heartbeatResult.status === 'up'
            ? parseAgentSnapshot(monitor.lastMetrics)
            : null
          const result = monitor.type === 'agent' && heartbeatResult.status === 'up'
            ? {
                status: agentSnapshot?.status ?? 'down' as const,
                message: agentSnapshot?.message ?? 'No valid agent metrics received',
                logKey: null,
              }
            : heartbeatResult
          return {
            monitor,
            status: result.status,
            message: result.logKey ?? result.message,
            responseTimeMs: null,
            checkedAt: now,
            source: 'cron',
            resultCode: result.status === 'up' ? 'inbound_fresh' : 'inbound_missed',
            colo: origin?.colo,
            countryCode: origin?.countryCode,
            inboundGuard: {
              lastCheckedAt: monitor.lastCheckedAt,
              lastPingAt: capturedLastPingAt,
            },
          } satisfies CheckObservation
        } catch (error) {
          return internalErrorObservation(
            monitor,
            now,
            error,
            origin,
            lastPingByMonitor.get(monitor.id) ?? null,
          )
        }
      }))
      observations.push(...batch)
      estimatedQueriesUsed += renewalQueries
        + batch.reduce(
          (total, observation) => total + estimatedObservationQueries(
            observation,
            alertStateByMonitor.get(observation.monitor.id),
          ),
          0,
        )
      offset += safeBatchSize
    }

    if (!(await renewSchedulerLease(env, holder))) {
      throw new Error('Scheduler lease ownership was lost before observations were persisted')
    }
    const persisted = await persistCheckObservations(env, observations)
    const acceptedObservations = persisted.acceptedObservations

    const failedAlertObservations: FailedAlertObservation[] = []
    for (let offset = 0; offset < acceptedObservations.length; offset += CHECK_CONCURRENCY) {
      const alertBatch = acceptedObservations.slice(offset, offset + CHECK_CONCURRENCY)
      const alertResults = await Promise.allSettled(alertBatch.map((observation) =>
        processAlert({
          db,
          monitor: observation.monitor,
          observationRevision: observation.observationRevision,
          status: observation.status,
          message: observation.message,
          responseTimeMs: observation.responseTimeMs,
          encryptionKey: env.ENCRYPTION_KEY,
        })
      ))
      alertResults.forEach((result, index) => {
        if (result.status !== 'rejected') return
        const observation = alertBatch[index]
        console.error(`[cron] alert error for ${observation.monitor.id}:`, result.reason)
        failedAlertObservations.push({
          monitorId: observation.monitor.id,
          observationRevision: observation.observationRevision,
        })
      })
    }
    await rescheduleFailedAlertObservations(env, failedAlertObservations, now + 60)

    const remainingForDrain = WORKER_D1_QUERY_BUDGET
      - MAX_FIXED_CRON_D1_QUERIES
      - estimatedQueriesUsed
    const drainAttempts = remainingForDrain >= MAX_NOTIFICATION_DRAIN_D1_QUERIES
      ? 2
      : 1
    await drainNotificationDeliveries(
      db,
      env.ENCRYPTION_KEY,
      Math.floor(Date.now() / 1000),
      drainAttempts,
    ).catch((error) => {
      console.error('[cron] notification delivery drain failed:', error)
    })

    return {
      checked: acceptedObservations.length,
      deferred: due.length - acceptedObservations.length,
      diagnosticsWritten: persisted.diagnosticsWritten,
      skippedBecauseLeased: false,
    }
  } finally {
    try {
      await releaseSchedulerLease(env, holder)
    } catch (error) {
      console.error('[cron] failed to release scheduler lease:', error)
    }
  }
}
