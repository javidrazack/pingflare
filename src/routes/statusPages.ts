import { Hono, type Context } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, statusPages, statusPageMonitors } from '../db'
import { requireAuth } from '../middleware/auth'
import { hashPassword } from '../utils'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import { PUBLIC_STATUS_MONITOR_LIMIT } from '../services/d1-budget'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

const THEMES = new Set(['light', 'dark', 'system'])
const HISTORY_DAYS = new Set([7, 30, 60, 90])
const MAX_STATUS_PAGE_BODY_BYTES = 128 * 1024
const MAX_STATUS_PAGE_MONITORS = PUBLIC_STATUS_MONITOR_LIMIT

async function readStatusPageBody(c: Context<{ Bindings: Env }>) {
  try {
    const body = await readJsonBodyWithLimit(c.req.raw, MAX_STATUS_PAGE_BODY_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
    return body as Record<string, any>
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    return c.json({ error: status === 413 ? 'Request is too large' : 'Invalid JSON body' }, status)
  }
}

function pageMonitorIds(value: unknown): string[] | null | 'invalid' {
  if (value === undefined) return null
  if (
    !Array.isArray(value)
    || value.length > MAX_STATUS_PAGE_MONITORS
    || value.some((id) => typeof id !== 'string' || id.length === 0)
  ) return 'invalid'
  return [...new Set(value)]
}

function pageMonitorInsert(
  env: Env,
  pageId: string,
  monitorIds: string[],
): D1PreparedStatement {
  const links = monitorIds.map((monitorId, sortOrder) => ({ monitorId, sortOrder }))
  return env.DB.prepare(`
    INSERT INTO status_page_monitors (page_id, monitor_id, sort_order)
    SELECT
      ?,
      json_extract(value, '$.monitorId'),
      CAST(json_extract(value, '$.sortOrder') AS INTEGER)
    FROM json_each(?)
    WHERE true
    ON CONFLICT (page_id, monitor_id) DO UPDATE SET
      sort_order = excluded.sort_order
  `).bind(pageId, JSON.stringify(links))
}

function pageAppearance(body: Record<string, any>, existing?: typeof statusPages.$inferSelect) {
  const brandColor = typeof body.brandColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(body.brandColor)
    ? body.brandColor.toUpperCase()
    : existing?.brandColor ?? '#B45309'
  return {
    logoUrl: body.logoUrl !== undefined ? (body.logoUrl || null) : existing?.logoUrl ?? null,
    brandColor,
    theme: THEMES.has(body.theme) ? body.theme : existing?.theme ?? 'system',
    showResponseTime: body.showResponseTime !== undefined ? !!body.showResponseTime : existing?.showResponseTime ?? true,
    showUptime: body.showUptime !== undefined ? !!body.showUptime : existing?.showUptime ?? true,
    historyDays: HISTORY_DAYS.has(Number(body.historyDays)) ? Number(body.historyDays) : existing?.historyDays ?? 90,
    seoTitle: body.seoTitle !== undefined ? (body.seoTitle || null) : existing?.seoTitle ?? null,
    seoDescription: body.seoDescription !== undefined ? (body.seoDescription || null) : existing?.seoDescription ?? null,
  } as const
}

function sanitizePage<T extends typeof statusPages.$inferSelect>(page: T): T {
  return { ...page, passwordHash: page.passwordHash ? 'configured' : null }
}

router.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select().from(statusPages)
  return c.json(rows.map(sanitizePage))
})

router.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readStatusPageBody(c)
  if (body instanceof Response) return body
  const monitorIds = pageMonitorIds(body.monitorIds)
  if (monitorIds === 'invalid') {
    return c.json({ error: `Select at most ${MAX_STATUS_PAGE_MONITORS} monitors` }, 400)
  }
  const id = crypto.randomUUID()

  let passwordHash: string | null = null
  if (body.password) passwordHash = await hashPassword(body.password)

  const appearance = pageAppearance(body)
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`
      INSERT INTO status_pages (
        id, name, slug, description, password_hash, show_all_monitors,
        logo_url, brand_color, theme, show_response_time, show_uptime,
        history_days, seo_title, seo_description
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      body.name,
      body.slug,
      body.description ?? null,
      passwordHash,
      body.showAllMonitors ? 1 : 0,
      appearance.logoUrl,
      appearance.brandColor,
      appearance.theme,
      appearance.showResponseTime ? 1 : 0,
      appearance.showUptime ? 1 : 0,
      appearance.historyDays,
      appearance.seoTitle,
      appearance.seoDescription,
    ),
  ]
  if (monitorIds && monitorIds.length > 0) {
    statements.push(pageMonitorInsert(c.env, id, monitorIds))
  }
  await c.env.DB.batch(statements)

  const created = await db.query.statusPages.findFirst({ where: eq(statusPages.id, id) })
  return c.json(sanitizePage(created!), 201)
})

router.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.id, c.req.param('id')) })
  if (!page) return c.json({ error: 'Not found' }, 404)
  return c.json(sanitizePage(page))
})

router.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readStatusPageBody(c)
  if (body instanceof Response) return body
  const monitorIds = pageMonitorIds(body.monitorIds)
  if (monitorIds === 'invalid') {
    return c.json({ error: `Select at most ${MAX_STATUS_PAGE_MONITORS} monitors` }, 400)
  }
  const existing = await db.query.statusPages.findFirst({ where: eq(statusPages.id, id) })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  let passwordHash = existing.passwordHash
  if (body.password === '') {
    passwordHash = null
  } else if (body.password) {
    passwordHash = await hashPassword(body.password)
  }

  await db.update(statusPages).set({
    name: body.name ?? existing.name,
    slug: body.slug ?? existing.slug,
    description: body.description !== undefined ? body.description : existing.description,
    passwordHash,
    showAllMonitors: body.showAllMonitors !== undefined ? body.showAllMonitors : existing.showAllMonitors,
    ...pageAppearance(body, existing),
  }).where(eq(statusPages.id, id))

  if (monitorIds) {
    const statements: D1PreparedStatement[] = [
      c.env.DB.prepare('DELETE FROM status_page_monitors WHERE page_id = ?').bind(id),
    ]
    if (monitorIds.length > 0) {
      statements.push(pageMonitorInsert(c.env, id, monitorIds))
    }
    await c.env.DB.batch(statements)
  }

  const updated = await db.query.statusPages.findFirst({ where: eq(statusPages.id, id) })
  return c.json(sanitizePage(updated!))
})

router.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  await db.delete(statusPages).where(eq(statusPages.id, c.req.param('id')))
  return c.json({ ok: true })
})

router.get('/:id/monitors', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select().from(statusPageMonitors)
    .where(eq(statusPageMonitors.pageId, c.req.param('id')))
  return c.json(rows.map(r => r.monitorId))
})

export default router
