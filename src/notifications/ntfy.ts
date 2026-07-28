import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendNtfy(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  const priority = payload.status === 'down' ? '4' : '2'
  const tag = payload.status === 'up' ? 'white_check_mark' : 'red_circle'
  const headers: Record<string, string> = {
    'Title': payload.monitor.name,
    'Priority': priority,
    'Tags': tag,
  }
  if (config.token) headers['Authorization'] = `Bearer ${config.token}`

  const response = await fetch(`${config.url}/${config.topic}`, {
    method: 'POST',
    headers,
    body: formatMessage(payload, locale),
    signal,
  })
  await assertResponseOk(response, 'ntfy')
}
