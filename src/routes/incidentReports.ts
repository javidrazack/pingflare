import { Hono, type Context } from 'hono'
import { eq, desc, inArray, isNull } from 'drizzle-orm'
import {
  getDb,
  incidentReports,
  incidentUpdates,
  incidentMonitors,
  incidentReportEvents,
  incidents,
  monitors,
} from '../db'
import { requireAuth } from '../middleware/auth'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)
const MAX_INCIDENT_BODY_BYTES = 128 * 1024
const MAX_MONITOR_ASSOCIATIONS = 1000
const MAX_EVENT_ASSOCIATIONS = 100

async function readIncidentBody(c: Context<{ Bindings: Env }>) {
  try {
    const body = await readJsonBodyWithLimit(c.req.raw, MAX_INCIDENT_BODY_BYTES)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new SyntaxError()
    return body as Record<string, any>
  } catch (error) {
    const status = error instanceof RequestBodyTooLargeError ? 413 : 400
    return c.json({ error: status === 413 ? 'Request is too large' : 'Invalid JSON body' }, status)
  }
}

function associationIds(
  value: unknown,
  maxIds: number,
): string[] | null | 'invalid' {
  if (value === undefined) return null
  if (
    !Array.isArray(value)
    || value.length > maxIds
    || value.some((id) => typeof id !== 'string' || id.length === 0)
  ) return 'invalid'
  return [...new Set(value)]
}

function associationInsert(
  env: Env,
  table: 'incident_monitors' | 'incident_report_events',
  targetColumn: 'monitor_id' | 'event_id',
  incidentId: string,
  ids: string[],
): D1PreparedStatement {
  return env.DB.prepare(`
    INSERT INTO ${table} (incident_id, ${targetColumn})
    SELECT ?, value
    FROM json_each(?)
    WHERE true
    ON CONFLICT (incident_id, ${targetColumn}) DO NOTHING
  `).bind(incidentId, JSON.stringify(ids))
}

router.get('/', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select().from(incidentReports).orderBy(desc(incidentReports.startedAt)).limit(100)
  if (rows.length === 0) return c.json([])
  const ids = rows.map(row => row.id)
  const [links, updates] = await Promise.all([
    db.select().from(incidentMonitors).where(inArray(incidentMonitors.incidentId, ids)),
    db.select().from(incidentUpdates)
      .where(inArray(incidentUpdates.incidentId, ids))
      .orderBy(desc(incidentUpdates.createdAt)),
  ])
  const enriched = rows.map(inc => ({
    ...inc,
    monitorIds: links.filter(row => row.incidentId === inc.id).map(row => row.monitorId),
    updates: updates.filter(row => row.incidentId === inc.id),
  }))
  return c.json(enriched)
})

router.get('/detected', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select({
    id: incidents.id,
    monitorId: incidents.monitorId,
    monitorName: monitors.name,
    startedAt: incidents.startedAt,
    resolvedAt: incidents.resolvedAt,
    durationSeconds: incidents.durationSeconds,
  })
    .from(incidents)
    .innerJoin(monitors, eq(incidents.monitorId, monitors.id))
    .leftJoin(incidentReportEvents, eq(incidents.id, incidentReportEvents.eventId))
    .where(isNull(incidentReportEvents.eventId))
    .orderBy(desc(incidents.startedAt))
    .limit(100)
  return c.json(rows)
})

router.post('/', async (c) => {
  const db = getDb(c.env.DB)
  const body = await readIncidentBody(c)
  if (body instanceof Response) return body
  const monitorIds = associationIds(body.monitorIds, MAX_MONITOR_ASSOCIATIONS)
  const eventIds = associationIds(body.eventIds, MAX_EVENT_ASSOCIATIONS)
  if (monitorIds === 'invalid' || eventIds === 'invalid') {
    return c.json({
      error: 'Select at most 1000 monitors and 100 detected events',
    }, 400)
  }
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)
  const status = body.status ?? 'investigating'
  const visibility = body.visibility === 'draft' ? 'draft' : 'published'
  const impact = ['minor', 'major', 'critical'].includes(body.impact) ? body.impact : 'minor'
  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(`
      INSERT INTO incident_reports (
        id, title, status, visibility, impact, published_at, started_at, resolved_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      body.title,
      status,
      visibility,
      impact,
      visibility === 'draft' ? null : now,
      now,
      status === 'resolved' ? now : null,
    ),
  ]

  if (body.message) {
    statements.push(c.env.DB.prepare(`
      INSERT INTO incident_updates (id, incident_id, message, status)
      VALUES (?, ?, ?, ?)
    `).bind(crypto.randomUUID(), id, body.message, status))
  }
  if (monitorIds && monitorIds.length > 0) {
    statements.push(associationInsert(
      c.env,
      'incident_monitors',
      'monitor_id',
      id,
      monitorIds,
    ))
  }
  if (eventIds && eventIds.length > 0) {
    statements.push(associationInsert(
      c.env,
      'incident_report_events',
      'event_id',
      id,
      eventIds,
    ))
  }
  await c.env.DB.batch(statements)

  const created = await db.query.incidentReports.findFirst({ where: eq(incidentReports.id, id) })
  return c.json(created, 201)
})

router.get('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const incident = await db.query.incidentReports.findFirst({ where: eq(incidentReports.id, id) })
  if (!incident) return c.json({ error: 'Not found' }, 404)
  const updates = await db.select().from(incidentUpdates)
    .where(eq(incidentUpdates.incidentId, id))
    .orderBy(desc(incidentUpdates.createdAt))
  const links = await db.select().from(incidentMonitors).where(eq(incidentMonitors.incidentId, id))
  return c.json({ ...incident, updates, monitorIds: links.map(r => r.monitorId) })
})

router.put('/:id', async (c) => {
  const db = getDb(c.env.DB)
  const id = c.req.param('id')
  const body = await readIncidentBody(c)
  if (body instanceof Response) return body
  const monitorIds = associationIds(body.monitorIds, MAX_MONITOR_ASSOCIATIONS)
  const eventIds = associationIds(body.eventIds, MAX_EVENT_ASSOCIATIONS)
  if (monitorIds === 'invalid' || eventIds === 'invalid') {
    return c.json({
      error: 'Select at most 1000 monitors and 100 detected events',
    }, 400)
  }
  const now = Math.floor(Date.now() / 1000)
  const existing = await db.query.incidentReports.findFirst({ where: eq(incidentReports.id, id) })
  if (!existing) return c.json({ error: 'Not found' }, 404)

  const nextStatus = body.status ?? existing.status
  const resolvedAt = nextStatus === 'resolved' ? (existing.resolvedAt ?? now) : null
  await db.update(incidentReports).set({
    title: body.title ?? existing.title,
    status: nextStatus,
    visibility: body.visibility === 'draft' || body.visibility === 'published'
      ? body.visibility
      : existing.visibility,
    impact: ['minor', 'major', 'critical'].includes(body.impact)
      ? body.impact
      : existing.impact,
    publishedAt: body.visibility === 'published'
      ? (existing.publishedAt ?? now)
      : body.visibility === 'draft' ? null : existing.publishedAt,
    resolvedAt,
  }).where(eq(incidentReports.id, id))

  const associationStatements: D1PreparedStatement[] = []
  if (monitorIds) {
    associationStatements.push(
      c.env.DB.prepare('DELETE FROM incident_monitors WHERE incident_id = ?').bind(id),
    )
    if (monitorIds.length > 0) {
      associationStatements.push(associationInsert(
        c.env,
        'incident_monitors',
        'monitor_id',
        id,
        monitorIds,
      ))
    }
  }

  if (eventIds) {
    associationStatements.push(
      c.env.DB.prepare('DELETE FROM incident_report_events WHERE incident_id = ?').bind(id),
    )
    if (eventIds.length > 0) {
      associationStatements.push(associationInsert(
        c.env,
        'incident_report_events',
        'event_id',
        id,
        eventIds,
      ))
    }
  }
  if (associationStatements.length > 0) {
    await c.env.DB.batch(associationStatements)
  }

  const updated = await db.query.incidentReports.findFirst({ where: eq(incidentReports.id, id) })
  return c.json(updated)
})

router.post('/:id/updates', async (c) => {
  const db = getDb(c.env.DB)
  const incidentId = c.req.param('id')
  const body = await c.req.json()
  const now = Math.floor(Date.now() / 1000)

  const incident = await db.query.incidentReports.findFirst({ where: eq(incidentReports.id, incidentId) })
  if (!incident) return c.json({ error: 'Not found' }, 404)

  const updateId = crypto.randomUUID()
  await db.insert(incidentUpdates).values({
    id: updateId,
    incidentId,
    message: body.message,
    status: body.status,
  })

  const resolvedAt = body.status === 'resolved' ? (incident.resolvedAt ?? now) : null
  await db.update(incidentReports).set({ status: body.status, resolvedAt }).where(eq(incidentReports.id, incidentId))

  const update = await db.query.incidentUpdates.findFirst({ where: eq(incidentUpdates.id, updateId) })
  return c.json(update, 201)
})

router.delete('/:id', async (c) => {
  const db = getDb(c.env.DB)
  await db.delete(incidentReports).where(eq(incidentReports.id, c.req.param('id')))
  return c.json({ ok: true })
})

export default router
