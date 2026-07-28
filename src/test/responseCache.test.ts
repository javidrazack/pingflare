import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearAggregateMemoryCache,
  getOrComputeAggregate,
  type AggregateCacheBackend,
} from '../services/response-cache'

class FakeCache implements AggregateCacheBackend {
  readonly entries = new Map<string, Response>()

  async match(request: Request): Promise<Response | undefined> {
    return this.entries.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.entries.set(request.url, response.clone())
  }
}

function options(
  key: string,
  overrides: Partial<Parameters<typeof getOrComputeAggregate>[0]> = {},
) {
  return {
    namespace: 'uptime',
    key,
    revision: 'v1',
    ttlSeconds: 60,
    cache: null,
    ...overrides,
  }
}

describe('getOrComputeAggregate', () => {
  beforeEach(() => {
    clearAggregateMemoryCache()
    vi.useRealTimers()
  })

  it('returns a Cloudflare cache hit without calling the loader again', async () => {
    const cache = new FakeCache()
    const loader = vi.fn(async () => ({ uptime: 99.9 }))
    const cacheOptions = options('monitor-1', { cache })

    const first = await getOrComputeAggregate(cacheOptions, loader)
    const second = await getOrComputeAggregate(cacheOptions, loader)

    expect(first).toEqual({ value: { uptime: 99.9 }, status: 'MISS' })
    expect(second).toEqual({ value: { uptime: 99.9 }, status: 'HIT' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('isolates entries by namespace, key, and revision', async () => {
    const loader = vi.fn(async () => ({ call: loader.mock.calls.length }))

    const first = await getOrComputeAggregate(options('monitor-1'), loader)
    const differentKey = await getOrComputeAggregate(options('monitor-2'), loader)
    const differentRevision = await getOrComputeAggregate(
      options('monitor-1', { revision: 'v2' }),
      loader,
    )
    const differentNamespace = await getOrComputeAggregate(
      options('monitor-1', { namespace: 'daily' }),
      loader,
    )

    expect([
      first.status,
      differentKey.status,
      differentRevision.status,
      differentNamespace.status,
    ]).toEqual(['MISS', 'MISS', 'MISS', 'MISS'])
    expect(loader).toHaveBeenCalledTimes(4)
  })

  it('coalesces concurrent misses for the same cache key', async () => {
    let resolveLoader!: (value: { samples: number }) => void
    const loader = vi.fn(() => new Promise<{ samples: number }>((resolve) => {
      resolveLoader = resolve
    }))

    const first = getOrComputeAggregate(options('monitor-1'), loader)
    const second = getOrComputeAggregate(options('monitor-1'), loader)
    resolveLoader({ samples: 42 })

    await expect(first).resolves.toEqual({ value: { samples: 42 }, status: 'MISS' })
    await expect(second).resolves.toEqual({ value: { samples: 42 }, status: 'MISS' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('falls back to memory when Cache API match and put throw', async () => {
    const failingCache: AggregateCacheBackend = {
      match: vi.fn(async () => {
        throw new Error('Cache API unavailable')
      }),
      put: vi.fn(async () => {
        throw new Error('Cache API unavailable')
      }),
    }
    const loader = vi.fn(async () => ({ days: 30 }))
    const cacheOptions = options('monitor-1', { cache: failingCache })

    const first = await getOrComputeAggregate(cacheOptions, loader)
    const second = await getOrComputeAggregate(cacheOptions, loader)

    expect(first.status).toBe('MISS')
    expect(second).toEqual({ value: { days: 30 }, status: 'HIT' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('expires process-memory entries after their TTL', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const loader = vi.fn(async () => ({ call: loader.mock.calls.length }))
    const cacheOptions = options('monitor-1', { ttlSeconds: 10 })

    await expect(getOrComputeAggregate(cacheOptions, loader)).resolves.toMatchObject({ status: 'MISS' })
    vi.advanceTimersByTime(10_001)
    await expect(getOrComputeAggregate(cacheOptions, loader)).resolves.toMatchObject({ status: 'MISS' })
    expect(loader).toHaveBeenCalledTimes(2)
  })

  it('evicts the oldest process-memory entry after 256 entries', async () => {
    const loader = vi.fn(async () => ({ call: loader.mock.calls.length }))

    for (let index = 0; index < 257; index += 1) {
      await getOrComputeAggregate(options(`monitor-${index}`), loader)
    }
    const firstKeyAgain = await getOrComputeAggregate(options('monitor-0'), loader)

    expect(firstKeyAgain.status).toBe('MISS')
    expect(loader).toHaveBeenCalledTimes(258)
  })

  it('bypasses caching for invalid cache options', async () => {
    const loader = vi.fn(async () => ({ live: false }))

    const result = await getOrComputeAggregate(options('monitor-1', { ttlSeconds: 0 }), loader)

    expect(result).toEqual({ value: { live: false }, status: 'BYPASS' })
    expect(loader).toHaveBeenCalledTimes(1)
  })

  it('bypasses an oversized process-memory entry', async () => {
    const loader = vi.fn(async () => ({ payload: 'x'.repeat(1024 * 1024) }))
    const cacheOptions = options('oversized')

    const first = await getOrComputeAggregate(cacheOptions, loader)
    const second = await getOrComputeAggregate(cacheOptions, loader)

    expect(first.status).toBe('BYPASS')
    expect(second.status).toBe('BYPASS')
    expect(loader).toHaveBeenCalledTimes(2)
  })
})
