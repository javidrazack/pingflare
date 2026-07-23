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
    expect(script).toContain('crontab "$cron_tmp"')
    expect(script).toContain('the cron daemon could not be started')
    expect(script).toContain('grep -v -F "$SCRIPT_PATH"')
  })

  it('only reports success after the first heartbeat and scheduler setup', () => {
    const firstHeartbeat = script.indexOf('Sending the first infrastructure heartbeat')
    const schedulerSetup = script.indexOf('systemctl enable --now pingflare-agent.timer')
    const successMessage = script.indexOf('Pingflare agent installed successfully')

    expect(firstHeartbeat).toBeGreaterThan(-1)
    expect(schedulerSetup).toBeGreaterThan(firstHeartbeat)
    expect(successMessage).toBeGreaterThan(schedulerSetup)
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
