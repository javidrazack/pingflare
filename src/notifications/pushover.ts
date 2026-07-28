import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendPushover(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  const priority = payload.status === 'down' ? '1' : '0'

  const response = await fetch('https://api.pushover.net/1/messages.json', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      token: config.token,
      user: config.user,
      message: formatMessage(payload, locale),
      priority,
      title: payload.monitor.name,
    }),
    signal,
  })
  await assertResponseOk(response, 'Pushover')
}
