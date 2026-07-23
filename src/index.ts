import { Hono } from 'hono'
import { cors } from 'hono/cors'
import authRoutes from './routes/auth'
import monitorRoutes from './routes/monitors'
import heartbeatRoutes from './routes/heartbeat'
import historyRoutes from './routes/history'
import notificationRoutes from './routes/notifications'
import settingsRoutes from './routes/settings'
import agentRoutes from './routes/agent'
import statusPagesRoutes from './routes/statusPages'
import publicStatusRoutes from './routes/publicStatus'
import incidentReportsRoutes from './routes/incidentReports'
import backupRoutes from './routes/backup'
import eventsRoutes from './routes/events'
import { runCron } from './cron'
import { requireAuth } from './middleware/auth'
import { ensureSchema } from './db/migrate'

export type Env = Cloudflare.Env

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  const usesWorkerApi = c.req.path.startsWith('/api/') || c.req.path.startsWith('/h/')
  if (usesWorkerApi && c.req.path !== '/api/health') {
    const missing = (['ADMIN_USER', 'ADMIN_PASS', 'JWT_SECRET', 'ENCRYPTION_KEY'] as const)
      .filter((key) => typeof c.env[key] !== 'string' || c.env[key].length === 0)
    const tooShort = (['JWT_SECRET', 'ENCRYPTION_KEY'] as const)
      .filter((key) => typeof c.env[key] === 'string' && c.env[key].length > 0 && c.env[key].length < 32)
    const missingBindings = [
      !c.env.DB || typeof c.env.DB.prepare !== 'function' ? 'DB (D1 binding)' : null,
      !c.env.LOGIN_RATE_LIMITER || typeof c.env.LOGIN_RATE_LIMITER.limit !== 'function'
        ? 'LOGIN_RATE_LIMITER (rate-limit binding)'
        : null,
    ].filter((value): value is string => value !== null)
    if (missing.length > 0 || tooShort.length > 0 || missingBindings.length > 0) {
      const issues = [
        ...missing,
        ...tooShort.map(key => `${key} (must be at least 32 characters)`),
        ...missingBindings,
      ]
      return c.json({
        error: `Worker runtime configuration is incomplete: ${issues.join(', ')}`,
        code: 'CONFIGURATION_ERROR',
      }, 503)
    }
    try {
      await ensureSchema(c.env.DB)
    } catch (error) {
      console.error('[schema] initialization failed', error)
      return c.json({
        error: 'Database schema initialization failed',
        code: 'DATABASE_INITIALIZATION_ERROR',
      }, 503)
    }
  }
  await next()
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

app.get('*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw)
  if (res.status === 404) return c.env.ASSETS.fetch(new Request(new URL('/index.html', c.req.url).href))
  return res
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env))
  },
}
