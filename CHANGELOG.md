# Changelog

## [Unreleased]

### Added
- Analytics Engine telemetry datasets for high-resolution check, agent, and sampled API metrics
- Exact compact D1 daily rollups with authoritative current-day counters
- Versioned aggregate caching for completed historical days, with a bounded Docker/Node fallback
- A consolidated monitor analytics endpoint and detailed storage/telemetry architecture documentation
- A global scheduler lease that prevents overlapping scheduled and manual runs

### Improved
- Dashboard current-state polling now runs every 30 seconds, historical polling every five minutes, and both pause in hidden tabs
- Historical dashboard and public-status queries read compact daily rows instead of scanning minute-level status logs
- D1 status logs are sparse diagnostic evidence while Analytics Engine receives every high-resolution observation
- Due monitors and heartbeat state are selected in sets, retention cleanup drains in bounded batches, and healthy checks reset tolerated failure streaks with one conditional write
- Static assets bypass Worker execution; only API and heartbeat paths run Worker-first
- Monitor and incident transitions commit before bounded notification delivery; total provider failures retry the initial alert
- Bulk monitor actions and backup restore use set-based JSON operations to stay below D1's per-invocation query limit

### Reliability
- Current status, scheduling, alerts, incidents, and exact uptime remain authoritative in D1/SQLite
- Cache never stores current status, recent logs, or active incidents; complete API responses use `no-store`
- Analytics Engine and Cache failures fall back without interrupting monitoring
- Worker request-path schema DDL was removed; deployment applies migrations before publishing code

### Upgrade
- Apply D1 migrations `0005_flimsy_quicksilver.sql` and `0006_remarkable_johnny_blaze.sql`
- `npm run deploy` now safely reconciles legacy v1.6 migration-ledger drift, applies pending migrations through the `DB` binding, and then deploys

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
