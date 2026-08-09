/// <reference types="vitest/globals" />

import { describeInfrastructureSignal } from './infrastructure.ts'

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
