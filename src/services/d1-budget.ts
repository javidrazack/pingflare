const PUBLIC_READ_BUDGET_KEY = 'public-status-read-rows-v1'

/**
 * Keep one million of D1 Free's five-million daily row reads available for
 * monitoring, the authenticated UI, and recovery work.
 */
export const PUBLIC_D1_READ_BUDGET_PER_DAY = 4_000_000
export const PUBLIC_STATUS_BASE_READ_RESERVATION = 800
export const PUBLIC_STATUS_MONITOR_LIMIT = 180
export const PUBLIC_INCIDENT_FEED_READS_PER_LINK = 3
export const PUBLIC_INCIDENT_FEED_FIXED_READS = 500
export const PUBLIC_INCIDENT_FEED_LINK_LIMIT = 20_000

export class PublicD1ReadBudgetExceededError extends Error {
  constructor() {
    super('Public status read budget is exhausted until the next UTC day')
    this.name = 'PublicD1ReadBudgetExceededError'
  }
}

export async function reservePublicD1ReadBudget(
  d1: D1Database,
  requestedRows: number,
  now = Math.floor(Date.now() / 1000),
): Promise<boolean> {
  const units = Math.max(1, Math.ceil(requestedRows))
  if (units > PUBLIC_D1_READ_BUDGET_PER_DAY) return false
  const day = now - (now % 86400)
  const row = await d1.prepare(`
    INSERT INTO quota_budgets (key, day, used)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      day = excluded.day,
      used = CASE
        WHEN quota_budgets.day = excluded.day
          THEN quota_budgets.used + excluded.used
        ELSE excluded.used
      END
    WHERE quota_budgets.day <> excluded.day
      OR quota_budgets.used + excluded.used <= ?
    RETURNING used
  `).bind(
    PUBLIC_READ_BUDGET_KEY,
    day,
    units,
    PUBLIC_D1_READ_BUDGET_PER_DAY,
  ).first<{ used: number }>()
  return row !== null
}

export async function requirePublicD1ReadBudget(
  d1: D1Database,
  requestedRows: number,
): Promise<void> {
  if (!(await reservePublicD1ReadBudget(d1, requestedRows))) {
    throw new PublicD1ReadBudgetExceededError()
  }
}

/**
 * Reserve the worst-case rows for the public incident feed before touching
 * incident history. The trigger-maintained per-monitor counts are bounded by
 * the status-page monitor limit; the feed then reads at most one link row and
 * one report row per candidate.
 */
export async function reservePublicIncidentFeedReadBudget(
  d1: D1Database,
  monitorIds: string[],
): Promise<
  | { kind: 'reserved'; candidateLinks: number; reservedRows: number }
  | { kind: 'history_limit'; candidateLinks: number }
  | { kind: 'daily_budget' }
> {
  const row = await d1.prepare(`
    SELECT COALESCE(SUM(link_count), 0) AS candidateLinks
    FROM incident_feed_monitor_counts
    WHERE monitor_id IN (SELECT value FROM json_each(?))
  `).bind(JSON.stringify(monitorIds)).first<{ candidateLinks: number }>()
  const parsedCandidateLinks = Number(row?.candidateLinks ?? 0)
  const candidateLinks = Number.isFinite(parsedCandidateLinks)
    ? Math.max(0, Math.ceil(parsedCandidateLinks))
    : PUBLIC_INCIDENT_FEED_LINK_LIMIT + 1
  if (candidateLinks > PUBLIC_INCIDENT_FEED_LINK_LIMIT) {
    return { kind: 'history_limit', candidateLinks }
  }
  const reservedRows =
    candidateLinks * PUBLIC_INCIDENT_FEED_READS_PER_LINK
    + PUBLIC_INCIDENT_FEED_FIXED_READS
  if (!(await reservePublicD1ReadBudget(d1, reservedRows))) {
    return { kind: 'daily_budget' }
  }
  return { kind: 'reserved', candidateLinks, reservedRows }
}
