import { isEncryptedValue } from '../utils'

function hasValue(config: Record<string, string>, key: string): boolean {
  return typeof config[key] === 'string' && config[key].trim().length > 0
}

function isSlackWebhookUrl(value: string): boolean {
  if (isEncryptedValue(value)) return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && (url.hostname === 'hooks.slack.com' || url.hostname === 'hooks.slack-gov.com')
      && url.pathname.startsWith('/services/')
  } catch {
    return false
  }
}

function isTelegramBotToken(value: string): boolean {
  return isEncryptedValue(value) || /^\d+:[A-Za-z0-9_-]{20,}$/.test(value)
}

function isTelegramChatId(value: string): boolean {
  return /^-?\d+$/.test(value) || /^@[A-Za-z0-9_]{5,}$/.test(value)
}

/**
 * Validate credentials whose structure Pingflare can safely check without a
 * network request. Provider-side delivery tests remain the final authority.
 */
export function validateNotificationConfig(
  type: string,
  config: Record<string, string>,
): string | null {
  if (type === 'slack') {
    if (!hasValue(config, 'webhookUrl')) return 'Slack webhook URL is required'
    if (!isSlackWebhookUrl(config.webhookUrl)) {
      return 'Enter a valid Slack incoming webhook URL from hooks.slack.com'
    }
  }

  if (type === 'telegram') {
    if (!hasValue(config, 'botToken')) return 'Telegram bot token is required'
    if (!isTelegramBotToken(config.botToken)) {
      return 'Enter the bot token provided by BotFather'
    }
    if (!hasValue(config, 'chatId')) return 'Telegram chat ID is required'
    if (!isTelegramChatId(config.chatId.trim())) {
      return 'Enter a numeric Telegram chat ID or a public @channel username'
    }
  }

  return null
}
