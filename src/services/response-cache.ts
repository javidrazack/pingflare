export type AggregateCacheStatus = 'HIT' | 'MISS' | 'BYPASS'

export interface AggregateCacheResult<T> {
  value: T
  status: AggregateCacheStatus
}

export interface AggregateCacheBackend {
  match(request: Request): Promise<Response | undefined>
  put(request: Request, response: Response): Promise<void>
}

export interface AggregateCacheOptions {
  namespace: string
  key: string
  revision: string | number
  ttlSeconds: number
  baseUrl?: string
  /**
   * Omit to auto-detect Cloudflare's `caches.default`. Pass null to force the
   * bounded process-memory fallback (useful for Node.js and tests).
   */
  cache?: AggregateCacheBackend | null
}

interface MemoryEntry {
  json: string
  expiresAt: number
  bytes: number
}

const DEFAULT_BASE_URL = 'https://cache.pingflare.internal'
const MAX_MEMORY_ENTRIES = 256
const MAX_MEMORY_ENTRY_BYTES = 1024 * 1024
const MAX_MEMORY_TOTAL_BYTES = 8 * 1024 * 1024
const CACHE_PATH_PREFIX = '/__pingflare-cache/v1/'
const EXPIRY_HEADER = 'x-pingflare-cache-expires-at'

// Module state is limited to serialized data; request-bound I/O promises must
// never be shared across Worker invocations.
const memoryCache = new Map<string, MemoryEntry>()
const textEncoder = new TextEncoder()
let memoryCacheBytes = 0

function detectCloudflareCache(): AggregateCacheBackend | undefined {
  const cacheStorage = (globalThis as typeof globalThis & {
    caches?: { default?: AggregateCacheBackend }
  }).caches
  const cache = cacheStorage?.default
  if (
    cache
    && typeof cache.match === 'function'
    && typeof cache.put === 'function'
  ) {
    return cache
  }
  return undefined
}

function buildCacheUrl(options: AggregateCacheOptions): string | undefined {
  const namespace = options.namespace.trim()
  const key = options.key.trim()
  const revision = String(options.revision).trim()
  if (!namespace || !key || !revision || !Number.isFinite(options.ttlSeconds) || options.ttlSeconds <= 0) {
    return undefined
  }

  try {
    const base = new URL(options.baseUrl ?? DEFAULT_BASE_URL)
    base.pathname = [
      CACHE_PATH_PREFIX,
      encodeURIComponent(namespace),
      '/',
      encodeURIComponent(revision),
      '/',
      encodeURIComponent(key),
    ].join('')
    base.search = ''
    base.hash = ''
    return base.toString()
  } catch {
    return undefined
  }
}

function getMemoryEntry(cacheUrl: string, now: number): string | undefined {
  const entry = memoryCache.get(cacheUrl)
  if (!entry) return undefined
  if (entry.expiresAt <= now) {
    memoryCacheBytes -= entry.bytes
    memoryCache.delete(cacheUrl)
    return undefined
  }
  return entry.json
}

function deleteMemoryEntry(cacheUrl: string): void {
  const entry = memoryCache.get(cacheUrl)
  if (!entry) return
  memoryCacheBytes -= entry.bytes
  memoryCache.delete(cacheUrl)
}

function setMemoryEntry(cacheUrl: string, json: string, expiresAt: number, now: number): boolean {
  const bytes = textEncoder.encode(json).byteLength
  if (bytes > MAX_MEMORY_ENTRY_BYTES) return false

  for (const [key, entry] of memoryCache) {
    if (entry.expiresAt <= now) deleteMemoryEntry(key)
  }

  deleteMemoryEntry(cacheUrl)
  while (
    memoryCache.size >= MAX_MEMORY_ENTRIES
    || memoryCacheBytes + bytes > MAX_MEMORY_TOTAL_BYTES
  ) {
    const oldestKey = memoryCache.keys().next().value as string | undefined
    if (oldestKey === undefined) break
    deleteMemoryEntry(oldestKey)
  }
  memoryCache.set(cacheUrl, { json, expiresAt, bytes })
  memoryCacheBytes += bytes
  return true
}

function parseJson<T>(json: string): T | undefined {
  try {
    return JSON.parse(json) as T
  } catch {
    return undefined
  }
}

async function readCloudflareEntry<T>(
  cache: AggregateCacheBackend,
  request: Request,
  now: number,
): Promise<T | undefined> {
  const response = await cache.match(request)
  if (!response) return undefined

  const expiryHeader = response.headers.get(EXPIRY_HEADER)
  const expiresAt = expiryHeader === null ? undefined : Number(expiryHeader)
  if (expiresAt !== undefined && Number.isFinite(expiresAt) && expiresAt <= now) return undefined
  return parseJson<T>(await response.text())
}

/**
 * Cache an immutable JSON aggregate fragment.
 *
 * Callers are responsible for ensuring the value contains no live status,
 * active incidents, credentials, or user-specific data.
 */
export async function getOrComputeAggregate<T>(
  options: AggregateCacheOptions,
  loader: () => Promise<T>,
): Promise<AggregateCacheResult<T>> {
  const cacheUrl = buildCacheUrl(options)
  if (!cacheUrl) {
    return { value: await loader(), status: 'BYPASS' }
  }

  const now = Date.now()
  const ttlMilliseconds = Math.max(1, Math.floor(options.ttlSeconds * 1000))
  const expiresAt = now + ttlMilliseconds
  const request = new Request(cacheUrl, { method: 'GET' })
  const cloudflareCache = options.cache === undefined
    ? detectCloudflareCache()
    : options.cache ?? undefined

  if (cloudflareCache) {
    try {
      const cached = await readCloudflareEntry<T>(cloudflareCache, request, now)
      if (cached !== undefined) return { value: cached, status: 'HIT' }
    } catch {
      // A Cache API failure must not make aggregate reads fail.
    }
  }

  const memoryJson = getMemoryEntry(cacheUrl, now)
  if (memoryJson !== undefined) {
    const cached = parseJson<T>(memoryJson)
    if (cached !== undefined) return { value: cached, status: 'HIT' }
    deleteMemoryEntry(cacheUrl)
  }

  const value = await loader()
  let json: string
  try {
    json = JSON.stringify(value)
  } catch {
    return { value, status: 'BYPASS' }
  }

  // JSON.stringify(undefined) returns undefined despite its TypeScript type.
  if (typeof json !== 'string') return { value, status: 'BYPASS' }

  if (cloudflareCache) {
    try {
      await cloudflareCache.put(request, new Response(json, {
        headers: {
          'cache-control': `public, max-age=${Math.max(1, Math.ceil(options.ttlSeconds))}`,
          'content-type': 'application/json; charset=utf-8',
          [EXPIRY_HEADER]: String(expiresAt),
        },
      }))
      return { value, status: 'MISS' }
    } catch {
      // Fall through to the bounded Node/process-local cache.
    }
  }

  return setMemoryEntry(cacheUrl, json, expiresAt, now)
    ? { value, status: 'MISS' }
    : { value, status: 'BYPASS' }
}

/** Clear process-local entries, primarily for local invalidation and tests. */
export function clearAggregateMemoryCache(): void {
  memoryCache.clear()
  memoryCacheBytes = 0
}
