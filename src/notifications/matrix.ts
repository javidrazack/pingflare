import type { NotificationPayload } from './index'
import { formatMessage } from './messages'

export async function sendMatrix(config: Record<string, string>, payload: NotificationPayload, locale: string): Promise<void> {
  const { homeserverUrl, accessToken, roomId } = config
  if (!homeserverUrl || !accessToken || !roomId) throw new Error('Missing homeserverUrl, accessToken, or roomId for Matrix')

  const text = formatMessage(payload, locale)
  const formattedBody = payload.status === 'down' ? `🔴 <b>[${payload.monitor.name}] DOWN</b><br>${text}` : `🟢 <b>[${payload.monitor.name}] UP</b><br>${text}`

  const url = `${homeserverUrl.replace(/\/$/, '')}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message?access_token=${accessToken}`

  const body = {
    msgtype: 'm.text',
    format: 'org.matrix.custom.html',
    body: text,
    formatted_body: formattedBody
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Matrix error: ${res.status} ${err}`)
  }
}
