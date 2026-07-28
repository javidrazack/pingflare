import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { schedule } from 'node-cron'
import path from 'node:path'

import { openSqlite } from './db/shim'
import { ensureSchema } from './db/migrate'
import { runCron } from './cron'
import { requireAuth } from './middleware/auth'
import type { Env } from './index'

import authRoutes from './routes/auth'
import monitorRoutes from './routes/monitors'
import heartbeatRoutes from './routes/heartbeat'
import historyRoutes from './routes/history'
import notificationRoutes from './routes/notifications'
import settingsRoutes from './routes/settings'
import statusPagesRoutes from './routes/statusPages'
import publicStatusRoutes from './routes/publicStatus'
import incidentReportsRoutes from './routes/incidentReports'
import backupRoutes from './routes/backup'
import eventsRoutes from './routes/events'
import agentRoutes from './routes/agent'

function createLocalLoginRateLimiter(): RateLimit {
  const attempts = new Map<string, { count: number; resetAt: number }>()
  return {
    async limit({ key }) {
      const now = Date.now()
      const current = attempts.get(key)
      if (!current || now >= current.resetAt) {
        attempts.set(key, { count: 1, resetAt: now + 60_000 })
        return { success: true }
      }
      current.count += 1
      return { success: current.count <= 5 }
    },
  }
}

function createNoopAnalyticsDataset(): AnalyticsEngineDataset {
  return {
    writeDataPoint() {},
  }
}

async function main() {
  const dbPath = process.env.DB_PATH ?? path.join(process.cwd(), 'data', 'pingflare.db')
  const { shim } = openSqlite(dbPath)
  const d1 = shim as unknown as D1Database

  await ensureSchema(d1)

  const env: Env = {
    DB: d1,
    LOGIN_RATE_LIMITER: createLocalLoginRateLimiter(),
    CHECK_ANALYTICS: createNoopAnalyticsDataset(),
    API_ANALYTICS: createNoopAnalyticsDataset(),
    PINGFLARE_INSTANCE_ID: process.env.PINGFLARE_INSTANCE_ID ?? 'docker',
    API_ANALYTICS_SAMPLE_RATE: process.env.API_ANALYTICS_SAMPLE_RATE ?? '0',
    ADMIN_USER: process.env.ADMIN_USER ?? '',
    ADMIN_PASS: process.env.ADMIN_PASS ?? '',
    JWT_SECRET: process.env.JWT_SECRET ?? '',
    ENCRYPTION_KEY: process.env.ENCRYPTION_KEY ?? '',
  }

  if (
    !env.ADMIN_USER ||
    !env.ADMIN_PASS ||
    env.JWT_SECRET.length < 32 ||
    env.ENCRYPTION_KEY.length < 32
  ) {
    console.error('Missing required env vars, or JWT_SECRET/ENCRYPTION_KEY are shorter than 32 characters')
    process.exit(1)
  }

  const app = new Hono<{ Bindings: Env }>()

  app.use('*', async (c, next) => {
    await next()
    const usesApplicationApi = c.req.path.startsWith('/api/')
      || c.req.path === '/api'
      || c.req.path.startsWith('/h/')
      || c.req.path === '/h'
    if (usesApplicationApi && !c.res.headers.has('Cache-Control')) {
      c.header('Cache-Control', 'no-store')
    }
  })
  app.use('/api/*', cors())

  app.route('/api/auth', authRoutes)
  app.route('/h', heartbeatRoutes)
  app.route('/api/monitors', historyRoutes)
  app.route('/api/monitors', monitorRoutes)
  app.route('/api/notifications', notificationRoutes)
  app.route('/api/agent', agentRoutes)
  app.route('/api/settings', settingsRoutes)
  app.route('/api/status-pages', statusPagesRoutes)
  app.route('/api/public/status', publicStatusRoutes)
  app.route('/api/incidents', incidentReportsRoutes)
  app.route('/api/backup', backupRoutes)
  app.route('/api/events', eventsRoutes)

  app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

  app.post('/api/cron/run', requireAuth, async (c) => {
    await runCron(c.env)
    return c.json({ ok: true, triggeredAt: Date.now() })
  })

  const staticRoot = path.join(process.cwd(), 'frontend', 'build')
  app.use('*', serveStatic({ root: staticRoot }))
  app.get('*', serveStatic({ path: path.join(staticRoot, 'index.html') }))

  schedule('* * * * *', () => {
    runCron(env).catch((err) => console.error('[cron]', err))
  })

  const port = parseInt(process.env.PORT ?? '3000', 10)

  serve(
    {
      // Inject env bindings as the second fetch argument (c.env in all routes)
      fetch: (req) => app.fetch(req, env),
      port,
    },
    (info) => console.log(`Pingflare running on http://0.0.0.0:${info.port}`),
  )
}

main().catch((err) => {
  console.error('Failed to start:', err)
  process.exit(1)
})
