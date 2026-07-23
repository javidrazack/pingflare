import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendPagerDuty(config: Record<string, string>, payload: NotificationPayload, locale: string): Promise<void> {
  const { routingKey } = config
  if (!routingKey) throw new Error('Missing routingKey for PagerDuty')

  const action = payload.status === 'down' ? 'trigger' : 'resolve'
  const summary = `Monitor ${payload.monitor.name} is ${payload.status.toUpperCase()}`
  const source = payload.monitor.url || payload.monitor.id

  const body = {
    routing_key: routingKey,
    event_action: action,
    dedup_key: payload.monitor.id,
    payload: {
      summary: summary,
      source: source,
      severity: payload.status === 'down' ? 'critical' : 'info',
      custom_details: {
        message: formatMessage(payload, locale)
      }
    }
  }

  const res = await fetch('https://events.pagerduty.com/v2/enqueue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  await assertResponseOk(res, 'PagerDuty')
}
