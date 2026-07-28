export const MAX_SAFE_DESTRUCTIVE_D1_WRITES = 40_000

export type DestructiveMonitorOperation = 'delete' | 'reset' | 'restore'

export interface DestructiveRowCounts {
  monitorCount: number
  statusLogCount: number
  rollupCount: number
  incidentCount: number
  incidentEventCount: number
  notificationDeliveryCount: number
  monitorNotificationCount: number
  heartbeatCount: number
  alertStateCount: number
  statusPageMonitorCount: number
  incidentMonitorCount: number
  maintenanceCount: number
  channelCount: number
  notificationTestCount: number
  statusPageCount: number
  settingsCount: number
}

export class DestructiveD1WriteBudgetError extends Error {
  readonly estimatedWrites: number
  readonly limit: number

  constructor(estimatedWrites: number) {
    super(
      `Operation would require about ${estimatedWrites.toLocaleString('en-US')} indexed D1 row writes, `
      + `above the ${MAX_SAFE_DESTRUCTIVE_D1_WRITES.toLocaleString('en-US')} safety limit. `
      + 'No data was changed. Lower retention and let paced cleanup drain the backlog, '
      + 'or perform a paced cleanup on paid D1 before retrying.',
    )
    this.name = 'DestructiveD1WriteBudgetError'
    this.estimatedWrites = estimatedWrites
    this.limit = MAX_SAFE_DESTRUCTIVE_D1_WRITES
  }
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0
}

export function estimateDestructiveD1Writes(
  counts: DestructiveRowCounts,
  operation: DestructiveMonitorOperation,
  plannedWrites = 0,
): number {
  // D1 counts table and index maintenance. These weights deliberately round
  // upward for partial indexes and cascades so the preflight fails safely.
  const historyWrites =
    counts.statusLogCount * 4
    + counts.rollupCount * 3
    + counts.incidentCount * 4
    + counts.incidentEventCount * 3

  if (operation === 'reset') {
    return Math.ceil(
      historyWrites
      + counts.alertStateCount
      + counts.monitorCount * 3
      + plannedWrites,
    )
  }

  const monitorCascadeWrites =
    historyWrites
    + counts.notificationDeliveryCount * 5
    + counts.monitorNotificationCount * 2
    + counts.heartbeatCount * 2
    + counts.alertStateCount * 2
    + counts.statusPageMonitorCount * 2
    + counts.incidentMonitorCount * 5
    + counts.maintenanceCount * 3
    + counts.monitorCount * 7

  if (operation === 'delete') {
    return Math.ceil(monitorCascadeWrites + plannedWrites)
  }

  return Math.ceil(
    monitorCascadeWrites
    + counts.notificationTestCount * 3
    + counts.channelCount * 2
    + counts.statusPageCount * 3
    + counts.settingsCount * 2
    + plannedWrites,
  )
}

async function countDestructiveRows(
  d1: D1Database,
  monitorIds?: string[],
): Promise<DestructiveRowCounts> {
  const allMonitors = monitorIds === undefined ? 1 : 0
  const idsJson = JSON.stringify(monitorIds ?? [])
  const row = await d1.prepare(`
    WITH target_monitors(id) AS (
      SELECT id
      FROM monitors
      WHERE ? = 1
        OR id IN (SELECT value FROM json_each(?))
    ),
    target_incidents(id) AS (
      SELECT incident.id
      FROM incidents AS incident
      JOIN target_monitors AS target ON target.id = incident.monitor_id
    )
    SELECT
      (SELECT COUNT(*) FROM target_monitors) AS monitorCount,
      (SELECT COUNT(*) FROM status_logs AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS statusLogCount,
      (SELECT COUNT(*) FROM monitor_daily_rollups AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS rollupCount,
      (SELECT COUNT(*) FROM target_incidents) AS incidentCount,
      (SELECT COUNT(*) FROM incident_report_events AS item
        JOIN target_incidents AS target ON target.id = item.event_id) AS incidentEventCount,
      (SELECT COUNT(*) FROM notification_deliveries AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS notificationDeliveryCount,
      (SELECT COUNT(*) FROM monitor_notifications AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS monitorNotificationCount,
      (SELECT COUNT(*) FROM heartbeat_tokens AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS heartbeatCount,
      (SELECT COUNT(*) FROM alert_state AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS alertStateCount,
      (SELECT COUNT(*) FROM status_page_monitors AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS statusPageMonitorCount,
      (SELECT COUNT(*) FROM incident_monitors AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS incidentMonitorCount,
      (SELECT COUNT(*) FROM maintenance_windows AS item
        JOIN target_monitors AS target ON target.id = item.monitor_id) AS maintenanceCount,
      (SELECT COUNT(*) FROM notification_channels) AS channelCount,
      (SELECT COUNT(*) FROM notification_test_runs) AS notificationTestCount,
      (SELECT COUNT(*) FROM status_pages) AS statusPageCount,
      (SELECT COUNT(*) FROM settings) AS settingsCount
  `).bind(allMonitors, idsJson).first<Record<keyof DestructiveRowCounts, unknown>>()

  const result = {} as DestructiveRowCounts
  for (const key of [
    'monitorCount',
    'statusLogCount',
    'rollupCount',
    'incidentCount',
    'incidentEventCount',
    'notificationDeliveryCount',
    'monitorNotificationCount',
    'heartbeatCount',
    'alertStateCount',
    'statusPageMonitorCount',
    'incidentMonitorCount',
    'maintenanceCount',
    'channelCount',
    'notificationTestCount',
    'statusPageCount',
    'settingsCount',
  ] as const) {
    result[key] = numberValue(row?.[key])
  }
  return result
}

export async function assertDestructiveMonitorWriteBudget(
  d1: D1Database,
  operation: DestructiveMonitorOperation,
  options: {
    monitorIds?: string[]
    plannedWrites?: number
  } = {},
): Promise<number> {
  const counts = await countDestructiveRows(d1, options.monitorIds)
  const estimate = estimateDestructiveD1Writes(
    counts,
    operation,
    options.plannedWrites,
  )
  if (estimate > MAX_SAFE_DESTRUCTIVE_D1_WRITES) {
    throw new DestructiveD1WriteBudgetError(estimate)
  }
  return estimate
}
