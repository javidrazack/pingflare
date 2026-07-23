import { createMiddleware } from 'hono/factory'
import { jwtVerify } from 'jose'
import type { Env } from '../index'

export const requireAuth = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const authorization = c.req.header('Authorization')
  if (!authorization?.startsWith('Bearer ')) {
    return c.json({ error: 'Unauthorized' }, 401)
  }

  const token = authorization.slice(7)
  try {
    const key = new TextEncoder().encode(c.env.JWT_SECRET)
    await jwtVerify(token, key)
  } catch {
    return c.json({ error: 'Invalid token' }, 401)
  }
  await next()
})
