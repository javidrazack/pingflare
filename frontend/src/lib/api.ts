import type { InfrastructureSignal } from './infrastructure-types'
export type { InfrastructureSignal } from './infrastructure-types'

const BASE = '/api'

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

function getToken(): string | null {
  if (typeof localStorage === 'undefined') return null
  return localStorage.getItem('token')
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken()
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string> ?? {}),
  }
  if (token) headers['Authorization'] = `Bearer ${token}`

  const timeout = AbortSignal.timeout(path === '/cron/run' ? 180_000 : 30_000)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  const res = await fetch(`${BASE}${path}`, { ...init, headers, signal })

  if (res.status === 401 && path !== '/auth/login') {
    localStorage.removeItem('token')
    window.location.href = '/login'
    throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED')
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    const errorBody = body as { error?: string; code?: string }
    throw new ApiError(errorBody.error ?? `HTTP ${res.status}`, res.status, errorBody.code)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export const api = {
  operations: {
    dashboard: () => request<{ summary: { total: number; up: number; down: number; pending: number; stale: number }; items: MonitorSummary[] }>('/operations/dashboard'),
    watchlist: () => request<{ items: Array<MonitorSummary & { uptime: number | null }> }>('/operations/watchlist'),
    overview: () => request<OperationsOverview>('/operations'),
    deliveries: () => request<DeliveryInbox>('/operations/deliveries'),
    retry: (id: string) => request<{ ok: boolean; changed: boolean }>(`/operations/deliveries/${id}/retry`, { method: 'POST' }),
  },
  auth: {
    logout: () => request<{ ok: boolean }>('/auth/logout', { method: 'POST' }),
    login: (username: string, password: string) =>
      request<{ token: string }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify({ username, password }),
      }),
  },

  monitors: {
    maintenance: (id: string) => request<MaintenanceWindow[]>(`/monitors/${id}/maintenance`),
    scheduleMaintenance: (id: string, data: { startAt: number; endAt: number; reason: string; occurrences: Array<{ startAt: number; endAt: number }> }) =>
      request<{ ok: boolean }>(`/monitors/${id}/maintenance`, { method: 'POST', body: JSON.stringify(data) }),
    deleteMaintenance: (id: string, windowId: string) => request<{ ok: boolean }>(`/monitors/${id}/maintenance/${windowId}`, { method: 'DELETE' }),
    list:   () => request<Monitor[]>('/monitors'),
    search: (params: MonitorSearchParams) => {
      const query = new URLSearchParams()
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== '' && value !== 'all') query.set(key, String(value))
      })
      return request<PaginatedMonitors>(`/monitors?${query.toString()}`)
    },
    bulk: (ids: string[], action: 'pause' | 'resume' | 'delete') =>
      request<{ ok: boolean; affected: number }>('/monitors/bulk', {
        method: 'PATCH',
        body: JSON.stringify({ ids, action }),
      }),
    get:    (id: string) => request<Monitor>(`/monitors/${id}`),
    create: (data: MonitorPayload) => request<Monitor>('/monitors', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: MonitorPayload) => request<Monitor>(`/monitors/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<{ ok: boolean }>(`/monitors/${id}`, { method: 'DELETE' }),
    toggleActive: (id: string, active: boolean) => request<Monitor>(`/monitors/${id}`, { method: 'PUT', body: JSON.stringify({ active }) }),
    resetStats:  (id: string) => request<{ ok: boolean }>(`/monitors/${id}/reset-stats`, { method: 'POST' }),
    channels:    (id: string) => request<string[]>(`/monitors/${id}/channels`),
    hbToken:     (id: string) => request<{ token: string }>(`/monitors/${id}/heartbeat-token`),
    regenToken:  (id: string) => request<{ token: string }>(`/monitors/${id}/heartbeat-token/regenerate`, { method: 'POST' }),
    logs:        (id: string, hours = 24) => request<StatusLog[]>(`/monitors/${id}/logs?hours=${hours}`),
    recentLogs:  (id: string, limit = 200) => request<StatusLog[]>(`/monitors/${id}/logs?limit=${limit}`),
    checkCount:  (id: string) => request<{ count: number }>(`/monitors/${id}/check-count`),
    incidents:   (id: string) => request<Incident[]>(`/monitors/${id}/incidents`),
    uptime:      (id: string, days = 90) => request<{ uptime: number | null; days: number }>(`/monitors/${id}/uptime?days=${days}`),
    uptimeSummary: (days = 30) => request<{ days: number; uptimes: Record<string, number | null> }>(`/monitors/uptime-summary?days=${days}`),
    daily:       (id: string, days = 90) => request<DailyUptime[]>(`/monitors/${id}/daily?days=${days}`),
    analytics:   (id: string, days = 90) => request<MonitorAnalytics>(`/monitors/${id}/analytics?days=${days}`),
    metricHistory: (id: string, range: AgentMetricRange = '24h') =>
      request<AgentMetricHistory>(`/monitors/${id}/metric-history?range=${range}`),
  },

  infrastructure: {
    overview: () => request<InfrastructureOverview>('/infrastructure/overview'),
  },

  cron: {
    run: () => request<CronRunResult>('/cron/run', { method: 'POST' }),
  },

  settings: {
    get:    () => request<Record<string, string>>('/settings'),
    update: (data: Record<string, string>) => request<Record<string, string>>('/settings', { method: 'PUT', body: JSON.stringify(data) }),
  },

  backup: {
    export: () => request<BackupData>('/backup'),
    restore: (data: BackupData) => request<{ ok: boolean }>('/backup/restore', { method: 'POST', body: JSON.stringify(data) }),
  },

  notifications: {
    list:   () => request<NotificationChannel[]>('/notifications'),
    get:    (id: string) => request<NotificationChannel>(`/notifications/${id}`),
    create: (data: NotificationChannelPayload) => request<NotificationChannel>('/notifications', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: NotificationChannelPayload) => request<NotificationChannel>(`/notifications/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<{ ok: boolean }>(`/notifications/${id}`, { method: 'DELETE' }),
    previewTest: (data: NotificationChannelPayload) => request<{ ok: boolean; latencyMs: number }>('/notifications/test', { method: 'POST', body: JSON.stringify(data) }),
    test:              (id: string) => request<{ ok: boolean; run: NotificationTestRun }>(`/notifications/${id}/test`, { method: 'POST' }),
    tests:             (id: string) => request<NotificationTestRun[]>(`/notifications/${id}/tests`),
    applyToAllMonitors:(id: string) => request<{ ok: boolean; applied: number }>(`/notifications/${id}/apply-all-monitors`, { method: 'POST' }),
  },

  statusPages: {
    list:    () => request<StatusPage[]>('/status-pages'),
    get:     (id: string) => request<StatusPage>(`/status-pages/${id}`),
    create:  (data: Partial<StatusPage> & { password?: string; monitorIds?: string[] }) =>
               request<StatusPage>('/status-pages', { method: 'POST', body: JSON.stringify(data) }),
    update:  (id: string, data: Partial<StatusPage> & { password?: string; monitorIds?: string[] }) =>
               request<StatusPage>(`/status-pages/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete:  (id: string) => request<{ ok: boolean }>(`/status-pages/${id}`, { method: 'DELETE' }),
    monitors: (id: string) => request<string[]>(`/status-pages/${id}/monitors`),
  },

  incidents: {
    list:      () => request<IncidentReport[]>('/incidents'),
    detected:  () => request<DetectedIncident[]>('/incidents/detected'),
    detectedDetail: (id: string) => request<DetectedIncidentDetail>(`/incidents/detected/${encodeURIComponent(id)}`),
    get:       (id: string) => request<IncidentReport>(`/incidents/${id}`),
    create:    (data: { title: string; status: IncidentStatus; message?: string; monitorIds?: string[]; eventIds?: string[]; visibility?: IncidentVisibility; impact?: IncidentImpact }) =>
                 request<IncidentReport>('/incidents', { method: 'POST', body: JSON.stringify(data) }),
    update:    (id: string, data: { title?: string; status?: IncidentStatus; monitorIds?: string[]; eventIds?: string[]; visibility?: IncidentVisibility; impact?: IncidentImpact }) =>
                 request<IncidentReport>(`/incidents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    addUpdate: (id: string, message: string, status: IncidentStatus) =>
                 request<IncidentUpdate>(`/incidents/${id}/updates`, { method: 'POST', body: JSON.stringify({ message, status }) }),
    delete:    (id: string) => request<{ ok: boolean }>(`/incidents/${id}`, { method: 'DELETE' }),
  },
}

export interface Monitor {
  id: string
  name: string
  type: 'http' | 'heartbeat' | 'agent' | 'dns' | 'ping'
  tags: string
  interval: number
  active: boolean
  lastCheckedAt: number | null
  displayStatus?: DisplayStatus
  lastStatus: 'up' | 'down' | 'pending'
  reminderIntervalHours: number | null
  toleranceFailures: number
  url: string | null
  method: string
  body: string | null
  headers: string
  expectedStatus: number
  followRedirects: boolean
  timeout: number
  ipVersion: 'auto' | 'ipv4' | 'ipv6'
  authType: 'none' | 'basic' | 'digest' | 'bearer'
  authUsername: string | null
  authPassword: string | null
  authToken: string | null
  heartbeatInterval: number | null
  heartbeatGrace: number
  toleranceMissed: number
  surgeProtectionLimit: number | null
  sslCheckEnabled: boolean
  sslStatus: 'ok' | 'error' | 'unknown'
  cacheBooster: boolean
  jsonPath: string | null
  expectedValue: string | null
  cpuThreshold: number | null
  ramThreshold: number | null
  diskThreshold: number | null
  lastMetrics: string | null
  dnsHostname: string | null
  dnsRecordType: string | null
  dnsResolverUrl: string | null
  dnsExpectedIp: string | null
  createdAt: number
  updatedAt: number
}

export interface MonitorSearchParams {
  page: number
  pageSize?: number
  search?: string
  status?: 'all' | 'up' | 'down' | 'pending'
  type?: 'all' | Monitor['type']
  active?: 'all' | 'true' | 'false'
  sort?: 'name' | 'status' | 'type' | 'checked' | 'updated'
  direction?: 'asc' | 'desc'
}

export interface PaginatedMonitors {
  items: Monitor[]
  total: number
  page: number
  pageSize: number
  totalPages: number
}

export interface StatusLog {
  id: string
  monitorId: string
  status: 'up' | 'down' | 'pending'
  message: string | null
  responseTimeMs: number | null
  checkedAt: number
  colo: string | null
  countryCode: string | null
  originIp: string | null
  source: 'cron' | 'heartbeat' | 'agent' | 'legacy' | null
}

export interface Incident {
  id: string
  monitorId: string
  startedAt: number
  resolvedAt: number | null
  durationSeconds: number | null
}

export interface NotificationChannel {
  id: string
  name: string
  type: 'discord' | 'slack' | 'telegram' | 'email' | 'ntfy' | 'pushover' | 'webhook' | 'apprise' | 'googlechat' | 'msteams' | 'matrix' | 'pagerduty' | 'twilio'
  config: string
  active: boolean
  isDefault: boolean
  createdAt: number
  encryptedFields?: string[]
}

export interface NotificationTestRun {
  id: string
  channelId: string
  status: 'success' | 'failed'
  latencyMs: number
  error: string | null
  createdAt: number
}

export interface DailyUptime {
  date: string
  uptime: number | null
}

export interface MonitorAnalytics {
  monitorId: string
  uptimes: {
    '1': number | null
    '7': number | null
    '30': number | null
    '90': number | null
  }
  daily: DailyUptime[]
  count: number
  up: number
  down: number
  avgResponseMs: number | null
}

export type AgentMetricRange = '2h' | '24h' | '7d' | '30d'

export interface AgentMetricPoint {
  sampledAt: number
  cpu: { avg: number; max: number }
  ram: { avg: number; max: number }
  disk: { avg: number; max: number }
}

export interface AgentMetricHistory {
  monitorId: string
  range: AgentMetricRange
  resolutionSeconds: number
  thresholds: {
    cpu: number | null
    ram: number | null
    disk: number | null
  }
  points: AgentMetricPoint[]
}

export type InfrastructureNodeState =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'stale'
  | 'pending'
  | 'paused'

export interface InfrastructureNode {
  id: string
  name: string
  state: InfrastructureNodeState
  active: boolean
  lastCheckedAt: number | null
  metrics: { cpu: number; ram: number; disk: number } | null
  thresholds: { cpu: number | null; ram: number | null; disk: number | null }
  pressure: 'normal' | 'warning' | 'critical'
  strongestSignal: InfrastructureSignal
}

export interface InfrastructureOverview {
  generatedAt: number
  truncated: boolean
  summary: {
    total: number
    reporting: number
    pressure: number
    stale: number
  }
  issues: InfrastructureNode[]
  nodes: InfrastructureNode[]
}

export interface CronRunResult {
  ok: boolean
  triggeredAt: number
  checked: number
  deferred: number
  diagnosticsWritten: number
  skippedBecauseLeased: boolean
}

export interface StatusPage {
  id: string
  name: string
  slug: string
  description: string | null
  passwordHash: string | null
  showAllMonitors: boolean
  logoUrl: string | null
  brandColor: string
  theme: 'light' | 'dark' | 'system'
  showResponseTime: boolean
  showUptime: boolean
  historyDays: 7 | 30 | 60 | 90
  seoTitle: string | null
  seoDescription: string | null
  createdAt: number
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved'
export type IncidentVisibility = 'draft' | 'published'
export type IncidentImpact = 'minor' | 'major' | 'critical'

export interface IncidentReport {
  id: string
  title: string
  status: IncidentStatus
  visibility: IncidentVisibility
  impact: IncidentImpact
  publishedAt: number | null
  startedAt: number
  resolvedAt: number | null
  monitorIds?: string[]
  updates?: IncidentUpdate[]
}

export interface DetectedIncident {
  id: string
  monitorId: string
  monitorName: string
  startedAt: number
  resolvedAt: number | null
  durationSeconds: number | null
}

export interface EventEvidence {
  id: string
  status: 'up' | 'down' | 'pending'
  message: string | null
  checkedAt: number
  responseTimeMs: number | null
}
export interface DetectedIncidentDetail extends DetectedIncident {
  monitorType: string
  observedAt: number
  evidence: EventEvidence[]
  hasMore: boolean
  recovery: EventEvidence | null
}

export interface IncidentUpdate {
  id: string
  incidentId: string
  message: string
  status: IncidentStatus
  createdAt: number
}

export interface PublicMonitorStatus {
  id: string
  name: string
  status: DisplayStatus
  uptime90d: number | null
  daily: DailyUptime[]
}

export interface PublicIncident {
  id: string
  title: string
  status: IncidentStatus
  startedAt: number
  resolvedAt: number | null
  updates: IncidentUpdate[]
  monitorIds: string[]
}

export interface PublicStatusPage {
  page: {
    name: string
    description: string | null
    protected: boolean
    logoUrl: string | null
    brandColor: string
    theme: 'light' | 'dark' | 'system'
    showResponseTime: boolean
    showUptime: boolean
    historyDays: number
    seoTitle: string | null
    seoDescription: string | null
  }
  monitors: PublicMonitorStatus[]
  incidents: PublicIncident[]
}

/** Payload for creating/updating a monitor (headers as object, tags as array) */
export type MonitorPayload = Omit<Partial<Monitor>, 'headers' | 'tags'> & {
  headers?: Record<string, string>
  tags?: string[]
  channelIds?: string[]
}

/** Payload for creating/updating a notification channel (config as object) */
export type NotificationChannelPayload = Omit<Partial<NotificationChannel>, 'config'> & {
  config?: Record<string, string>
}

export interface BackupData {
  version: number
  exportedAt: number
  settings: Record<string, string>
  monitors: (Monitor & { channelIds: string[] })[]
  notifications: NotificationChannel[]
  statusPages: (StatusPage & { monitorIds: string[] })[]
  maintenanceWindows?: Array<{
    id: string
    monitorId: string
    startAt: number
    endAt: number
    reason: string | null
  }>
}

export type DisplayStatus = 'up' | 'down' | 'pending' | 'stale' | 'paused'
export interface MaintenanceWindow { id: string; monitorId: string; startAt: number; endAt: number; reason: string | null }
export interface OperationsOverview {
  total: number; active: number; overdue: number; observedAt: number
  oldestOverdueSeconds: number | null; scheduledPerMinute: number; inboundPerMinute: number
  normalChecksPerMinute: number; conservativeChecksPerMinute: number
  scheduler: { lastCompletedAt: number | null; failed: boolean; running: boolean; stale: boolean }
  publicReadReservation: { used: number; limit: number }
}
export interface DeliveryInbox {
  pending: Array<{ id: string; monitorName: string; eventType: string; createdAt: number;
    nextAttemptAt: number; attempts: number; deliveredCount: number; failed: number;
    claimUntil: number | null; channels: string | null }>
  hasMore: boolean
  receipts: Array<{ id: number; monitorName: string; channelName: string; eventType: string; deliveredAt: number }>
}

export type MonitorSummary = Pick<Monitor, 'id' | 'name' | 'type' | 'tags' | 'url' | 'interval' | 'active' | 'lastCheckedAt' | 'lastStatus' | 'displayStatus'>
