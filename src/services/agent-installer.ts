function quoteForBash(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

export function buildAgentInstaller(token: string, requestOrigin: string): string {
  const origin = new URL(requestOrigin).origin
  const encodedToken = encodePathSegment(token)
  const installUrl = `${origin}/api/agent/install/${encodedToken}`
  const pushUrl = `${origin}/api/agent/push/${encodedToken}`

  return `#!/usr/bin/env bash
# Pingflare Infrastructure Agent installer
set -Eeuo pipefail
IFS=$'\\n\\t'
umask 077

readonly INSTALL_DIR="/opt/pingflare-agent"
readonly SCRIPT_PATH="$INSTALL_DIR/agent.sh"
readonly SYSTEMD_SERVICE="/etc/systemd/system/pingflare-agent.service"
readonly SYSTEMD_TIMER="/etc/systemd/system/pingflare-agent.timer"
readonly INSTALL_COMMAND=${quoteForBash(`curl -fsSL ${installUrl} | sudo bash`)}

fail() {
  echo "Pingflare installation failed: $*" >&2
  exit 1
}

on_error() {
  local exit_code=$?
  echo "Pingflare installation failed at line $1 (exit $exit_code)." >&2
  exit "$exit_code"
}
trap 'on_error $LINENO' ERR

if [ "\${EUID:-$(id -u)}" -ne 0 ]; then
  fail "root access is required. Re-run with: $INSTALL_COMMAND"
fi

echo "Installing Pingflare Agent..."

has_systemd=false
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  has_systemd=true
  systemctl disable --now pingflare-agent.timer >/dev/null 2>&1 || true
fi

install_dependencies() {
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y coreutils curl gawk jq
    if [ "$has_systemd" = false ]; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y cron
    fi
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y coreutils curl gawk jq
    if [ "$has_systemd" = false ]; then dnf install -y cronie; fi
  elif command -v yum >/dev/null 2>&1; then
    yum install -y coreutils curl gawk jq
    if [ "$has_systemd" = false ]; then yum install -y cronie; fi
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache coreutils curl gawk jq
    if [ "$has_systemd" = false ]; then apk add --no-cache dcron; fi
  else
    fail "curl, jq, and a scheduler are required; no supported package manager was found"
  fi
}

dependencies_missing=false
for command_name in curl jq awk df install; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    dependencies_missing=true
  fi
done
if [ "$has_systemd" = false ] && ! command -v crontab >/dev/null 2>&1; then
  dependencies_missing=true
fi

if [ "$dependencies_missing" = true ]; then
  echo "Installing missing agent dependencies..."
  install_dependencies
fi

for command_name in curl jq awk df install; do
  command -v "$command_name" >/dev/null 2>&1 ||
    fail "required command '$command_name' is unavailable"
done
if [ "$has_systemd" = false ]; then
  command -v crontab >/dev/null 2>&1 ||
    fail "neither systemd nor crontab is available"
fi

if command -v crontab >/dev/null 2>&1; then
  previous_cron=$(mktemp)
  crontab -l 2>/dev/null | grep -v -F "$SCRIPT_PATH" > "$previous_cron" || true
  crontab "$previous_cron"
  rm -f "$previous_cron"
fi

install -d -m 0700 "$INSTALL_DIR"

cat > "$SCRIPT_PATH" <<'AGENT_EOF'
#!/usr/bin/env bash
set -Eeuo pipefail
IFS=$'\\n\\t'
umask 077

readonly PUSH_URL=${quoteForBash(pushUrl)}
readonly HEARTBEAT_SENTINEL="PINGFLARE_HEARTBEAT_ACCEPTED"

cpu_sample() {
  awk '/^cpu / {
    idle = $5 + $6
    total = 0
    for (field = 2; field <= NF; field++) total += $field
    print total, idle
    exit
  }' /proc/stat
}

cpu_usage=0
if [ -r /proc/stat ]; then
  IFS=' ' read -r cpu_total_before cpu_idle_before <<< "$(cpu_sample)"
  sleep 1
  IFS=' ' read -r cpu_total_after cpu_idle_after <<< "$(cpu_sample)"
  if [[ "\${cpu_total_before:-}" =~ ^[0-9]+$ ]] &&
     [[ "\${cpu_idle_before:-}" =~ ^[0-9]+$ ]] &&
     [[ "\${cpu_total_after:-}" =~ ^[0-9]+$ ]] &&
     [[ "\${cpu_idle_after:-}" =~ ^[0-9]+$ ]]; then
    cpu_usage=$(awk \
      -v total_before="$cpu_total_before" \
      -v idle_before="$cpu_idle_before" \
      -v total_after="$cpu_total_after" \
      -v idle_after="$cpu_idle_after" \
      'BEGIN {
        total = total_after - total_before
        idle = idle_after - idle_before
        if (total <= 0) {
          print "0"
          exit
        }
        value = 100 * (total - idle) / total
        if (value < 0) value = 0
        if (value > 100) value = 100
        printf "%.2f", value
      }')
  else
    echo "Warning: could not parse CPU counters from /proc/stat." >&2
  fi
fi

mem_total=$(awk '/^MemTotal:/ { print $2; exit }' /proc/meminfo)
mem_available=$(awk '/^MemAvailable:/ { print $2; exit }' /proc/meminfo)
ram_usage=0
if [ "\${mem_total:-0}" -gt 0 ]; then
  ram_usage=$(awk -v total="$mem_total" -v available="\${mem_available:-0}" \
    'BEGIN {
      value = 100 * (total - available) / total
      if (value < 0) value = 0
      if (value > 100) value = 100
      printf "%.2f", value
    }')
fi

disk_usage=$(df -P / | awk 'NR == 2 { gsub(/%/, "", $5); print $5 }')
disk_usage=\${disk_usage:-0}

docker_containers="[]"
if command -v docker >/dev/null 2>&1; then
  if docker_rows=$(docker ps -a --format '{{json .}}' 2>/dev/null); then
    docker_containers=$(printf '%s\\n' "$docker_rows" | jq -s -c \
      '[.[] | {id: .ID, name: .Names, status: (.State // ""), health: (.Status // "")}]')
  else
    echo "Warning: Docker is installed but its daemon is unavailable." >&2
  fi
fi

payload=$(jq -cn \
  --argjson cpu "$cpu_usage" \
  --argjson ram "$ram_usage" \
  --argjson disk "$disk_usage" \
  --argjson docker "$docker_containers" \
  '{cpu: $cpu, ram: $ram, disk: $disk, docker: $docker}')

curl -fsS \
  --retry 3 \
  --retry-delay 2 \
  --connect-timeout 10 \
  --max-time 30 \
  -X POST \
  -H "Content-Type: application/json" \
  --data-binary "$payload" \
  "$PUSH_URL" >/dev/null

if [ "\${1:-}" = "--verify" ]; then
  printf '%s\\n' "$HEARTBEAT_SENTINEL"
fi
AGENT_EOF

chmod 0700 "$SCRIPT_PATH"

echo "Sending the first infrastructure heartbeat..."
if ! first_heartbeat_result=$("$SCRIPT_PATH" --verify); then
  fail "the first heartbeat request was rejected"
fi
if [ "$first_heartbeat_result" != "PINGFLARE_HEARTBEAT_ACCEPTED" ]; then
  fail "the agent did not confirm that the first heartbeat was accepted"
fi

if [ "$has_systemd" = true ]; then
  cat > "$SYSTEMD_SERVICE" <<EOF
[Unit]
Description=Pingflare Infrastructure Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=$SCRIPT_PATH
User=root
EOF

  cat > "$SYSTEMD_TIMER" <<'EOF'
[Unit]
Description=Run Pingflare Infrastructure Agent every minute

[Timer]
OnActiveSec=1min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF

  systemctl daemon-reload
  systemctl enable --now pingflare-agent.timer
  systemctl is-active --quiet pingflare-agent.timer ||
    fail "the pingflare-agent systemd timer did not start"
  next_elapse=$(systemctl show pingflare-agent.timer \
    --property=NextElapseUSecMonotonic --value 2>/dev/null || true)
  if [ -z "$next_elapse" ] || [ "$next_elapse" = "0" ] ||
     [ "$next_elapse" = "infinity" ]; then
    fail "the pingflare-agent systemd timer has no scheduled next run"
  fi
  scheduler_description="systemd timer"
else
  cron_tmp=$(mktemp)
  cleanup() { rm -f "$cron_tmp"; }
  trap cleanup EXIT
  crontab -l 2>/dev/null | grep -v -F "$SCRIPT_PATH" > "$cron_tmp" || true
  echo "* * * * * $SCRIPT_PATH >/dev/null 2>&1" >> "$cron_tmp"
  crontab "$cron_tmp"

  cron_started=false
  if command -v service >/dev/null 2>&1; then
    if service cron start >/dev/null 2>&1 || service crond start >/dev/null 2>&1; then
      cron_started=true
    fi
  fi
  if [ "$cron_started" = false ] && command -v rc-service >/dev/null 2>&1; then
    rc-update add crond default >/dev/null 2>&1 || true
    if rc-service crond start >/dev/null 2>&1; then cron_started=true; fi
  fi
  if [ "$cron_started" = false ] && command -v crond >/dev/null 2>&1; then
    if crond; then cron_started=true; fi
  fi
  if [ "$cron_started" = false ] && command -v cron >/dev/null 2>&1; then
    if cron; then cron_started=true; fi
  fi
  [ "$cron_started" = true ] ||
    fail "the cron schedule was installed, but the cron daemon could not be started"
  scheduler_description="root crontab"
fi

echo "Pingflare agent installed successfully using $scheduler_description."
echo "The first heartbeat was accepted and the agent will run every minute."
`
}
