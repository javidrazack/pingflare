import { Hono } from 'hono'
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
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

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
  const body = await c.req.json()
  const id = crypto.randomUUID()
  const now = Math.floor(Date.now() / 1000)

  await db.insert(incidentReports).values({
    id,
    title: body.title,
    status: body.status ?? 'investigating',
    visibility: body.visibility === 'draft' ? 'draft' : 'published',
    impact: ['minor', 'major', 'critical'].includes(body.impact) ? body.impact : 'minor',
    publishedAt: body.visibility === 'draft' ? null : now,
    startedAt: now,
    resolvedAt: body.status === 'resolved' ? now : null,
  })

  if (body.message) {
    await db.insert(incidentUpdates).values({
      id: crypto.randomUUID(),
      incidentId: id,
      message: body.message,
      status: body.status ?? 'investigating',
    })
  }

  if (Array.isArray(body.monitorIds)) {
    for (const monitorId of body.monitorIds) {
      await db.insert(incidentMonitors).values({ incidentId: id, monitorId })
    }
  }

  if (Array.isArray(body.eventIds)) {
    const eventIds = [...new Set<string>(
      (body.eventIds as unknown[]).filter((value): value is string => typeof value === 'string'),
    )].slice(0, 100)
    for (const eventId of eventIds) {
      await db.insert(incidentReportEvents).values({ incidentId: id, eventId }).onConflictDoNothing()
    }
  }

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
  const body = await c.req.json()
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

  if (Array.isArray(body.monitorIds)) {
    await db.delete(incidentMonitors).where(eq(incidentMonitors.incidentId, id))
    for (const monitorId of body.monitorIds) {
      await db.insert(incidentMonitors).values({ incidentId: id, monitorId })
    }
  }

  if (Array.isArray(body.eventIds)) {
    await db.delete(incidentReportEvents).where(eq(incidentReportEvents.incidentId, id))
    const eventIds = [...new Set<string>(
      (body.eventIds as unknown[]).filter((value): value is string => typeof value === 'string'),
    )].slice(0, 100)
    for (const eventId of eventIds) {
      await db.insert(incidentReportEvents).values({ incidentId: id, eventId }).onConflictDoNothing()
    }
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
