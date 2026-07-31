import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import { getDb, monitors } from '../db'
import { requireAuth } from '../middleware/auth'
import { classifyInfrastructureNode } from '../services/infrastructure'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
const MAX_NODES = 200

router.use('*', requireAuth)
router.use('*', async (c, next) => {
  await next()
  c.header('Cache-Control', 'private, no-store')
})

router.get('/overview', async (c) => {
  const db = getDb(c.env.DB)
  const rows = await db.select()
    .from(monitors)
    .where(eq(monitors.type, 'agent'))
    .orderBy(asc(monitors.name))
    .limit(MAX_NODES + 1)

  const now = Math.floor(Date.now() / 1000)
  const truncated = rows.length > MAX_NODES
  const nodes = rows
    .slice(0, MAX_NODES)
    .map((monitor) => classifyInfrastructureNode(monitor, now))
  const severity = {
    critical: 0,
    stale: 1,
    warning: 2,
    pending: 3,
    paused: 4,
    healthy: 5,
  } as const
  const issues = nodes
    .filter((node) => node.state !== 'healthy' && node.state !== 'paused')
    .sort((a, b) => severity[a.state] - severity[b.state] || a.name.localeCompare(b.name))
    .slice(0, 5)

  return c.json({
    generatedAt: now,
    truncated,
    summary: {
      total: nodes.length,
      reporting: nodes.filter((node) =>
        node.active
        && node.metrics !== null
        && node.state !== 'stale'
        && node.state !== 'pending',
      ).length,
      pressure: nodes.filter((node) => node.pressure !== 'normal').length,
      stale: nodes.filter((node) => node.state === 'stale').length,
    },
    issues,
    nodes,
  })
})

export default router
