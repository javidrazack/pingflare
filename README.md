# Pingflare 🔥

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![SvelteKit](https://img.shields.io/badge/SvelteKit-2.x-FF3E00?logo=svelte&logoColor=white)](https://kit.svelte.dev/)
[![D1 Database](https://img.shields.io/badge/Cloudflare-D1-F38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/d1/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

https://github.com/user-attachments/assets/c33e20fd-6a82-4e57-b95a-ec06bbf701f5

HTTP, DNS, ping, heartbeat, and lightweight infrastructure-agent monitoring. Runs on the **Cloudflare free tier** (Workers + D1) or on **any Docker host** (Fly.io, Railway, VPS) with SQLite.

Sends alerts through Discord, Slack, Telegram, Email, ntfy, Pushover, generic webhooks, Apprise, Google Chat, Microsoft Teams, Matrix, PagerDuty, and Twilio.

## Highlights

- **Infrastructure monitoring agent** — install a lightweight systemd timer or cron job to monitor CPU, RAM, disk usage, and Docker container health.
- **Five monitor types** — HTTP, DNS over HTTPS, ping/port, heartbeat, and infrastructure agent.
- **Operational controls** — JSONPath response assertions, failure tolerances, scheduled maintenance, reminder alerts, and surge protection.
- **Monitoring dashboard** — searchable and sortable monitor inventory, bulk actions, response-time and uptime charts, and incident management.
- **Custom status pages** — choose monitors, branding, theme, history range, visibility, and published incident updates.
- **Cloudflare or self-hosted** — deploy to Workers + D1 or run the same application with Docker and SQLite.

---

## Deploy

Two deployment modes are supported:

| | Cloudflare Workers | Docker / VPS |
|---|---|---|
| **Database** | Cloudflare D1 | SQLite (local file) |
| **Cron** | Cloudflare Triggers | node-cron (built-in) |
| **Cost** | Free tier | Depends on host |
| **Setup** | CF dashboard or `wrangler deploy` | `docker compose up` |

---

## ☁️ Deploy on Cloudflare Workers

> **Recommended:** Fork this repository to your own GitHub account. This gives you full control over updates, pull upstream changes whenever you want, and Cloudflare deploys automatically from your fork on every push.

> **Quick start:** Use the button below to deploy instantly from the current version of this repository. Note that this won't receive future updates automatically.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/javidrazack/pingflare)

### 1. Create the D1 database

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → **Storage & Database > D1 SQL Database**
2. Click **Create database**, name it `pingflare`, and confirm

### 2. Connect the database to the Worker

The `[[d1_databases]]` section in `wrangler.toml` is the source of truth for the `DB` binding. When adapting this repository to another Cloudflare account, replace `database_id` with the ID shown on that account's `pingflare` D1 database page.

Do not add `DB=pingflare` as a text variable. `DB` must be a **D1 database binding**, not an environment variable.

### 3. Set the required secrets

Open the Worker and go to **Settings > Variables & Secrets** (the runtime section), then add all four values as secrets:

| Variable | Required | Description |
|---|---|---|
| `ADMIN_USER` | Yes | Username |
| `ADMIN_PASS` | Yes | Password |
| `JWT_SECRET` | Yes | Secret used to sign JWT tokens, min 32 characters |
| `ENCRYPTION_KEY` | Yes | Key used to encrypt notification credentials at rest. Min 32 characters. |

> Do not put these under **Settings > Build > Variables and secrets**. Build values only exist while the repository is being compiled; the running Worker cannot read them.

### 4. Redeploy

Apply migrations, then redeploy:

```bash
npm run db:migrate:remote
npm run deploy
```

For a Git-connected Worker, run the migration once from a Wrangler-authenticated checkout and then use **Deployments > Retry deploy** (or push a commit). The Worker also performs a compatibility schema check on requests.

Your dashboard will be live at `https://pingflare.<your-subdomain>.workers.dev`.

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

---

## Cloudflare Free Tier Limits

When running on Cloudflare Workers, Pingflare is designed to stay within free tier limits:

- Workers: 100,000 requests per day
- D1: 100,000 write rows per day, 5 million read rows per day
- Cron Triggers: minimum 1-minute interval

With the default 90-day log retention and automatic cleanup on each cron run, write usage stays bounded proportional to the number of active monitors.

> When running in Docker mode, there are no such limits — SQLite has no row quotas and the cron runs on the same Node.js process.
