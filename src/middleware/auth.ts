import { createMiddleware } from 'hono/factory'
import { verifyAdminToken, InvalidSessionError } from '../services/admin-session'
import type { Env } from '../index'

export const requireAuth = createMiddleware<{ Bindings: Env; Variables: { adminAuthenticated: boolean } }>(async (c, next) => {
  if (c.get('adminAuthenticated')) { await next(); return }
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authorization.slice(7)
  try {
    await verifyAdminToken(token, c.env)
  } catch (error) {
    return error instanceof InvalidSessionError
      ? c.json({ error: 'Invalid token' }, 401)
      : c.json({ error: 'Session validation unavailable. Try again.', code: 'SESSION_UNAVAILABLE' }, 503)
  }
  c.set('adminAuthenticated', true)
  await next()
})
