import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendMSTeams(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  const { webhookUrl } = config
  if (!webhookUrl) throw new Error('Missing webhookUrl for MS Teams')

  const title = payload.status === 'down' ? `🚨 [${payload.monitor.name}] Down` : `✅ [${payload.monitor.name}] Up`
  const text = formatMessage(payload, locale)

  const body = {
    '@type': 'MessageCard',
    '@context': 'http://schema.org/extensions',
    themeColor: payload.status === 'down' ? 'd9534f' : '5cb85c',
    title: title,
    text: text
  }

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })

  await assertResponseOk(res, 'MS Teams')
}
