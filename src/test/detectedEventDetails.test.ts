import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('cloudflare:sockets', () => ({ connect: vi.fn() }))
import worker from '../index'
import { createTestDb, insertMonitor, makeAuthHeader, makeEnv } from './setup'

describe('detected event evidence', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>
  let auth: string
  let monitorId: string
  beforeEach(async () => {
    ctx = await createTestDb()
    auth = await makeAuthHeader()
    monitorId = await insertMonitor(ctx.db)
    ctx.raw.prepare('INSERT INTO incidents (id, monitor_id, started_at, resolved_at, duration_seconds) VALUES (?, ?, ?, ?, ?)')
      .run('event', monitorId, 1000, 1100, 100)
  })
  afterEach(() => ctx.raw.close())
  function log(id: string, at: number, status: string, message: string, monitor = monitorId) {
    ctx.raw.prepare('INSERT INTO status_logs (id, monitor_id, status, message, checked_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, monitor, status, message, at)
  }
  function request(id = 'event', authenticated = true) {
    return worker.fetch(new Request(`http://local/api/incidents/detected/${id}`, {
      headers: authenticated ? { Authorization: auth } : {},
    }), makeEnv(ctx.d1))
  }
  it('includes the failing check just before incident processing and its recovery, excluding later events', async () => {
    log('before', 997, 'down', 'Expected HTTP 200, received 503')
    log('during', 1040, 'down', 'Connection timed out')
    log('recovery', 1098, 'up', 'HTTP 200')
    log('later', 1101, 'down', 'Unrelated failure')
    const other = await insertMonitor(ctx.db)
    log('other', 1050, 'down', 'Other monitor', other)
    const response = await request()
    expect(response.status).toBe(200)
    const detail = await response.json() as { evidence: { id: string }[]; recovery: { id: string }; hasMore: boolean }
    expect(detail.evidence.map(row => row.id)).toEqual(['before', 'during', 'recovery'])
    expect(detail.recovery.id).toBe('recovery')
    expect(detail.hasMore).toBe(false)
  })
  it('does not borrow failure evidence from an earlier resolved incident or from current monitor state', async () => {
    ctx.raw.prepare('INSERT INTO incidents (id, monitor_id, started_at, resolved_at) VALUES (?, ?, ?, ?)')
      .run('previous', monitorId, 800, 950)
    log('old', 900, 'down', 'Old error')
    const detail = await (await request()).json() as { evidence: unknown[]; recovery: unknown }
    expect(detail.evidence).toEqual([])
    expect(detail.recovery).toBeNull()
  })
  it('bounds the timeline while preserving recovery beyond the first 50 checks', async () => {
    for (let n = 1; n <= 70; n++) log(`check-${n}`, 1000 + n, 'down', '503')
    log('recovered', 1100, 'up', '200')
    const detail = await (await request()).json() as { evidence: unknown[]; recovery: { id: string }; hasMore: boolean }
    expect(detail.evidence).toHaveLength(50)
    expect(detail.hasMore).toBe(true)
    expect(detail.recovery.id).toBe('recovered')
  })
  it('handles ongoing events and does not invent recovery evidence', async () => {
    ctx.raw.prepare('UPDATE incidents SET resolved_at = NULL, duration_seconds = NULL WHERE id = ?').run('event')
    log('start', 1000, 'down', 'Missed heartbeat')
    const detail = await (await request()).json() as { recovery: unknown; resolvedAt: unknown }
    expect(detail.recovery).toBeNull()
    expect(detail.resolvedAt).toBeNull()
  })
  it('requires authentication and returns 404 for an unknown event', async () => {
    expect((await request('event', false)).status).toBe(401)
    expect((await request('missing')).status).toBe(404)
  })
})
