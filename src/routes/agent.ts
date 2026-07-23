import { Hono } from 'hono'
import { eq } from 'drizzle-orm'
import { getDb, monitors, heartbeatTokens, statusLogs, alertState } from '../db'
import { processAlert } from '../services/alert-manager'
import { evaluateAgentPayload, parseAgentPayload } from '../services/agent-status'
import { readJsonBodyWithLimit, RequestBodyTooLargeError } from '../request'
import type { Env } from '../index'

const router = new Hono<{ Bindings: Env }>()
const MAX_AGENT_PAYLOAD_BYTES = 64 * 1024

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
  docker_containers=$(docker ps -a --format '{"id":"{{.ID}}", "name":"{{.Names}}", "status":"{{.State}}", "health":"{{.Status}}"}' | jq -s -c '.')
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

curl -fsS --retry 3 --retry-delay 2 -X POST -H "Content-Type: application/json" -d "$PAYLOAD" "\${PINGFLARE_URL}/api/agent/push/\${TOKEN}"
AGENT_EOF

chmod +x "$SCRIPT_PATH"

CRON_TMP=$(mktemp)
trap 'rm -f "$CRON_TMP"' EXIT
crontab -l 2>/dev/null | grep -v "$SCRIPT_PATH" > "$CRON_TMP" || true
echo "$CRON_SCHEDULE $SCRIPT_PATH >/dev/null 2>&1" >> "$CRON_TMP"
crontab "$CRON_TMP"

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

  let rawBody: unknown
  try {
    rawBody = await readJsonBodyWithLimit(c.req.raw, MAX_AGENT_PAYLOAD_BYTES)
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return c.json({ error: 'Agent payload is too large' }, 413)
    }
    return c.json({ error: 'Invalid JSON payload' }, 400)
  }
  const body = parseAgentPayload(rawBody)
  if (!body) {
    return c.json({ error: 'Invalid agent payload' }, 400)
  }
  const now = Math.floor(Date.now() / 1000)

  const { status, message } = evaluateAgentPayload(monitor, body)
  const snapshot = { ...body, status, message, evaluatedAt: now }

  await db.update(heartbeatTokens)
    .set({ lastPingAt: now })
    .where(eq(heartbeatTokens.monitorId, monitor.id))
  await db.update(monitors)
    .set({ lastMetrics: JSON.stringify(snapshot), lastCheckedAt: now })
    .where(eq(monitors.id, monitor.id))
  await db.insert(statusLogs).values({
    id: crypto.randomUUID(),
    monitorId: monitor.id,
    status,
    message,
    responseTimeMs: null,
    checkedAt: now,
  })

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
