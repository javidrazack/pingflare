import { Hono } from 'hono'
import { getDb } from '../db'
import { settings } from '../db/schema'
import { requireAuth } from '../middleware/auth'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const app = new Hono<{ Bindings: Env }>()

app.use('*', requireAuth)
const MAX_SETTINGS_BODY_BYTES = 64 * 1024
const MAX_SETTINGS_PER_REQUEST = 100
const MAX_SETTING_KEY_LENGTH = 200
const MAX_SETTING_VALUE_LENGTH = 16 * 1024

app.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select().from(settings)
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return c.json(result)
})

app.put('/', async (c) => {
  let body: unknown
  try {
    body = await readJsonBodyWithLimit(c.req.raw, MAX_SETTINGS_BODY_BYTES)
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    return c.json({ error: status === 413 ? 'Request is too large' : 'Invalid JSON body' }, status)
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return c.json({ error: 'Invalid settings object' }, 400)
  }
  const entries = Object.entries(body)
  const normalized = entries.map(([key, value]) => ({ key, value: String(value) }))
  if (
    normalized.length > MAX_SETTINGS_PER_REQUEST
    || normalized.some(({ key, value }) =>
      key.length === 0
      || key.length > MAX_SETTING_KEY_LENGTH
      || value.length > MAX_SETTING_VALUE_LENGTH)
  ) {
    return c.json({ error: 'Invalid settings object' }, 400)
  }

  const db = getDb(c.env.DB)
  if (normalized.length > 0) {
    await c.env.DB.prepare(`
      INSERT INTO settings (key, value)
      SELECT
        json_extract(value, '$.key'),
        json_extract(value, '$.value')
      FROM json_each(?)
      WHERE 1
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).bind(JSON.stringify(normalized)).run()
  }
  const rows = await db.select().from(settings)
  const result: Record<string, string> = {}
  for (const row of rows) result[row.key] = row.value
  return c.json(result)
})

export default app
