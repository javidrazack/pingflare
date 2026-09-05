# Current features

This document describes the functionality implemented in Pingflare today. It
is a product reference rather than a roadmap.

## Dashboard surfaces

| Surface | Purpose |
|---|---|
| Dashboard | Live monitor totals, operational/down/pending state, the monitors needing attention, a low-uptime watchlist, and a manual check trigger |
| Monitors | Searchable and paginated inventory with status/type/active filters, sorting, and bulk pause, resume, or delete actions |
| Monitor detail | Overview, performance, incidents, sparse logs, and configuration tabs for one monitor |
| Infrastructure | Fleet-level agent health, resource pressure, stale telemetry, a top-five priority list with exact reasons, and current CPU/RAM/disk values |
| Incidents | Unlinked detected outages plus manual incident reports with impact, draft/published visibility, affected monitors, and timestamped updates |
| Status pages | Public-page creation, monitor selection or “show all,” branding, theme, history visibility, SEO metadata, and optional password protection |
| Notifications | Channel creation, validation, unsaved previews, persisted test history, default channels, and apply-to-all-monitors |
| Configuration | Language, diagnostic retention, and versioned configuration backup/restore |

Authenticated dashboard data refreshes without forcing a full page reload.
Current monitor state is refreshed every 30 seconds, infrastructure state every
minute, and aggregate uptime less frequently. Hidden tabs do not continue those
polls.

The dashboard separates overdue checks from pending and paused monitors and
shows monitoring capacity, scheduler completion, and overdue age. Notifications
includes a bounded delivery inbox and provider acceptance receipts. Each monitor
has maintenance controls with finite weekly repeats. See [operational controls](OPERATIONS.md)
for limits, session behavior, and upgrade requirements.

## Monitor types

### HTTP

- `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `HEAD`, and `OPTIONS`
- Expected HTTP status and response-time measurement
- Optional request body and custom headers
- Redirect control and a 1–60 second end-to-end timeout
- Basic, digest, and bearer authentication; stored secrets are encrypted
- JSONPath presence or expected-value assertions on JSON responses up to 512 KB
- Optional SSL state tracking for HTTPS targets
- Optional cache booster that adds a cache-busting query value to each check

Pingflare does not currently provide a free-text response keyword assertion.

### DNS

- DNS-over-HTTPS resolution
- `A`, `AAAA`, `CNAME`, `MX`, `NS`, and `TXT` records
- Configurable resolver URL
- Optional exact expected-answer validation
- JSON and DNS wire-format resolver responses, with bounded response sizes

### Ping / port reachability

The Ping monitor is a Worker-compatible reachability check, not ICMP. It sends
an HTTP `HEAD` request and treats any HTTP response as reachable. For narrow
HTTP protocol-decoding failures, it treats the failure as evidence that the
requested TCP port opened. This makes it useful for many TCP services while
remaining compatible with Cloudflare Workers.

### Heartbeat

- Unique push URL for jobs and services
- Configurable expected interval, grace period, and missed-push tolerance
- `GET` or `POST` pushes
- Token regeneration
- Missed-push evaluation by the regular scheduler

### Agent / infrastructure

- One-minute Linux reports for CPU, RAM, root-disk usage, and optional Docker
  container state
- CPU, RAM, and disk thresholds
- Fleet classification as healthy, watch, critical, stale, pending, or paused
- A structured strongest signal explaining the threshold, freshness, check, or
  optional Docker issue behind each node's state
- No Docker requirement; hosts without Docker report an empty container list
- Generated installer with systemd timer and root-crontab fallback
- Lazy-loaded historical CPU/RAM/disk charts for `2h`, `24h`, `7d`, and `30d`

See [Infrastructure Agent](AGENT.md) for installation, retention, and Free-plan
sizing.

## History and investigation

- Exact current-day counters and compact completed-day rollups
- Uptime summaries for 1, 7, 30, and 90 UTC calendar-day windows
- Daily uptime and average response-time history
- Sparse diagnostic evidence for first checks, transitions, internal errors,
  and periodic samples
- Automatically opened and resolved downtime incidents
- Agent resource samples retained for 30 days

Agent resource history is intentionally on demand. The fleet page shows current
values; opening an agent monitor's **Performance** tab fetches the selected
historical range. Five-minute source samples are returned as five-minute,
30-minute, or two-hour buckets depending on the requested range.

## Alerting and incidents

Monitor-level controls include consecutive-failure tolerance, missed-heartbeat
tolerance, reminder intervals, scheduled maintenance windows, and surge
protection. Maintenance suppresses alert transitions for the configured window.

Notifications are written to a durable D1/SQLite outbox before provider I/O.
Delivery is deduplicated, bounded per invocation, and retried by later requests
or cron runs. Supported providers are:

- Discord
- Slack
- Telegram
- Email
- ntfy
- Pushover
- Generic webhook
- Apprise
- Google Chat
- Microsoft Teams
- Matrix
- PagerDuty
- Twilio

Detected downtime events are operational evidence. Incident reports are the
human-facing communication layer: they can link detected events and monitors,
carry minor/major/critical impact, remain drafts, be published to status pages,
and receive investigating/identified/monitoring/resolved updates.

## Public status pages

Each public status page can:

- Show selected monitors or all monitors
- Display exact uptime, response time, and 7/30/60/90-day history according to
  page settings
- Show published incident reports and their latest updates
- Use a logo, brand color, light/dark/system theme, and SEO title/description
- Require a password without exposing its stored hash

Public traffic is rate-limited before D1 access and shares a reserved daily D1
read budget. Live status and active incidents are never served from historical
cache entries.

## Configuration backup and restore

The versioned JSON backup contains settings, monitors, notification channels,
monitor-channel links, status pages, page-monitor links, and maintenance
windows. It intentionally excludes uptime history, diagnostic logs, detected
incidents, alert delivery state, and agent resource samples.

Restore validates record types and references, rejects more than 5,000 records,
preflights the destructive-write budget, replaces configuration atomically,
regenerates heartbeat/agent tokens, and resets restored monitors to pending.

## Platform behavior

| Capability | Cloudflare Workers | Docker / VPS |
|---|---|---|
| Operational database | D1 | SQLite |
| Scheduler | One-minute Cron Trigger | Built-in `node-cron` |
| Best-effort high-resolution telemetry | Analytics Engine | Not exported |
| Completed-history cache | Cloudflare Cache API | Bounded process-local cache |
| Configuration and feature set | Same application | Same application |

Cloudflare deployments are designed around Free-plan request, D1, subrequest,
and Analytics Engine limits. Docker removes Cloudflare account quotas, but the
application keeps the same scheduler admission and safety bounds unless they
are deliberately changed and tested.

## Deliberate limits

- No log aggregation or arbitrary host-log storage
- No container orchestration, per-container resource metrics, or requirement
  to run Docker
- No ICMP checks from Cloudflare Workers
- No per-minute persistence of agent resource metrics; regular history samples
  are stored every five minutes
- No Analytics Engine dependency for dashboard accuracy
- No cached current status or active incidents
