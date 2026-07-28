import type { NotificationPayload } from './index'
import { assertResponseOk } from './http'

export async function sendWebhook(
  config: Record<string, string>,
  payload: NotificationPayload,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (config.secret) headers['X-Pingflare-Secret'] = config.secret

  const response = await fetch(config.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...payload,
      timestamp: Math.floor(Date.now() / 1000),
    }),
    signal,
  })
  await assertResponseOk(response, 'Webhook')
}
