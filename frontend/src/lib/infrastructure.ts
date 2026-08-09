import type { InfrastructureSignal } from './infrastructure-types'

function formatMetric(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)
}

function formatCompactDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  if (seconds < 60) return `${seconds}s`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    const remainder = seconds % 60
    return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`
  }

  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const remainder = minutes % 60
    return remainder === 0 ? `${hours}h` : `${hours}h ${remainder}m`
  }

  const days = Math.floor(hours / 24)
  const remainder = hours % 24
  return remainder === 0 ? `${days}d` : `${days}d ${remainder}h`
}

export function describeInfrastructureSignal(
  signal: InfrastructureSignal,
  locale = 'en',
): string {
  if (signal.kind === 'resource') {
    const resource = signal.resource.toUpperCase()
    const value = formatMetric(signal.value, locale)
    const threshold = formatMetric(signal.threshold, locale)
    const relation = signal.severity === 'critical' ? 'over' : 'nearing'
    return `${resource} ${value}% ${relation} its ${threshold}% threshold`
  }
  if (signal.kind === 'stale') {
    return `Telemetry ${formatCompactDuration(signal.ageSeconds)} old; stale after ${formatCompactDuration(signal.staleAfterSeconds)}`
  }
  if (signal.kind === 'docker') {
    const problem = signal.containerStatus !== 'running'
      ? `is not running (${signal.containerStatus})`
      : 'is unhealthy'
    const remainder = signal.affectedContainers - 1
    const additional = remainder > 0
      ? `; ${remainder} more ${remainder === 1 ? 'needs' : 'need'} attention`
      : ''
    return `Docker container ${signal.containerName} ${problem}${additional}`
  }
  if (signal.kind === 'check') return 'Agent health check failed'
  if (signal.kind === 'pending') return 'Waiting for the first complete agent report'
  if (signal.kind === 'paused') return 'Agent monitoring is paused'
  return 'Latest agent report is within configured thresholds'
}
