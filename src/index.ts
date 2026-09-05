import operationsRoutes from './routes/operations'
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
import infrastructureRoutes from './routes/infrastructure'
import { runCron } from './cron'
import { requireAuth } from './middleware/auth'
import { recordApiRequest } from './services/analytics-engine'

export type Env = Cloudflare.Env

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (c, next) => {
  const startedAt = performance.now()
  const usesWorkerApi = c.req.path.startsWith('/api/') || c.req.path.startsWith('/h/')
  // Set this before downstream middleware so early auth/configuration responses
  // inherit the same non-cacheable policy as successful API responses.
  if (usesWorkerApi) c.header('Cache-Control', 'no-store')
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
      !c.env.PUBLIC_STATUS_RATE_LIMITER
        || typeof c.env.PUBLIC_STATUS_RATE_LIMITER.limit !== 'function'
        ? 'PUBLIC_STATUS_RATE_LIMITER (rate-limit binding)'
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
  }
  await next()
  if (usesWorkerApi) {
    recordApiRequest(c.env, {
      instance: c.env.PINGFLARE_INSTANCE_ID,
      operation: c.req.routePath || 'unmatched',
      method: c.req.method,
      statusCode: c.res.status,
      durationMs: performance.now() - startedAt,
      resultCode: c.res.status >= 500 ? 'server_error' : c.res.status >= 400 ? 'client_error' : 'ok',
    })
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
app.route('/api/infrastructure', infrastructureRoutes)
app.route('/api/operations', operationsRoutes)

app.get('/api/health', (c) => c.json({ ok: true, ts: Date.now() }))

app.post('/api/cron/run', requireAuth, async (c) => {
  const result = await runCron(c.env, 1)
  return c.json({ ok: true, triggeredAt: Date.now(), ...result })
})

export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runCron(env))
  },
} satisfies ExportedHandler<Env>
