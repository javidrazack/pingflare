import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError } from './api'

beforeEach(() => { vi.stubGlobal('localStorage', { getItem: () => null, removeItem: vi.fn() }) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('API request recovery', () => {
  it('cancels a hung read when its deadline aborts', async () => {
    const controller = new AbortController()
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })))
    const request = api.operations.overview()
    controller.abort(new DOMException('Timed out', 'TimeoutError'))
    await expect(request).rejects.toThrow('Timed out')
    expect(deadline).toHaveBeenCalledWith(30_000)
  })

  it('does not clear a session when its validation database is unavailable', async () => {
    const removeItem = vi.fn()
    vi.stubGlobal('localStorage', { getItem: () => 'test-session', removeItem })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'Session validation unavailable', code: 'SESSION_UNAVAILABLE',
    }), { status: 503, headers: { 'Content-Type': 'application/json' } })))
    await expect(api.operations.overview()).rejects.toMatchObject({ status: 503, code: 'SESSION_UNAVAILABLE' })
    expect(removeItem).not.toHaveBeenCalled()
  })

  it('does not retry a failed maintenance write automatically', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response('{"error":"busy"}', { status: 503 }))
    vi.stubGlobal('fetch', fetcher)
    await expect(api.monitors.scheduleMaintenance('monitor', {
      startAt: 100, endAt: 200, reason: '', occurrences: [{ startAt: 100, endAt: 200 }],
    })).rejects.toBeInstanceOf(ApiError)
    expect(fetcher).toHaveBeenCalledOnce()
  })
})
