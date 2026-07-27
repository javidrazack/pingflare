import { beforeEach, describe, expect, it, vi } from 'vitest'
import { checkHttp } from '../services/checker'
import type { Monitor } from '../db/schema'

const base: Monitor = {
  id: 'test-http',
  name: 'Test HTTP',
  type: 'http',
  tags: '[]',
  interval: 60,
  active: true,
  lastCheckedAt: null,
  lastStatus: 'pending',
  reminderIntervalHours: null,
  toleranceFailures: 1,
  url: 'https://example.com',
  method: 'GET',
  body: null,
  headers: '{}',
  expectedStatus: 200,
  followRedirects: true,
  timeout: 30,
  ipVersion: 'auto',
  authType: 'none',
  authUsername: null,
  authPassword: null,
  authToken: null,
  heartbeatInterval: null,
  heartbeatGrace: 30,
  toleranceMissed: 1,
  surgeProtectionLimit: null,
  sslCheckEnabled: false,
  sslStatus: 'unknown',
  cacheBooster: false,
  jsonPath: '$.data.status',
  expectedValue: 'ok',
  cpuThreshold: null,
  ramThreshold: null,
  diskThreshold: null,
  lastMetrics: null,
  dnsHostname: null,
  dnsRecordType: null,
  dnsResolverUrl: null,
  dnsExpectedIp: null,
  createdAt: 0,
  updatedAt: 0,
}

describe('checkHttp JSONPath validation', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('matches a nested JSON value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'ok' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const result = await checkHttp(base)

    expect(result.status).toBe('up')
    expect(result.message).toBe('HTTP 200')
  })

  it('reports a mismatched JSON value', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'degraded' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const result = await checkHttp(base)

    expect(result.status).toBe('down')
    expect(result.message).toContain("JSON value 'degraded' != expected 'ok'")
  })

  it('rejects JSONPath script expressions', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ status: 'ok' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ))

    const result = await checkHttp({
      ...base,
      jsonPath: '$.items[?(@.status === "ok")]',
      expectedValue: null,
    })

    expect(result.status).toBe('down')
    expect(result.message).toContain('Failed to parse JSON for query')
  })
})
