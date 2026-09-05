import { Hono } from 'hono'
import type { Env } from '../index'
import { requireAuth } from '../middleware/auth'

const router = new Hono<{ Bindings: Env }>()
router.use('*', requireAuth)

const monitorProjection = `m.id, m.name, m.type, m.tags, m.url, m.interval, m.active,
  m.last_checked_at AS lastCheckedAt, m.last_status AS lastStatus,
  CASE WHEN m.active = 0 THEN 'paused'
    WHEN m.last_checked_at IS NULL OR m.last_status = 'pending' THEN 'pending'
    WHEN m.next_check_at + 90 < ? THEN 'stale' ELSE m.last_status END AS displayStatus`

router.get('/dashboard', async (c) => {
  const now = Math.floor(Date.now() / 1000)
  const summary = await c.env.DB.prepare(`SELECT COUNT(*) AS total,
    COALESCE(SUM(active = 1 AND last_checked_at IS NOT NULL AND last_status = 'up' AND next_check_at + 90 >= ?), 0) AS up,
    COALESCE(SUM(active = 1 AND last_checked_at IS NOT NULL AND last_status = 'down' AND next_check_at + 90 >= ?), 0) AS down,
    COALESCE(SUM(active = 1 AND (last_checked_at IS NULL OR last_status = 'pending')), 0) AS pending,
    COALESCE(SUM(active = 1 AND last_checked_at IS NOT NULL AND last_status <> 'pending' AND next_check_at + 90 < ?), 0) AS stale
    FROM monitors`).bind(now, now, now).first()
  const items = await c.env.DB.prepare(`SELECT ${monitorProjection} FROM monitors m
    WHERE m.active = 1 AND (m.last_status <> 'up' OR m.last_checked_at IS NULL OR m.next_check_at + 90 < ?)
    ORDER BY CASE WHEN m.last_status = 'down' THEN 0 ELSE 1 END, m.next_check_at, m.id LIMIT 20`)
    .bind(now, now).all()
  return c.json({ summary, items: items.results.map(row => ({ ...row, active: Boolean(row.active) })) })
})

router.get('/watchlist', async (c) => {
  const now = Math.floor(Date.now() / 1000)
  const since = now - now % 86400 - 29 * 86400
  const rows = await c.env.DB.prepare(`SELECT ${monitorProjection},
    100.0 * (COALESCE(r.up, 0) + CASE WHEN m.stats_day >= ? THEN m.day_up_count ELSE 0 END)
      / NULLIF(COALESCE(r.checks, 0) + CASE WHEN m.stats_day >= ? THEN m.day_checks ELSE 0 END, 0) AS uptime
    FROM monitors m LEFT JOIN (
      SELECT monitor_id, SUM(up_count) AS up, SUM(checks) AS checks FROM monitor_daily_rollups
      WHERE day >= ? GROUP BY monitor_id
    ) r ON r.monitor_id = m.id
    WHERE m.active = 1 AND m.last_status = 'up' AND m.last_checked_at IS NOT NULL AND m.next_check_at + 90 >= ?
    ORDER BY uptime IS NULL, uptime, m.name, m.id LIMIT 5`)
    .bind(now, since, since, since, now).all()
  return c.json({ items: rows.results.map(row => ({ ...row, active: Boolean(row.active) })) })
})

router.get('/', async (c) => {
  const now = Math.floor(Date.now() / 1000)
  const totals = await c.env.DB.prepare(`
    SELECT COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN active = 1 AND next_check_at < ? THEN 1 ELSE 0 END), 0) AS overdue,
      MIN(CASE WHEN active = 1 AND next_check_at < ? THEN next_check_at END) AS oldestDueAt,
      COALESCE(SUM(CASE WHEN active = 1 AND type IN ('http', 'dns', 'ping')
        THEN 60.0 / MAX(interval, 60) ELSE 0 END), 0) AS scheduledPerMinute,
      COALESCE(SUM(CASE WHEN active = 1 AND type IN ('heartbeat', 'agent')
        THEN 60.0 / MAX(COALESCE(heartbeat_interval, interval), 60) ELSE 0 END), 0) AS inboundPerMinute
    FROM monitors
  `).bind(now - 90, now - 90).first<{
    total: number; active: number; overdue: number; oldestDueAt: number | null
    scheduledPerMinute: number; inboundPerMinute: number
  }>()
  const scheduler = await c.env.DB.prepare(`
    SELECT last_completed_at AS lastCompletedAt, last_run_failed AS lastRunFailed,
      lease_until AS leaseUntil FROM scheduler_leases WHERE name = 'monitor-cron'
  `).first<{ lastCompletedAt: number | null; lastRunFailed: number; leaseUntil: number }>()
  const quota = await c.env.DB.prepare(`SELECT used FROM quota_budgets
    WHERE key = 'public-status-read-rows-v1' AND day = ?`).bind(now - now % 86400)
    .first<{ used: number }>()
  return c.json({
    ...totals, observedAt: now,
    oldestOverdueSeconds: totals?.oldestDueAt === null || totals?.oldestDueAt === undefined
      ? null : Math.max(0, now - totals.oldestDueAt),
    scheduler: {
      lastCompletedAt: scheduler?.lastCompletedAt ?? null,
      failed: Boolean(scheduler?.lastRunFailed),
      running: (scheduler?.leaseUntil ?? 0) > now,
      stale: !scheduler?.lastCompletedAt || now - scheduler.lastCompletedAt > 180,
    },
    normalChecksPerMinute: 2,
    conservativeChecksPerMinute: 1,
    publicReadReservation: { used: quota?.used ?? 0, limit: 4_000_000 },
  })
})

router.get('/deliveries', async (c) => {
  const pending = await c.env.DB.prepare(`
    SELECT d.id, m.name AS monitorName, d.event_type AS eventType,
      d.created_at AS createdAt, d.next_attempt_at AS nextAttemptAt,
      d.attempts, d.delivered_count AS deliveredCount,
      CASE WHEN d.last_error IS NULL THEN 0 ELSE 1 END AS failed,
      d.claim_until AS claimUntil,
      (SELECT group_concat(c.name, ', ') FROM json_each(d.remaining_channel_ids) j
        JOIN notification_channels c ON c.id = j.value) AS channels
    FROM notification_deliveries d JOIN monitors m ON m.id = d.monitor_id
    ORDER BY d.next_attempt_at, d.created_at LIMIT 51
  `).all()
  const receipts = await c.env.DB.prepare(`
    SELECT id, monitor_name AS monitorName, channel_name AS channelName,
      event_type AS eventType, delivered_at AS deliveredAt
    FROM delivery_receipts ORDER BY id DESC LIMIT 50
  `).all()
  return c.json({ pending: pending.results.slice(0, 50), hasMore: pending.results.length > 50,
    receipts: receipts.results })
})

// Retry changes eligibility only; actual provider I/O remains in the bounded drain.
router.post('/deliveries/:id/retry', async (c) => {
  const now = Math.floor(Date.now() / 1000)
  const result = await c.env.DB.prepare(`UPDATE notification_deliveries
    SET next_attempt_at = ?, updated_at = ?
    WHERE id = ? AND (claim_until IS NULL OR claim_until <= ?)
      AND next_attempt_at > ?`)
    .bind(now, now, c.req.param('id'), now, now).run()
  return c.json({ ok: true, changed: Number(result.meta.changes) > 0 })
})

export default router
