import Database from 'better-sqlite3'
import { D1Shim } from '../db/shim'
import { ensureSchema, resetMigratedFlag } from '../db/migrate'
import { getDb } from '../db'
import { monitors, settings } from '../db/schema'
import type { Env } from '../index'
import { SignJWT } from 'jose'

export const JWT_SECRET = 'test-secret-key-exactly-32chars!!'
export const ENCRYPTION_KEY = 'test-encryption-key-32chars-xact'

export async function createTestDb() {
  resetMigratedFlag()
  const raw = new Database(':memory:')
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  const shim = new D1Shim(raw)
  const d1 = shim as unknown as D1Database
  await ensureSchema(d1)
  const db = getDb(d1)

  await db.insert(settings).values({ key: 'retention_days', value: '90' }).onConflictDoNothing()

  return { d1, db, raw }
}

export function makeEnv(d1: D1Database): Env {
  return {
    DB: d1,
    ASSETS: undefined as unknown as Fetcher,
    LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
    ADMIN_USER: 'admin',
    ADMIN_PASS: 'testpass',
    JWT_SECRET,
    ENCRYPTION_KEY,
  }
}

export async function makeAuthHeader(): Promise<string> {
  const key = new TextEncoder().encode(JWT_SECRET)
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: 'HS256' })
    .setExpirationTime('1h')
    .sign(key)
  return `Bearer ${token}`
}

/** Insert a minimal monitor and return its id. */
export async function insertMonitor(
  db: ReturnType<typeof getDb>,
  overrides: Partial<typeof monitors.$inferInsert> = {},
): Promise<string> {
  const id = crypto.randomUUID()
  await db.insert(monitors).values({
    id,
    name: 'Test Monitor',
    type: 'http',
    url: 'https://example.com',
    active: true,
    interval: 60,
    ...overrides,
  })
  return id
}
