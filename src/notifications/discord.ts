import type { NotificationPayload } from './index'
import { typeLabel, metaFields } from './messages'
import { assertResponseOk } from './http'

export async function sendDiscord(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
): Promise<void> {
  const color = payload.status === 'up' ? 0x22c55e : 0xef4444
  const icon = payload.status === 'up' ? '✅' : '🔴'
  const label = typeLabel(payload.type, locale)

  const embed: Record<string, unknown> = {
    title: `${icon} ${label}: ${payload.monitor.name}`,
    description: payload.message || undefined,
    color,
    timestamp: new Date().toISOString(),
    fields: metaFields(payload, locale),
  }

  const response = await fetch(config.webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  })
  await assertResponseOk(response, 'Discord')
}
