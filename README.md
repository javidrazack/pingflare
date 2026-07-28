# Pingflare 🔥

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-2.x-FF3E00?logo=svelte&logoColor=white)](https://kit.svelte.dev/)
[![D1 Database](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![Analytics Engine](https://img.shields.io/badge/Cloudflare-Analytics%20Engine-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/analytics/analytics-engine/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

https://github.com/user-attachments/assets/c33e20fd-6a82-4e57-b95a-ec06bbf701f5

HTTP, DNS, ping, heartbeat, and lightweight infrastructure-agent monitoring. Runs on the **Cloudflare free tier** with Workers, D1, Analytics Engine, and Cache, or on **any Docker host** with SQLite.

Sends alerts through Discord, Slack, Telegram, Email, ntfy, Pushover, generic webhooks, Apprise, Google Chat, Microsoft Teams, Matrix, PagerDuty, and Twilio.

## Highlights

- **Infrastructure monitoring agent** — install a lightweight systemd timer or cron job to monitor CPU, RAM, disk usage, and Docker container health.
- **Five monitor types** — HTTP, DNS over HTTPS, ping/port, heartbeat, and infrastructure agent.
- **Operational controls** — JSONPath response assertions, failure tolerances, scheduled maintenance, reminder alerts, and surge protection.
- **Monitoring dashboard** — searchable and sortable monitor inventory, bulk actions, response-time and uptime charts, and incident management.
- **Custom status pages** — choose monitors, branding, theme, history range, visibility, and published incident updates.
- **Fast, exact history** — D1 stores authoritative current state and compact daily rollups; Analytics Engine receives high-resolution telemetry; completed history is cached without ever caching current status.
- **Cloudflare or self-hosted** — deploy to Workers + D1 or run the same application with Docker and SQLite.

---

## Deploy

Two deployment modes are supported:

| | Cloudflare Workers | Docker / VPS |
|---|---|---|
| **Authoritative state** | Cloudflare D1 | SQLite (local file) |
| **Raw telemetry** | Analytics Engine | SQLite daily counters and diagnostics |
| **Aggregate cache** | Cache API, completed days only | Bounded in-process cache |
| **Cron** | Cloudflare Triggers | node-cron (built-in) |
| **Cost** | Designed for the Free plan | Depends on host |
| **Setup** | Deploy button or `npm run deploy` | `docker compose up` |

Current status, scheduling, alerts, incidents, and exact uptime counters always come from D1/SQLite. Analytics Engine and Cache are acceleration and observability layers; monitoring continues if either is unavailable. See [Architecture](docs/ARCHITECTURE.md) and [Analytics Engine](docs/ANALYTICS.md).

---

## ☁️ Deploy on Cloudflare Workers

> **Recommended:** Fork this repository to your own GitHub account. This gives you full control over updates, pull upstream changes whenever you want, and Cloudflare deploys automatically from your fork on every push.

> **Quick start:** Use the button below to deploy the current version. Fork first if you want Git-connected updates under your own account.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/javidrazack/pingflare)

### What the deploy creates

The Deploy to Cloudflare flow reads `wrangler.toml`, provisions the `DB` D1 database, replaces the template database ID, builds the UI, applies all D1 migrations through the `DB` binding, and deploys the Worker.

> **One-time account prerequisite:** before the first deployment, open **Workers & Pages → Analytics Engine** in the Cloudflare dashboard and select **Enable Analytics Engine**. Cloudflare rejects a Worker with Analytics Engine bindings with error `10089` until this account-level feature is enabled.

After enablement, the two Analytics Engine datasets declared in `wrangler.toml` are created automatically and begin receiving points on first use. Cache API needs no separate resource or binding. Static assets bypass Worker code, while `/api/*` and `/h/*` run through the Worker.

During setup, provide these runtime secrets:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | Yes | Username |
| `ADMIN_PASS` | Yes | Password |
| `JWT_SECRET` | Yes | Secret used to sign JWT tokens, min 32 characters |
| `ENCRYPTION_KEY` | Yes | Key used to encrypt notification credentials at rest. Min 32 characters. |

Generate different values for the last two secrets, for example with `openssl rand -hex 32`. Do not put runtime secrets only under build variables.

### Manual deploy or upgrade

For a manual first deploy, enable Analytics Engine in the Cloudflare dashboard, create a D1 database named `pingflare`, copy its ID into `wrangler.toml`, then run:

```bash
npm ci
npx wrangler login
npm run deploy
```

`npm run deploy` runs the production build, reconciles the v1.6 migration ledger only when every expected v1.6 schema object is already present, applies pending migrations through the `DB` binding, and deploys only after migration success. Existing installations upgrading from v1.6.0 then apply migrations `0005` and `0006`. A partial legacy schema stops deployment without changing the ledger. The Worker never runs schema DDL on an API request.

> **Existing Workers Builds projects:** change the saved deploy command to `npm run deploy` before merging this upgrade. A saved `npx wrangler deploy` command bypasses D1 migrations and must not be used for schema-dependent upgrades.

Your dashboard will be live at `https://pingflare.<your-subdomain>.workers.dev`.

For the strongest aggregate-cache hit rate, attach a custom domain. Cloudflare Cache API entries are data-center-local; Pingflare falls back safely when Cache API is unavailable.

---

## 🐳 Deploy with Docker

```bash
curl -O https://raw.githubusercontent.com/javidrazack/pingflare/main/compose.yml

# Edit the file and fill in ADMIN_USER, ADMIN_PASS, JWT_SECRET, ENCRYPTION_KEY

docker compose up -d
```

Open `http://localhost:3000`.

### Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `ADMIN_USER` | Yes | — | Dashboard username |
| `ADMIN_PASS` | Yes | — | Dashboard password |
| `JWT_SECRET` | Yes | — | JWT signing key, min 32 chars |
| `ENCRYPTION_KEY` | Yes | — | AES-GCM key for notification credentials, min 32 chars |
| `PINGFLARE_INSTANCE_ID` | No | `docker` | Label used in telemetry |
| `API_ANALYTICS_SAMPLE_RATE` | No | `0` | Docker has no Analytics Engine binding; retained for configuration parity |

> Mount a volume at `/data` to persist the database

---

## ✈️ Deploy on Fly.io

```bash
fly launch --name pingflare
fly volumes create pingflare_data --size 1 --region iad

fly secrets set \
  ADMIN_USER=admin \
  ADMIN_PASS=yourpassword \
  JWT_SECRET=your-jwt-secret-min-32-chars \
  ENCRYPTION_KEY=your-enc-key-min-32-chars

fly deploy
```

---

## Docs

- [LOCAL_DEVELOPMENT.md](docs/LOCAL_DEVELOPMENT.md)
- [LOCALES.md](docs/LOCALES.md)
- [API.md](docs/API.md)
- [AGENT.md](docs/AGENT.md)
- [ARCHITECTURE.md](docs/ARCHITECTURE.md)
- [ANALYTICS.md](docs/ANALYTICS.md)

---

## Cloudflare Free Tier Limits

As of July 2026, the relevant included limits are:

- [Workers Free](https://developers.cloudflare.com/workers/platform/limits/): 100,000 requests/day, 10 ms CPU/invocation, 50 subrequests/invocation
- [D1 Free](https://developers.cloudflare.com/d1/platform/pricing/): 5 million rows read/day, 100,000 rows written/day, 5 GB total storage; [50 queries per Worker invocation](https://developers.cloudflare.com/d1/platform/limits/)
- [Analytics Engine Free](https://developers.cloudflare.com/analytics/analytics-engine/pricing/): 100,000 data points/day and 10,000 read queries/day, with [three-month retention](https://developers.cloudflare.com/analytics/analytics-engine/limits/)
- Cron Triggers: minimum one-minute interval

Pingflare admits at most eight routine observations per cron invocation and reduces the batch automatically when alert transitions need more D1 work. For capacity planning, keep:

```text
sum(60 / monitor_interval_seconds) <= 8 checks per minute
```

That is an execution ceiling, not a promise that every workload will fit every Free-plan quota. Leave headroom for API traffic, heartbeat/agent pushes, incidents, and notification work. A conservative target is six checks/minute: about 6 one-minute monitors, 30 five-minute monitors, or 360 hourly monitors. Analytics Engine alone would allow roughly 69 one-minute points before API telemetry, but D1/Worker reliability is the tighter design constraint.

Every check updates one compact D1 counter row and writes one Analytics Engine point. D1 diagnostic logs are sparse: transitions, failures, first checks, and a periodic sample. Dashboard historical polling is five minutes instead of ten seconds, and completed aggregate rows can be served from Cache API.

> When running in Docker mode, there are no such limits — SQLite has no row quotas and the cron runs on the same Node.js process.
