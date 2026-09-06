# Local Development

## 1. Dependencies

Use Node.js 22, matching CI and Docker (`nvm use` reads `.nvmrc`). If you
change Node versions after installation, run `npm rebuild better-sqlite3`
or reinstall dependencies before running the backend tests.

```bash
npm ci
```

## 2. Secrets

```bash
cp .dev.vars.example .dev.vars
```

Use local-only values. `JWT_SECRET` and `ENCRYPTION_KEY` must be different,
long random strings.

## 3. Apply database migrations

```bash
npm run db:migrate:local
```

This applies the same schema used in production, including exact daily
rollups, the durable notification outbox, and 30-day agent resource samples.

## 4. Start

```bash
npm run dev
```

Starts backend (port 8787), frontend (port 5173) and cron simulator together.

Or start each individually:

```bash
npm run dev:backend
npm run dev:frontend
npm run dev:cron
```

### Cron simulator

`dev:cron` hits `http://localhost:8787/__scheduled?cron=*+*+*+*+*` every 60 seconds, replicating the `* * * * *` trigger from `wrangler.toml`.

To trigger the cron manually:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

## 5. Validate

```bash
npm run typecheck
npm test
npm run build
npx wrangler deploy --dry-run
```

The Worker frontend is served from `frontend/build`. API and heartbeat routes
run Worker-first under `/api/*` and `/h/*`; all other paths use the static
single-page application.

## Optional SQLite server

To exercise the Docker/VPS runtime without Wrangler:

```bash
npm run dev:node
```

This uses the SQLite-backed Node server. Analytics Engine and Cloudflare Cache
API are not available in this mode; the application uses its documented local
fallbacks. The dashboard and authenticated APIs, including the Infrastructure
overview, use the same route set as the Worker runtime.
