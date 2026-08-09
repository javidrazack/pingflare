# Pingflare Infrastructure Agent

Pingflare provides a simple bash agent for infrastructure servers, inspired by
Checkmate's Capture agent. Docker is optional; hosts without Docker report an
empty container list and the infrastructure dashboard remains node-focused.

## What it monitors

The agent runs every minute and collects:

1. **CPU Usage**: Calculated from the change in `/proc/stat` counters since the previous heartbeat. This represents average CPU utilization over the heartbeat interval; the first run after installation or reboot uses a one-second sample to seed the counters.
2. **RAM Usage**: Calculated from `/proc/meminfo`.
3. **Disk Usage**: Extracted via `df` (checks the root `/` mount).
4. **Docker Containers (optional)**: When Docker is installed and accessible, extracts running, stopped, and unhealthy container states via `docker ps -a` and `jq`.

It pushes these metrics to your Pingflare instance via `POST /api/agent/push/:token`.

The latest CPU, RAM, and disk values appear on the Infrastructure page.
CPU, RAM, and disk history is fetched only when the monitor's Performance tab is opened.
Pingflare keeps one regular five-minute sample plus rare transition samples for
30 days; it does not store per-minute server metrics or host logs.

## Dashboard behavior

The fleet-level **Infrastructure** page is optimized for triage:

- Reporting nodes, resource-pressure count, and stale-telemetry count
- Current CPU, RAM, disk, state, and last-report time for up to 200 agents
- A top-five list of nodes needing attention
- `healthy`, `warning`, `critical`, `stale`, `pending`, and `paused` states

A metric enters the warning state at 80% of its configured threshold and the
critical state after crossing the threshold. Staleness is based on the expected
report interval and grace period, with a minimum three-minute window.
Each node also reports a structured strongest signal: the most urgent resource
threshold, stale cutoff, Docker failure, health-check failure, or lifecycle
state. This is the exact reason displayed in the priority list and fleet table.

Open an individual node for deeper investigation. Its **Performance** tab loads
historical `2h`, `24h`, `7d`, or `30d` CPU/RAM/disk data only on demand. The
short ranges use five-minute buckets; `7d` uses 30-minute buckets; `30d` uses
two-hour buckets. Container details appear on the node overview only when the
agent actually reports containers.

## Reporting cadence and Free-plan sizing

The installed systemd timer or cron entry runs once per minute. The one-second CPU sample mentioned above is only a first-run/reboot fallback used to seed `/proc/stat` counters; it is not a ten-second or one-second reporting mode.

Ten-second reporting is not supported by the current agent. Cloudflare Cron has a one-minute minimum, and a ten-second push source would consume 8,640 Worker requests and Analytics Engine points per day before its D1 writes or any dashboard/API traffic.

For a Cloudflare Free-plan installation, start with up to ten healthy one-minute heartbeat and infrastructure-agent push sources combined, then monitor D1 row writes and Worker requests. Healthy pushes bypass scheduled external-check admission, but missed-push detection does not: if multiple sources stop together, their failure checks share the scheduler's two-check/minute normal budget. If every source must alert within one minute during a simultaneous outage, count all scheduled and push monitors under that shared budget. See [Architecture](ARCHITECTURE.md#capacity-model) for the full model.

The history feature adds 288 regular samples per agent each day. With the
composite primary-key write and the matching bounded retention delete after day
30, budget for about 1,152 additional D1 row writes per agent/day at steady
state, plus rare transition samples. Ten agents therefore add about 11,520
history-related row writes/day, retaining useful investigation data while
leaving headroom inside D1's 100,000-row Free allowance.

## Setup

1. Open your Pingflare dashboard.
2. Click **Create Monitor** and select the **Agent / Infra** tab.
3. Configure optional maximum CPU, RAM, or disk thresholds. If a threshold is breached, a reported container is not running, or a running container is unhealthy, the monitor triggers a downtime incident and alert workflow.
4. Save the monitor.
5. In the monitor details page, you will see an **Agent Installation** command block.
6. Copy the command and paste it into the terminal of a sudo-capable user on the server you wish to monitor:

   ```bash
   curl -fsSL https://your-pingflare.example/api/agent/install/YOUR_TOKEN | sudo bash
   ```

### How it works
The install script will:
- Require root access and stop immediately if any installation step fails.
- Install missing `curl`, `jq`, and scheduler packages through `apt`, `dnf`, `yum`, or `apk`.
- Install the root-only agent at `/opt/pingflare-agent/agent.sh`.
- Immediately send and verify the first heartbeat.
- Prefer a `pingflare-agent.timer` systemd timer, with a root crontab fallback when systemd is unavailable.

The agent keeps only its last CPU counters in `/run/pingflare-agent/cpu.state`. This state is a small, root-only file stored in memory-backed runtime storage and is cleared on reboot. Missing, stale, corrupt, or rolled-back counters automatically fall back to a one-second sample. A non-blocking execution lock prevents overlapping cron runs from racing or sending snapshots out of order.

The generated installation URL contains the agent token. Treat the URL and installed script as credentials and do not publish them.

## Log aggregation

The agent does not collect or store host logs. Pingflare is designed to remain
within Cloudflare Free-plan limits, and high-volume logs would consume D1's
daily write allowance quickly. The agent intentionally sends only bounded
periodic health snapshots.
