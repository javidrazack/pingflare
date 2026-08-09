# API

All authenticated endpoints require an `Authorization: Bearer <token>` header.
Obtain a token by calling `POST /api/auth/login`.

---

## Authentication

| Method | Path | Description |
|---|---|---|
| POST | `/api/auth/login` | Returns a JWT token valid for 30 days |
| POST | `/api/auth/refresh` | Exchanges a valid token for a new one with a fresh 30-day expiry |

---

## Operations

| Method | Path | Authentication | Description |
|---|---|---|---|
| GET | `/api/health` | No | Lightweight process health and current server timestamp |
| POST | `/api/cron/run` | Yes | Run the same lease-protected scheduler used by the one-minute trigger |

The manual cron response reports how many checks ran or were deferred and
whether another scheduler holder already owned the lease.

---

## Monitors

| Method | Path | Description |
|---|---|---|
| GET | `/api/monitors` | List all monitors, or return a paginated result when `page` is present |
| PATCH | `/api/monitors/bulk` | Pause, resume, or delete 1–100 monitor IDs |
| POST | `/api/monitors` | Create a monitor |
| GET | `/api/monitors/:id` | Get a monitor |
| PUT | `/api/monitors/:id` | Update a monitor |
| DELETE | `/api/monitors/:id` | Delete a monitor |
| GET | `/api/monitors/:id/logs` | Sparse transition/error/sample logs, supports `?hours=24&limit=500` |
| GET | `/api/monitors/:id/incidents` | Downtime incidents |
| GET | `/api/monitors/:id/analytics` | Consolidated exact 1/7/30/90-day uptime, daily history, count, and response average |
| GET | `/api/monitors/:id/metric-history` | Agent CPU/RAM/disk rollups, supports `?range=2h`, `24h`, `7d`, or `30d` |
| GET | `/api/monitors/:id/uptime` | Uptime percentage, supports `?days=90` |
| GET | `/api/monitors/:id/daily` | Per-day uptime breakdown, supports `?days=90` |
| GET | `/api/monitors/uptime-summary` | Batched uptime percentages, supports `?days=30` |
| GET | `/api/monitors/:id/check-count` | Total number of recorded checks |
| GET | `/api/monitors/:id/heartbeat-token` | Get heartbeat token |
| POST | `/api/monitors/:id/heartbeat-token/regenerate` | Rotate heartbeat token |
| GET | `/api/monitors/:id/channels` | Notification channel IDs linked to the monitor |
| POST | `/api/monitors/:id/reset-stats` | Clear rollups/logs/incidents, advance cache revision, and reset alert state |
| GET/POST | `/api/monitors/:id/maintenance` | List or create maintenance windows |
| DELETE | `/api/monitors/:id/maintenance/:maintenanceId` | Delete a maintenance window |

Paginated monitor queries accept `page`, `pageSize`, `search`, `status`,
`type`, `active`, `sort`, and `direction`. Search covers monitor name, target
URL, tags, and DNS hostname. `sort` may be `name`, `status`, `type`, `checked`,
or `updated`; `direction` may be `asc` or `desc`.

Bulk requests use `{ "ids": ["..."], "action": "pause" }`, where `action` is
`pause`, `resume`, or `delete`. Destructive operations can return
`409 D1_DESTRUCTIVE_WRITE_BUDGET_EXCEEDED` before changing data.

Uptime windows use completed and current UTC calendar days. The one-day value is the current UTC day, not a rolling 24-hour window.

---

## Heartbeat

| Method | Path | Description |
|---|---|---|
| GET or POST | `/h/:token` | Register a heartbeat ping |

## Infrastructure Agent

| Method | Path | Description |
|---|---|---|
| GET | `/api/agent/install/:token` | Generated installation script for an agent monitor |
| POST | `/api/agent/push/:token` | Submit CPU, RAM, disk, and optional Docker state |
| GET | `/api/infrastructure/overview` | Current fleet summary, node health, resource pressure, freshness, and the top five issues |

Metric history is retained for 30 days. The `2h` and `24h` ranges return
five-minute buckets, `7d` returns 30-minute buckets, and `30d` returns two-hour
buckets. This endpoint is authenticated and is requested by the dashboard only
when an agent monitor's Performance tab is opened.

The overview returns at most 200 agent nodes and sets `truncated: true` when
more exist. Node states are `healthy`, `warning`, `critical`, `stale`,
`pending`, or `paused`. Every node includes a structured `strongestSignal` so
clients can explain the most urgent threshold, freshness, check, or optional
Docker problem. The overview does not return the full container inventory.

---

## Notifications

| Method | Path | Description |
|---|---|---|
| GET | `/api/notifications` | List channels |
| GET | `/api/notifications/:id` | Get one sanitized channel |
| GET | `/api/notifications/:id/tests` | Get the latest 20 persisted test results |
| POST | `/api/notifications` | Create a channel |
| POST | `/api/notifications/test` | Validate and test an unsaved channel configuration |
| PUT | `/api/notifications/:id` | Update a channel |
| DELETE | `/api/notifications/:id` | Delete a channel |
| POST | `/api/notifications/:id/test` | Test a saved channel and persist the result |
| POST | `/api/notifications/:id/apply-all-monitors` | Link the channel to all monitors |

Sensitive configuration fields are encrypted at rest and returned as empty
strings with their names listed in `encryptedFields`.

---

## Status Pages

| Method | Path | Description |
|---|---|---|
| GET | `/api/status-pages` | List status pages |
| GET | `/api/status-pages/:id` | Get a status page |
| POST | `/api/status-pages` | Create a status page |
| PUT | `/api/status-pages/:id` | Update a status page |
| DELETE | `/api/status-pages/:id` | Delete a status page |
| GET | `/api/status-pages/:id/monitors` | List monitor IDs assigned to a page |
| GET | `/api/public/status/:slug` | Public data for a status page |
| GET | `/api/public/status/:slug/monitors/:monitorId` | Public monitor detail |

Protected public reads accept the page password in `X-Status-Password`. A
successful request returns a ten-minute signed value in
`X-Pingflare-Status-Access`; clients can send that same header on later polls
instead of resending the password.

Public status reads return `429 PUBLIC_D1_READ_BUDGET_EXHAUSTED` when the account-wide UTC-day read allocation is spent. A page whose selected monitors have more than 20,000 historical manual-incident links returns `503 PUBLIC_INCIDENT_FEED_HISTORY_LIMIT`; archive old incident associations before retrying.

---

## Incidents

| Method | Path | Description |
|---|---|---|
| GET | `/api/incidents` | List incident reports |
| GET | `/api/incidents/detected` | List up to 100 detected downtime events not linked to a report |
| GET | `/api/incidents/:id` | Get a report with updates and affected monitors |
| POST | `/api/incidents` | Create an incident report |
| PUT | `/api/incidents/:id` | Update an incident report |
| POST | `/api/incidents/:id/updates` | Add an update to an incident |
| DELETE | `/api/incidents/:id` | Delete an incident report |

---

## Events (SSE)

`GET /api/events` opens a Server-Sent Events stream that pushes monitor status in real time.

```
Authorization: Bearer <token>
```

### Events emitted

| Event | Payload | Frequency |
|---|---|---|
| `snapshot` | `Monitor[]` — full list of monitors with current status | On connect, then every 60 s |
| `heartbeat` | `{ ts: number }` — Unix timestamp (ms) | Every 30 s |

> **Note:** Cloudflare Workers free tier may close long-lived connections after ~30 s. The client should reconnect automatically, `EventSource` does this natively, and each reconnect immediately receives a fresh `snapshot`.

---

## Settings

| Method | Path | Description |
|---|---|---|
| GET | `/api/settings` | Get all settings |
| PUT | `/api/settings` | Update settings |

The endpoint stores a generic string key/value map. Keys used by the current
dashboard are `retention_days` (default `90`) and `locale`. A request may
contain at most 100 entries and 64 KiB of JSON.

---

## Notification Channel Configuration

Each channel stores its config as a JSON object.
Required fields per type:

| Type | Required fields |
|---|---|
| `discord` | `webhookUrl` |
| `slack` | `webhookUrl` |
| `telegram` | `botToken`, `chatId` |
| `email` | `host`, `port` (default `587`), `user`, `password`, `from`, `to` (comma-separated for multiple recipients) |
| `ntfy` | `url`, `topic` - optional: `token` |
| `pushover` | `token`, `user` |
| `webhook` | `url` - optional: `secret` (sent as `X-Pingflare-Secret` header) |
| `apprise` | `url` (Apprise API base URL), `urls` (notification service URLs) - optional: `token` |
| `googlechat` | `webhookUrl` |
| `msteams` | `webhookUrl` |
| `matrix` | `homeserverUrl`, `accessToken`, `roomId` |
| `pagerduty` | `routingKey` |
| `twilio` | `accountSid`, `authToken`, `fromNumber`, `toNumber` |

---

## Monitor

### Fields

| Field | Default | Description |
|---|---|---|
| `name` | - | Display name |
| `type` | - | `http`, `heartbeat`, `agent`, `dns`, or `ping` |
| `tags` | `[]` | Searchable labels |
| `interval` | `60` | Check interval in seconds |
| `active` | `true` | Whether the monitor is enabled |
| `toleranceFailures` | `1` | Consecutive failures before alerting |
| `reminderIntervalHours` | null | Hours between reminder alerts while down |
| `surgeProtectionLimit` | null | Max alerts before pausing for 1 hour |

### HTTP-specific

| Field | Default | Description |
|---|---|---|
| `url` | - | Target URL |
| `method` | `GET` | HTTP method |
| `expectedStatus` | `200` | Expected HTTP status code |
| `timeout` | `30` | Request timeout in seconds |
| `followRedirects` | `true` | Follow HTTP redirects |
| `ipVersion` | `auto` | Stored address-family preference; Worker checks currently use platform DNS resolution |
| `authType` | `none` | `none`, `basic`, `digest`, or `bearer` |
| `headers` | `{}` | Custom request headers as JSON object |
| `body` | null | Request body for POST/PUT/PATCH |
| `sslCheckEnabled` | `false` | Track the latest HTTPS certificate/TLS failure state |
| `cacheBooster` | `false` | Add a random `pingflare` query value to bypass origin/intermediary caches |
| `jsonPath` | null | Optional JSONPath assertion |
| `expectedValue` | null | Optional expected value for the first JSONPath match |

### Heartbeat-specific

| Field | Default | Description |
|---|---|---|
| `heartbeatInterval` | - | Expected interval between pings in seconds |
| `heartbeatGrace` | `30` | Grace period after deadline before marking down |
| `toleranceMissed` | `1` | Consecutive missed heartbeats before alerting |

Agent monitors use the heartbeat fields above and add optional `cpuThreshold`, `ramThreshold`, and `diskThreshold` percentages.

### DNS-specific

| Field | Default | Description |
|---|---|---|
| `dnsHostname` | - | Hostname to resolve |
| `dnsRecordType` | `A` | DNS record type |
| `dnsResolverUrl` | provider default | DNS-over-HTTPS resolver |
| `dnsExpectedIp` | null | Optional exact expected answer |

### Ping-specific

Ping monitors use `url` as the target and treat any HTTP response as reachable.
They are Worker-compatible HTTP/TCP reachability checks, not ICMP echo. A
narrow HTTP protocol-decoding failure is treated as evidence that the
requested port accepted a connection; opaque fetch, DNS, timeout, and TLS
failures remain down.

## Backup

| Method | Path | Description |
|---|---|---|
| GET | `/api/backup` | Export a versioned configuration backup |
| POST | `/api/backup/restore` | Validate, preflight the D1 indexed-write budget, and atomically restore a backup |

Backup version 3 includes settings, monitors, notification channels, status
pages, their relationships, and maintenance windows. It excludes uptime
history, diagnostic logs, detected incidents, delivery state, and agent metric
samples. Restore accepts at most 512 KB and 5,000 records, regenerates
heartbeat/agent tokens, and resets restored monitors to `pending`.
