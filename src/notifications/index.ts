import type { NotificationChannel } from '../db/schema'
import { sendDiscord } from './discord'
import { sendSlack } from './slack'
import { sendTelegram } from './telegram'
import { sendEmail } from './email'
import { sendNtfy } from './ntfy'
import { sendPushover } from './pushover'
import { sendWebhook } from './webhook'
import { sendApprise } from './apprise'
import { sendGoogleChat } from './googlechat'
import { sendMSTeams } from './msteams'
import { sendPagerDuty } from './pagerduty'
import { sendMatrix } from './matrix'
import { sendTwilio } from './twilio'
import { SENSITIVE_FIELDS, isEncryptedValue, decryptField } from '../utils'
export { formatMessage } from './messages'

export interface NotificationPayload {
  type: 'alert' | 'recovery' | 'callback' | 'reminder'
  monitor: { id: string; name: string; type: string; url?: string | null }
  status: 'up' | 'down'
  message: string
  responseTimeMs?: number | null
  incidentStartedAt?: number | null
  locale?: string
}

export async function sendNotification(
  channel: NotificationChannel,
  payload: NotificationPayload,
  encryptionKey?: string,
): Promise<void> {
  const config = JSON.parse(channel.config) as Record<string, string>
  if (encryptionKey) {
    for (const field of SENSITIVE_FIELDS[channel.type] ?? []) {
      if (config[field] && isEncryptedValue(config[field])) {
        config[field] = await decryptField(config[field], encryptionKey)
      }
    }
  }
  const locale = payload.locale ?? 'en'
  switch (channel.type) {
    case 'discord':  return sendDiscord(config, payload, locale)
    case 'slack':    return sendSlack(config, payload, locale)
    case 'telegram': return sendTelegram(config, payload, locale)
    case 'email':    return sendEmail(config, payload, locale)
    case 'ntfy':     return sendNtfy(config, payload, locale)
    case 'pushover': return sendPushover(config, payload, locale)
    case 'webhook':     return sendWebhook(config, payload)
    case 'apprise':     return sendApprise(config, payload, locale)
    case 'googlechat':  return sendGoogleChat(config, payload, locale)
    case 'msteams':     return sendMSTeams(config, payload, locale)
    case 'pagerduty':   return sendPagerDuty(config, payload, locale)
    case 'matrix':      return sendMatrix(config, payload, locale)
    case 'twilio':      return sendTwilio(config, payload, locale)
    default: throw new Error(`Unsupported notification channel type: ${String(channel.type)}`)
  }
}
