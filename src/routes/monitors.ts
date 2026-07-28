import { Hono, type Context } from 'hono'
import { and, asc, count, desc, eq, like, or, type SQL } from 'drizzle-orm'
import { getDb, monitors, heartbeatTokens, alertState, monitorNotifications, maintenanceWindows } from '../db'
import { requireAuth } from '../middleware/auth'
import { encryptField, isEncryptedValue } from '../utils'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)
const MONITOR_TYPES = new Set(['http', 'heartbeat', 'agent', 'dns', 'ping'])
const AUTH_TYPES = new Set(['none', 'basic', 'digest', 'bearer'])
const METHODS = new Set(['HEAD', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])
const MAX_MONITOR_BODY_BYTES = 128 * 1024

function sanitizeMonitor<T extends typeof monitors.$inferSelect>(monitor: T): T {
  return { ...monitor, authPassword: null, authToken: null }
}

async function encryptCredential(value: unknown, encryptionKey: string): Promise<string | null> {
  return typeof value === 'string' && value.length > 0
    ? (isEncryptedValue(value) ? value : encryptField(value, encryptionKey))
    : null
}

async function readMonitorBody(c: Context<{ Bindings: Env }>) {
  try {
    const body = await readJsonBodyWithLimit(c.req.raw, MAX_MONITOR_BODY_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
    return body as Record<string, any>
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    return c.json({ error: status === 413 ? 'Request is too large' : 'Invalid JSON body' }, status)
  }
}

function validateMonitor(body: Record<string, any>, existing?: typeof monitors.$inferSelect): string | null {
  const name = body.name ?? existing?.name
  const type = body.type ?? existing?.type
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 200) return 'Invalid monitor name'
  if (typeof type !== 'string' || !MONITOR_TYPES.has(type)) return 'Invalid monitor type'

  const boundedNumber = (field: string, min: number, max: number) => {
    const value = body[field]
    return value === undefined || value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max)
  }
  if (!boundedNumber('interval', 60, 86400)) return 'Interval must be between 60 and 86400 seconds'
  if (!boundedNumber('timeout', 1, 60)) return 'Timeout must be between 1 and 60 seconds'
  if (!boundedNumber('expectedStatus', 100, 599)) return 'Expected status must be between 100 and 599'
  if (!boundedNumber('toleranceFailures', 1, 100)) return 'Failure tolerance must be between 1 and 100'
  if (!boundedNumber('toleranceMissed', 1, 100)) return 'Missed-heartbeat tolerance must be between 1 and 100'
  if (!boundedNumber('heartbeatInterval', 60, 86400)) return 'Heartbeat interval must be between 60 and 86400 seconds'
  if (!boundedNumber('heartbeatGrace', 0, 86400)) return 'Heartbeat grace must be between 0 and 86400 seconds'
  for (const field of ['cpuThreshold', 'ramThreshold', 'diskThreshold']) {
    if (!boundedNumber(field, 0, 100)) return `${field} must be between 0 and 100`
  }

  if (body.tags !== undefined && (
    !Array.isArray(body.tags) ||
    body.tags.length > 50 ||
    body.tags.some((tag: unknown) => typeof tag !== 'string' || tag.length > 100)
  )) return 'Invalid tags'
  if (body.headers !== undefined && (
    !body.headers ||
    typeof body.headers !== 'object' ||
    Array.isArray(body.headers) ||
    Object.entries(body.headers).some(([key, value]) => key.length > 200 || typeof value !== 'string' || value.length > 8192)
  )) return 'Invalid headers'
  if (body.channelIds !== undefined && (
    !Array.isArray(body.channelIds) ||
    body.channelIds.length > 100 ||
    body.channelIds.some((id: unknown) => typeof id !== 'string')
  )) return 'Invalid notification channels'
  if (body.body !== undefined && body.body !== null && (typeof body.body !== 'string' || body.body.length > 65536)) {
    return 'Request body is too large'
  }

  const authType = body.authType ?? existing?.authType ?? 'none'
  if (typeof authType !== 'string' || !AUTH_TYPES.has(authType)) return 'Invalid authentication type'
  const method = body.method ?? existing?.method ?? 'GET'
  if (typeof method !== 'string' || !METHODS.has(method)) return 'Invalid HTTP method'

  if (type === 'http') {
    const url = body.url ?? existing?.url
    if (typeof url !== 'string') return 'HTTP monitor URL is required'
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'Monitor URL must use HTTP or HTTPS'
    } catch {
      return 'Invalid monitor URL'
    }
  } else if (type === 'ping') {
    const url = body.url ?? existing?.url
    if (typeof url !== 'string' || url.trim() === '' || url.length > 2048) return 'Ping target is required'
  } else if (type === 'dns') {
    const hostname = body.dnsHostname ?? existing?.dnsHostname
    if (typeof hostname !== 'string' || hostname.trim() === '' || hostname.length > 253) return 'DNS hostname is required'
  }
  return null
}

router.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const wantsPage = c.req.query('page') !== undefined
  if (!wantsPage) {
    const rows = await db.select().from(monitors)
    return c.json(rows.map(sanitizeMonitor))
  }

  const boundedInt = (value: string | undefined, fallback: number, min: number, max: number) => {
    const parsed = Number(value)
    return Number.isInteger(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback
  }
  const page = boundedInt(c.req.query('page'), 1, 1, 100_000)
  const pageSize = boundedInt(c.req.query('pageSize'), 25, 10, 100)
  const status = c.req.query('status')
  const type = c.req.query('type')
  const active = c.req.query('active')
  const search = c.req.query('search')?.trim().slice(0, 200)
  const conditions: SQL[] = []
  if (status && ['up', 'down', 'pending'].includes(status)) conditions.push(eq(monitors.lastStatus, status as 'up' | 'down' | 'pending'))
  if (type && MONITOR_TYPES.has(type)) conditions.push(eq(monitors.type, type as (typeof monitors.$inferSelect)['type']))
  if (active === 'true' || active === 'false') conditions.push(eq(monitors.active, active === 'true'))
  if (search) {
    const pattern = `%${search.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
    conditions.push(or(
      like(monitors.name, pattern),
      like(monitors.url, pattern),
      like(monitors.tags, pattern),
      like(monitors.dnsHostname, pattern),
    )!)
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined
  const sortMap = {
    name: monitors.name,
    status: monitors.lastStatus,
    type: monitors.type,
    checked: monitors.lastCheckedAt,
    updated: monitors.updatedAt,
  } as const
  const sortKey = c.req.query('sort') as keyof typeof sortMap
  const sortColumn = sortMap[sortKey] ?? monitors.updatedAt
  const order = c.req.query('direction') === 'asc' ? asc(sortColumn) : desc(sortColumn)
  const offset = (page - 1) * pageSize

  const [countRows, rows] = await Promise.all([
    db.select({ total: count() }).from(monitors).where(where),
    db.select().from(monitors).where(where).orderBy(order).limit(pageSize).offset(offset),
  ])
  const total = countRows[0]?.total ?? 0
  return c.json({
    items: rows.map(sanitizeMonitor),
    total,
    page,
    pageSize,
    totalPages: Math.max(1, Math.ceil(total / pageSize)),
  })
})

router.patch('/bulk', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readMonitorBody(c)
  if (body instanceof Response) return body
  if (!Array.isArray(body.ids) || body.ids.length === 0 || body.ids.length > 100 ||
      body.ids.some((id: unknown) => typeof id !== 'string')) {
    return c.json({ error: 'Select between 1 and 100 monitors' }, 400)
  }
  const idsJson = JSON.stringify(body.ids)
  if (body.action === 'delete') {
    await c.env.DB.prepare(`
      DELETE FROM monitors
      WHERE id IN (SELECT value FROM json_each(?))
    `).bind(idsJson).run()
    return c.json({ ok: true, affected: body.ids.length })
  }
  if (body.action !== 'pause' && body.action !== 'resume') {
    return c.json({ error: 'Invalid bulk action' }, 400)
  }
  const active = body.action === 'resume'
  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(`
    UPDATE monitors SET active = ?, updated_at = ?
    WHERE id IN (SELECT value FROM json_each(?))
  `).bind(active ? 1 : 0, now, idsJson).run()
  return c.json({ ok: true, affected: body.ids.length })
})

router.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, c.req.param('id')),
  })
  if (!monitor) return c.json({ error: 'Not found' }, 404)
  return c.json(sanitizeMonitor(monitor))
})

router.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readMonitorBody(c)
  if (body instanceof Response) return body
  const validationError = validateMonitor(body)
  if (validationError) return c.json({ error: validationError }, 400)
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const authType = body.authType ?? 'none'
  const authPassword = ['basic', 'digest'].includes(authType)
    ? await encryptCredential(body.authPassword, c.env.ENCRYPTION_KEY)
    : null
  const authToken = authType === 'bearer'
    ? await encryptCredential(body.authToken, c.env.ENCRYPTION_KEY)
    : null

  await db.insert(monitors).values({
    id,
    name: body.name,
    type: body.type,
    tags: JSON.stringify(body.tags ?? []),
    interval: body.interval ?? 60,
    active: body.active ?? true,
    lastStatus: 'pending',
    reminderIntervalHours: body.reminderIntervalHours ?? null,
    toleranceFailures: body.toleranceFailures ?? 1,
    url: body.url ?? null,
    method: body.method ?? 'GET',
    body: body.body ?? null,
    headers: JSON.stringify(body.headers ?? {}),
    expectedStatus: body.expectedStatus ?? 200,
    followRedirects: body.followRedirects ?? true,
    timeout: body.timeout ?? 30,
    ipVersion: body.ipVersion ?? 'auto',
    authType,
    authUsername: body.authUsername ?? null,
    authPassword,
    authToken,
    heartbeatInterval: body.heartbeatInterval ?? null,
    heartbeatGrace: body.heartbeatGrace ?? 30,
    toleranceMissed: body.toleranceMissed ?? 1,
    surgeProtectionLimit: body.surgeProtectionLimit ?? null,
    sslCheckEnabled: body.sslCheckEnabled ?? false,
    cacheBooster: body.cacheBooster ?? false,
    jsonPath: body.jsonPath ?? null,
    expectedValue: body.expectedValue ?? null,
    cpuThreshold: body.cpuThreshold ?? null,
    ramThreshold: body.ramThreshold ?? null,
    diskThreshold: body.diskThreshold ?? null,
    dnsHostname: body.dnsHostname ?? null,
    dnsRecordType: body.dnsRecordType ?? 'A',
    dnsResolverUrl: body.dnsResolverUrl ?? null,
    dnsExpectedIp: body.dnsExpectedIp ?? null,
    createdAt: now,
    updatedAt: now,
  })

  await db.insert(alertState).values({ monitorId: id })

  if (body.type === 'heartbeat' || body.type === 'agent') {
    await db.insert(heartbeatTokens).values({
      monitorId: id,
      token: crypto.randomUUID(),
    })
  }

  if (Array.isArray(body.channelIds)) {
    for (const channelId of body.channelIds) {
      await db.insert(monitorNotifications).values({ monitorId: id, channelId })
    }
  }

  const created = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  return c.json(sanitizeMonitor(created!), 201)
})

router.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readMonitorBody(c)
  if (body instanceof Response) return body
  const now = Math.floor(Date.now() / 1000)

  const existing = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const validationError = validateMonitor(body, existing)
  if (validationError) return c.json({ error: validationError }, 400)
  const nextType = body.type ?? existing.type
  const nextAuthType = body.authType ?? existing.authType
  const sameAuthType = nextAuthType === existing.authType
  const authPassword = ['basic', 'digest'].includes(nextAuthType)
    ? (await encryptCredential(body.authPassword, c.env.ENCRYPTION_KEY)
      ?? (sameAuthType ? existing.authPassword : null))
    : null
  const authToken = nextAuthType === 'bearer'
    ? (await encryptCredential(body.authToken, c.env.ENCRYPTION_KEY)
      ?? (sameAuthType ? existing.authToken : null))
    : null
  const authUsername = ['basic', 'digest'].includes(nextAuthType)
    ? (body.authUsername !== undefined
      ? body.authUsername
      : (sameAuthType ? existing.authUsername : null))
    : null

  await db.update(monitors).set({
    name: body.name ?? existing.name,
    type: nextType,
    tags: body.tags !== undefined ? JSON.stringify(body.tags) : existing.tags,
    interval: body.interval ?? existing.interval,
    active: body.active ?? existing.active,
    reminderIntervalHours: body.reminderIntervalHours ?? existing.reminderIntervalHours,
    toleranceFailures: body.toleranceFailures ?? existing.toleranceFailures,
    url: body.url ?? existing.url,
    method: body.method ?? existing.method,
    body: body.body ?? existing.body,
    headers: body.headers !== undefined ? JSON.stringify(body.headers) : existing.headers,
    expectedStatus: body.expectedStatus ?? existing.expectedStatus,
    followRedirects: body.followRedirects ?? existing.followRedirects,
    timeout: body.timeout ?? existing.timeout,
    ipVersion: body.ipVersion ?? existing.ipVersion,
    authType: nextAuthType,
    authUsername,
    authPassword,
    authToken,
    heartbeatInterval: body.heartbeatInterval ?? existing.heartbeatInterval,
    heartbeatGrace: body.heartbeatGrace ?? existing.heartbeatGrace,
    toleranceMissed: body.toleranceMissed ?? existing.toleranceMissed,
    surgeProtectionLimit: body.surgeProtectionLimit ?? existing.surgeProtectionLimit,
    sslCheckEnabled: body.sslCheckEnabled ?? existing.sslCheckEnabled,
    cacheBooster: body.cacheBooster ?? existing.cacheBooster,
    jsonPath: body.jsonPath ?? existing.jsonPath,
    expectedValue: body.expectedValue ?? existing.expectedValue,
    cpuThreshold: body.cpuThreshold ?? existing.cpuThreshold,
    ramThreshold: body.ramThreshold ?? existing.ramThreshold,
    diskThreshold: body.diskThreshold ?? existing.diskThreshold,
    dnsHostname: body.dnsHostname ?? existing.dnsHostname,
    dnsRecordType: body.dnsRecordType ?? existing.dnsRecordType,
    dnsResolverUrl: body.dnsResolverUrl ?? existing.dnsResolverUrl,
    dnsExpectedIp: body.dnsExpectedIp ?? existing.dnsExpectedIp,
    updatedAt: now,
  }).where(eq(monitors.id, id))

  const requiresHeartbeatToken = nextType === 'heartbeat' || nextType === 'agent'
  const hadHeartbeatToken = existing.type === 'heartbeat' || existing.type === 'agent'
  if (requiresHeartbeatToken && !hadHeartbeatToken) {
    await db.insert(heartbeatTokens)
      .values({ monitorId: id, token: crypto.randomUUID() })
      .onConflictDoNothing()
  } else if (!requiresHeartbeatToken && hadHeartbeatToken) {
    await db.delete(heartbeatTokens).where(eq(heartbeatTokens.monitorId, id))
  }

  if (Array.isArray(body.channelIds)) {
    await db.delete(monitorNotifications).where(eq(monitorNotifications.monitorId, id))
    for (const channelId of body.channelIds) {
      await db.insert(monitorNotifications).values({ monitorId: id, channelId })
    }
  }

  const updated = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  return c.json(sanitizeMonitor(updated!))
})

router.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  await db.delete(monitors).where(eq(monitors.id, id))
  return c.json({ ok: true })
})

router.get('/:id/heartbeat-token', async (c) => {
  const db = getDb(c.env.DB)
  const token = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.monitorId, c.req.param('id')),
  })
  if (!token) return c.json({ error: 'Not a heartbeat monitor' }, 404)
  return c.json(token)
})

router.post('/:id/heartbeat-token/regenerate', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const existing = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.monitorId, id),
  })
  if (!existing) return c.json({ error: 'Not a heartbeat or agent monitor' }, 404)
  const newToken = crypto.randomUUID()
  await db.update(heartbeatTokens)
    .set({ token: newToken })
    .where(eq(heartbeatTokens.monitorId, id))
  return c.json({ token: newToken })
})

router.post('/:id/reset-stats', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')

  const monitor = await db.query.monitors.findFirst({ where: eq(monitors.id, id) })
  if (!monitor) return c.json({ error: 'Not found' }, 404)

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM status_logs WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM monitor_daily_rollups WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare('DELETE FROM incidents WHERE monitor_id = ?').bind(id),
    c.env.DB.prepare(`
      UPDATE alert_state SET
        consecutive_failures = 0,
        consecutive_missed = 0,
        alert_sent_at = NULL,
        consecutive_alerts = 0,
        last_reminder_at = NULL,
        surge_paused_until = NULL
      WHERE monitor_id = ?
    `).bind(id),
    c.env.DB.prepare(`
      UPDATE monitors SET
        last_status = 'pending',
        last_checked_at = NULL,
        history_revision = history_revision + 1,
        stats_day = NULL,
        day_checks = 0,
        day_up_count = 0,
        day_down_count = 0,
        day_response_count = 0,
        day_response_sum_ms = 0,
        day_response_min_ms = NULL,
        day_response_max_ms = NULL
      WHERE id = ?
    `).bind(id),
  ])

  return c.json({ ok: true })
})

router.get('/:id/channels', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select()
    .from(monitorNotifications)
    .where(eq(monitorNotifications.monitorId, c.req.param('id')))
  return c.json(rows.map(r => r.channelId))
})

router.get('/:id/maintenance', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select()
    .from(maintenanceWindows)
    .where(eq(maintenanceWindows.monitorId, c.req.param('id')))
  return c.json(rows)
})

router.post('/:id/maintenance', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readMonitorBody(c)
  if (body instanceof Response) return body
  if (
    typeof body.startAt !== 'number' ||
    typeof body.endAt !== 'number' ||
    !Number.isInteger(body.startAt) ||
    !Number.isInteger(body.endAt) ||
    body.startAt >= body.endAt ||
    (body.reason !== undefined && body.reason !== null &&
      (typeof body.reason !== 'string' || body.reason.length > 500))
  ) {
    return c.json({ error: 'Invalid maintenance window' }, 400)
  }
  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, c.req.param('id')),
  })
  if (!monitor) return c.json({ error: 'Not found' }, 404)
  const id = crypto.randomUUID()
  await db.insert(maintenanceWindows).values({
    id,
    monitorId: c.req.param('id'),
    startAt: body.startAt,
    endAt: body.endAt,
    reason: body.reason ?? null,
  })
  return c.json({ ok: true, id })
})

router.delete('/:id/maintenance/:maintenanceId', async (c) => {
  const db = getDb(c.env.DB)
  await db.delete(maintenanceWindows)
    .where(and(
      eq(maintenanceWindows.id, c.req.param('maintenanceId')),
      eq(maintenanceWindows.monitorId, c.req.param('id')),
    ))
  return c.json({ ok: true })
})

export default router
