# Pingflare storage architecture

Pingflare separates authoritative operational state from high-volume telemetry and derived read acceleration.

## Ownership

| Concern | Cloudflare deployment | Docker deployment |
|---|---|---|
| Monitor configuration, current status, scheduler cursor | D1 | SQLite |
| Alert state, incidents, notification configuration | D1 | SQLite |
| Exact current UTC-day counters | D1 `monitors` row | SQLite `monitors` row |
| Exact completed daily history | D1 `monitor_daily_rollups` | SQLite `monitor_daily_rollups` |
| High-resolution check and agent telemetry | Analytics Engine | Not exported; exact counters remain local |
| Transition/error evidence | Sparse D1 `status_logs` | Sparse SQLite `status_logs` |
| Completed historical aggregate cache | Cloudflare Cache API | Bounded process-local cache |

D1/SQLite is the source of truth. Analytics Engine writes are best-effort and never gate a check. Cache misses and failures fall back to D1.

## Check write path

1. A holder-owned D1 lease prevents scheduled and manual runs from overlapping. Long runs renew the lease before each additional check batch and again before persistence.
2. The scheduler selects due active monitors in SQL and admits up to eight routine observations without starting checks that cannot fit the remaining D1 query budget.
3. HTTP, DNS, and ping checks run in query-budgeted batches with concurrency up to six. Heartbeat and agent state is prefetched in one query.
4. A D1 batch archives a completed UTC day when needed and updates `last_checked_at` plus exact current-day counters in the same transaction.
5. A D1 diagnostic row is written only for first checks, status transitions, internal errors, or the ten-minute sample boundary.
6. One privacy-bounded Analytics Engine point is emitted synchronously. A write failure is ignored.
7. Alert handling runs after the scheduling cursor is durable. A steady healthy check uses one conditional alert-state reset so a successful check always breaks a failure streak.

Monitor and incident transitions commit before notification I/O. Each provider attempt is bounded to 15 seconds; individual failures are logged and do not block the other state changes. If every configured channel fails for an initial down alert, its delivery timestamp remains empty so the next down observation retries.

## Read path

The `/api/monitors/:id/analytics` endpoint replaces four independent uptime requests. It reads:

- versioned completed daily rows older than yesterday from Cache API when present;
- yesterday and today directly from D1;
- the current monitor counter row directly from D1.

Full responses containing current status, logs, or incidents always return `Cache-Control: no-store`. Cache API stores only completed aggregate fragments, so a hit cannot make current status stale.

Cache keys include monitor IDs, per-monitor history revisions, and the requested range. Statistics reset and backup restore advance the revision. Cloudflare Cache API is data-center-local, so every region can fill independently without affecting correctness.

## Failure behavior

| Failure | Behavior |
|---|---|
| Analytics Engine unavailable at runtime | Monitoring and exact history continue in D1 |
| Analytics Engine not enabled for the account | Cloudflare rejects deployment before changing the active Worker; enable it once in the dashboard and redeploy |
| Cache API unavailable/miss | Query compact D1 rollups; use a bounded in-process fallback |
| Duplicate cron/manual run | Second invocation exits when it cannot acquire the lease |
| Notification provider failure | Operational state still commits; failure is logged |
| Worker stops after a check | The renewable lease expires after 110 seconds; durable cursors prevent immediate duplicate scheduling once persistence completes |
| D1 migration failure | `npm run deploy` stops before deploying the new Worker |

## Query and write controls

- Worker request-path schema DDL has been removed.
- Due selection is indexed and performed in SQL instead of loading every active monitor.
- Heartbeat rows are prefetched rather than queried once per monitor.
- Daily uptime reads at most one compact row per monitor per day instead of scanning minute-level logs.
- Retention deletes diagnostic rows in bounded batches of 200; a backlog continues draining on later cron runs before returning to hourly cleanup.
- Static frontend assets bypass Worker code; only `/api/*` and `/h/*` are Worker-first.
- Dashboard current state polls every 30 seconds; historical aggregates poll every five minutes; hidden tabs pause both.

The scheduler reserves worst-case query capacity before each external check batch, then uses the observed outcome cost to admit another batch when safe. It never performs a check whose result would have to be discarded for query-budget reasons. Deferred monitors remain due and are retried by the next cron invocation.
