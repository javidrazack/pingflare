import { Hono } from 'hono'
import { SignJWT, jwtVerify } from 'jose'
import type { Env } from '../index'
import { timingSafeEqualText } from '../utils'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'

const auth = new Hono<{ Bindings: Env }>()

async function issueToken(sub: string, secret: string): Promise<string> {
  const key = new TextEncoder().encode(secret)
  return new SignJWT({ sub })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('30d')
    .sign(key)
}

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

  if (typeof body.username !== 'string' || typeof body.password !== 'string') {
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

  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET)
  return c.json({ token })
})

auth.post('/refresh', async (c) => {
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const oldToken = authorization.slice(7)
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET)
    await jwtVerify(oldToken, key)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }

  const token = await issueToken(c.env.ADMIN_USER, c.env.JWT_SECRET)
  return c.json({ token })
})

export default auth
