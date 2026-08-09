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
