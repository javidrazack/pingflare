# Pingflare Infrastructure Agent

Pingflare provides a simple, zero-hassle bash script agent to monitor your infrastructure servers and Docker containers, akin to Checkmate's Capture agent.

## What it Monitors
The agent runs every minute and collects:
1. **CPU Usage**: Calculated from `/proc/stat`.
2. **RAM Usage**: Calculated from `/proc/meminfo`.
3. **Disk Usage**: Extracted via `df` (checks the root `/` mount).
4. **Docker Containers**: Extracts running and stopped container statuses via `docker ps -a` and `jq`.

It pushes these metrics to your Pingflare instance via `POST /api/agent/push/:token`.

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

The generated installation URL contains the agent token. Treat the URL and installed script as credentials and do not publish them.

## Log Aggregation
Please note that Pingflare is designed to run entirely on the Cloudflare Free Tier. As such, aggregating and storing heavy server logs is not natively supported by the agent, as high log volumes would instantly exhaust Cloudflare D1's 100,000 writes/day free limit. The agent strictly focuses on periodic health metrics to keep your infrastructure running smoothly without incurring costs.
