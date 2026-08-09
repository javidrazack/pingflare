import type { Monitor } from '../db/schema'
import { parseAgentSnapshot } from './agent-status'

export type InfrastructureNodeState =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'stale'
  | 'pending'
  | 'paused'

export type InfrastructureSignal =
  | {
      kind: 'resource'
      severity: 'warning' | 'critical'
      resource: 'cpu' | 'ram' | 'disk'
      value: number
      threshold: number
    }
  | {
      kind: 'stale'
      severity: 'critical'
      ageSeconds: number
      staleAfterSeconds: number
    }
  | {
      kind: 'docker'
      severity: 'critical'
      containerName: string
      containerStatus: string
      containerHealth: string | null
      affectedContainers: number
    }
  | { kind: 'check'; severity: 'warning' | 'critical' }
  | { kind: 'pending'; severity: 'info' }
  | { kind: 'paused'; severity: 'info' }
  | { kind: 'healthy'; severity: 'normal' }

export interface InfrastructureNode {
  id: string
  name: string
  state: InfrastructureNodeState
  active: boolean
  lastCheckedAt: number | null
  metrics: { cpu: number; ram: number; disk: number } | null
  thresholds: { cpu: number | null; ram: number | null; disk: number | null }
  pressure: 'normal' | 'warning' | 'critical'
  strongestSignal: InfrastructureSignal
}

function thresholdState(
  value: number,
  threshold: number | null,
): 'healthy' | 'warning' | 'critical' {
  if (threshold === null) return 'healthy'
  if (value > threshold) return 'critical'
  if (value >= threshold * 0.8) return 'warning'
  return 'healthy'
}

function strongestResourceSignal(
  metrics: NonNullable<InfrastructureNode['metrics']>,
  thresholds: InfrastructureNode['thresholds'],
  severity: 'warning' | 'critical',
): Extract<InfrastructureSignal, { kind: 'resource' }> | null {
  const candidates = (['cpu', 'ram', 'disk'] as const)
    .flatMap((resource) => {
      const threshold = thresholds[resource]
      if (threshold === null) return []
      const value = metrics[resource]
      const state = thresholdState(value, threshold)
      return state === severity
        ? [{ kind: 'resource' as const, severity, resource, value, threshold }]
        : []
    })
    .sort((a, b) =>
      (b.value / b.threshold) - (a.value / a.threshold)
      || a.resource.localeCompare(b.resource),
    )

  return candidates[0] ?? null
}

function strongestDockerSignal(
  snapshot: ReturnType<typeof parseAgentSnapshot>,
): Extract<InfrastructureSignal, { kind: 'docker' }> | null {
  if (!snapshot) return null
  const affected = snapshot.docker
    .filter((container) =>
      container.status !== 'running' || container.health?.includes('unhealthy'),
    )
    .sort((a, b) => {
      const aStopped = a.status === 'running' ? 1 : 0
      const bStopped = b.status === 'running' ? 1 : 0
      return aStopped - bStopped || a.name.localeCompare(b.name)
    })
  const primary = affected[0]
  if (!primary) return null

  return {
    kind: 'docker',
    severity: 'critical',
    containerName: primary.name,
    containerStatus: primary.status,
    containerHealth: primary.health ?? null,
    affectedContainers: affected.length,
  }
}

export function classifyInfrastructureNode(
  monitor: Monitor,
  now: number,
): InfrastructureNode {
  const snapshot = parseAgentSnapshot(monitor.lastMetrics)
  const metrics = snapshot
    ? { cpu: snapshot.cpu, ram: snapshot.ram, disk: snapshot.disk }
    : null
  const thresholds = {
    cpu: monitor.cpuThreshold,
    ram: monitor.ramThreshold,
    disk: monitor.diskThreshold,
  }
  const pressureStates = metrics
    ? [
        thresholdState(metrics.cpu, thresholds.cpu),
        thresholdState(metrics.ram, thresholds.ram),
        thresholdState(metrics.disk, thresholds.disk),
      ]
    : []
  const pressure = pressureStates.includes('critical')
    ? 'critical'
    : pressureStates.includes('warning')
      ? 'warning'
      : 'normal'

  let state: InfrastructureNodeState
  let staleAfter: number | null = null
  if (!monitor.active) {
    state = 'paused'
  } else if (monitor.lastCheckedAt === null) {
    state = 'pending'
  } else {
    const expectedInterval = monitor.heartbeatInterval ?? monitor.interval
    staleAfter = Math.max(180, expectedInterval * 2 + monitor.heartbeatGrace)
    if (now - monitor.lastCheckedAt > staleAfter) {
      state = 'stale'
    } else if (monitor.lastStatus === 'down') {
      state = 'critical'
    } else if (!metrics) {
      state = 'pending'
    } else {
      state = pressure === 'normal' ? 'healthy' : pressure
    }
  }

  let strongestSignal: InfrastructureSignal
  if (state === 'paused') {
    strongestSignal = { kind: 'paused', severity: 'info' }
  } else if (state === 'pending') {
    strongestSignal = { kind: 'pending', severity: 'info' }
  } else if (state === 'stale') {
    strongestSignal = {
      kind: 'stale',
      severity: 'critical',
      ageSeconds: Math.max(0, now - (monitor.lastCheckedAt ?? now)),
      staleAfterSeconds: staleAfter ?? 180,
    }
  } else if (state === 'critical') {
    strongestSignal = strongestDockerSignal(snapshot)
      ?? (metrics ? strongestResourceSignal(metrics, thresholds, 'critical') : null)
      ?? { kind: 'check', severity: 'critical' }
  } else if (state === 'warning') {
    strongestSignal = (metrics ? strongestResourceSignal(metrics, thresholds, 'warning') : null)
      ?? { kind: 'check', severity: 'warning' }
  } else {
    strongestSignal = { kind: 'healthy', severity: 'normal' }
  }

  return {
    id: monitor.id,
    name: monitor.name,
    state,
    active: monitor.active,
    lastCheckedAt: monitor.lastCheckedAt,
    metrics,
    thresholds,
    pressure,
    strongestSignal,
  }
}
