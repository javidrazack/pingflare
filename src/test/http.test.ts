import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
  nextCheckAt: 0,
  observationRevision: '',
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
  historyRevision: 1,
  statsDay: null,
  dayChecks: 0,
  dayUpCount: 0,
  dayDownCount: 0,
  dayResponseCount: 0,
  dayResponseSumMs: 0,
  dayResponseMinMs: null,
  dayResponseMaxMs: null,
  createdAt: 0,
  updatedAt: 0,
}

describe('checkHttp JSONPath validation', () => {
  beforeEach(() => vi.restoreAllMocks())
  afterEach(() => vi.useRealTimers())

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

  it('keeps the hard deadline active while reading a JSON response body', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('Aborted')
            error.name = 'AbortError'
            controller.error(error)
          }, { once: true })
        },
      })
      return Promise.resolve(new Response(stream, { status: 200 }))
    }))

    const pending = checkHttp({ ...base, timeout: 1 })
    await vi.advanceTimersByTimeAsync(1000)
    const result = await pending

    expect(result.status).toBe('down')
    expect(result.message).toContain('1s')
  })

  it('shares one hard deadline across both digest-auth requests', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1
      if (calls === 1) {
        return new Promise<Response>((resolve) => {
          setTimeout(() => resolve(new Response('', {
            status: 401,
            headers: {
              'WWW-Authenticate': 'Digest realm="test", nonce="nonce", qop="auth"',
            },
          })), 700)
        })
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('Aborted')
          error.name = 'AbortError'
          reject(error)
        }, { once: true })
      })
    }))

    const pending = checkHttp({
      ...base,
      timeout: 1,
      authType: 'digest',
      authUsername: 'user',
      authPassword: 'password',
      jsonPath: null,
    })
    await vi.advanceTimersByTimeAsync(700)
    expect(fetch).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(300)
    const result = await pending

    expect(result.status).toBe('down')
    expect(result.message).toContain('1s')
  })
})
