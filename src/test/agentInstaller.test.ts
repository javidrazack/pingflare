import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { buildAgentInstaller } from '../services/agent-installer'

describe('agent installer generation', () => {
  const token = '12345678-1234-4234-8234-123456789abc'
  const origin = 'https://pingflare.example'
  const script = buildAgentInstaller(token, origin)

  it('generates valid Bash', () => {
    const result = spawnSync('bash', ['-n'], {
      input: script,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
  })

  it('generates a separately valid installed agent script', () => {
    const heredocStart = "cat > \"$SCRIPT_PATH\" <<'AGENT_EOF'\n"
    const installedAgent = script
      .split(heredocStart)[1]
      ?.split('\nAGENT_EOF\n')[0]

    expect(installedAgent).toBeTruthy()
    const result = spawnSync('bash', ['-n'], {
      input: installedAgent,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('splits large CPU counters explicitly and avoids shell arithmetic', () => {
    expect(script).toContain(
      `IFS=' ' read -r cpu_total_before cpu_idle_before <<< "$(cpu_sample)"`,
    )
    expect(script).toContain(
      `IFS=' ' read -r cpu_total_after cpu_idle_after <<< "$(cpu_sample)"`,
    )
    expect(script).toContain('-v total_before="$cpu_total_before"')
    expect(script).not.toContain('cpu_delta=$((')

    const parseProbe = spawnSync('bash', ['-c', `
      set -Eeuo pipefail
      IFS=$'\\n\\t'
      IFS=' ' read -r total idle <<< "2464352180 2454232902"
      test "$total" = "2464352180"
      test "$idle" = "2454232902"
    `], { encoding: 'utf8' })
    expect(parseProbe.status, parseProbe.stderr).toBe(0)
  })

  it('embeds the complete push URL in the installed agent', () => {
    expect(script).toContain(
      `readonly PUSH_URL='${origin}/api/agent/push/${token}'`,
    )
    expect(script).not.toContain('${PINGFLARE_URL}')
    expect(script).not.toContain('${TOKEN}')
  })

  it('requires root and supports systemd with a cron fallback', () => {
    expect(script).toContain('root access is required')
    expect(script).toContain('systemctl enable --now pingflare-agent.timer')
    expect(script).toContain('OnActiveSec=1min')
    expect(script).toContain('OnUnitActiveSec=1min')
    expect(script).not.toContain('OnBootSec=')
    expect(script).not.toContain('Persistent=true')
    expect(script).toContain('NextElapseUSecMonotonic')
    expect(script).toContain('systemd timer has no scheduled next run')
    expect(script).toContain('crontab "$cron_tmp"')
    expect(script).toContain('the cron daemon could not be started')
    expect(script).toContain('grep -v -F "$SCRIPT_PATH"')
    expect(script).toContain('systemctl disable --now pingflare-agent.timer')
  })

  it('only reports success after the first heartbeat and scheduler setup', () => {
    const firstHeartbeat = script.indexOf('Sending the first infrastructure heartbeat')
    const existingTimerStop = script.indexOf('systemctl disable --now pingflare-agent.timer')
    const existingCronRemoval = script.indexOf('previous_cron=$(mktemp)')
    const sentinelCheck = script.indexOf(
      'first_heartbeat_result" != "PINGFLARE_HEARTBEAT_ACCEPTED"',
    )
    const schedulerSetup = script.indexOf('systemctl enable --now pingflare-agent.timer')
    const schedulerCheck = script.indexOf('NextElapseUSecMonotonic')
    const successMessage = script.indexOf('Pingflare agent installed successfully')

    expect(firstHeartbeat).toBeGreaterThan(-1)
    expect(existingTimerStop).toBeLessThan(firstHeartbeat)
    expect(existingCronRemoval).toBeLessThan(firstHeartbeat)
    expect(script).toContain('"$SCRIPT_PATH" --verify')
    expect(script).toContain('the first heartbeat request was rejected')
    expect(script).toContain('the agent did not confirm that the first heartbeat was accepted')
    expect(sentinelCheck).toBeGreaterThan(firstHeartbeat)
    expect(schedulerSetup).toBeGreaterThan(sentinelCheck)
    expect(schedulerCheck).toBeGreaterThan(schedulerSetup)
    expect(successMessage).toBeGreaterThan(schedulerCheck)
  })

  it('encodes unexpected token characters before adding them to shell URLs', () => {
    const hostileToken = `token'$(touch /tmp/should-not-exist)`
    const hostileScript = buildAgentInstaller(hostileToken, origin)

    expect(hostileScript).not.toContain(hostileToken)
    expect(hostileScript).toContain(
      'token%27%24%28touch%20%2Ftmp%2Fshould-not-exist%29',
    )

    const result = spawnSync('bash', ['-n'], {
      input: hostileScript,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
  })
})
