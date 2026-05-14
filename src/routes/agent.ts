import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, monitors, heartbeatTokens, statusLogs, alertState } from '../db'
import { processAlert } from '../services/alert-manager'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()

router.get('/install/:token', async (c) => {
  const db = getDb(c.env.DB)
  const tokenRecord = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.token, c.req.param('token')),
  })

  if (!tokenRecord) {
    return c.text('Invalid token', 404)
  }

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, tokenRecord.monitorId),
  })

  if (!monitor || monitor.type !== 'agent') {
    return c.text('Not an agent monitor', 400)
  }

  const origin = new URL(c.req.url).origin

  const template = `#!/bin/bash
# Pingflare Infrastructure Agent

TOKEN="{{TOKEN}}"
PINGFLARE_URL="{{PINGFLARE_URL}}"
CRON_SCHEDULE="* * * * *"

INSTALL_DIR="/opt/pingflare-agent"
SCRIPT_PATH="$INSTALL_DIR/agent.sh"

echo "Installing Pingflare Agent..."

mkdir -p "$INSTALL_DIR"

if ! command -v jq &> /dev/null; then
  echo "jq is required but not installed. Attempting to install..."
  if command -v apt-get &> /dev/null; then apt-get update && apt-get install -y jq;
  elif command -v yum &> /dev/null; then yum install -y jq;
  elif command -v apk &> /dev/null; then apk add jq;
  else echo "Could not install jq. Please install it manually."; fi
fi

cat << 'AGENT_EOF' > "$SCRIPT_PATH"
#!/bin/bash

cpu_usage=$(top -bn1 | grep "Cpu(s)" | sed "s/.*, *\\([0-9.]*\\)%* id.*/\\1/" | awk '{print 100 - $1}')
if [ -z "$cpu_usage" ]; then cpu_usage="0"; fi

read total used <<< $(free -m | awk '/Mem:/ {print $2, $3}')
if [ "$total" -gt 0 ]; then
  ram_usage=$(awk "BEGIN {printf \\"%.2f\\", ($used/$total)*100}")
else
  ram_usage="0"
fi

disk_usage=$(df -h / | awk 'NR==2 {print $5}' | sed 's/%//')
if [ -z "$disk_usage" ]; then disk_usage="0"; fi

docker_containers="[]"
if command -v docker &> /dev/null; then
  docker_containers=$(docker ps --format '{"id":"{{.ID}}", "name":"{{.Names}}", "status":"{{.State}}", "health":"{{.Status}}"}' | jq -s -c '.')
  if [ -z "$docker_containers" ]; then docker_containers="[]"; fi
fi

PAYLOAD=$(cat <<JSON
{
  "cpu": $cpu_usage,
  "ram": $ram_usage,
  "disk": $disk_usage,
  "docker": $docker_containers
}
JSON
)

curl -s -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "${PINGFLARE_URL}/api/agent/push/${TOKEN}"
AGENT_EOF

chmod +x "$SCRIPT_PATH"

crontab -l 2>/dev/null | grep -v "$SCRIPT_PATH" > /tmp/pingflare_cron || true
echo "$CRON_SCHEDULE $SCRIPT_PATH >/dev/null 2>&1" >> /tmp/pingflare_cron
crontab /tmp/pingflare_cron
rm /tmp/pingflare_cron

$SCRIPT_PATH

echo "Pingflare agent installed successfully! It will run every minute."
`
  const script = template
    .replace('{{TOKEN}}', tokenRecord.token)
    .replace('{{PINGFLARE_URL}}', origin)

  return c.text(script)
})

router.post('/push/:token', async (c) => {
  const db = getDb(c.env.DB)
  const token = c.req.param('token')

  const tokenRecord = await db.query.heartbeatTokens.findFirst({
    where: eq(heartbeatTokens.token, token),
  })

  if (!tokenRecord) {
    return c.text('Invalid token', 404)
  }

  const monitor = await db.query.monitors.findFirst({
    where: eq(monitors.id, tokenRecord.monitorId),
  })

  if (!monitor || monitor.type !== 'agent') {
    return c.text('Not an agent monitor', 400)
  }

  const body = await c.req.json()
  const now = Math.floor(Date.now() / 1000)

  // Update last ping and metrics
  await db.update(heartbeatTokens).set({ lastPingAt: now }).where(eq(heartbeatTokens.monitorId, monitor.id))
  await db.update(monitors).set({ lastMetrics: JSON.stringify(body) }).where(eq(monitors.id, monitor.id))

  let isDown = false
  let downReason = []

  if (monitor.cpuThreshold && body.cpu > monitor.cpuThreshold) {
    isDown = true
    downReason.push(`CPU usage ${body.cpu}% exceeds threshold ${monitor.cpuThreshold}%`)
  }
  if (monitor.ramThreshold && body.ram > monitor.ramThreshold) {
    isDown = true
    downReason.push(`RAM usage ${body.ram}% exceeds threshold ${monitor.ramThreshold}%`)
  }
  if (monitor.diskThreshold && body.disk > monitor.diskThreshold) {
    isDown = true
    downReason.push(`Disk usage ${body.disk}% exceeds threshold ${monitor.diskThreshold}%`)
  }

  if (Array.isArray(body.docker)) {
    for (const container of body.docker) {
      if (container.status === 'exited' || container.status === 'dead' || container.health === 'unhealthy') {
        isDown = true
        downReason.push(`Docker container ${container.name} is ${container.status} (${container.health || 'no health'})`)
      }
    }
  }

  const status = isDown ? 'down' : 'up'
  const message = isDown ? downReason.join(', ') : 'Agent metrics OK'

  await processAlert({
    db,
    monitor,
    status,
    message,
    encryptionKey: c.env.ENCRYPTION_KEY,
  })

  return c.json({ ok: true })
})

export default router
