# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

The primary user today is a self-hoster operating and monitoring their own services and infrastructure. They need to know whether services are reachable, whether hosts are healthy, what changed, and whether an incident requires action.

Pingflare is intended to be published for broader use by other self-hosters. Small infrastructure or SRE teams are not yet confirmed as a co-primary audience.

## Product Purpose

Pingflare provides self-hosted uptime and infrastructure monitoring for external services, scheduled jobs, and Linux servers. It combines current operational status, historical evidence, incident investigation, alert delivery, and public status communication in one deployable product.

Success means a self-hoster can run Pingflare within their chosen environment, trust the operational state it reports, detect failures promptly, investigate what happened, and notify the appropriate people or systems without depending on a hosted monitoring vendor.

## Positioning

Pingflare is serious uptime and infrastructure monitoring that remains self-hostable and viable within Cloudflare Free-plan constraints. It can run on Cloudflare Workers with D1, Analytics Engine, and Cache API, or on a Docker host with SQLite, while retaining the same core operational model.

Its differentiating mechanism is the combination of external checks, push heartbeats, lightweight Linux infrastructure reporting, incident workflows, notification delivery, and public status pages within an explicitly budgeted self-hosted architecture.

## Operating Context

Users deploy and administer their own Pingflare instance. They authenticate into a web dashboard, configure monitors and notification channels, review current status and historical evidence, run checks manually when needed, investigate detected downtime, publish incident updates, and maintain public status pages.

Monitoring sources include HTTP endpoints, DNS, TCP ports, push heartbeats, and a lightweight Linux agent for CPU, RAM, disk, freshness, thresholds, and optional Docker health. Scheduled checks, heartbeat evaluation, notifications, and maintenance behavior continue independently of whether the dashboard is open.

Deployment and maintenance happen through Cloudflare Workers tooling or Docker/VPS workflows. Configuration backup and restore, migrations, encrypted credentials, localization, retention settings, and platform safety budgets are factual parts of operating the product.

## Capabilities and Constraints

- External monitoring supports HTTP behavior and assertions, DNS-over-HTTPS, TCP reachability, SSL state, authentication, headers, bodies, redirects, and JSONPath assertions.
- Push monitoring supports tokenized job and service heartbeats plus Linux infrastructure agents.
- Investigation includes uptime and response-time history, diagnostic logs, detected incidents, and bounded agent resource history.
- Operations include search, filters, pagination, bulk pause/resume/delete, manual runs, maintenance windows, failure tolerances, reminders, and surge protection.
- Communication includes multiple notification providers, deduplicated delivery, incident reports, and branded or password-protected public status pages.
- Authoritative operational state lives in D1 on Cloudflare or SQLite on Docker. Analytics Engine is best-effort telemetry and must not become a dependency for monitoring correctness.
- Cloudflare deployments must respect documented request, query, write, connection, scheduling, retention, and public-read safety budgets. Current numeric limits and planning guidance live in the root `README.md` and architecture documentation rather than being duplicated here.
- Current scheduled-monitor intervals are constrained to 60–86,400 seconds. Ten-second reporting is not a supported product promise.
- Docker removes Cloudflare account quotas but does not automatically remove Pingflare's application-level scheduler and safety bounds.
- The authenticated product is currently designed around a single self-hosted administrator. Broader multi-user or team roles are an open product decision.

## Brand Commitments

- The product name is **Pingflare**.
- The Pingflare logo assets under `static/` are committed product assets.
- Product language should be operationally precise and should not make the interface appear more certain, current, or reliable than the underlying data.
- The product is self-hosted and MIT-licensed; future work must not imply a hosted commercial service unless that product direction is explicitly introduced.
- English and Brazilian Portuguese are currently supported interface locales.

## Evidence on Hand

- The root `README.md` contains the confirmed product description, deployment model, operational limits, and current capability summary.
- `docs/FEATURES.md` documents current product behavior across monitoring, history, alerts, status pages, and platform differences.
- `docs/ARCHITECTURE.md` documents the validated data flow and reliability model.
- `docs/ANALYTICS.md`, `docs/API.md`, `docs/AGENT.md`, `docs/LOCALES.md`, and `docs/LOCAL_DEVELOPMENT.md` provide supporting technical and operating evidence.
- The implemented frontend routes, API types, locale files, and logo assets under `static/` provide working product and brand evidence.
- The repository contains a linked product demonstration asset in the root `README.md`.
- No testimonials, customer logos, adoption metrics, case studies, press coverage, pricing, or commercial-service claims are confirmed. Future work must not fabricate them.

## Product Principles

1. **Operational truth before reassurance.** Clearly distinguish healthy, empty, stale, loading, degraded, and failed states; never infer absence from unavailable data.
2. **Self-hosting without toy-level tradeoffs.** Preserve serious monitoring, investigation, incident, and notification capabilities while keeping ownership with the operator.
3. **Budgets are product behavior.** Cloudflare Free-plan and application safety limits must be visible, honest constraints rather than hidden implementation details.
4. **Monitoring continues without the dashboard.** The interface explains and controls the system, but correctness cannot depend on an open browser session.
5. **Evidence over claims.** Use implemented behavior and documented limits as proof; do not invent reliability, adoption, or commercial claims.

## Accessibility & Inclusion

The interface implements keyboard, focus, contrast, reduced-motion, and
responsive accessibility practices where documented in `DESIGN.md`. No formal
WCAG conformance audit has been completed, so future work must not claim a
conformance level without evidence.
