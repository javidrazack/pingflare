import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import { getDb, heartbeatTokens, monitors, settings } from './db'
import { checkHttp, checkDns, checkPing } from './services/checker'
import { checkHeartbeat } from './services/heartbeat-checker'
import { parseAgentSnapshot } from './services/agent-status'
import { processAlert, getLocale } from './services/alert-manager'
import { persistCheckObservations, type CheckObservation } from './services/check-storage'
import type { Env } from './index'

let cachedOrigin: { colo: string; countryCode: string } | null = null
let cachedOriginAt = 0
const ORIGIN_TTL_MS = 5 * 60 * 1000
const RETENTION_INTERVAL_MS = 60 * 60 * 1000
const RETENTION_DELETE_LIMIT = 200
const SCHEDULER_LEASE_SECONDS = 110
const MAX_CHECKS_PER_RUN = 8
const CHECK_CONCURRENCY = 6
const OBSERVATION_D1_QUERY_BUDGET = 38
const MAX_ESTIMATED_OBSERVATION_QUERIES = 10
const LEGACY_CATCHUP_MARKER = '_schema_legacy_gap_catchup_v1'
let lastRetentionCleanupAt = 0

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
  if (Date.now() - lastRetentionCleanupAt <= RETENTION_INTERVAL_MS) return
  const db = getDb(env.DB)
  const retentionRow = await db.select().from(settings).where(eq(settings.key, 'retention_days')).get()
  const configuredDays = retentionRow ? Number.parseInt(retentionRow.value, 10) : 90
  const retentionDays = Number.isFinite(configuredDays) ? Math.max(1, configuredDays) : 90
  const cutoff = now - retentionDays * 86400

  const result = await env.DB.prepare(`
    DELETE FROM status_logs
    WHERE id IN (
      SELECT id FROM status_logs
      WHERE checked_at < ?
      ORDER BY checked_at
      LIMIT ?
    )
  `).bind(cutoff, RETENTION_DELETE_LIMIT).run()
  if ((result.meta.changes ?? 0) < RETENTION_DELETE_LIMIT) {
    lastRetentionCleanupAt = Date.now()
  }
}

async function catchUpLegacyStatusLogs(env: Env): Promise<boolean> {
  const marker = await env.DB.prepare(
    'SELECT value FROM settings WHERE key = ?',
  ).bind(LEGACY_CATCHUP_MARKER).first<{ value: string }>()
  if (marker?.value === '1') return false

  await env.DB.batch([
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
    `),
    env.DB.prepare(`
      UPDATE status_logs SET source = 'legacy' WHERE source IS NULL
    `),
    env.DB.prepare(`
      INSERT INTO settings (key, value) VALUES (?, '1')
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(LEGACY_CATCHUP_MARKER),
  ])
  return true
}

function internalErrorObservation(
  monitor: typeof monitors.$inferSelect,
  checkedAt: number,
  error: unknown,
  origin: { colo: string; countryCode: string } | null,
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
  }
}

function estimatedObservationQueries(observation: CheckObservation): number {
  let queries = 2 // archive-if-needed + authoritative monitor update
  const previous = observation.monitor
  const writesDiagnostic = !previous.lastCheckedAt
    || previous.lastStatus !== observation.status
    || observation.message.startsWith('Internal error:')
    || Math.floor(previous.lastCheckedAt / 600) !== Math.floor(observation.checkedAt / 600)
  if (writesDiagnostic) queries += 1

  if (observation.status === 'up' && previous.lastStatus === 'up') return queries + 1
  if (observation.status === 'up' && previous.lastStatus === 'pending') return queries + 3
  return queries + 7
}

export async function runCron(env: Env): Promise<CronResult> {
  const holder = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  if (!(await acquireSchedulerLease(env, holder, now))) {
    return { checked: 0, deferred: 0, diagnosticsWritten: 0, skippedBecauseLeased: true }
  }

  try {
    const db = getDb(env.DB)
    if (await catchUpLegacyStatusLogs(env)) {
      return { checked: 0, deferred: 0, diagnosticsWritten: 0, skippedBecauseLeased: false }
    }
    const due = await db.select()
      .from(monitors)
      .where(and(
        eq(monitors.active, true),
        or(
          isNull(monitors.lastCheckedAt),
          lte(sql<number>`${monitors.lastCheckedAt} + ${monitors.interval}`, now),
        ),
      ))
      .orderBy(sql`${monitors.lastCheckedAt} IS NOT NULL`, monitors.lastCheckedAt, monitors.createdAt)
      .limit(MAX_CHECKS_PER_RUN)

    await cleanupRetention(env, now)
    if (due.length === 0) {
      return { checked: 0, deferred: 0, diagnosticsWritten: 0, skippedBecauseLeased: false }
    }

    const inboundIds = due
      .filter((monitor) => monitor.type === 'heartbeat' || monitor.type === 'agent')
      .map((monitor) => monitor.id)
    const inboundRows = inboundIds.length > 0
      ? await db.select().from(heartbeatTokens).where(inArray(heartbeatTokens.monitorId, inboundIds))
      : []
    const lastPingByMonitor = new Map(inboundRows.map((row) => [row.monitorId, row.lastPingAt]))

    const [origin, locale] = await Promise.all([getWorkerOrigin(), getLocale(db)])
    const observations: CheckObservation[] = []
    let estimatedQueriesUsed = 0
    let offset = 0

    while (offset < due.length) {
      const renewalQueries = offset === 0 ? 0 : 1
      const remainingQueryBudget = OBSERVATION_D1_QUERY_BUDGET
        - estimatedQueriesUsed
        - renewalQueries
      const safeBatchSize = Math.min(
        CHECK_CONCURRENCY,
        due.length - offset,
        Math.floor(remainingQueryBudget / MAX_ESTIMATED_OBSERVATION_QUERIES),
      )
      if (safeBatchSize <= 0) break

      if (renewalQueries > 0 && !(await renewSchedulerLease(env, holder))) {
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

          const heartbeatResult = checkHeartbeat(
            monitor,
            lastPingByMonitor.get(monitor.id) ?? null,
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
          } satisfies CheckObservation
        } catch (error) {
          return internalErrorObservation(monitor, now, error, origin)
        }
      }))
      observations.push(...batch)
      estimatedQueriesUsed += renewalQueries
        + batch.reduce((total, observation) => total + estimatedObservationQueries(observation), 0)
      offset += safeBatchSize
    }

    if (!(await renewSchedulerLease(env, holder))) {
      throw new Error('Scheduler lease ownership was lost before observations were persisted')
    }
    const persisted = await persistCheckObservations(env, observations)

    for (let offset = 0; offset < observations.length; offset += CHECK_CONCURRENCY) {
      await Promise.allSettled(observations.slice(offset, offset + CHECK_CONCURRENCY).map((observation) =>
        processAlert({
          db,
          monitor: observation.monitor,
          status: observation.status,
          message: observation.message,
          responseTimeMs: observation.responseTimeMs,
          encryptionKey: env.ENCRYPTION_KEY,
        }).catch((error) => {
          console.error(`[cron] alert error for ${observation.monitor.id}:`, error)
        })
      ))
    }

    return {
      checked: observations.length,
      deferred: due.length - observations.length,
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
