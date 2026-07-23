import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

export async function sendMatrix(config: Record<string, string>, payload: NotificationPayload, locale: string): Promise<void> {
  const { homeserverUrl, accessToken, roomId } = config
  if (!homeserverUrl || !accessToken || !roomId) throw new Error('Missing homeserverUrl, accessToken, or roomId for Matrix')

  const text = formatMessage(payload, locale)
  const formattedBody = payload.status === 'down'
    ? `🔴 <b>[${escapeHtml(payload.monitor.name)}] DOWN</b><br>${escapeHtml(text)}`
    : `🟢 <b>[${escapeHtml(payload.monitor.name)}] UP</b><br>${escapeHtml(text)}`

  const transactionId = crypto.randomUUID()
  const url = `${homeserverUrl.replace(/\/$/, '')}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${transactionId}`

  const body = {
    msgtype: 'm.text',
    format: 'org.matrix.custom.html',
    body: text,
    formatted_body: formattedBody
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })

  await assertResponseOk(res, 'Matrix')
}
