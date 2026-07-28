import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const monitors = sqliteTable('monitors', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().$type<'http' | 'heartbeat' | 'agent' | 'dns' | 'ping'>(),
  tags: text('tags').notNull().default('[]'),
  interval: integer('interval').notNull().default(60),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastCheckedAt: integer('last_checked_at'),
  nextCheckAt: integer('next_check_at').notNull().default(0),
  observationRevision: text('observation_revision').notNull().default(''),
  lastStatus: text('last_status').notNull().default('pending').$type<'up' | 'down' | 'pending'>(),
  reminderIntervalHours: integer('reminder_interval_hours'),
  toleranceFailures: integer('tolerance_failures').notNull().default(1),
  url: text('url'),
  method: text('method').notNull().default('GET'),
  body: text('body'),
  headers: text('headers').notNull().default('{}'),
  expectedStatus: integer('expected_status').notNull().default(200),
  followRedirects: integer('follow_redirects', { mode: 'boolean' }).notNull().default(true),
  timeout: integer('timeout').notNull().default(30),
  ipVersion: text('ip_version').notNull().default('auto').$type<'auto' | 'ipv4' | 'ipv6'>(),
  authType: text('auth_type').notNull().default('none').$type<'none' | 'basic' | 'digest' | 'bearer'>(),
  authUsername: text('auth_username'),
  authPassword: text('auth_password'),
  authToken: text('auth_token'),
  heartbeatInterval: integer('heartbeat_interval'),
  heartbeatGrace: integer('heartbeat_grace').notNull().default(30),
  toleranceMissed: integer('tolerance_missed').notNull().default(1),
  surgeProtectionLimit: integer('surge_protection_limit'),
  sslCheckEnabled: integer('ssl_check_enabled', { mode: 'boolean' }).notNull().default(false),
  sslStatus: text('ssl_status').notNull().default('unknown').$type<'ok' | 'error' | 'unknown'>(),
  cacheBooster: integer('cache_booster', { mode: 'boolean' }).notNull().default(false),
  jsonPath: text('json_path'),
  expectedValue: text('expected_value'),
  cpuThreshold: integer('cpu_threshold'),
  ramThreshold: integer('ram_threshold'),
  diskThreshold: integer('disk_threshold'),
  lastMetrics: text('last_metrics'),
  dnsHostname: text('dns_hostname'),
  dnsRecordType: text('dns_record_type').default('A'),
  dnsResolverUrl: text('dns_resolver_url'),
  dnsExpectedIp: text('dns_expected_ip'),
  historyRevision: integer('history_revision').notNull().default(1),
  statsDay: integer('stats_day'),
  dayChecks: integer('day_checks').notNull().default(0),
  dayUpCount: integer('day_up_count').notNull().default(0),
  dayDownCount: integer('day_down_count').notNull().default(0),
  dayResponseCount: integer('day_response_count').notNull().default(0),
  dayResponseSumMs: integer('day_response_sum_ms').notNull().default(0),
  dayResponseMinMs: integer('day_response_min_ms'),
  dayResponseMaxMs: integer('day_response_max_ms'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  index('idx_monitors_active').on(t.active),
  index('idx_monitors_status').on(t.lastStatus),
  index('idx_monitors_type').on(t.type),
  index('idx_monitors_updated').on(t.updatedAt),
  index('idx_monitors_active_next_check').on(t.active, t.nextCheckAt),
])

export const statusLogs = sqliteTable('status_logs', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  status: text('status').notNull().$type<'up' | 'down' | 'pending'>(),
  message: text('message'),
  responseTimeMs: integer('response_time_ms'),
  checkedAt: integer('checked_at').notNull(),
  colo: text('colo'),
  countryCode: text('country_code'),
  originIp: text('origin_ip'),
  source: text('source').$type<'cron' | 'heartbeat' | 'agent' | 'legacy'>(),
}, (t) => [
  index('idx_sl_monitor_checked').on(t.monitorId, t.checkedAt),
  index('idx_sl_checked_at').on(t.checkedAt),
])

export const monitorDailyRollups = sqliteTable('monitor_daily_rollups', {
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  day: integer('day').notNull(),
  checks: integer('checks').notNull().default(0),
  upCount: integer('up_count').notNull().default(0),
  downCount: integer('down_count').notNull().default(0),
  responseCount: integer('response_count').notNull().default(0),
  responseSumMs: integer('response_sum_ms').notNull().default(0),
  responseMinMs: integer('response_min_ms'),
  responseMaxMs: integer('response_max_ms'),
}, (t) => [
  primaryKey({ columns: [t.monitorId, t.day] }),
  index('idx_monitor_daily_day').on(t.day),
])

export const schedulerLeases = sqliteTable('scheduler_leases', {
  name: text('name').primaryKey(),
  holder: text('holder').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  updatedAt: integer('updated_at').notNull(),
})

export const quotaBudgets = sqliteTable('quota_budgets', {
  key: text('key').primaryKey(),
  day: integer('day').notNull(),
  used: integer('used').notNull().default(0),
})

export const incidents = sqliteTable('incidents', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  startedAt: integer('started_at').notNull(),
  resolvedAt: integer('resolved_at'),
  durationSeconds: integer('duration_seconds'),
}, (t) => [
  uniqueIndex('idx_incidents_one_open')
    .on(t.monitorId)
    .where(sql`${t.resolvedAt} IS NULL`),
  index('idx_incidents_monitor_started_id').on(t.monitorId, t.startedAt, t.id),
])

export const notificationChannels = sqliteTable('notification_channels', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull().$type<'discord' | 'slack' | 'telegram' | 'email' | 'ntfy' | 'pushover' | 'webhook' | 'apprise' | 'googlechat' | 'msteams' | 'matrix' | 'pagerduty' | 'twilio'>(),
  config: text('config').notNull().default('{}'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const notificationTestRuns = sqliteTable('notification_test_runs', {
  id: text('id').primaryKey(),
  channelId: text('channel_id').notNull().references(() => notificationChannels.id, { onDelete: 'cascade' }),
  status: text('status').notNull().$type<'success' | 'failed'>(),
  latencyMs: integer('latency_ms').notNull(),
  error: text('error'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  index('idx_notification_tests_channel_created').on(t.channelId, t.createdAt),
])

export const notificationDeliveries = sqliteTable('notification_deliveries', {
  id: text('id').primaryKey(),
  dedupeKey: text('dedupe_key').notNull().unique(),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  eventType: text('event_type').notNull().$type<'alert' | 'recovery' | 'reminder'>(),
  payload: text('payload').notNull(),
  remainingChannelIds: text('remaining_channel_ids').notNull(),
  attempts: integer('attempts').notNull().default(0),
  deliveredCount: integer('delivered_count').notNull().default(0),
  stateApplied: integer('state_applied', { mode: 'boolean' }).notNull().default(false),
  nextAttemptAt: integer('next_attempt_at').notNull(),
  claimToken: text('claim_token'),
  claimUntil: integer('claim_until'),
  lastError: text('last_error'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  index('idx_notification_deliveries_due').on(t.nextAttemptAt, t.claimUntil),
  index('idx_notification_deliveries_monitor').on(t.monitorId, t.createdAt),
])

export const monitorNotifications = sqliteTable('monitor_notifications', {
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  channelId: text('channel_id').notNull().references(() => notificationChannels.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.monitorId, t.channelId] })])

export const heartbeatTokens = sqliteTable('heartbeat_tokens', {
  monitorId: text('monitor_id').primaryKey().references(() => monitors.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  lastPingAt: integer('last_ping_at'),
})

export const alertState = sqliteTable('alert_state', {
  monitorId: text('monitor_id').primaryKey().references(() => monitors.id, { onDelete: 'cascade' }),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
  consecutiveMissed: integer('consecutive_missed').notNull().default(0),
  alertSentAt: integer('alert_sent_at'),
  consecutiveAlerts: integer('consecutive_alerts').notNull().default(0),
  lastReminderAt: integer('last_reminder_at'),
  surgePausedUntil: integer('surge_paused_until'),
})

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})

export const statusPages = sqliteTable('status_pages', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  description: text('description'),
  passwordHash: text('password_hash'),
  showAllMonitors: integer('show_all_monitors', { mode: 'boolean' }).notNull().default(false),
  logoUrl: text('logo_url'),
  brandColor: text('brand_color').notNull().default('#B45309'),
  theme: text('theme').notNull().default('system').$type<'light' | 'dark' | 'system'>(),
  showResponseTime: integer('show_response_time', { mode: 'boolean' }).notNull().default(true),
  showUptime: integer('show_uptime', { mode: 'boolean' }).notNull().default(true),
  historyDays: integer('history_days').notNull().default(90),
  seoTitle: text('seo_title'),
  seoDescription: text('seo_description'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const statusPageMonitors = sqliteTable('status_page_monitors', {
  pageId: text('page_id').notNull().references(() => statusPages.id, { onDelete: 'cascade' }),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  sortOrder: integer('sort_order').notNull().default(0),
}, (t) => [primaryKey({ columns: [t.pageId, t.monitorId] })])

export const incidentReports = sqliteTable('incident_reports', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  status: text('status').notNull().$type<'investigating' | 'identified' | 'monitoring' | 'resolved'>(),
  visibility: text('visibility').notNull().default('published').$type<'draft' | 'published'>(),
  impact: text('impact').notNull().default('minor').$type<'minor' | 'major' | 'critical'>(),
  publishedAt: integer('published_at'),
  startedAt: integer('started_at').notNull().default(sql`(unixepoch())`),
  resolvedAt: integer('resolved_at'),
})

export const incidentUpdates = sqliteTable('incident_updates', {
  id: text('id').primaryKey(),
  incidentId: text('incident_id').notNull().references(() => incidentReports.id, { onDelete: 'cascade' }),
  message: text('message').notNull(),
  status: text('status').notNull().$type<'investigating' | 'identified' | 'monitoring' | 'resolved'>(),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
}, (t) => [
  index('idx_incident_updates_incident_created_id')
    .on(t.incidentId, t.createdAt, t.id),
])

export const incidentMonitors = sqliteTable('incident_monitors', {
  incidentId: text('incident_id').notNull().references(() => incidentReports.id, { onDelete: 'cascade' }),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.incidentId, t.monitorId] }),
  index('idx_incident_monitors_monitor').on(t.monitorId, t.incidentId),
])

export const incidentFeedMonitorCounts = sqliteTable('incident_feed_monitor_counts', {
  monitorId: text('monitor_id').primaryKey().references(() => monitors.id, { onDelete: 'cascade' }),
  linkCount: integer('link_count').notNull().default(0),
})

export const incidentReportEvents = sqliteTable('incident_report_events', {
  incidentId: text('incident_id').notNull().references(() => incidentReports.id, { onDelete: 'cascade' }),
  eventId: text('event_id').notNull().references(() => incidents.id, { onDelete: 'cascade' }),
}, (t) => [
  primaryKey({ columns: [t.incidentId, t.eventId] }),
  index('idx_incident_report_events_event').on(t.eventId, t.incidentId),
])

export type Monitor = typeof monitors.$inferSelect
export type NewMonitor = typeof monitors.$inferInsert
export type StatusLog = typeof statusLogs.$inferSelect
export type MonitorDailyRollup = typeof monitorDailyRollups.$inferSelect
export type Incident = typeof incidents.$inferSelect
export type NotificationChannel = typeof notificationChannels.$inferSelect
export type NotificationTestRun = typeof notificationTestRuns.$inferSelect
export type NotificationDelivery = typeof notificationDeliveries.$inferSelect
export type AlertState = typeof alertState.$inferSelect
export type StatusPage = typeof statusPages.$inferSelect
export const maintenanceWindows = sqliteTable('maintenance_windows', {
  id: text('id').primaryKey(),
  monitorId: text('monitor_id').notNull().references(() => monitors.id, { onDelete: 'cascade' }),
  startAt: integer('start_at').notNull(),
  endAt: integer('end_at').notNull(),
  reason: text('reason'),
}, (t) => [
  index('idx_maintenance_monitor_window').on(t.monitorId, t.startAt, t.endAt),
])

export type IncidentReport = typeof incidentReports.$inferSelect
export type IncidentUpdate = typeof incidentUpdates.$inferSelect
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect
