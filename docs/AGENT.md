# Pingflare Infrastructure Agent

Pingflare provides a simple, zero-hassle bash script agent to monitor your infrastructure servers and Docker containers, akin to Checkmate's Capture agent.

## What it Monitors
The agent runs on a 1-minute cron schedule and collects:
1. **CPU Usage**: Extracted via `top`.
2. **RAM Usage**: Extracted via `free`.
3. **Disk Usage**: Extracted via `df` (checks the root `/` mount).
4. **Docker Containers**: Extracts running and stopped container statuses via `docker ps -a` and `jq`.

It pushes these metrics to your Pingflare instance via `POST /api/agent/push/:token`.

## Setup

1. Open your Pingflare dashboard.
2. Click **Create Monitor** and select the **Agent / Infra** tab.
3. Configure the maximum thresholds (e.g., maximum CPU, RAM, or Disk). If any threshold is breached, any container is not running, or a running container is unhealthy, the monitor will trigger a downtime incident and send alerts.
4. Save the monitor.
5. In the monitor details page, you will see an **Agent Installation** command block.
6. Copy the command and paste it into the terminal of the server you wish to monitor.

### How it works
The install script will:
- Download the generated shell script into `/opt/pingflare-agent`.
- Verify if `jq` is installed (and attempt to install it via package managers if missing).
- Add an entry to the user's `crontab` to execute the script every minute.
- Immediately execute the script to record its first heartbeat.

Because it relies on the user's crontab, the cron job executes with the permissions of the user running the installation command.

## Log Aggregation
Please note that Pingflare is designed to run entirely on the Cloudflare Free Tier. As such, aggregating and storing heavy server logs is not natively supported by the agent, as high log volumes would instantly exhaust Cloudflare D1's 100,000 writes/day free limit. The agent strictly focuses on periodic health metrics to keep your infrastructure running smoothly without incurring costs.
