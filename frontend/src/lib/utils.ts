import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import enLocale from '$locales/en.json'
import ptBRLocale from '$locales/pt-BR.json'

type LocaleData = Record<string, string>
const _localeFiles: Record<string, LocaleData> = {
  en: enLocale as LocaleData,
  'pt-BR': ptBRLocale as LocaleData,
}
function _tl(locale: string, key: string): string {
  return _localeFiles[locale]?.[key] ?? _localeFiles.en[key] ?? key
}

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatUptime(uptime: number | null): string {
  if (uptime === null) return '-'
  return `${uptime.toFixed(2)}%`
}

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '-'
  if (seconds < 60) return `${seconds}s`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}h ${m}m`
}

export function formatRelative(ts: number | null, locale = 'en'): string {
  if (!ts) return _tl(locale, 'time.never')
  const diff = Math.floor(Date.now() / 1000) - ts
  if (diff < 60) return _tl(locale, 'time.secondsAgo').replace('{n}', String(diff))
  if (diff < 3600) return _tl(locale, 'time.minutesAgo').replace('{n}', String(Math.floor(diff / 60)))
  if (diff < 86400) return _tl(locale, 'time.hoursAgo').replace('{n}', String(Math.floor(diff / 3600)))
  return _tl(locale, 'time.daysAgo').replace('{n}', String(Math.floor(diff / 86400)))
}

export function formatTs(ts: number): string {
  return new Date(ts * 1000).toLocaleString()
}

export function parseTags(tags: string): string[] {
  try { return JSON.parse(tags) } catch { return [] }
}

export function statusColor(status: 'up' | 'down' | 'pending'): string {
  if (status === 'up') return 'text-green-500'
  if (status === 'down') return 'text-red-400'
  return 'text-primary'
}

export function channelTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    discord: 'Discord', slack: 'Slack', telegram: 'Telegram',
    email: 'Email', ntfy: 'ntfy', pushover: 'Pushover',
    webhook: 'Webhook', apprise: 'Apprise API', googlechat: 'Google Chat',
    msteams: 'Microsoft Teams', matrix: 'Matrix',
    pagerduty: 'PagerDuty', twilio: 'Twilio SMS',
  }
  return labels[type] ?? type
}

export function channelTypeIcon(type: string): string {
  const icons: Record<string, string> = {
    discord: '💬', slack: '🔔', telegram: '✈️',
    email: '📧', ntfy: '📣', pushover: '📱',
    webhook: '🔗', apprise: '🔀', googlechat: '💼',
    msteams: '👥', matrix: '💬', pagerduty: '🚨', twilio: '📲',
  }
  return icons[type] ?? '🔔'
}
