import type { Monitor } from '../db/schema'

export interface AgentContainer {
  id: string
  name: string
  status: string
  health?: string
}

export interface AgentPayload {
  cpu: number
  ram: number
  disk: number
  docker: AgentContainer[]
}

export interface AgentSnapshot extends AgentPayload {
  status: 'up' | 'down'
  message: string
  evaluatedAt: number
}

const isPercent = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100

export function parseAgentPayload(value: unknown): AgentPayload | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  if (!isPercent(input.cpu) || !isPercent(input.ram) || !isPercent(input.disk)) return null
  if (!Array.isArray(input.docker) || input.docker.length > 200) return null

  const docker: AgentContainer[] = []
  for (const raw of input.docker) {
    if (!raw || typeof raw !== 'object') return null
    const container = raw as Record<string, unknown>
    if (
      typeof container.id !== 'string' ||
      typeof container.name !== 'string' ||
      typeof container.status !== 'string' ||
      container.id.length > 128 ||
      container.name.length > 256 ||
      container.status.length > 128 ||
      (container.health !== undefined &&
        (typeof container.health !== 'string' || container.health.length > 256))
    ) {
      return null
    }
    docker.push({
      id: container.id,
      name: container.name,
      status: container.status.toLowerCase(),
      health: typeof container.health === 'string' ? container.health.toLowerCase() : undefined,
    })
  }

  return { cpu: input.cpu, ram: input.ram, disk: input.disk, docker }
}

export function evaluateAgentPayload(
  monitor: Monitor,
  payload: AgentPayload,
): Pick<AgentSnapshot, 'status' | 'message'> {
  const reasons: string[] = []

  if (monitor.cpuThreshold !== null && payload.cpu > monitor.cpuThreshold) {
    reasons.push(`CPU usage ${payload.cpu}% exceeds threshold ${monitor.cpuThreshold}%`)
  }
  if (monitor.ramThreshold !== null && payload.ram > monitor.ramThreshold) {
    reasons.push(`RAM usage ${payload.ram}% exceeds threshold ${monitor.ramThreshold}%`)
  }
  if (monitor.diskThreshold !== null && payload.disk > monitor.diskThreshold) {
    reasons.push(`Disk usage ${payload.disk}% exceeds threshold ${monitor.diskThreshold}%`)
  }

  for (const container of payload.docker) {
    const unhealthy = container.health?.includes('unhealthy') ?? false
    if (container.status !== 'running' || unhealthy) {
      reasons.push(
        `Docker container ${container.name} is ${container.status}` +
        (container.health ? ` (${container.health})` : ''),
      )
    }
  }

  return reasons.length > 0
    ? { status: 'down', message: reasons.join(', ') }
    : { status: 'up', message: 'Agent metrics OK' }
}

export function parseAgentSnapshot(value: string | null): AgentSnapshot | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>
    const payload = parseAgentPayload(parsed)
    if (
      !payload ||
      (parsed.status !== 'up' && parsed.status !== 'down') ||
      typeof parsed.message !== 'string' ||
      typeof parsed.evaluatedAt !== 'number'
    ) {
      return null
    }
    return {
      ...payload,
      status: parsed.status,
      message: parsed.message,
      evaluatedAt: parsed.evaluatedAt,
    }
  } catch {
    return null
  }
}
