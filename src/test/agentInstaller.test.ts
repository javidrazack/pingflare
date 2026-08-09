import { spawnSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildAgentInstaller } from '../services/agent-installer'

function createAgentHarness(installedAgent: string) {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'pingflare-agent-test-'))
  const stateDir = join(fixtureRoot, 'state')
  const shimDir = join(fixtureRoot, 'bin')
  const procStatPath = join(fixtureRoot, 'stat')
  const nextStatPath = join(fixtureRoot, 'stat.next')
  const meminfoPath = join(fixtureRoot, 'meminfo')
  const bootIdPath = join(fixtureRoot, 'boot_id')
  const capturePath = join(fixtureRoot, 'payload.json')
  const callLogPath = join(fixtureRoot, 'curl.calls')
  const sleepMarker = join(fixtureRoot, 'sleep.marker')
  const agentPath = join(fixtureRoot, 'agent.sh')
  const statePath = join(stateDir, 'cpu.state')
  mkdirSync(stateDir)
  mkdirSync(shimDir)

  const fixtureAgent = installedAgent
    .replaceAll('/run/pingflare-agent', stateDir)
    .replaceAll('/proc/sys/kernel/random/boot_id', bootIdPath)
    .replaceAll('/proc/stat', procStatPath)
    .replaceAll('/proc/meminfo', meminfoPath)
  writeFileSync(agentPath, fixtureAgent)
  chmodSync(agentPath, 0o700)
  writeFileSync(bootIdPath, 'boot-a\n')
  writeFileSync(meminfoPath, 'MemTotal: 1000 kB\nMemAvailable: 500 kB\n')

  const sleepShim = join(shimDir, 'sleep')
  writeFileSync(sleepShim, `#!/usr/bin/env bash
set -eu
cp "$PINGFLARE_NEXT_STAT" "$PINGFLARE_STAT_PATH"
: > "$PINGFLARE_SLEEP_MARKER"
`)
  chmodSync(sleepShim, 0o700)

  const curlShim = join(shimDir, 'curl')
  writeFileSync(curlShim, `#!/usr/bin/env bash
set -eu
printf '%s\\n' "$$" >> "$PINGFLARE_CALL_LOG"
if [ "\${PINGFLARE_CURL_DELAY:-0}" != "0" ]; then
  /bin/sleep "$PINGFLARE_CURL_DELAY"
fi
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--data-binary" ]; then
    shift
    printf '%s' "$1" > "$PINGFLARE_CAPTURE_PATH"
    exit "\${PINGFLARE_CURL_STATUS:-0}"
  fi
  shift
done
exit 1
`)
  chmodSync(curlShim, 0o700)

  const dockerShim = join(shimDir, 'docker')
  writeFileSync(dockerShim, `#!/usr/bin/env bash
set -eu
if [ "\${PINGFLARE_DOCKER_INSPECT_JSON:-}" = "" ]; then
  exit 1
fi
if [ "\${1:-}" = "ps" ]; then
  printf '%s\\n' init-id web-id
  exit 0
fi
if [ "\${1:-}" = "inspect" ]; then
  printf '%s\\n' "$PINGFLARE_DOCKER_INSPECT_JSON"
  exit 0
fi
exit 1
`)
  chmodSync(dockerShim, 0o700)

  const mvShim = join(shimDir, 'mv')
  writeFileSync(mvShim, `#!/usr/bin/env bash
if [ "\${PINGFLARE_MV_STATUS:-0}" != "0" ]; then
  exit "$PINGFLARE_MV_STATUS"
fi
exec /bin/mv "$@"
`)
  chmodSync(mvShim, 0o700)

  // macOS does not ship util-linux flock. This shim applies flock(2) to the
  // inherited descriptor; the lock remains held by the parent agent process.
  const flockShim = join(shimDir, 'flock')
  writeFileSync(flockShim, `#!/usr/bin/env python3
import fcntl
import sys

try:
    fcntl.flock(int(sys.argv[-1]), fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise SystemExit(1)
`)
  chmodSync(flockShim, 0o700)

  const env = {
    ...process.env,
    PATH: `${shimDir}:${process.env.PATH ?? ''}`,
    PINGFLARE_CALL_LOG: callLogPath,
    PINGFLARE_CAPTURE_PATH: capturePath,
    PINGFLARE_NEXT_STAT: nextStatPath,
    PINGFLARE_SLEEP_MARKER: sleepMarker,
    PINGFLARE_STAT_PATH: procStatPath,
  }

  return {
    agentPath,
    bootIdPath,
    callLogPath,
    capturePath,
    cleanup: () => rmSync(fixtureRoot, { recursive: true, force: true }),
    env,
    procStatPath,
    nextStatPath,
    runAgent: (overrides: Partial<NodeJS.ProcessEnv> = {}) => spawnSync(agentPath, {
      encoding: 'utf8',
      env: { ...env, ...overrides },
    }),
    sleepMarker,
    stateDir,
    statePath,
    writeCpuStat: (path: string, values: string) =>
      writeFileSync(path, `cpu ${values}\n`),
  }
}

describe('agent installer generation', () => {
  const shellIntegrationTimeout = 15_000
  const token = '12345678-1234-4234-8234-123456789abc'
  const origin = 'https://pingflare.example'
  const script = buildAgentInstaller(token, origin)
  const heredocStart = "cat > \"$SCRIPT_PATH\" <<'AGENT_EOF'\n"
  const installedAgent = script
    .split(heredocStart)[1]
    ?.split('\nAGENT_EOF\n')[0]

  it('generates valid Bash', () => {
    const result = spawnSync('bash', ['-n'], {
      input: script,
      encoding: 'utf8',
    })

    expect(result.status, result.stderr).toBe(0)
  })

  it('generates a separately valid installed agent script', () => {
    expect(installedAgent).toBeTruthy()
    const result = spawnSync('bash', ['-n'], {
      input: installedAgent,
      encoding: 'utf8',
    })
    expect(result.status, result.stderr).toBe(0)
  })

  it('validates large CPU counters and avoids shell arithmetic', () => {
    expect(script).toContain(
      `IFS=' ' read -r cpu_total_current cpu_idle_current <<< "$(cpu_sample)"`,
    )
    expect(script).toContain(
      `IFS=' ' read -r cpu_total_after cpu_idle_after <<< "$(cpu_sample)"`,
    )
    expect(script).toContain('-v total_before="$1"')
    expect(script).toContain('total <= 0 || idle < 0 || idle > total')
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

  it('uses persisted CPU counters after a safe first-run sample', () => {
    expect(installedAgent).toBeTruthy()
    if (!installedAgent) return

    const harness = createAgentHarness(installedAgent)
    try {
      const readCpu = () =>
        (JSON.parse(readFileSync(harness.capturePath, 'utf8')) as { cpu: number }).cpu

      harness.writeCpuStat(harness.procStatPath, '100 0 50 800 20 0 0 0 500 200')
      harness.writeCpuStat(harness.nextStatPath, '130 0 70 850 20 0 0 0 900 400')
      const firstRun = harness.runAgent()
      expect(firstRun.status, firstRun.stderr).toBe(0)
      expect(readCpu()).toBe(50)
      expect(readFileSync(harness.sleepMarker, 'utf8')).toBe('')
      expect(readFileSync(harness.statePath, 'utf8')).toBe(
        'v1 boot-a 1070 870\n',
      )
      expect(statSync(harness.stateDir).mode & 0o777).toBe(0o700)
      expect(statSync(harness.statePath).mode & 0o777).toBe(0o600)

      rmSync(harness.sleepMarker)
      harness.writeCpuStat(harness.procStatPath, '160 0 80 890 20 0 0 0 1200 600')
      const secondRun = harness.runAgent()
      expect(secondRun.status, secondRun.stderr).toBe(0)
      expect(readCpu()).toBe(50)
      expect(existsSync(harness.sleepMarker)).toBe(false)
      expect(readFileSync(harness.statePath, 'utf8')).toBe(
        'v1 boot-a 1150 910\n',
      )
    } finally {
      harness.cleanup()
    }
  }, shellIntegrationTimeout)

  it('falls back safely for corrupt, rebooted, or rolled-back CPU state', () => {
    expect(installedAgent).toBeTruthy()
    if (!installedAgent) return

    const harness = createAgentHarness(installedAgent)
    try {
      const fallbackCases = [
        { bootId: 'boot-a', state: 'not valid\n' },
        { bootId: 'boot-new', state: 'v1 boot-old 900 800\n' },
        { bootId: 'boot-new', state: 'v1 boot-new 999999 999000\n' },
        { bootId: 'boot-new', state: 'v1 boot-new 900 800 $(touch BAD)\n' },
      ]

      for (const fallbackCase of fallbackCases) {
        rmSync(harness.sleepMarker, { force: true })
        writeFileSync(harness.bootIdPath, `${fallbackCase.bootId}\n`)
        writeFileSync(harness.statePath, fallbackCase.state)
        harness.writeCpuStat(harness.procStatPath, '160 0 80 890 20 0 0 0 0 0')
        harness.writeCpuStat(harness.nextStatPath, '190 0 100 940 20 0 0 0 0 0')

        const result = harness.runAgent()
        expect(result.status, result.stderr).toBe(0)
        expect(existsSync(harness.sleepMarker)).toBe(true)
        expect(readFileSync(harness.statePath, 'utf8')).toBe(
          `v1 ${fallbackCase.bootId} 1250 960\n`,
        )
      }
    } finally {
      harness.cleanup()
    }
  }, shellIntegrationTimeout)

  it('advances the CPU baseline before delivery and preserves old state on write failure', () => {
    expect(installedAgent).toBeTruthy()
    if (!installedAgent) return

    const harness = createAgentHarness(installedAgent)
    try {
      writeFileSync(harness.statePath, 'v1 boot-a 1070 870\n')
      harness.writeCpuStat(harness.procStatPath, '160 0 80 890 20 0 0 0 0 0')

      const failedPush = harness.runAgent({ PINGFLARE_CURL_STATUS: '7' })
      expect(failedPush.status).toBe(7)
      expect(readFileSync(harness.statePath, 'utf8')).toBe('v1 boot-a 1150 910\n')

      harness.writeCpuStat(harness.procStatPath, '190 0 100 940 20 0 0 0 0 0')
      const nextPush = harness.runAgent()
      expect(nextPush.status, nextPush.stderr).toBe(0)
      expect(existsSync(harness.sleepMarker)).toBe(false)
      expect(readFileSync(harness.statePath, 'utf8')).toBe('v1 boot-a 1250 960\n')

      harness.writeCpuStat(harness.procStatPath, '220 0 120 980 20 0 0 0 0 0')
      const failedStateWrite = harness.runAgent({ PINGFLARE_MV_STATUS: '1' })
      expect(failedStateWrite.status, failedStateWrite.stderr).toBe(0)
      expect(failedStateWrite.stderr).toContain('could not update CPU state')
      expect(readFileSync(harness.statePath, 'utf8')).toBe('v1 boot-a 1250 960\n')
      expect(readdirSync(harness.stateDir).sort()).toEqual(['agent.lock', 'cpu.state'])
    } finally {
      harness.cleanup()
    }
  }, shellIntegrationTimeout)

  it('updates CPU state atomically for overlapping invocations', () => {
    expect(installedAgent).toBeTruthy()
    if (!installedAgent) return

    const harness = createAgentHarness(installedAgent)
    try {
      writeFileSync(harness.statePath, 'v1 boot-a 1070 870\n')
      harness.writeCpuStat(harness.procStatPath, '160 0 80 890 20 0 0 0 0 0')
      const parallelRun = spawnSync('bash', [
        '-c',
        '"$1" & first=$!; "$1" & second=$!; wait "$first"; first_status=$?; wait "$second"; second_status=$?; test "$first_status" -eq 0 && test "$second_status" -eq 0',
        'bash',
        harness.agentPath,
      ], {
        encoding: 'utf8',
        env: { ...harness.env, PINGFLARE_CURL_DELAY: '0.2' },
      })

      expect(parallelRun.status, parallelRun.stderr).toBe(0)
      expect(readFileSync(harness.statePath, 'utf8')).toBe('v1 boot-a 1150 910\n')
      expect(readdirSync(harness.stateDir).sort()).toEqual(['agent.lock', 'cpu.state'])
      expect(readFileSync(harness.callLogPath, 'utf8').trim().split('\n')).toHaveLength(1)
    } finally {
      harness.cleanup()
    }
  }, shellIntegrationTimeout)

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

  it('derives one-shot containers from Docker Compose dependency labels', () => {
    expect(installedAgent).toContain('docker inspect $docker_ids')
    expect(installedAgent).toContain('com.docker.compose.depends_on')
    expect(installedAgent).toContain(':service_completed_successfully:')
    expect(installedAgent).toContain('oneShot:')
  })

  it('reports Compose completion intent in Docker metrics', () => {
    expect(installedAgent).toBeTruthy()
    if (!installedAgent) return

    const harness = createAgentHarness(installedAgent)
    try {
      harness.writeCpuStat(harness.procStatPath, '100 0 50 800 20 0 0 0 0 0')
      harness.writeCpuStat(harness.nextStatPath, '130 0 70 850 20 0 0 0 0 0')
      const dockerInspect = JSON.stringify([
        {
          Id: 'init-id',
          Name: '/posthog-kafka-init-1',
          State: { Status: 'exited', ExitCode: 0 },
          Config: { Labels: {
            'com.docker.compose.project': 'posthog',
            'com.docker.compose.service': 'kafka-init',
          } },
        },
        {
          Id: 'web-id',
          Name: '/posthog-web-1',
          State: { Status: 'running', ExitCode: 0, Health: { Status: 'healthy' } },
          Config: { Labels: {
            'com.docker.compose.project': 'posthog',
            'com.docker.compose.service': 'web',
            'com.docker.compose.depends_on': 'kafka-init:service_completed_successfully:false',
          } },
        },
      ])

      const result = harness.runAgent({ PINGFLARE_DOCKER_INSPECT_JSON: dockerInspect })
      expect(result.status, result.stderr).toBe(0)
      const payload = JSON.parse(readFileSync(harness.capturePath, 'utf8')) as {
        docker: Array<{ name: string; status: string; health: string; oneShot: boolean }>
      }
      expect(payload.docker).toEqual([
        {
          id: 'init-id',
          name: 'posthog-kafka-init-1',
          status: 'exited',
          health: 'Exited (0)',
          oneShot: true,
        },
        {
          id: 'web-id',
          name: 'posthog-web-1',
          status: 'running',
          health: 'healthy',
          oneShot: false,
        },
      ])
    } finally {
      harness.cleanup()
    }
  }, shellIntegrationTimeout)

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
