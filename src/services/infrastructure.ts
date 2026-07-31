import type { Monitor } from '../db/schema'
import { parseAgentSnapshot } from './agent-status'

export type InfrastructureNodeState =
  | 'healthy'
  | 'warning'
  | 'critical'
  | 'stale'
  | 'pending'
  | 'paused'

export interface InfrastructureNode {
  id: string
  name: string
  state: InfrastructureNodeState
  active: boolean
  lastCheckedAt: number | null
  metrics: { cpu: number; ram: number; disk: number } | null
  thresholds: { cpu: number | null; ram: number | null; disk: number | null }
  pressure: 'normal' | 'warning' | 'critical'
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
  if (!monitor.active) {
    state = 'paused'
  } else if (monitor.lastCheckedAt === null) {
    state = 'pending'
  } else {
    const expectedInterval = monitor.heartbeatInterval ?? monitor.interval
    const staleAfter = Math.max(180, expectedInterval * 2 + monitor.heartbeatGrace)
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

  return {
    id: monitor.id,
    name: monitor.name,
    state,
    active: monitor.active,
    lastCheckedAt: monitor.lastCheckedAt,
    metrics,
    thresholds,
    pressure,
  }
}
