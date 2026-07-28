import type { NotificationPayload } from './index'
import { formatMessage } from './messages'
import { assertResponseOk } from './http'

export async function sendTwilio(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  const { accountSid, authToken, fromNumber, toNumber } = config
  if (!accountSid || !authToken || !fromNumber || !toNumber) {
    throw new Error('Missing accountSid, authToken, fromNumber, or toNumber for Twilio')
  }

  const text = formatMessage(payload, locale)

  const formData = new URLSearchParams()
  formData.append('To', toNumber)
  formData.append('From', fromNumber)
  formData.append('Body', text)

  const auth = btoa(`${accountSid}:${authToken}`)

  const url = `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${auth}`
    },
    body: formData.toString(),
    signal,
  })

  await assertResponseOk(res, 'Twilio')
}
