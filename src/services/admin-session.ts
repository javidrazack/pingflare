import { SignJWT, jwtVerify } from 'jose'
import type { Env } from '../index'

const MAX_SESSION_SECONDS = 24 * 60 * 60
export class InvalidSessionError extends Error {}
// Password or username changes invalidate sessions without extra database writes.
async function signingKey(env: Pick<Env, 'ADMIN_USER' | 'ADMIN_PASS' | 'JWT_SECRET'>) {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(
    JSON.stringify([env.JWT_SECRET, env.ADMIN_USER, env.ADMIN_PASS]),
  )))
}

export async function issueAdminToken(env: Pick<Env, 'ADMIN_USER' | 'ADMIN_PASS' | 'JWT_SECRET'>) {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(env.ADMIN_USER)
    .setAudience('pingflare-admin')
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + MAX_SESSION_SECONDS)
    .sign(await signingKey(env))
}

export async function verifyAdminToken(token: string, env: Env) {
  const { payload } = await jwtVerify(token, await signingKey(env), {
    algorithms: ['HS256'], audience: 'pingflare-admin', subject: env.ADMIN_USER,
    maxTokenAge: MAX_SESSION_SECONDS,
    requiredClaims: ['iat', 'exp', 'jti'],
  }).catch(() => { throw new InvalidSessionError('Invalid session') })
  if (typeof payload.jti !== 'string' || !payload.jti || !payload.exp || !payload.iat
    || payload.exp - payload.iat > MAX_SESSION_SECONDS) throw new InvalidSessionError('Invalid session')
  const revoked = await env.DB.prepare('SELECT id FROM revoked_sessions WHERE id = ?')
    .bind(payload.jti).first()
  if (revoked) throw new InvalidSessionError('Session revoked')
  return payload
}

export async function revokeAdminToken(token: string, env: Env) {
  const session = await verifyAdminToken(token, env)
  await env.DB.batch([
    env.DB.prepare('INSERT OR IGNORE INTO revoked_sessions (id, expires_at) VALUES (?, ?)')
      .bind(session.jti!, session.exp!),
    env.DB.prepare(`DELETE FROM revoked_sessions WHERE id IN (
      SELECT id FROM revoked_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
    )`).bind(Math.floor(Date.now() / 1000)),
  ])
}
