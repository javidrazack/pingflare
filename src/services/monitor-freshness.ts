export type DisplayStatus = 'up' | 'down' | 'pending' | 'stale' | 'paused'

export function displayStatus(monitor: {
  active: boolean
  lastStatus: 'up' | 'down' | 'pending'
  lastCheckedAt: number | null
  nextCheckAt: number
}, now = Math.floor(Date.now() / 1000)): DisplayStatus {
  if (!monitor.active) return 'paused'
  if (monitor.lastCheckedAt === null || monitor.lastStatus === 'pending') return 'pending'
  // One cron tick plus scheduling jitter. Inbound deadlines already include grace.
  if (monitor.nextCheckAt + 90 < now) return 'stale'
  return monitor.lastStatus
}
