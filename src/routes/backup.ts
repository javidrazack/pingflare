import { Hono } from 'hono'
import {
  getDb,
  monitors,
  notificationChannels,
  statusPages,
  statusPageMonitors,
  monitorNotifications,
  settings,
  maintenanceWindows,
} from '../db'
import { requireAuth } from '../middleware/auth'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const MAX_PAYLOAD_BYTES = 512 * 1024
const MAX_RECORDS = 5_000
const MONITOR_TYPES = new Set(['http', 'heartbeat', 'agent', 'dns', 'ping'])
const CHANNEL_TYPES = new Set([
  'discord', 'slack', 'telegram', 'email', 'ntfy', 'pushover', 'webhook',
  'apprise', 'googlechat', 'msteams', 'matrix', 'pagerduty', 'twilio',
])

type JsonObject = Record<string, unknown>

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requiredString(record: JsonObject, field: string): string {
  const value = record[field]
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Invalid ${field}`)
  }
  return value
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function integerOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback
}

function assertUnique(records: JsonObject[], field: string, label: string): Set<string> {
  const ids = new Set<string>()
  for (const record of records) {
    const id = requiredString(record, field)
    if (ids.has(id)) throw new Error(`Duplicate ${label}: ${id}`)
    ids.add(id)
  }
  return ids
}

function parseRecords(value: unknown, field: string): JsonObject[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every(isObject)) throw new Error(`Invalid ${field} field`)
  return value
}

function prepareJsonInsert(
  d1: D1Database,
  table: string,
  columns: string[],
  rows: JsonObject[],
): D1PreparedStatement {
  const selectedColumns = columns
    .map((column) => `json_extract(value, '$.${column}')`)
    .join(', ')
  return d1.prepare(`
    INSERT INTO ${table} (${columns.join(', ')})
    SELECT ${selectedColumns}
    FROM json_each(?)
  `).bind(JSON.stringify(rows))
}

router.get('/', async (c) => {
  const db = getDb(c.env.DB)

  const [settingsRows, monitorsRows, notifRows, statusPagesRows, monitorNotifRows, spmRows, maintenanceRows] =
    await Promise.all([
      db.select().from(settings),
      db.select().from(monitors),
      db.select().from(notificationChannels),
      db.select().from(statusPages),
      db.select().from(monitorNotifications),
      db.select().from(statusPageMonitors),
      db.select().from(maintenanceWindows),
    ])

  const settingsMap: Record<string, string> = {}
  for (const row of settingsRows) settingsMap[row.key] = row.value

  return c.json({
    version: 3,
    exportedAt: Math.floor(Date.now() / 1000),
    settings: settingsMap,
    monitors: monitorsRows.map(m => ({
      ...m,
      channelIds: monitorNotifRows.filter(mn => mn.monitorId === m.id).map(mn => mn.channelId),
    })),
    notifications: notifRows,
    statusPages: statusPagesRows.map(p => ({
      ...p,
      monitorIds: spmRows
        .filter(spm => spm.pageId === p.id)
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(spm => spm.monitorId),
    })),
    maintenanceWindows: maintenanceRows,
  })
})

router.post('/restore', async (c) => {
  let body: JsonObject
  try {
    const parsed = await readJsonBodyWithLimit(c.req.raw, MAX_PAYLOAD_BYTES)
    if (!isObject(parsed)) throw new Error('Backup must be an object')
    body = parsed
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: `Payload too large (max ${MAX_PAYLOAD_BYTES / 1024}KB)` }, 413)
    }
    return c.json({ error: 'Invalid JSON' }, 400)
  }
  if (body.version !== 1 && body.version !== 2 && body.version !== 3) {
    return c.json({ error: 'Unsupported backup version' }, 400)
  }

  try {
    const monitorRows = parseRecords(body.monitors, 'monitors')
    const channelRows = parseRecords(body.notifications, 'notifications')
    const pageRows = parseRecords(body.statusPages, 'statusPages')
    const maintenanceRows = parseRecords(body.maintenanceWindows, 'maintenanceWindows')
    if (!isObject(body.settings ?? {})) throw new Error('Invalid settings field')

    const recordCount = monitorRows.length + channelRows.length + pageRows.length + maintenanceRows.length
    if (recordCount > MAX_RECORDS) throw new Error(`Backup exceeds ${MAX_RECORDS} records`)

    const monitorIds = assertUnique(monitorRows, 'id', 'monitor id')
    const channelIds = assertUnique(channelRows, 'id', 'notification id')
    assertUnique(pageRows, 'id', 'status page id')
    assertUnique(pageRows, 'slug', 'status page slug')
    assertUnique(maintenanceRows, 'id', 'maintenance window id')

    for (const channel of channelRows) {
      requiredString(channel, 'name')
      if (!CHANNEL_TYPES.has(requiredString(channel, 'type'))) throw new Error('Invalid notification type')
      const config = requiredString(channel, 'config')
      if (!isObject(JSON.parse(config))) throw new Error('Invalid notification config')
    }

    for (const monitor of monitorRows) {
      requiredString(monitor, 'name')
      if (!MONITOR_TYPES.has(requiredString(monitor, 'type'))) throw new Error('Invalid monitor type')
      for (const channelId of Array.isArray(monitor.channelIds) ? monitor.channelIds : []) {
        if (typeof channelId !== 'string' || !channelIds.has(channelId)) {
          throw new Error(`Monitor references unknown notification: ${String(channelId)}`)
        }
      }
    }

    for (const page of pageRows) {
      requiredString(page, 'name')
      requiredString(page, 'slug')
      for (const monitorId of Array.isArray(page.monitorIds) ? page.monitorIds : []) {
        if (typeof monitorId !== 'string' || !monitorIds.has(monitorId)) {
          throw new Error(`Status page references unknown monitor: ${String(monitorId)}`)
        }
      }
    }

    for (const window of maintenanceRows) {
      const monitorId = requiredString(window, 'monitorId')
      if (!monitorIds.has(monitorId)) throw new Error(`Maintenance window references unknown monitor: ${monitorId}`)
      if (optionalNumber(window.startAt) === null || optionalNumber(window.endAt) === null) {
        throw new Error('Invalid maintenance window timestamps')
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const restoredHistoryRevision = Date.now()

    const settingsObj = body.settings as JsonObject
    const entries = Object.entries(settingsObj)
    if (!entries.some(([key]) => key === 'retention_days')) entries.push(['retention_days', '90'])
    const restoredSettings = entries.map(([key, value]) => ({
      key,
      value: String(value),
    }))
    const restoredChannels = channelRows.map((channel) => ({
      id: requiredString(channel, 'id'),
      name: requiredString(channel, 'name'),
      type: requiredString(channel, 'type'),
      config: requiredString(channel, 'config'),
      active: channel.active === false ? 0 : 1,
      is_default: channel.isDefault === true ? 1 : 0,
      created_at: integerOr(channel.createdAt, now),
    }))
    const restoredMonitors: JsonObject[] = []
    const restoredAlertStates: JsonObject[] = []
    const restoredHeartbeatTokens: JsonObject[] = []
    const restoredMonitorNotifications: JsonObject[] = []

    for (const monitor of monitorRows) {
      const id = requiredString(monitor, 'id')
      const type = requiredString(monitor, 'type')
      restoredMonitors.push({
        id,
        name: requiredString(monitor, 'name'),
        type,
        tags: typeof monitor.tags === 'string' ? monitor.tags : '[]',
        interval: integerOr(monitor.interval, 60),
        active: monitor.active === false ? 0 : 1,
        last_checked_at: null,
        last_status: 'pending',
        reminder_interval_hours: optionalNumber(monitor.reminderIntervalHours),
        tolerance_failures: integerOr(monitor.toleranceFailures, 1),
        url: optionalString(monitor.url),
        method: typeof monitor.method === 'string' ? monitor.method : 'GET',
        body: optionalString(monitor.body),
        headers: typeof monitor.headers === 'string' ? monitor.headers : '{}',
        expected_status: integerOr(monitor.expectedStatus, 200),
        follow_redirects: monitor.followRedirects === false ? 0 : 1,
        timeout: integerOr(monitor.timeout, 30),
        ip_version: typeof monitor.ipVersion === 'string' ? monitor.ipVersion : 'auto',
        auth_type: typeof monitor.authType === 'string' ? monitor.authType : 'none',
        auth_username: optionalString(monitor.authUsername),
        auth_password: optionalString(monitor.authPassword),
        auth_token: optionalString(monitor.authToken),
        heartbeat_interval: optionalNumber(monitor.heartbeatInterval),
        heartbeat_grace: integerOr(monitor.heartbeatGrace, 30),
        tolerance_missed: integerOr(monitor.toleranceMissed, 1),
        surge_protection_limit: optionalNumber(monitor.surgeProtectionLimit),
        ssl_check_enabled: monitor.sslCheckEnabled === true ? 1 : 0,
        ssl_status: 'unknown',
        cache_booster: monitor.cacheBooster === true ? 1 : 0,
        json_path: optionalString(monitor.jsonPath),
        expected_value: optionalString(monitor.expectedValue),
        cpu_threshold: optionalNumber(monitor.cpuThreshold),
        ram_threshold: optionalNumber(monitor.ramThreshold),
        disk_threshold: optionalNumber(monitor.diskThreshold),
        last_metrics: optionalString(monitor.lastMetrics),
        dns_hostname: optionalString(monitor.dnsHostname),
        dns_record_type: typeof monitor.dnsRecordType === 'string' ? monitor.dnsRecordType : 'A',
        dns_resolver_url: optionalString(monitor.dnsResolverUrl),
        dns_expected_ip: optionalString(monitor.dnsExpectedIp),
        history_revision: restoredHistoryRevision,
        created_at: integerOr(monitor.createdAt, now),
        updated_at: now,
      })
      restoredAlertStates.push({ monitor_id: id })
      if (type === 'heartbeat' || type === 'agent') {
        restoredHeartbeatTokens.push({ monitor_id: id, token: crypto.randomUUID() })
      }
      for (const channelId of Array.isArray(monitor.channelIds) ? monitor.channelIds : []) {
        restoredMonitorNotifications.push({
          monitor_id: id,
          channel_id: channelId as string,
        })
      }
    }

    const restoredPages: JsonObject[] = []
    const restoredPageMonitors: JsonObject[] = []
    for (const page of pageRows) {
      const id = requiredString(page, 'id')
      restoredPages.push({
        id,
        name: requiredString(page, 'name'),
        slug: requiredString(page, 'slug'),
        description: optionalString(page.description),
        password_hash: optionalString(page.passwordHash),
        show_all_monitors: page.showAllMonitors === true ? 1 : 0,
        logo_url: optionalString(page.logoUrl),
        brand_color: typeof page.brandColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(page.brandColor)
          ? page.brandColor.toUpperCase()
          : '#B45309',
        theme: page.theme === 'light' || page.theme === 'dark' ? page.theme : 'system',
        show_response_time: page.showResponseTime === false ? 0 : 1,
        show_uptime: page.showUptime === false ? 0 : 1,
        history_days: [7, 30, 60, 90].includes(integerOr(page.historyDays, 90))
          ? integerOr(page.historyDays, 90)
          : 90,
        seo_title: optionalString(page.seoTitle),
        seo_description: optionalString(page.seoDescription),
        created_at: integerOr(page.createdAt, now),
      })
      const pageMonitorIds = Array.isArray(page.monitorIds) ? page.monitorIds : []
      pageMonitorIds.forEach((monitorId, sortOrder) => {
        restoredPageMonitors.push({
          page_id: id,
          monitor_id: monitorId as string,
          sort_order: sortOrder,
        })
      })
    }

    const restoredMaintenanceWindows = maintenanceRows.map((window) => ({
      id: requiredString(window, 'id'),
      monitor_id: requiredString(window, 'monitorId'),
      start_at: optionalNumber(window.startAt),
      end_at: optionalNumber(window.endAt),
      reason: optionalString(window.reason),
    }))

    // D1 counts every statement inside batch() toward its 50-query invocation
    // limit. Loading each table from one JSON parameter keeps a 5,000-record
    // restore to a fixed, small number of statements.
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM monitors'),
      c.env.DB.prepare('DELETE FROM notification_channels'),
      c.env.DB.prepare('DELETE FROM status_pages'),
      c.env.DB.prepare('DELETE FROM settings'),
      prepareJsonInsert(c.env.DB, 'settings', ['key', 'value'], restoredSettings),
      prepareJsonInsert(
        c.env.DB,
        'notification_channels',
        ['id', 'name', 'type', 'config', 'active', 'is_default', 'created_at'],
        restoredChannels,
      ),
      prepareJsonInsert(c.env.DB, 'monitors', [
        'id', 'name', 'type', 'tags', 'interval', 'active', 'last_checked_at', 'last_status',
        'reminder_interval_hours', 'tolerance_failures', 'url', 'method', 'body', 'headers',
        'expected_status', 'follow_redirects', 'timeout', 'ip_version', 'auth_type',
        'auth_username', 'auth_password', 'auth_token', 'heartbeat_interval', 'heartbeat_grace',
        'tolerance_missed', 'surge_protection_limit', 'ssl_check_enabled', 'ssl_status',
        'cache_booster', 'json_path', 'expected_value', 'cpu_threshold', 'ram_threshold',
        'disk_threshold', 'last_metrics', 'dns_hostname', 'dns_record_type', 'dns_resolver_url',
        'dns_expected_ip', 'history_revision', 'created_at', 'updated_at',
      ], restoredMonitors),
      prepareJsonInsert(c.env.DB, 'alert_state', ['monitor_id'], restoredAlertStates),
      prepareJsonInsert(
        c.env.DB,
        'heartbeat_tokens',
        ['monitor_id', 'token'],
        restoredHeartbeatTokens,
      ),
      prepareJsonInsert(
        c.env.DB,
        'monitor_notifications',
        ['monitor_id', 'channel_id'],
        restoredMonitorNotifications,
      ),
      prepareJsonInsert(c.env.DB, 'status_pages', [
        'id', 'name', 'slug', 'description', 'password_hash', 'show_all_monitors',
        'logo_url', 'brand_color', 'theme', 'show_response_time', 'show_uptime',
        'history_days', 'seo_title', 'seo_description', 'created_at',
      ], restoredPages),
      prepareJsonInsert(
        c.env.DB,
        'status_page_monitors',
        ['page_id', 'monitor_id', 'sort_order'],
        restoredPageMonitors,
      ),
      prepareJsonInsert(c.env.DB, 'maintenance_windows', [
        'id', 'monitor_id', 'start_at', 'end_at', 'reason',
      ], restoredMaintenanceWindows),
    ]

    await c.env.DB.batch(statements)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid backup' }, 400)
  }
})

export default router
