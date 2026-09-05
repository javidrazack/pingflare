import { Hono } from 'hono'
import { issueAdminToken, verifyAdminToken, revokeAdminToken, InvalidSessionError } from '../services/admin-session'
import type { Env } from '../index'
import { timingSafeEqualText } from '../utils'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'

const auth = new Hono<{ Bindings: Env }>()

auth.post('/login', async (c) => {
  let body: { username?: unknown; password?: unknown }
  try {
    body = await readJsonBodyWithLimit(c.req.raw, 8 * 1024) as typeof body
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: 'Request is too large', code: 'INVALID_REQUEST' }, 413)
    }
    return c.json({ error: 'Invalid request', code: 'INVALID_REQUEST' }, 400)
  }

  if (!body || typeof body.username !== 'string' || typeof body.password !== 'string') {
    return c.json({ error: 'Username and password are required', code: 'INVALID_REQUEST' }, 400)
  }

  const { success } = await c.env.LOGIN_RATE_LIMITER.limit({
    key: body.username.trim().toLowerCase() || 'empty-username',
  })
  if (!success) {
    return c.json({ error: 'Too many login attempts. Try again in one minute.', code: 'RATE_LIMITED' }, 429)
  }

  const [usernameMatches, passwordMatches] = await Promise.all([
    timingSafeEqualText(body.username, c.env.ADMIN_USER),
    timingSafeEqualText(body.password, c.env.ADMIN_PASS),
  ])
  if (!usernameMatches || !passwordMatches) {
    return c.json({ error: 'Invalid credentials', code: 'INVALID_CREDENTIALS' }, 401)
  }

  const token = await issueAdminToken(c.env)
  return c.json({ token })
})

// Refresh validates the existing session; it never extends its absolute lifetime.
auth.post('/refresh', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    await verifyAdminToken(token, c.env)
    return c.json({ token })
  } catch (error) { return c.json({ error: 'Session validation unavailable' }, error instanceof InvalidSessionError ? 401 : 503) }
})

auth.post('/logout', async (c) => {
  const token = c.req.header('Authorization')?.replace(/^Bearer /, '')
  if (!token) return c.json({ error: 'Unauthorized' }, 401)
  try {
    await revokeAdminToken(token, c.env)
    return c.json({ ok: true })
  } catch (error) { return c.json({ error: 'Unable to revoke session' }, error instanceof InvalidSessionError ? 401 : 503) }
})

export default auth
