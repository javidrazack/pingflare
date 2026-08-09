import { describe, expect, it } from 'vitest'
import {
  containerNeedsAttention,
  evaluateAgentPayload,
  parseAgentPayload,
  parseAgentSnapshot,
} from '../services/agent-status'
import type { Monitor } from '../db/schema'

const monitor = {
  cpuThreshold: 80,
  ramThreshold: 90,
  diskThreshold: 95,
} as Monitor

describe('agent status evaluation', () => {
  it('accepts a healthy bounded payload', () => {
    const payload = parseAgentPayload({
      cpu: 10,
      ram: 20,
      disk: 30,
      docker: [{ id: '1', name: 'web', status: 'running', health: 'Up 2 minutes (healthy)' }],
    })
    expect(payload).not.toBeNull()
    expect(evaluateAgentPayload(monitor, payload!)).toEqual({
      status: 'up',
      message: 'Agent metrics OK',
    })
  })

  it('marks thresholds and every non-running container down', () => {
    const payload = parseAgentPayload({
      cpu: 81,
      ram: 20,
      disk: 30,
      docker: [{ id: '1', name: 'worker', status: 'restarting' }],
    })
    const result = evaluateAgentPayload(monitor, payload!)
    expect(result.status).toBe('down')
    expect(result.message).toContain('CPU usage')
    expect(result.message).toContain('worker is restarting')
  })

  it('accepts successful one-shot containers but not failed exits', () => {
    const payload = parseAgentPayload({
      cpu: 10,
      ram: 20,
      disk: 30,
      docker: [
        { id: '1', name: 'kafka-init', status: 'exited', health: 'Exited (0) 2 hours ago' },
        { id: '2', name: 'prepare-data', status: 'exited', health: 'Exited (1) 2 hours ago', oneShot: true },
      ],
    })

    expect(containerNeedsAttention(payload!.docker[0])).toBe(false)
    expect(containerNeedsAttention(payload!.docker[1])).toBe(true)
    expect(evaluateAgentPayload(monitor, {
      ...payload!,
      docker: [payload!.docker[0]],
    })).toEqual({ status: 'up', message: 'Agent metrics OK' })
    expect(evaluateAgentPayload(monitor, payload!).message).toContain('prepare-data is exited')
  })

  it('keeps ambiguous stopped containers actionable', () => {
    expect(containerNeedsAttention({ id: '1', name: 'legacy', status: 'exited' })).toBe(true)
    expect(containerNeedsAttention({
      id: '2',
      name: 'oom-killed',
      status: 'exited',
      health: 'Exited (137) 1 minute ago',
    })).toBe(true)
    expect(containerNeedsAttention({
      id: '3',
      name: 'web',
      status: 'running',
      health: 'Up 1 minute (unhealthy)',
    })).toBe(true)
    expect(containerNeedsAttention({
      id: '4',
      name: 'web',
      status: 'exited',
      health: 'Exited (0) 1 minute ago',
    })).toBe(true)
    expect(containerNeedsAttention({
      id: '5',
      name: 'prepare-data',
      status: 'exited',
      health: 'Exited (0) 1 minute ago',
      oneShot: true,
    })).toBe(false)
  })

  it('rejects out-of-range metrics and oversized container lists', () => {
    expect(parseAgentPayload({ cpu: 101, ram: 20, disk: 30, docker: [] })).toBeNull()
    expect(parseAgentPayload({
      cpu: 10,
      ram: 20,
      disk: 30,
      docker: Array.from({ length: 201 }, (_, i) => ({
        id: String(i),
        name: String(i),
        status: 'running',
      })),
    })).toBeNull()
  })

  it('rejects malformed stored snapshots', () => {
    expect(parseAgentSnapshot('{"cpu":10}')).toBeNull()
    expect(parseAgentSnapshot('not-json')).toBeNull()
  })
})
