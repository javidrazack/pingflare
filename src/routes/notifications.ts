import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, notificationChannels, monitors, monitorNotifications } from '../db'
import { requireAuth } from '../middleware/auth'
import { sendNotification } from '../services/notifier'
import { SENSITIVE_FIELDS, isEncryptedValue, encryptField } from '../utils'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)
const CHANNEL_TYPES = new Set([
  'discord', 'slack', 'telegram', 'email', 'ntfy', 'pushover', 'webhook',
  'apprise', 'googlechat', 'msteams', 'matrix', 'pagerduty', 'twilio',
])

async function readChannelBody(c: Context<{ Bindings: Env }>): Promise<Record<string, any> | Response> {
  try {
    const body = await readJsonBodyWithLimit(c.req.raw, 64 * 1024)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
    return body as Record<string, any>
  } catch (error) {
    return c.json(
      { error: error instanceof RequestBodyTooLargeError ? 'Request is too large' : 'Invalid JSON body' },
      error instanceof RequestBodyTooLargeError ? 413 : 400,
    )
  }
}

function validateChannel(body: Record<string, any>, existingType?: string): string | null {
  const type = body.type ?? existingType
  if (typeof body.name !== 'undefined' && (
    typeof body.name !== 'string' || body.name.trim() === '' || body.name.length > 200
  )) return 'Invalid channel name'
  if (typeof type !== 'string' || !CHANNEL_TYPES.has(type)) return 'Invalid channel type'
  if (body.config !== undefined && (
    !body.config ||
    typeof body.config !== 'object' ||
    Array.isArray(body.config) ||
    Object.keys(body.config).length > 100 ||
    Object.entries(body.config).some(([key, value]) =>
      key.length > 100 || typeof value !== 'string' || value.length > 16384)
  )) return 'Invalid channel configuration'
  return null
}

function sanitizeChannel(ch: { id: string; name: string; type: string; config: string; active: boolean; isDefault: boolean; createdAt: number }) {
  const config = JSON.parse(ch.config) as Record<string, string>
  const sensitiveKeys = SENSITIVE_FIELDS[ch.type] ?? []
  const encryptedFields: string[] = []

  for (const key of sensitiveKeys) {
    if (config[key]) {
      encryptedFields.push(key)
      config[key] = ''
    }
  }

  return { ...ch, config: JSON.stringify(config), encryptedFields }
}

async function encryptSensitiveFields(
  config: Record<string, string>,
  type: string,
  encryptionKey: string,
): Promise<Record<string, string>> {
  const result = { ...config }
  for (const key of SENSITIVE_FIELDS[type] ?? []) {
    if (result[key] && result[key].length > 0 && !isEncryptedValue(result[key])) {
      result[key] = await encryptField(result[key], encryptionKey)
    }
  }
  return result
}

router.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const channels = await db.select().from(notificationChannels)
  return c.json(channels.map(sanitizeChannel))
})

router.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const ch = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, c.req.param('id')),
  })
  if (!ch) return c.json({ error: 'Not found' }, 404)
  return c.json(sanitizeChannel(ch))
})

router.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readChannelBody(c)
  if (body instanceof Response) return body
  const validationError = validateChannel(body)
  if (validationError || typeof body.name !== 'string') {
    return c.json({ error: validationError ?? 'Channel name is required' }, 400)
  }
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  let config = body.config ?? {}
  config = await encryptSensitiveFields(config, body.type, c.env.ENCRYPTION_KEY)

  await db.insert(notificationChannels).values({
    id,
    name: body.name,
    type: body.type,
    config: JSON.stringify(config),
    active: body.active ?? true,
    isDefault: body.isDefault ?? false,
    createdAt: now,
  })

  const created = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, id),
  })
  return c.json(sanitizeChannel(created!), 201)
})

router.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readChannelBody(c)
  if (body instanceof Response) return body

  const existing = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, id),
  })
  if (!existing) return c.json({ error: 'Not found' }, 404)
  const validationError = validateChannel(body, existing.type)
  if (validationError) return c.json({ error: validationError }, 400)

  const nextType = body.type ?? existing.type
  let newConfig: Record<string, string> | undefined
  if (body.config !== undefined) {
    const existingConfig = JSON.parse(existing.config) as Record<string, string>
    const incomingConfig = body.config as Record<string, string>
    const mergedConfig = nextType === existing.type
      ? { ...existingConfig, ...incomingConfig }
      : { ...incomingConfig }

    for (const key of SENSITIVE_FIELDS[nextType] ?? []) {
      const incoming = incomingConfig[key]
      if (nextType === existing.type && (!incoming || incoming.length === 0)) {
        const saved = existingConfig[key] ?? ''
        mergedConfig[key] = saved && !isEncryptedValue(saved)
          ? await encryptField(saved, c.env.ENCRYPTION_KEY)
          : saved
      } else if (incoming && !isEncryptedValue(incoming)) {
        mergedConfig[key] = await encryptField(incoming, c.env.ENCRYPTION_KEY)
      }
    }

    newConfig = mergedConfig
  }

  await db.update(notificationChannels).set({
    name: body.name ?? existing.name,
    type: nextType,
    config: newConfig !== undefined ? JSON.stringify(newConfig) : existing.config,
    active: body.active ?? existing.active,
    isDefault: body.isDefault !== undefined ? body.isDefault : existing.isDefault,
  }).where(eq(notificationChannels.id, id))

  const updated = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, id),
  })
  return c.json(sanitizeChannel(updated!))
})

router.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  await db.delete(notificationChannels).where(eq(notificationChannels.id, c.req.param('id')))
  return c.json({ ok: true })
})

router.post('/:id/apply-all-monitors', async (c) => {
  const db = getDb(c.env.DB)
  const channelId = c.req.param('id')

  const ch = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, channelId),
  })
  if (!ch) return c.json({ error: 'Not found' }, 404)

  const allMonitors = await db.select().from(monitors)
  for (const monitor of allMonitors) {
    await db.insert(monitorNotifications)
      .values({ monitorId: monitor.id, channelId })
      .onConflictDoNothing()
  }

  return c.json({ ok: true, applied: allMonitors.length })
})

router.post('/:id/test', async (c) => {
  const db = getDb(c.env.DB)
  const ch = await db.query.notificationChannels.findFirst({
    where: eq(notificationChannels.id, c.req.param('id')),
  })
  if (!ch) return c.json({ error: 'Not found' }, 404)

  try {
    await sendNotification(ch, {
      type: 'callback',
      monitor: { id: 'test', name: 'Test Monitor', type: 'http', url: 'https://example.com' },
      status: 'up',
      message: 'This is a test notification from Pingflare.',
    }, c.env.ENCRYPTION_KEY)
    return c.json({ ok: true })
  } catch (err) {
    return c.json({ error: String(err) }, 500)
  }
})

export default router
