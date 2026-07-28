import type { Monitor } from '../db/schema'
import { eq } from 'drizzle-orm'
import { getDb, heartbeatTokens, monitors } from '../db'
import type { Env } from '../index'
import { recordCheckAnalytics } from './analytics-engine'

export type CheckSource = 'cron' | 'heartbeat' | 'agent'

export interface InboundObservationGuard {
  lastCheckedAt: number | null
  lastPingAt: number | null
}

export interface CheckObservation {
  monitor: Monitor
  status: 'up' | 'down'
  message: string
  responseTimeMs?: number | null
  checkedAt: number
  source: CheckSource
  resultCode?: string
  sslStatus?: 'ok' | 'error' | 'unknown'
  colo?: string | null
  countryCode?: string | null
  lastMetrics?: string
  /**
   * Cron heartbeat/agent observations carry the inbound state they evaluated.
   * Every authoritative statement is skipped when a newer push changed either
   * cursor before the batch commits.
   */
  inboundGuard?: InboundObservationGuard
  agentMetrics?: {
    cpu?: number
    ram?: number
    disk?: number
    unhealthyContainers?: number
  }
}

export interface PersistedCheckObservations {
  diagnosticsWritten: number
  acceptedObservations: PersistedCheckObservation[]
}

export interface PersistedCheckObservation extends CheckObservation {
  /**
   * Unique token written with this observation. Every later alert/incident
   * mutation must still match it so an older invocation cannot finish after a
   * newer observation and overwrite the newer truth.
   */
  observationRevision: string
}

type RefreshInboundObservation = (
  monitor: Monitor,
  checkedAt: number,
) => CheckObservation | null

const DIAGNOSTIC_SAMPLE_SECONDS = 10 * 60

function utcDay(timestamp: number): number {
  return timestamp - (timestamp % 86400)
}

function shouldPersistDiagnostic(observation: CheckObservation): boolean {
  const previous = observation.monitor
  if (!previous.lastCheckedAt || previous.lastStatus !== observation.status) return true
  if (observation.message.startsWith('Internal error:')) return true
  return Math.floor(previous.lastCheckedAt / DIAGNOSTIC_SAMPLE_SECONDS)
    !== Math.floor(observation.checkedAt / DIAGNOSTIC_SAMPLE_SECONDS)
}

/**
 * Persists the authoritative scheduling cursor and exact UTC-day counters.
 *
 * Each observation uses two statements (archive-if-needed and authoritative
 * monitor update), plus one sparse diagnostic log statement when required.
 * Inbound cron observations apply the same compare-and-swap guard to every
 * statement so a newer heartbeat/agent push wins atomically.
 * Callers should keep batches small enough to stay under D1's per-invocation
 * query budget.
 */
export async function persistCheckObservations(
  env: Env,
  observations: CheckObservation[],
): Promise<PersistedCheckObservations> {
  if (observations.length === 0) {
    return { diagnosticsWritten: 0, acceptedObservations: [] }
  }

  const statements: D1PreparedStatement[] = []
  const planned: Array<{
    observation: CheckObservation
    observationRevision: string
    updateResultIndex: number
    diagnosticResultIndex?: number
  }> = []

  for (const observation of observations) {
    const observationRevision = crypto.randomUUID()
    const priorObservationRevision = observation.monitor.observationRevision
    const day = utcDay(observation.checkedAt)
    const responseTime = observation.responseTimeMs ?? null
    const guardEnabled = observation.inboundGuard ? 1 : 0
    const guardLastCheckedAt = observation.inboundGuard?.lastCheckedAt ?? null
    const guardLastPingAt = observation.inboundGuard?.lastPingAt ?? null

    statements.push(env.DB.prepare(`
      INSERT INTO monitor_daily_rollups (
        monitor_id, day, checks, up_count, down_count,
        response_count, response_sum_ms, response_min_ms, response_max_ms
      )
      SELECT
        id, stats_day, day_checks, day_up_count, day_down_count,
        day_response_count, day_response_sum_ms, day_response_min_ms, day_response_max_ms
      FROM monitors
      WHERE id = ?
        AND observation_revision = ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
        AND stats_day IS NOT NULL
        AND stats_day <> ?
        AND day_checks > 0
        AND (
          ? = 0
          OR (
            monitors.last_checked_at IS ?
            AND EXISTS (
              SELECT 1
              FROM heartbeat_tokens
              WHERE heartbeat_tokens.monitor_id = monitors.id
                AND heartbeat_tokens.last_ping_at IS ?
            )
          )
        )
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
    `).bind(
      observation.monitor.id,
      priorObservationRevision,
      observation.checkedAt,
      day,
      guardEnabled,
      guardLastCheckedAt,
      guardLastPingAt,
    ))

    const updateResultIndex = statements.length
    statements.push(env.DB.prepare(`
      UPDATE monitors SET
        last_checked_at = CASE
          WHEN last_checked_at IS NULL OR last_checked_at <= ? THEN ?
          ELSE last_checked_at
        END,
        observation_revision = ?,
        next_check_at = CASE
          WHEN last_checked_at IS NULL OR last_checked_at <= ? THEN ? + interval
          ELSE MAX(next_check_at, last_checked_at + interval)
        END,
        ssl_status = COALESCE(?, ssl_status),
        last_metrics = COALESCE(?, last_metrics),
        history_revision = CASE
          WHEN stats_day IS NOT NULL AND stats_day <> ? AND day_checks > 0
            THEN history_revision + 1
          ELSE history_revision
        END,
        stats_day = ?,
        day_checks = CASE WHEN stats_day = ? THEN day_checks + 1 ELSE 1 END,
        day_up_count = CASE
          WHEN stats_day = ? THEN day_up_count + ?
          ELSE ?
        END,
        day_down_count = CASE
          WHEN stats_day = ? THEN day_down_count + ?
          ELSE ?
        END,
        day_response_count = CASE
          WHEN stats_day = ? THEN day_response_count + ?
          ELSE ?
        END,
        day_response_sum_ms = CASE
          WHEN stats_day = ? THEN day_response_sum_ms + ?
          ELSE ?
        END,
        day_response_min_ms = CASE
          WHEN ? IS NULL THEN CASE WHEN stats_day = ? THEN day_response_min_ms ELSE NULL END
          WHEN stats_day <> ? OR stats_day IS NULL OR day_response_min_ms IS NULL THEN ?
          ELSE MIN(day_response_min_ms, ?)
        END,
        day_response_max_ms = CASE
          WHEN ? IS NULL THEN CASE WHEN stats_day = ? THEN day_response_max_ms ELSE NULL END
          WHEN stats_day <> ? OR stats_day IS NULL OR day_response_max_ms IS NULL THEN ?
          ELSE MAX(day_response_max_ms, ?)
        END
      WHERE id = ?
        AND observation_revision = ?
        AND (last_checked_at IS NULL OR last_checked_at <= ?)
        AND (
          ? = 0
          OR (
            monitors.last_checked_at IS ?
            AND EXISTS (
              SELECT 1
              FROM heartbeat_tokens
              WHERE heartbeat_tokens.monitor_id = monitors.id
                AND heartbeat_tokens.last_ping_at IS ?
            )
          )
        )
    `).bind(
      observation.checkedAt,
      observation.checkedAt,
      observationRevision,
      observation.checkedAt,
      observation.checkedAt,
      observation.sslStatus ?? null,
      observation.lastMetrics ?? null,
      day,
      day,
      day,
      day,
      observation.status === 'up' ? 1 : 0,
      observation.status === 'up' ? 1 : 0,
      day,
      observation.status === 'down' ? 1 : 0,
      observation.status === 'down' ? 1 : 0,
      day,
      responseTime === null ? 0 : 1,
      responseTime === null ? 0 : 1,
      day,
      responseTime ?? 0,
      responseTime ?? 0,
      responseTime,
      day,
      day,
      responseTime,
      responseTime,
      responseTime,
      day,
      day,
      responseTime,
      responseTime,
      observation.monitor.id,
      priorObservationRevision,
      observation.checkedAt,
      guardEnabled,
      guardLastCheckedAt,
      guardLastPingAt,
    ))

    let diagnosticResultIndex: number | undefined
    if (shouldPersistDiagnostic(observation)) {
      diagnosticResultIndex = statements.length
      statements.push(env.DB.prepare(`
        INSERT INTO status_logs (
          id, monitor_id, status, message, response_time_ms, checked_at,
          colo, country_code, origin_ip, source
        )
        SELECT ?, monitors.id, ?, ?, ?, ?, ?, ?, NULL, ?
        FROM monitors
        WHERE monitors.id = ?
          AND monitors.observation_revision = ?
      `).bind(
        crypto.randomUUID(),
        observation.status,
        observation.message,
        responseTime,
        observation.checkedAt,
        observation.colo ?? null,
        observation.countryCode ?? null,
        observation.source,
        observation.monitor.id,
        observationRevision,
      ))
    }

    if (observation.source === 'heartbeat' || observation.source === 'agent') {
      statements.push(env.DB.prepare(`
        UPDATE heartbeat_tokens
        SET last_ping_at = CASE
          WHEN last_ping_at IS NULL OR last_ping_at < ? THEN ?
          ELSE last_ping_at
        END
        WHERE monitor_id = ?
          AND EXISTS (
            SELECT 1
            FROM monitors
            WHERE monitors.id = heartbeat_tokens.monitor_id
              AND monitors.observation_revision = ?
          )
      `).bind(
        observation.checkedAt,
        observation.checkedAt,
        observation.monitor.id,
        observationRevision,
      ))
    }

    planned.push({
      observation,
      observationRevision,
      updateResultIndex,
      diagnosticResultIndex,
    })
  }

  const results = await env.DB.batch(statements)
  const changesAt = (index: number | undefined): number => {
    if (index === undefined) return 0
    return Number(results[index]?.meta?.changes ?? 0)
  }
  const acceptedPlans = planned.filter((plan) => changesAt(plan.updateResultIndex) > 0)
  const acceptedObservations = acceptedPlans.map((plan) => ({
    ...plan.observation,
    observationRevision: plan.observationRevision,
  }))
  const diagnosticsWritten = acceptedPlans.reduce(
    (total, plan) => total + changesAt(plan.diagnosticResultIndex),
    0,
  )

  for (const observation of acceptedObservations) {
    recordCheckAnalytics(env, observation)
  }

  return { diagnosticsWritten, acceptedObservations }
}

/**
 * Inbound pushes are real observations and must not be lost just because a
 * cron CAS committed first. Retry one time against fresh monitor state when
 * the heartbeat token proves that no newer inbound push won. Cron remains
 * one-shot so an older timeout can never fight a newer inbound push.
 */
export async function persistInboundObservationWithRetry(
  env: Env,
  observation: CheckObservation,
  refreshObservation: RefreshInboundObservation,
): Promise<PersistedCheckObservations> {
  let persisted = await persistCheckObservations(env, [observation])
  if (persisted.acceptedObservations.length > 0) return persisted

  const db = getDb(env.DB)
  const [current, currentToken] = await Promise.all([
    db.query.monitors.findFirst({
      where: eq(monitors.id, observation.monitor.id),
    }),
    db.query.heartbeatTokens.findFirst({
      where: eq(heartbeatTokens.monitorId, observation.monitor.id),
    }),
  ])
  if (
    !current
    || !current.active
    || !currentToken
  ) return persisted

  // A changed ping cursor means another real inbound request won; never let an
  // older agent payload overwrite its metrics. Cron observations do not change
  // this cursor, so their CAS win remains safe to retry.
  const capturedLastPingAt = observation.inboundGuard?.lastPingAt
  if (
    observation.inboundGuard
    && currentToken.lastPingAt !== capturedLastPingAt
  ) return persisted

  const retryCheckedAt = Math.max(
    observation.checkedAt,
    current.lastCheckedAt ?? observation.checkedAt,
  )
  const rebuilt = refreshObservation(current, retryCheckedAt)
  const refreshed = rebuilt
    ? {
        ...rebuilt,
        checkedAt: retryCheckedAt,
        inboundGuard: {
          lastCheckedAt: current.lastCheckedAt,
          lastPingAt: currentToken.lastPingAt,
        },
      }
    : null
  if (
    !refreshed
    || refreshed.monitor.id !== observation.monitor.id
    || (refreshed.source !== 'heartbeat' && refreshed.source !== 'agent')
  ) return persisted

  persisted = await persistCheckObservations(env, [refreshed])
  return persisted
}
