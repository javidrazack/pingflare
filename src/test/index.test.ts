import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('cloudflare:sockets', () => ({
  connect: vi.fn(),
}))

import worker from '../index'
import { createTestDb, makeEnv } from './setup'

describe('Worker API cache policy', () => {
  let ctx: Awaited<ReturnType<typeof createTestDb>>

  beforeEach(async () => {
    ctx = await createTestDb()
  })

  it('marks early authentication failures as no-store', async () => {
    const writeDataPoint = vi.fn()
    const env = {
      ...makeEnv(ctx.d1),
      API_ANALYTICS: { writeDataPoint } as unknown as AnalyticsEngineDataset,
    }
    const response = await worker.fetch(
      new Request('http://localhost/api/monitors'),
      env,
    )

    expect(response.status).toBe(401)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(writeDataPoint).toHaveBeenCalledOnce()
  })

  it('marks early configuration failures as no-store', async () => {
    const env = { ...makeEnv(ctx.d1), JWT_SECRET: '' }
    const response = await worker.fetch(
      new Request('http://localhost/api/monitors'),
      env,
    )

    expect(response.status).toBe(503)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })
})
