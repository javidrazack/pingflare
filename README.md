# Pingflare 🔥

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-6.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-2.x-FF3E00?logo=svelte&logoColor=white)](https://kit.svelte.dev/)
[![D1 Database](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Analytics Engine](https://img.shields.io/badge/Cloudflare-Analytics%20Engine-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/analytics/analytics-engine/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

https://github.com/user-attachments/assets/c33e20fd-6a82-4e57-b95a-ec06bbf701f5

Pingflare is a self-hosted uptime and infrastructure monitor for HTTP, DNS, TCP ports, push heartbeats, and Linux servers. Docker discovery is optional: ordinary servers can report CPU, RAM, and disk health without running containers. Pingflare runs on Cloudflare Workers with D1, Analytics Engine, and Cache API, or on a Docker host with SQLite.

Alerts are supported through Discord, Slack, Telegram, Email, ntfy, Pushover, generic webhooks, Apprise, Google Chat, Microsoft Teams, Matrix, PagerDuty, and Twilio.

## What is included

| Area | Current functionality |
|---|---|
| External monitoring | HTTP methods, expected status, redirects, request headers/body, basic/digest/bearer auth, JSONPath assertions, SSL state, DNS-over-HTTPS, and Worker-compatible port reachability |
| Push monitoring | Tokenized heartbeats for jobs and services, plus a lightweight Linux agent for CPU, RAM, disk, freshness, thresholds, and optional Docker health |
| Investigation | Exact uptime and response-time history, sparse diagnostic logs, detected downtime incidents, and lazy-loaded 2-hour to 30-day agent resource charts |
| Operations | Search, filters, pagination, bulk pause/resume/delete, manual check runs, maintenance windows, failure tolerances, reminders, and surge protection |
| Communication | Thirteen notification providers, durable deduplicated delivery, draft/published incident reports, and branded or password-protected public status pages |
| Administration | Encrypted credentials, localized dashboard, versioned configuration backup/restore, configurable diagnostic retention, and Free-plan safety budgets |

For a feature-by-feature description of the dashboard, monitor types, history,
alerts, status pages, and platform differences, see the
[current feature reference](docs/FEATURES.md).

## Architecture at a glance

D1 or SQLite is the source of truth for scheduling, current state, counters, incidents, and alert delivery. Analytics Engine is a best-effort telemetry sink; losing it cannot stop monitoring. Cache API stores only immutable completed-day aggregates. Current status, today/yesterday history, recent logs, and active incidents are always read live.

The Worker admits checks against a fixed 50-query D1 budget, persists operational truth before provider I/O, and retries incomplete notifications from a durable outbox. Public status traffic is rate-limited before D1 and then charged to an account-wide daily read reservation.

See the validated [data-flow diagram and detailed architecture](docs/ARCHITECTURE.md), plus the [Analytics Engine notes](docs/ANALYTICS.md).

## Capacity on the Cloudflare Free plan

The figures below were verified on **August 9, 2026**. Cloudflare can change plan limits, so its linked documentation is the source of truth.

| Service | Included Free-plan capacity relevant to Pingflare |
|---|---|
| [Workers](https://developers.cloudflare.com/workers/platform/limits/) | 100,000 requests/day, 10 ms CPU per invocation, 50 external subrequests per invocation, 6 simultaneous outgoing connections |
| [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) and [limits](https://developers.cloudflare.com/d1/platform/limits/) | 5 million rows read/day, 100,000 rows written/day, 500 MB/database, 5 GB/account, 10 databases/account, 50 queries per Worker invocation |
| [Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/) and [limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/) | 100,000 data points written/day, 10,000 read queries/day, three-month retention |
| Cron Triggers | One-minute minimum interval |

### Scheduled HTTP, DNS, and port checks

The scheduler is deliberately D1-bound so a transition-heavy outage cannot exceed the per-invocation query limit. On a fully upgraded installation it admits up to two healthy steady-state checks per minute. During a five-minute legacy catch-up batch, or when sizing for worst-case transitions without any backlog, use one check per minute.

```text
normal theoretical load:       sum(60 / interval_seconds) <= 2
conservative guaranteed load:  sum(60 / interval_seconds) <= 1
```

| Check interval | Normal theoretical maximum | Conservative maximum |
|---|---:|---:|
| 1 minute | 2 monitors | 1 monitor |
| 5 minutes | 10 monitors | 5 monitors |
| 15 minutes | 30 monitors | 15 monitors |
| 1 hour | 120 monitors | 60 monitors |
| 24 hours | 2,880 monitors | 1,440 monitors |

These are admission-rate estimates, not a promise that thousands of checks aligned to the same second will finish on time. Spread due times, include every active monitor in the formula, and use the conservative column when punctual checks during outages matter. Monitor intervals are constrained to 60–86,400 seconds.

### Heartbeats and infrastructure agents

Healthy heartbeat and agent pushes arrive through their own Worker requests, so they do not consume normal external-check admission slots. Each push still writes authoritative D1 state and counters, sparse evidence when due, alert state when needed, and one Analytics Engine point.

- The supplied infrastructure agent reports **once per minute**.
- CPU, RAM, and disk history is sampled every five minutes and kept for 30 days. It is loaded only from an agent monitor's Performance tab.
- Start with **up to 10 healthy one-minute push sources per installation** as a Free-plan planning target, then watch D1 row-write and Worker-request usage. This is operational headroom, not a hard product limit.
- If every push source stops together, missed-push evaluation returns to the same scheduler. For strict one-minute failure detection, count scheduled monitors, heartbeat monitors, and agents together under the two-check/minute normal budget—or the one-check/minute conservative budget.
- **10-second reporting is not supported** by the current product or Cloudflare Cron. One 10-second source alone would generate 8,640 Worker requests and 8,640 Analytics Engine points per day before D1 and UI traffic, leaving little Free-plan safety margin as sources are added.

At two scheduled observations per minute, check telemetry is about 2,880 Analytics Engine points/day. Ten healthy one-minute push sources add about 14,400 points/day. API telemetry samples 5% of successful requests and records all error responses, leaving substantial Analytics Engine headroom under ordinary use.

### Application safety limits

These controls protect reliability even before the Cloudflare account quotas are reached:

| Control | Current value |
|---|---:|
| Public status-page monitors | 180/page |
| Public requests | 4/visitor + page/minute/location |
| Login attempts | 5/minute/location |
| Reserved public D1 reads | 4 million rows/day |
| Reads preserved for monitoring and authenticated use | At least 1 million rows/day |
| Incident feed result | 20 reports, 20 updates/report |
| Historical incident links before explicit archive error | 20,000/page |
| Destructive operation or migration preflight | Reject above 40,000 estimated D1 writes |
| Diagnostic retention cleanup | 200 rows/hour |
| Legacy minute-log catch-up | 25 rows/5 minutes |
| Notification-provider attempts | 2/invocation, 12-second deadline each |

Completed historical fragments are cached for 24 hours behind per-monitor revision keys. Resets and restores advance the revision. Cache misses fall back to compact D1 rollups; Cache API never contains current state, so it cannot make a monitor or active incident stale.

Docker removes Cloudflare account quotas, but the current application intentionally keeps the same scheduler admission and safety bounds. Raising them safely requires changing and testing the query/write model; switching to SQLite alone does not remove those application limits.

## Deployment options

| | Cloudflare Workers | Docker / VPS |
|---|---|---|
| Authoritative state | D1 | SQLite file |
| High-resolution telemetry | Analytics Engine | Not exported |
| Historical aggregate cache | Cache API | Bounded process-local cache |
| Scheduler | Cloudflare Cron Trigger | Built-in `node-cron` |
| Cost | Designed for the Free plan | Depends on the host |
| Setup | Deploy button or `npm run deploy` | `docker compose up` |

### Cloudflare Workers

Before the first deployment, open **Workers & Pages → Analytics Engine** in the Cloudflare dashboard and select **Enable Analytics Engine**. Cloudflare otherwise rejects Workers containing Analytics Engine bindings with error `10089`.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/javidrazack/pingflare)

The deploy flow reads `wrangler.toml`, provisions the `DB` D1 binding, builds the UI, applies D1 migrations, and deploys the Worker. The two Analytics Engine datasets and rate-limit namespaces declared in `wrangler.toml` are bound automatically. Cache API needs no separate resource or binding.

Provide these runtime secrets:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | Yes | Dashboard username |
| `ADMIN_PASS` | Yes | Dashboard password |
| `JWT_SECRET` | Yes | JWT signing secret, minimum 32 characters |
| `ENCRYPTION_KEY` | Yes | Notification-credential encryption key, minimum 32 characters |

Generate different values for `JWT_SECRET` and `ENCRYPTION_KEY`, for example with `openssl rand -hex 32`. Store them as runtime secrets, not only as build variables.

For a manual first deployment:

```bash
npm ci
npx wrangler login
npm run deploy
```

Create a D1 database named `pingflare` first and put its ID in `wrangler.toml`. `npm run deploy` builds the application, reconciles a complete legacy v1.6 migration ledger when necessary, preflights pending migration/index work, applies migrations through the `DB` binding, and deploys only after success.

Existing installations apply migrations `0005`–`0012`, which add compact rollups, indexed scheduling, the durable notification outbox, single-open-incident enforcement, the public-read budget, bounded incident access paths, 30-day agent resource history, session revocation, bounded delivery receipts, and scheduler completion metadata. Existing administrator sessions require sign-in after migration 0012. See [operational controls](docs/OPERATIONS.md). A partial legacy schema or a migration estimate above 40,000 writes stops without mutation.

> Existing Workers Builds projects must use `npm run deploy`. A saved `npx wrangler deploy` command bypasses D1 migrations and is unsafe for schema-dependent upgrades.

Static frontend assets bypass Worker code; `/api/*` and `/h/*` are Worker-first. A custom domain generally improves completed-history cache hit rate because Cache API entries are data-center-local.

### Docker

```bash
curl -O https://raw.githubusercontent.com/javidrazack/pingflare/main/compose.yml

# Fill in ADMIN_USER, ADMIN_PASS, JWT_SECRET, and ENCRYPTION_KEY
docker compose up -d
```

Open `http://localhost:3000` and mount a persistent volume at `/data`.

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_USER` | Yes | — | Dashboard username |
| `ADMIN_PASS` | Yes | — | Dashboard password |
| `JWT_SECRET` | Yes | — | JWT signing key, minimum 32 characters |
| `ENCRYPTION_KEY` | Yes | — | AES-GCM credential-encryption key, minimum 32 characters |
| `PINGFLARE_INSTANCE_ID` | No | `docker` | Telemetry instance label |
| `API_ANALYTICS_SAMPLE_RATE` | No | `0` | Retained for parity; Docker has no Analytics Engine binding |

### Fly.io

```bash
fly launch --name pingflare
fly volumes create pingflare_data --size 1 --region iad

fly secrets set \
  ADMIN_USER=admin \
  ADMIN_PASS=your-password \
  JWT_SECRET=your-jwt-secret-min-32-chars \
  ENCRYPTION_KEY=your-encryption-key-min-32-chars

fly deploy
```

## Infrastructure agent

Create an **Agent / Infra** monitor in the dashboard, then run the generated command as a sudo-capable user:

```bash
curl -fsSL https://your-pingflare.example/api/agent/install/YOUR_TOKEN | sudo bash
```

The installer sends and verifies an initial heartbeat, then configures a one-minute systemd timer or root-crontab fallback. The URL and installed script contain the agent token; treat them as credentials. See the [agent guide](docs/AGENT.md) for requirements and behavior.

The **Infrastructure** page shows node health, resource pressure, telemetry
freshness, and at most five priority issues with the exact strongest signal for
each node. It does not require containers;
Docker details appear only on an individual monitor when a host actually
reports them. CPU, RAM, and disk history is loaded only when the monitor's
**Performance** tab is opened.

## Development and validation

```bash
npm ci
npm run typecheck
npm test
npm run build
```

For local setup and platform-specific commands, see [local development](docs/LOCAL_DEVELOPMENT.md).

## Documentation

- [Architecture and data flow](docs/ARCHITECTURE.md)
- [Current features and product behavior](docs/FEATURES.md)
- [Analytics Engine](docs/ANALYTICS.md)
- [Infrastructure agent](docs/AGENT.md)
- [API](docs/API.md)
- [Local development](docs/LOCAL_DEVELOPMENT.md)
- [Locales](docs/LOCALES.md)

## License

[MIT](LICENSE)
