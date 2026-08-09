/// <reference types="vitest/globals" />

import { describeInfrastructureSignal, dockerContainerNeedsAttention } from './infrastructure'

describe('infrastructure signal descriptions', () => {
  it('describes resource pressure with the observed value and configured threshold', () => {
    expect(describeInfrastructureSignal({
      kind: 'resource',
      severity: 'critical',
      resource: 'cpu',
      value: 94,
      threshold: 90,
    })).toBe('CPU 94% over its 90% threshold')

    expect(describeInfrastructureSignal({
      kind: 'resource',
      severity: 'warning',
      resource: 'ram',
      value: 82.5,
      threshold: 90,
    })).toBe('RAM 82.5% nearing its 90% threshold')
  })

  it('describes stale telemetry with its current age and cutoff', () => {
    expect(describeInfrastructureSignal({
      kind: 'stale',
      severity: 'critical',
      ageSeconds: 605,
      staleAfterSeconds: 180,
    })).toBe('Telemetry 10m 5s old; stale after 3m')
  })

  it('describes the primary Docker failure and remaining affected count', () => {
    expect(describeInfrastructureSignal({
      kind: 'docker',
      severity: 'critical',
      containerName: 'jobs',
      containerStatus: 'exited',
      containerHealth: null,
      affectedContainers: 2,
    })).toBe('Docker container jobs is not running (exited); 1 more needs attention')

    expect(describeInfrastructureSignal({
      kind: 'docker',
      severity: 'critical',
      containerName: 'web',
      containerStatus: 'running',
      containerHealth: 'unhealthy',
      affectedContainers: 1,
    })).toBe('Docker container web is unhealthy')
  })
})

describe('dockerContainerNeedsAttention', () => {
  it('treats a successful one-shot exit as completed', () => {
    expect(dockerContainerNeedsAttention({
      name: 'kafka-init',
      status: 'exited',
      health: 'exited (0) 3 hours ago',
    })).toBe(false)
  })

  it('keeps failed and ambiguous exits actionable', () => {
    expect(dockerContainerNeedsAttention({
      name: 'worker',
      status: 'exited',
      health: 'exited (1) 3 hours ago',
    })).toBe(true)
    expect(dockerContainerNeedsAttention({ name: 'worker', status: 'exited' })).toBe(true)
    expect(dockerContainerNeedsAttention({
      name: 'worker',
      status: 'exited',
      health: 'exited (0) 3 hours ago',
    })).toBe(true)
    expect(dockerContainerNeedsAttention({
      name: 'prepare-data',
      status: 'exited',
      health: 'exited (0) 3 hours ago',
      oneShot: true,
    })).toBe(false)
  })
})
