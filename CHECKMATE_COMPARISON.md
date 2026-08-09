# Checkmate comparison

This is a current product comparison, not an implementation backlog. Checkmate
claims were verified against its
[official repository](https://github.com/bluewave-labs/checkmate) on
2026-08-09; upstream capabilities can change. Pingflare claims are derived from
this repository and the [current feature reference](docs/FEATURES.md).

## Product and deployment model

| Area | Checkmate | Pingflare |
|---|---|---|
| Primary deployment | Self-hosted application with MongoDB | Cloudflare Workers with D1, or Docker/VPS with SQLite |
| License | AGPL-3.0 | MIT |
| External monitoring | Uptime, ping, SSL, port, game-server, and page-speed monitors | HTTP, DNS, Worker-compatible port reachability, SSL state, heartbeats, and agents |
| Infrastructure agent | Capture; CPU, RAM, disk, temperature, network, and selective mount points | Lightweight Linux shell agent; CPU, RAM, root disk, freshness, thresholds, and optional Docker state |
| Public communication | Incidents and four status-page themes | Draft/published incident reports and branded, themed, optionally protected status pages |
| Languages | Broad multilingual catalog | English and Brazilian Portuguese |

The products optimize for different operating envelopes. Checkmate is a larger
server application with native network and agent capabilities. Pingflare keeps
authoritative state and history within an explicitly budgeted Cloudflare
Free-plan architecture, while retaining a Docker/SQLite runtime.

## Capability detail

| Capability | Checkmate | Pingflare | Pingflare / Cloudflare note |
|---|---:|---:|---|
| HTTP/HTTPS uptime | Yes | Yes | HTTP methods, auth, headers/body, redirects, status, and bounded response reads |
| JSON response query | Yes | Yes | JSONPath presence or expected-value assertions |
| DNS monitoring | — | Yes | DNS-over-HTTPS for A, AAAA, CNAME, MX, NS, and TXT |
| Push heartbeat | — | Yes | Tokenized GET/POST pushes with interval, grace, and missed-push tolerance |
| Native ICMP ping | Yes | No | Workers do not expose raw ICMP sockets |
| Native TCP/UDP port monitor | Yes | No | Pingflare uses an HTTP `HEAD` reachability strategy; it is not a general raw-socket probe |
| Game-server query | Yes | No | Protocol-specific TCP/UDP queries are outside the current product |
| Page-speed/browser metrics | Yes | No | Response time is measured, but Pingflare does not run a browser or Lighthouse |
| SSL state | Yes | Yes | Pingflare records HTTPS/TLS success or failure, not certificate metadata such as expiry |
| Infrastructure health | Yes | Yes | Pingflare reports each minute and stores bounded five-minute CPU/RAM/disk samples for 30 days |
| Optional Docker health | Yes | Yes | Pingflare does not require Docker and does not collect per-container resource metrics |
| Scheduled maintenance | Yes | Yes | Pingflare suppresses alert transitions during configured windows |
| Status pages and incidents | Yes | Yes | Pingflare separates detected downtime evidence from publishable incident reports |

`—` means the cited Checkmate feature list does not make a comparable claim; it
does not assert that the feature is absent.

## Notification providers

Both products document email, generic webhooks, Discord, Slack, Telegram,
Pushover, PagerDuty, Matrix, Microsoft Teams, and Twilio. Pingflare additionally
supports ntfy, Apprise, and Google Chat.

Pingflare writes alert delivery to a deduplicated D1/SQLite outbox before
provider I/O. Provider failures do not roll back monitor or incident state, and
incomplete fan-out is retried by later requests or scheduler runs.

## Deliberate Pingflare constraints

- No ICMP or UDP monitoring from Cloudflare Workers
- No browser-based page-speed testing
- No game-server protocol adapters
- No host log aggregation or arbitrary log retention
- No per-container CPU, RAM, disk, or network metrics
- Two interface locales rather than Checkmate's broader catalog
- Cloudflare Free-plan scheduling, request, query, write, and public-read safety
  budgets documented in the [README](README.md)

These are current product boundaries, not promises or priorities. Any future
work should be evaluated against Pingflare's reliability model and both runtime
targets rather than copied from this comparison.
