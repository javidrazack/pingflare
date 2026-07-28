import { inArray } from 'drizzle-orm'
import { getDb, monitors } from '../db'
import type { Monitor } from '../db/schema'
import type { Env } from '../index'
import { getOrComputeAggregate } from './response-cache'

interface RollupRow {
  monitorId: string
  day: number
  checks: number
  upCount: number
  downCount: number
  responseCount: number
  responseSumMs: number
  responseMinMs: number | null
  responseMaxMs: number | null
}

export interface DailyUptime {
  date: string
  uptime: number | null
}

export interface MonitorAnalytics {
  monitorId: string
  uptimes: Record<'1' | '7' | '30' | '90', number | null>
  daily: DailyUptime[]
  count: number
  up: number
  down: number
  avgResponseMs: number | null
}

export interface HistoryResult {
  analytics: Record<string, MonitorAnalytics>
  cacheStatus: 'HIT' | 'MISS' | 'BYPASS'
}

const EMPTY_CACHE_STATUS = 'BYPASS' as const
const FROZEN_HISTORY_TTL_SECONDS = 60 * 60
const D1_ID_CHUNK_SIZE = 90

function utcDay(timestamp: number): number {
  return timestamp - (timestamp % 86400)
}

function toNumber(value: unknown): number {
  return typeof value === 'number' ? value : Number(value ?? 0)
}

function normalizeRow(row: Record<string, unknown>): RollupRow {
  return {
    monitorId: String(row.monitorId),
    day: toNumber(row.day),
    checks: toNumber(row.checks),
    upCount: toNumber(row.upCount),
    downCount: toNumber(row.downCount),
    responseCount: toNumber(row.responseCount),
    responseSumMs: toNumber(row.responseSumMs),
    responseMinMs: row.responseMinMs === null ? null : toNumber(row.responseMinMs),
    responseMaxMs: row.responseMaxMs === null ? null : toNumber(row.responseMaxMs),
  }
}

function mergeRow(target: Map<string, Map<number, RollupRow>>, row: RollupRow): void {
  let byDay = target.get(row.monitorId)
  if (!byDay) {
    byDay = new Map()
    target.set(row.monitorId, byDay)
  }
  const current = byDay.get(row.day)
  if (!current) {
    byDay.set(row.day, { ...row })
    return
  }
  current.checks += row.checks
  current.upCount += row.upCount
  current.downCount += row.downCount
  current.responseCount += row.responseCount
  current.responseSumMs += row.responseSumMs
  if (row.responseMinMs !== null) {
    current.responseMinMs = current.responseMinMs === null
      ? row.responseMinMs
      : Math.min(current.responseMinMs, row.responseMinMs)
  }
  if (row.responseMaxMs !== null) {
    current.responseMaxMs = current.responseMaxMs === null
      ? row.responseMaxMs
      : Math.max(current.responseMaxMs, row.responseMaxMs)
  }
}

async function queryRollups(
  env: Env,
  monitorIds: string[],
  fromDay: number,
  toDayExclusive: number,
): Promise<RollupRow[]> {
  if (monitorIds.length === 0 || fromDay >= toDayExclusive) return []
  const rows: RollupRow[] = []
  for (let offset = 0; offset < monitorIds.length; offset += D1_ID_CHUNK_SIZE) {
    const chunk = monitorIds.slice(offset, offset + D1_ID_CHUNK_SIZE)
    const placeholders = chunk.map(() => '?').join(', ')
    const result = await env.DB.prepare(`
      SELECT
        monitor_id AS monitorId,
        day,
        checks,
        up_count AS upCount,
        down_count AS downCount,
        response_count AS responseCount,
        response_sum_ms AS responseSumMs,
        response_min_ms AS responseMinMs,
        response_max_ms AS responseMaxMs
      FROM monitor_daily_rollups
      WHERE monitor_id IN (${placeholders})
        AND day >= ?
        AND day < ?
      ORDER BY monitor_id, day
    `).bind(...chunk, fromDay, toDayExclusive).all<Record<string, unknown>>()
    rows.push(...result.results.map(normalizeRow))
  }
  return rows
}

async function historyCacheKey(monitorsForKey: Monitor[], fromDay: number, toDay: number): Promise<string> {
  const input = JSON.stringify({
    fromDay,
    toDay,
    monitors: monitorsForKey
      .map((monitor) => [monitor.id, monitor.historyRevision])
      .sort(([left], [right]) => String(left).localeCompare(String(right))),
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function percent(up: number, total: number, precision = 2): number | null {
  if (total === 0) return null
  const factor = 10 ** precision
  return Math.round((up / total) * 100 * factor) / factor
}

function buildMonitorAnalytics(
  monitorId: string,
  rows: Map<number, RollupRow> | undefined,
  now: number,
  days: number,
): MonitorAnalytics {
  const today = utcDay(now)

  function aggregate(windowDays: number): RollupRow {
    const start = today - (windowDays - 1) * 86400
    const total: RollupRow = {
      monitorId,
      day: start,
      checks: 0,
      upCount: 0,
      downCount: 0,
      responseCount: 0,
      responseSumMs: 0,
      responseMinMs: null,
      responseMaxMs: null,
    }
    if (!rows) return total
    for (const [day, row] of rows) {
      if (day < start || day > today) continue
      total.checks += row.checks
      total.upCount += row.upCount
      total.downCount += row.downCount
      total.responseCount += row.responseCount
      total.responseSumMs += row.responseSumMs
    }
    return total
  }

  const daily: DailyUptime[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const day = today - offset * 86400
    const row = rows?.get(day)
    daily.push({
      date: new Date(day * 1000).toISOString().slice(0, 10),
      uptime: row ? percent(row.upCount, row.checks, 1) : null,
    })
  }

  const a1 = aggregate(1)
  const a7 = aggregate(7)
  const a30 = aggregate(30)
  const a90 = aggregate(90)
  const requested = aggregate(days)

  return {
    monitorId,
    uptimes: {
      '1': percent(a1.upCount, a1.checks),
      '7': percent(a7.upCount, a7.checks),
      '30': percent(a30.upCount, a30.checks),
      '90': percent(a90.upCount, a90.checks),
    },
    daily,
    count: requested.checks,
    up: requested.upCount,
    down: requested.downCount,
    avgResponseMs: requested.responseCount > 0
      ? Math.round(requested.responseSumMs / requested.responseCount)
      : null,
  }
}

/**
 * Reads compact exact daily history. The current monitor counters are always
 * read live. Frozen history caching is added by the response-cache adapter at
 * the query boundary; this function deliberately never caches current state.
 */
export async function getMonitorAnalytics(
  env: Env,
  monitorIds: string[],
  days = 90,
  now = Math.floor(Date.now() / 1000),
  requestUrl?: string,
): Promise<HistoryResult> {
  const uniqueIds = [...new Set(monitorIds)]
  if (uniqueIds.length === 0) return { analytics: {}, cacheStatus: EMPTY_CACHE_STATUS }

  const db = getDb(env.DB)
  const monitorRows: Monitor[] = []
  for (let offset = 0; offset < uniqueIds.length; offset += D1_ID_CHUNK_SIZE) {
    monitorRows.push(...await db.select()
      .from(monitors)
      .where(inArray(monitors.id, uniqueIds.slice(offset, offset + D1_ID_CHUNK_SIZE))))
  }
  const foundIds = monitorRows.map((monitor) => monitor.id)
  if (foundIds.length === 0) return { analytics: {}, cacheStatus: EMPTY_CACHE_STATUS }

  const today = utcDay(now)
  const maxDays = Math.max(days, 90)
  const fromDay = today - (maxDays - 1) * 86400
  const yesterday = today - 86400
  const frozenEnd = Math.max(fromDay, yesterday)
  let frozenRows: RollupRow[] = []
  let cacheStatus: HistoryResult['cacheStatus'] = EMPTY_CACHE_STATUS

  if (fromDay < frozenEnd) {
    const key = await historyCacheKey(monitorRows, fromDay, frozenEnd)
    const cached = await getOrComputeAggregate({
      namespace: 'daily-rollups',
      key,
      revision: 'v1',
      ttlSeconds: FROZEN_HISTORY_TTL_SECONDS,
      baseUrl: requestUrl ? new URL(requestUrl).origin : undefined,
    }, () => queryRollups(env, foundIds, fromDay, frozenEnd))
    frozenRows = cached.value
    cacheStatus = cached.status
  }

  // Yesterday, today, and the monitor's current counters are deliberately live.
  // This makes current state fresh even when a Worker cache entry survives in a
  // different data center.
  const liveRows = await queryRollups(env, foundIds, frozenEnd, today + 86400)
  const rows = [...frozenRows, ...liveRows]
  const byMonitor = new Map<string, Map<number, RollupRow>>()

  for (const row of rows) mergeRow(byMonitor, row)

  for (const monitor of monitorRows) {
    mergeCurrentCounters(byMonitor, monitor, fromDay, today)
  }

  const analytics: Record<string, MonitorAnalytics> = {}
  for (const id of foundIds) {
    analytics[id] = buildMonitorAnalytics(id, byMonitor.get(id), now, days)
  }

  return { analytics, cacheStatus }
}

function mergeCurrentCounters(
  target: Map<string, Map<number, RollupRow>>,
  monitor: Monitor,
  fromDay: number,
  today: number,
): void {
  if (monitor.statsDay === null || monitor.dayChecks === 0) return
  if (monitor.statsDay < fromDay || monitor.statsDay > today) return
  mergeRow(target, {
    monitorId: monitor.id,
    day: monitor.statsDay,
    checks: monitor.dayChecks,
    upCount: monitor.dayUpCount,
    downCount: monitor.dayDownCount,
    responseCount: monitor.dayResponseCount,
    responseSumMs: monitor.dayResponseSumMs,
    responseMinMs: monitor.dayResponseMinMs,
    responseMaxMs: monitor.dayResponseMaxMs,
  })
}
