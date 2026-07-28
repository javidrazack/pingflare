# Pingflare Infrastructure Agent

Pingflare provides a simple, zero-hassle bash script agent to monitor your infrastructure servers and Docker containers, akin to Checkmate's Capture agent.

## What it Monitors
The agent runs every minute and collects:
1. **CPU Usage**: Calculated from the change in `/proc/stat` counters since the previous heartbeat. This represents average CPU utilization over the heartbeat interval; the first run after installation or reboot uses a one-second sample to seed the counters.
2. **RAM Usage**: Calculated from `/proc/meminfo`.
3. **Disk Usage**: Extracted via `df` (checks the root `/` mount).
4. **Docker Containers**: Extracts running and stopped container statuses via `docker ps -a` and `jq`.

It pushes these metrics to your Pingflare instance via `POST /api/agent/push/:token`.

## Reporting cadence and Free-plan sizing

The installed systemd timer or cron entry runs once per minute. The one-second CPU sample mentioned above is only a first-run/reboot fallback used to seed `/proc/stat` counters; it is not a ten-second or one-second reporting mode.

Ten-second reporting is not supported by the current agent. Cloudflare Cron has a one-minute minimum, and a ten-second push source would consume 8,640 Worker requests and Analytics Engine points per day before its D1 writes or any dashboard/API traffic.

For a Cloudflare Free-plan installation, start with up to ten healthy one-minute heartbeat and infrastructure-agent push sources combined, then monitor D1 row writes and Worker requests. Healthy pushes bypass scheduled external-check admission, but missed-push detection does not: if multiple sources stop together, their failure checks share the scheduler's two-check/minute normal budget. If every source must alert within one minute during a simultaneous outage, count all scheduled and push monitors under that shared budget. See [Architecture](ARCHITECTURE.md#capacity-model) for the full model.

## Setup

1. Open your Pingflare dashboard.
2. Click **Create Monitor** and select the **Agent / Infra** tab.
3. Configure the maximum thresholds (e.g., maximum CPU, RAM, or Disk). If any threshold is breached, any container is not running, or a running container is unhealthy, the monitor will trigger a downtime incident and send alerts.
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

## Log Aggregation
Please note that Pingflare is designed to run entirely on the Cloudflare Free Tier. As such, aggregating and storing heavy server logs is not natively supported by the agent, as high log volumes would instantly exhaust Cloudflare D1's 100,000 writes/day free limit. The agent strictly focuses on periodic health metrics to keep your infrastructure running smoothly without incurring costs.
