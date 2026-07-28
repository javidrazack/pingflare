import type { NotificationPayload } from './index'
import { typeLabel } from './messages'
import { assertResponseOk } from './http'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export async function sendTelegram(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  const icon = payload.status === 'up' ? '✅' : '🔴'
  const label = typeLabel(payload.type, locale)

  let text = `${icon} <b>${escapeHtml(label)}: ${escapeHtml(payload.monitor.name)}</b>`
  if (payload.message) text += `\n${escapeHtml(payload.message)}`
  if (payload.monitor.url) text += `\n<code>${escapeHtml(payload.monitor.url)}</code>`
  if (payload.responseTimeMs != null) text += `\n${payload.responseTimeMs}ms`

  const res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: config.chatId, text, parse_mode: 'HTML' }),
    signal,
  })

  await assertResponseOk(res, 'Telegram API')
}
