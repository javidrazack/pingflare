import { eq, lt } from 'drizzle-orm'
import { getDb, monitors, statusLogs, heartbeatTokens, settings } from './db'
import { checkHttp } from './services/checker'
import { checkHeartbeat } from './services/heartbeat-checker'
import { processAlert, getLocale } from './services/alert-manager'
import type { Env } from './index'

async function getWorkerOrigin(): Promise<{ colo: string; countryCode: string; originIp: string } | null> {
  try {
    const res = await fetch('https://1.1.1.1/cdn-cgi/trace', { signal: AbortSignal.timeout(3000) })
    const text = await res.text()
    const colo = text.match(/^colo=(.+)$/m)?.[1] ?? null
    const loc  = text.match(/^loc=(.+)$/m)?.[1] ?? null
    const ip   = text.match(/^ip=(.+)$/m)?.[1] ?? ''
    if (!colo || !loc) return null
    return { colo, countryCode: loc, originIp: ip }
  } catch {
    return null
  }
}

export async function runCron(env: Env): Promise<void> {
  const db = getDb(env.DB)
  const now = Math.floor(Date.now() / 1000)
  const origin = await getWorkerOrigin()

  const allMonitors = await db.select()
    .from(monitors)
    .where(eq(monitors.active, true))

  const due = allMonitors.filter(m => {
    if (!m.lastCheckedAt) return true
    return (now - m.lastCheckedAt) >= m.interval
  })

  const retentionRow = await db.select().from(settings).where(eq(settings.key, 'retention_days')).get()
  const retentionDays = retentionRow ? parseInt(retentionRow.value, 10) : 90
  const cutoff = now - retentionDays * 86400
  await db.delete(statusLogs).where(lt(statusLogs.checkedAt, cutoff))

  if (due.length === 0) return

  const locale = await getLocale(db)

  await Promise.allSettled(due.map(async (monitor) => {
    try {
      if (monitor.type === 'http') {
        const result = await checkHttp(monitor, locale)

        await db.insert(statusLogs).values({
          id: crypto.randomUUID(),
          monitorId: monitor.id,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs,
          checkedAt: now,
          colo: origin?.colo ?? null,
          countryCode: origin?.countryCode ?? null,
          originIp: origin?.originIp ?? null,
        })

        if (monitor.sslCheckEnabled && monitor.url?.startsWith('https://')) {
          const newSslStatus = result.sslError ? 'error' : (result.status === 'up' ? 'ok' : monitor.sslStatus)
          await db.update(monitors).set({ sslStatus: newSslStatus }).where(eq(monitors.id, monitor.id))
        }

        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          responseTimeMs: result.responseTimeMs,
          encryptionKey: env.ENCRYPTION_KEY,
        })

      } else if (monitor.type === 'heartbeat' || monitor.type === 'agent') {
        const hb = await db.query.heartbeatTokens.findFirst({
          where: eq(heartbeatTokens.monitorId, monitor.id),
        })

        const result = checkHeartbeat(monitor, hb?.lastPingAt ?? null, now, locale)

        await db.insert(statusLogs).values({
          id: crypto.randomUUID(),
          monitorId: monitor.id,
          status: result.status,
          message: result.logKey ?? result.message,
          responseTimeMs: null,
          checkedAt: now,
          colo: origin?.colo ?? null,
          countryCode: origin?.countryCode ?? null,
          originIp: origin?.originIp ?? null,
        })

        await processAlert({
          db,
          monitor,
          status: result.status,
          message: result.message,
          encryptionKey: env.ENCRYPTION_KEY,
        })
      }
    } catch (err) {
      await db.insert(statusLogs).values({
        id: crypto.randomUUID(),
        monitorId: monitor.id,
        status: 'down',
        message: `Internal error: ${String(err)}`,
        responseTimeMs: null,
        checkedAt: now,
        colo: origin?.colo ?? null,
        countryCode: origin?.countryCode ?? null,
        originIp: origin?.originIp ?? null,
      }).catch(() => {})
    }
  }))
}
