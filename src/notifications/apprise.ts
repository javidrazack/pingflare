import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendApprise(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`

  const response = await fetch(`${config.url}/notify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      urls: config.urls,
      title: payload.monitor.name,
      body: formatMessage(payload, locale),
      type: payload.status === 'up' ? 'success' : 'failure',
    }),
  })
  await assertResponseOk(response, 'Apprise')
}
