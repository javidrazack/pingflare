import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendGoogleChat(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
): Promise<void> {
  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: formatMessage(payload, locale) }),
  })
  await assertResponseOk(response, 'Google Chat')
}
