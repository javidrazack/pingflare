# Changelog

## [Unreleased]

## [1.8.0] - 2026-08-09

### Added
- A fleet-level Infrastructure dashboard with current agent health, CPU/RAM/disk pressure, freshness, bounded priority issues, and exact strongest-signal explanations
- On-demand CPU, RAM, and disk history for agent monitors across 2-hour, 24-hour, 7-day, and 30-day ranges
- Persisted notification test history and guided configuration for all supported providers

### Improved
- Docker is optional throughout agent setup and infrastructure triage; ordinary Linux hosts remain first-class monitored nodes
- Dashboard hierarchy, responsive layouts, keyboard behavior, focus treatment, reduced-motion support, feedback, and empty/error states were polished across authenticated and public views
- Infrastructure APIs now expose the same route set in Cloudflare Worker and Docker/SQLite deployments

### Security
- Updated SvelteKit, Hono, Wrangler, and affected transitive packages to patched releases so the production and development dependency audits pass without known vulnerabilities

### Documentation
- Refreshed the README, feature reference, API, architecture, Analytics Engine, infrastructure-agent, localization, product, and local-development guides against the current implementation
- Replaced completed implementation plans with archived records and updated the Checkmate comparison to distinguish current parity from deliberate platform limits

### Upgrade notes
- Apply migration `0011_agent_metric_samples.sql` before deploying code that reads agent resource history; `npm run deploy` performs this step automatically for Cloudflare deployments

## [1.7.0] - 2026-07-28

### Added
- Analytics Engine telemetry datasets for high-resolution check, agent, and sampled API metrics
- Exact compact D1 daily rollups with authoritative current-day counters
- Versioned aggregate caching for completed historical days, with a bounded Docker/Node fallback
- A consolidated monitor analytics endpoint and detailed storage/telemetry architecture documentation
- A global scheduler lease that prevents overlapping scheduled and manual runs
- A durable, deduplicated notification-delivery outbox with bounded provider attempts and capped-backoff retries
- An account-wide UTC-day D1 read ledger that preserves monitoring capacity under public-status traffic

### Improved
- Dashboard current-state polling now runs every 30 seconds, historical polling every five minutes, and both pause in hidden tabs
- Historical dashboard and public-status queries read compact daily rows instead of scanning minute-level status logs
- D1 status logs are sparse diagnostic evidence while Analytics Engine receives every high-resolution observation
- Due monitors and heartbeat state are selected in sets, retention cleanup is durably capped at 200 rows per hour across Worker cold starts, and healthy checks reset tolerated failure streaks with one conditional write
- Static assets bypass Worker execution; only API and heartbeat paths run Worker-first
- Monitor and incident transitions commit before bounded notification delivery; incomplete alert, reminder, and recovery fan-out remains retryable
- Bulk monitor actions and backup restore use set-based JSON operations to stay below D1's per-invocation query limit
- Large history and public-status ID sets use one JSON1 query instead of repeated 90-ID D1 chunks
- Incident, status-page, monitor-channel, and settings associations use bounded JSON1 set writes instead of per-row D1 loops
- API Analytics Engine points include application sampling weights so request and error estimates remain unbiased
- Manual check feedback distinguishes an active scheduler lease from a successful run, and dashboard data-source failures no longer hide each other
- Public status reads reuse loaded monitor rows and precompute UTC labels once per response
- Public incident feeds drive from selected-monitor links, reserve trigger-maintained candidate counts before querying, and use deterministic bounded indexes for report updates and monitor detail
- Destructive monitor, statistics-reset, and restore cascades are rejected before mutation when indexed writes exceed the Free-plan safety envelope

### Reliability
- Current status, scheduling, alerts, incidents, and exact uptime remain authoritative in D1/SQLite
- Cache never stores current status, recent logs, or active incidents; complete API responses use `no-store`
- Analytics Engine and Cache failures fall back without interrupting monitoring
- Worker request-path schema DDL was removed; deployment applies migrations before publishing code
- HTTP, DNS, and ping checks enforce one end-to-end 60-second maximum deadline, including streamed bodies and digest retries
- Indexed `next_check_at` scheduling and a 120-second renewable lease prevent overlap without scanning scheduling expressions
- Heartbeat and agent cron observations use compare-and-swap guards so a stale timeout cannot overwrite a newer inbound push
- Legacy history catch-up is restartable, paced to 25 rows every five minutes to protect D1's daily write quota, and rescans late writes before completion
- Open incidents are concurrency-safe, and recovery state commits even when maintenance or notification providers suppress delivery
- Observation revisions prevent older cron and inbound work from overwriting newer monitor, incident, or notification truth
- Alert-transition failures pull the durable scheduling cursor forward for a prompt retry, including a fallback marker attempt
- Cron admission budgets hidden claimed-DOWN recovery repairs at their full cost and is regression-tested against D1's 50-query invocation limit
- Claimed or partially delivered DOWN notifications are reconciled before recovery, including after a healthy-path crash
- Queued DOWN notifications wait until active maintenance ends, and cyclic DNS compression pointers fail within bounded work
- Notification provider work is serialized per monitor; late DOWN and recovery sends stage the corrective opposite event before cleanup
- Inbound heartbeat and agent pushes retry one fresh revision when cron wins their initial compare-and-swap
- Inbound retries advance to a monotonic winning timestamp and refuse to overwrite a newer real push
- Public status summary and detail reads are rate-limited before D1, capped at 180 monitors, and governed by an account-wide daily read budget; protected polls use short-lived HMAC access tokens after unlock
- CI replays the D1 migration chain and validates a production Worker bundle

### Upgrade
- Apply D1 migrations `0005_flimsy_quicksilver.sql` through `0010_bounded_incident_feed.sql`
- `npm run deploy` now validates and reconciles complete ledgerless v1.6 schemas, sums every pending index build, obsolete-index cleanup, and migration backfill against a 40,000-write safety envelope before mutation, applies pending migrations through the `DB` binding, and then deploys

## [1.6.0] - 2026-07-27

### Added
- **Redesigned monitoring experience**: New application shell, dashboard, monitor inventory, monitor details, incidents, notification, and status-page workflows
- **Monitor management tools**: Search, filter, sorting, pagination, and bulk pause, resume, and delete actions
- **Incident publishing**: Incident impact and visibility controls, monitor and detected-event linking, progress updates, and public incident history
- **Status-page appearance**: Custom logo, brand color, light/dark/system theme, history range, response-time and uptime visibility, and SEO metadata
- **Notification diagnostics**: Test-run history and clearer channel configuration feedback

### Improved
- Responsive layouts, accessibility, chart readability, status badges, forms, loading states, and English and Brazilian Portuguese copy
- Public status pages now support branded presentation, selected or all monitors, incident updates, and a dedicated monitor view
- Dependency constraints and HTTP-check behavior were hardened for reproducible Linux builds

### Upgrade
- Apply D1 migration `0004_wandering_mulholland_black.sql` before deploying the Worker
- Docker/SQLite deployments apply the compatibility schema during startup

## [1.5.0] - 2026-07-23

### Added
- **Infrastructure monitoring agent**: Collects CPU, RAM, disk, and Docker container health every minute
- **Threshold alerting**: Agent monitors participate in the existing incident, tolerance, recovery, reminder, and notification flow
- **Generated installer**: Token-scoped installation endpoint configures a systemd timer with a root-crontab fallback
- **Agent heartbeat detection**: Missing or invalid reports mark the agent monitor unavailable
- **JSONPath assertions** for HTTP response validation
- **Scheduled maintenance windows** that suppress alert and status transitions
- **Notification channels** for Microsoft Teams, Matrix, PagerDuty, and Twilio

### Improved
- Agent installer validates dependencies, permissions, scheduler activation, and the first successful heartbeat
- Non-overlapping execution locks and reusable CPU counters reduce agent overhead and prevent out-of-order snapshots
- Cloudflare Workers, Docker, migrations, request limits, secret handling, backup restore, and CI were hardened for production
- Added agent, installer, security, cron, history, backup, DNS, ping, and public-status test coverage

### Documentation
- Added the infrastructure-agent installation and operational guide
- Expanded API and deployment documentation for Cloudflare and Docker

## [1.4.1] - 2026-05-29

### Added
- **Ping monitor type**: New monitor type `ping` sends an HTTP HEAD request to any target and considers the host **up** on any response regardless of status code (200, 404, 500, etc.) — only connection failures, host-not-found, and timeouts mark the host as **down**
- **Port checking**: Ping targets accept `host:port` notation (e.g. `1.1.1.1:22`, `db.internal:5432`). When TCP connects but the port speaks a non-HTTP protocol (SSH, DNS-TCP, Redis, etc.) the check still returns **up** with message `Ping OK · :22 open`
- **Automatic URL normalisation**: Bare IPs (`1.1.1.1`) and `host:port` entries get `http://` prepended automatically; `https://` URLs are left unchanged

### Tests
- Added 15 Vitest unit tests for `checkPing()` covering: HTTP 200/404/500 all reported as up, non-HTTP protocol response (port open) reported as up with port label, ECONNREFUSED/ENOTFOUND/ENETUNREACH reported as down, timeout, custom timeout value, HEAD method assertion, and URL normalisation for bare IP / host:port / http:// / https://

## [1.3.3] - 2026-05-28

### Added
- **DNS Providers**: Adds a public DNS list normalization for improved data processing

## [1.3.2] - 2026-05-28

### Fixed
- **Migration**: Revert ensureScheme to fix auto migration database on Cloudflare Worker + D1

## [1.3.1] - 2026-05-28

### Fixed
- **Migration**: Fixing auto migration database on Cloudflare Worker + D1

## [1.3.0] - 2026-05-28

### Added
- **DNS over HTTPS (DoH) monitor type**: New monitor type `dns` checks if a DNS resolver is responding and resolving correctly by querying any RFC 8484-compliant DoH endpoint (e.g. `https://freedns.controld.com/p0`, `https://1.1.1.1/dns-query`, `https://dns.google/resolve`)
- **Configurable record type**: Supports any DNS record type (`A`, `AAAA`, `MX`, `CNAME`, `TXT`, `NS`, etc.) via the `dnsRecordType` field

### Tests
- Added 15 new Vitest tests for `checkDns()` covering NOERROR, NXDOMAIN, SERVFAIL, REFUSED, unknown RCODE, DoH HTTP errors, expected-IP validation, timeout, network errors, and query URL construction

---

## [1.2.0] - 2026-05-28

### Performance
- **SQL aggregation**: Uptime and daily stats in `/api/monitors/:id/uptime`, `/api/monitors/:id/daily`, and public status pages are now computed in SQL
- **Database indexes**: Added composite index, dramatically speeding up history queries and the retention cleanup DELETE
- **Cron concurrency cap**: Monitor checks are now batched in groups of 10 (`CONCURRENCY = 10`) instead of firing all at once, keeping D1 write operations well within the free-tier rate limit (100k writes/day)
- **HTTP caching on status pages**: Public status page endpoints now return `Cache-Control: public, max-age=30, stale-while-revalidate=60`, reducing D1 load under traffic
- **Cloudflare origin cache**: `getWorkerOrigin()` result (colo/country/IP) is cached in module scope for 5 minutes, was fetching `1.1.1.1/cdn-cgi/trace` on every cron tick
- **Observability sampling**: Reduced `head_sampling_rate` from 100% to 10% in `wrangler.toml`, preventing log-ingest quota exhaustion at 1-minute cron cadence
- **Retention cleanup**: Log retention DELETE now runs at most once per hour (was running every cron tick even when nothing was due)

### Fixed
- **Scheduling cursor decoupled from alerts**: `lastCheckedAt` is now advanced immediately after writing `status_logs`, before `processAlert` runs, a failed alert channel no longer causes a monitor to be re-checked on every subsequent cron tick
- **Backup restore atomicity**: `/api/backup/restore` now validates the entire payload before deleting any data; rejects payloads larger than 512 KB with HTTP 413
- **Schema migration moved out of request path**: `ensureSchema` is no longer called on every incoming request in the Cloudflare Workers entrypoint, migrations run at deploy time via `wrangler d1 migrations apply`
- **SQLite shim `raw()` bug**: `ShimStatement.raw()` was calling `raw(true)` on one `Database.Statement` instance and then running `.all()` on a different instance (due to the `stmt` getter creating a new prepared statement on each access), causing `db.select()` queries with custom fields to return object rows instead of arrays and breaking all SQL aggregation in the Node.js/Docker runtime

### Tests
- Added full Vitest test suite (`src/test/`) covering cron scheduling logic, backup export/restore, history API (logs, uptime, daily aggregation, incidents), and public status pages
- Tests run against an in-memory SQLite database via the D1 shim, no network or external dependencies required

---

## [1.1.0] - 2026-05-13

### Added
- **Multi-backend support**: Pingflare can now run as a standalone Node.js server in addition to Cloudflare Workers, enabling self-hosted deployments via Docker or Fly.io
- **Docker support**: Added `Dockerfile` and `compose.yml` for containerized deployments
- **Fly.io support**: Added `fly.toml` configuration for Fly.io deployments

### Fixed
- Corrected CLI argument parsing in the Node.js server (`src/server.ts`)
- Fixed D1 and SQLite compatibility issues in the database shim
- Fixed `npm ci` call in Dockerfile (was incorrectly using `install`)

### Docs
- Expanded README with deployment instructions for Docker, Fly.io, and self-hosted Node.js setups

### Chores
- Bumped package version and updated `package-lock.json`
- Updated CI/CD workflows to support multi-deployment targets

---

## [1.0.1] - 2026-05-13

Initial stable release with Cloudflare Workers deployment, Hono backend, SvelteKit frontend, and Google Chat notification support.
