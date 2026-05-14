# Checkmate vs. Pingflare on Cloudflare Infrastructure

This document analyzes the features of [Checkmate](https://github.com/bluewave-labs/checkmate) and compares them against Pingflare, with a specific focus on what can be implemented using Cloudflare's infrastructure (both within the Free Tier limits and beyond).

---

## 1. Feature Comparison & Cloudflare Feasibility

### HTTP & HTTPS Uptime Monitoring
* **Checkmate:** Yes
* **Pingflare:** Yes
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**. Workers `fetch()` API easily handles this.

### Heartbeat (Cron/Passive) Monitoring
* **Checkmate:** Agent-based (Capture)
* **Pingflare:** Yes (via webhooks)
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**. Endpoints handle incoming pings.

### SSL Certificate Monitoring
* **Checkmate:** Yes
* **Pingflare:** Yes (basic status)
* **Cloudflare Feasibility:** **Supported (Free Tier)**. However, Cloudflare's `fetch()` does not expose raw TLS certificate details (like expiry date) natively. Deep certificate inspection requires raw TCP connections (Workers TCP sockets), which is available but adds complexity.

### Ping (ICMP) Monitoring
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:** **Not Supported**. Cloudflare Workers do not support raw ICMP sockets. This cannot be implemented on Cloudflare infrastructure directly. It would require an external proxy or agent.

### Port (TCP/UDP) Monitoring
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:**
  * **TCP:** **Supported (Free Tier)** via `connect()` API (Workers TCP sockets). Can check if a port is open.
  * **UDP:** **Not Supported**. Workers currently do not support outbound UDP sockets.

### Game Server Monitoring
* **Checkmate:** Yes (often UDP-based like Source Engine Query)
* **Pingflare:** No
* **Cloudflare Feasibility:** **Partially Supported**. If the game server uses TCP, it can be checked. If it relies on UDP (which most do), it is **Not Supported** natively on Workers.

### Page Speed Monitoring
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:** **Supported (Free Tier)**. Can be implemented by measuring the `fetch()` response time. For deeper metrics (like Lighthouse scores), it's **Not Supported** as Workers cannot run headless browsers (Puppeteer/Playwright).

### Infrastructure Monitoring (CPU, RAM, Disk)
* **Checkmate:** Yes (via Capture agent)
* **Pingflare:** No
* **Cloudflare Feasibility:** **Supported (Free Tier)**. This is identical to Heartbeat monitoring. A lightweight agent (like Capture or a custom script) running on the target server can send JSON payloads to a Pingflare Worker endpoint. The Worker can then store this in D1.

### Docker Monitoring
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:** **Supported (Free Tier)**. Similar to infrastructure monitoring, an agent on the server can query the local Docker socket and push the status to a Pingflare endpoint.

### JSON Query Monitoring
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**. Pingflare can fetch a JSON endpoint and use simple JSONPath or similar logic to evaluate the response.

### Scheduled Maintenance
* **Checkmate:** Yes
* **Pingflare:** No
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**. This is purely a database/logic feature. Can easily store maintenance windows in D1 and suppress alerts during those times.

### Status Pages & Incidents
* **Checkmate:** Yes (Multiple themes)
* **Pingflare:** Yes
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**.

---

## 2. Notification Channels

### Existing in Pingflare
Discord, Slack, Telegram, Email, Ntfy, Pushover, Webhook, Apprise, Google Chat.

### Additional in Checkmate
* **PagerDuty, Matrix, Microsoft Teams, Twilio (SMS)**
* **Cloudflare Feasibility:** **Fully Supported (Free Tier)**. All of these operate via standard HTTP APIs and can be easily implemented using Workers `fetch()`.

---

## 3. Deep Dive: Implementation Priorities & Constraints

If the goal is to build an uptime monitoring system **completely on Cloudflare infrastructure** (staying within the Free Tier limits of 100k requests/day and 100k D1 write rows/day), here is the prioritized list of Checkmate features that can be added to Pingflare:

### High Priority & Easy Wins (Pure Logic/HTTP)
1. **JSON Query Monitoring:** Simple to add. Add a `json_path` and `expected_value` to the `monitors` table.
2. **Scheduled Maintenance:** Add a `maintenance_windows` table. Before sending an alert or logging downtime, check if the current timestamp falls within a window.
3. **New Notification Channels:** Add integrations for MS Teams, Matrix, PagerDuty, and Twilio. Just requires adding the config schema and HTTP request logic.

### Medium Priority (Requires Workers TCP)
4. **TCP Port Monitoring:** Use `import { connect } from 'cloudflare:sockets'`.
   * *Constraint:* Connecting and disconnecting quickly is feasible, but extensive data reading might incur CPU time. Easily fits in Free Tier.
5. **Advanced SSL Expiry Monitoring:** Since `fetch()` hides certificate details, fetching raw cert data requires TLS over TCP sockets.

### Hard / Architectural Additions
6. **Infrastructure & Docker Monitoring (Agent-based):**
   * *Implementation:* Create an endpoint `POST /api/agent/push`. Users run a bash/python script on their VPS via cron that sends CPU/RAM/Docker status.
   * *Constraint (D1 Limits):* If users send metrics every minute, 1 monitor = 1440 writes/day. The free tier allows 100k writes/day. Thus, the free tier limits you to ~69 active infrastructure monitors checking every minute. To scale, metrics should either be aggregated or old logs cleaned aggressively.

### Out of Scope (Cloudflare Restrictions)
* **ICMP Ping Monitoring:** Impossible without an external server.
* **UDP Game Server Monitoring:** Impossible without an external server.
* **Headless Browser Page Speed:** Impossible on Workers.

## Summary

The vast majority of Checkmate's features can be ported to Pingflare using Cloudflare Workers and D1. The primary exceptions are low-level network protocols (ICMP, UDP) which are fundamentally incompatible with the Cloudflare Workers execution environment.
