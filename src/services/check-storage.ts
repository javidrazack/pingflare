import type { Monitor } from '../db/schema'
import type { Env } from '../index'
import { recordCheckAnalytics } from './analytics-engine'

export type CheckSource = 'cron' | 'heartbeat' | 'agent'

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
  agentMetrics?: {
    cpu?: number
    ram?: number
    disk?: number
    unhealthyContainers?: number
  }
}

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
 * Each observation uses two unconditional statements (archive-if-needed and
 * monitor update), plus one sparse diagnostic log statement when required.
 * Callers should keep batches small enough to stay under D1's per-invocation
 * query budget.
 */
export async function persistCheckObservations(
  env: Env,
  observations: CheckObservation[],
  additionalStatements: D1PreparedStatement[] = [],
): Promise<{ diagnosticsWritten: number }> {
  if (observations.length === 0) return { diagnosticsWritten: 0 }

  const statements: D1PreparedStatement[] = [...additionalStatements]
  let diagnosticsWritten = 0

  for (const observation of observations) {
    const day = utcDay(observation.checkedAt)
    const responseTime = observation.responseTimeMs ?? null

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
        AND stats_day IS NOT NULL
        AND stats_day <> ?
        AND day_checks > 0
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
    `).bind(observation.monitor.id, day))

    statements.push(env.DB.prepare(`
      UPDATE monitors SET
        last_checked_at = ?,
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
    `).bind(
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
    ))

    if (shouldPersistDiagnostic(observation)) {
      diagnosticsWritten += 1
      statements.push(env.DB.prepare(`
        INSERT INTO status_logs (
          id, monitor_id, status, message, response_time_ms, checked_at,
          colo, country_code, origin_ip, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
      `).bind(
        crypto.randomUUID(),
        observation.monitor.id,
        observation.status,
        observation.message,
        responseTime,
        observation.checkedAt,
        observation.colo ?? null,
        observation.countryCode ?? null,
        observation.source,
      ))
    }
  }

  await env.DB.batch(statements)

  for (const observation of observations) {
    recordCheckAnalytics(env, observation)
  }

  return { diagnosticsWritten }
}
