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
    version: 2,
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
  if (body.version !== 1 && body.version !== 2) {
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
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM monitors'),
      c.env.DB.prepare('DELETE FROM notification_channels'),
      c.env.DB.prepare('DELETE FROM status_pages'),
      c.env.DB.prepare('DELETE FROM settings'),
    ]

    const settingsObj = body.settings as JsonObject
    const entries = Object.entries(settingsObj)
    if (!entries.some(([key]) => key === 'retention_days')) entries.push(['retention_days', '90'])
    for (const [key, value] of entries) {
      statements.push(c.env.DB.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').bind(key, String(value)))
    }

    for (const channel of channelRows) {
      statements.push(c.env.DB.prepare(`
        INSERT INTO notification_channels (id, name, type, config, active, is_default, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        requiredString(channel, 'id'),
        requiredString(channel, 'name'),
        requiredString(channel, 'type'),
        requiredString(channel, 'config'),
        channel.active === false ? 0 : 1,
        channel.isDefault === true ? 1 : 0,
        integerOr(channel.createdAt, now),
      ))
    }

    for (const monitor of monitorRows) {
      const id = requiredString(monitor, 'id')
      const type = requiredString(monitor, 'type')
      statements.push(c.env.DB.prepare(`
        INSERT INTO monitors (
          id, name, type, tags, interval, active, last_checked_at, last_status,
          reminder_interval_hours, tolerance_failures, url, method, body, headers,
          expected_status, follow_redirects, timeout, ip_version, auth_type,
          auth_username, auth_password, auth_token, heartbeat_interval, heartbeat_grace,
          tolerance_missed, surge_protection_limit, ssl_check_enabled, ssl_status,
          cache_booster, json_path, expected_value, cpu_threshold, ram_threshold,
          disk_threshold, last_metrics, dns_hostname, dns_record_type, dns_resolver_url,
          dns_expected_ip, created_at, updated_at
        ) VALUES (${Array(41).fill('?').join(', ')})
      `).bind(
        id,
        requiredString(monitor, 'name'),
        type,
        typeof monitor.tags === 'string' ? monitor.tags : '[]',
        integerOr(monitor.interval, 60),
        monitor.active === false ? 0 : 1,
        null,
        'pending',
        optionalNumber(monitor.reminderIntervalHours),
        integerOr(monitor.toleranceFailures, 1),
        optionalString(monitor.url),
        typeof monitor.method === 'string' ? monitor.method : 'GET',
        optionalString(monitor.body),
        typeof monitor.headers === 'string' ? monitor.headers : '{}',
        integerOr(monitor.expectedStatus, 200),
        monitor.followRedirects === false ? 0 : 1,
        integerOr(monitor.timeout, 30),
        typeof monitor.ipVersion === 'string' ? monitor.ipVersion : 'auto',
        typeof monitor.authType === 'string' ? monitor.authType : 'none',
        optionalString(monitor.authUsername),
        optionalString(monitor.authPassword),
        optionalString(monitor.authToken),
        optionalNumber(monitor.heartbeatInterval),
        integerOr(monitor.heartbeatGrace, 30),
        integerOr(monitor.toleranceMissed, 1),
        optionalNumber(monitor.surgeProtectionLimit),
        monitor.sslCheckEnabled === true ? 1 : 0,
        'unknown',
        monitor.cacheBooster === true ? 1 : 0,
        optionalString(monitor.jsonPath),
        optionalString(monitor.expectedValue),
        optionalNumber(monitor.cpuThreshold),
        optionalNumber(monitor.ramThreshold),
        optionalNumber(monitor.diskThreshold),
        optionalString(monitor.lastMetrics),
        optionalString(monitor.dnsHostname),
        typeof monitor.dnsRecordType === 'string' ? monitor.dnsRecordType : 'A',
        optionalString(monitor.dnsResolverUrl),
        optionalString(monitor.dnsExpectedIp),
        integerOr(monitor.createdAt, now),
        now,
      ))
      statements.push(c.env.DB.prepare('INSERT INTO alert_state (monitor_id) VALUES (?)').bind(id))
      if (type === 'heartbeat' || type === 'agent') {
        statements.push(c.env.DB.prepare(
          'INSERT INTO heartbeat_tokens (monitor_id, token) VALUES (?, ?)'
        ).bind(id, crypto.randomUUID()))
      }
      for (const channelId of Array.isArray(monitor.channelIds) ? monitor.channelIds : []) {
        statements.push(c.env.DB.prepare(
          'INSERT INTO monitor_notifications (monitor_id, channel_id) VALUES (?, ?)'
        ).bind(id, channelId as string))
      }
    }

    for (const page of pageRows) {
      const id = requiredString(page, 'id')
      statements.push(c.env.DB.prepare(`
        INSERT INTO status_pages (id, name, slug, description, password_hash, show_all_monitors, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        requiredString(page, 'name'),
        requiredString(page, 'slug'),
        optionalString(page.description),
        optionalString(page.passwordHash),
        page.showAllMonitors === true ? 1 : 0,
        integerOr(page.createdAt, now),
      ))
      const pageMonitorIds = Array.isArray(page.monitorIds) ? page.monitorIds : []
      pageMonitorIds.forEach((monitorId, sortOrder) => {
        statements.push(c.env.DB.prepare(
          'INSERT INTO status_page_monitors (page_id, monitor_id, sort_order) VALUES (?, ?, ?)'
        ).bind(id, monitorId as string, sortOrder))
      })
    }

    for (const window of maintenanceRows) {
      statements.push(c.env.DB.prepare(`
        INSERT INTO maintenance_windows (id, monitor_id, start_at, end_at, reason)
        VALUES (?, ?, ?, ?, ?)
      `).bind(
        requiredString(window, 'id'),
        requiredString(window, 'monitorId'),
        optionalNumber(window.startAt),
        optionalNumber(window.endAt),
        optionalString(window.reason),
      ))
    }

    await c.env.DB.batch(statements)
    return c.json({ ok: true })
  } catch (error) {
    return c.json({ error: error instanceof Error ? error.message : 'Invalid backup' }, 400)
  }
})

export default router
