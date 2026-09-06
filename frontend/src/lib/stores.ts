import { writable } from 'svelte/store'
import type { MonitorSummary, NotificationChannel } from './api'

export const token = writable<string | null>(
  typeof localStorage !== 'undefined' ? localStorage.getItem('token') : null,
)
token.subscribe(v => {
  if (typeof localStorage !== 'undefined') {
    if (v) localStorage.setItem('token', v)
    else localStorage.removeItem('token')
  }
})

function createTheme() {
  const initial = typeof localStorage !== 'undefined'
    ? (localStorage.getItem('theme') ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'))
    : 'dark'

  const { subscribe, set, update } = writable<'light' | 'dark'>(initial as 'light' | 'dark')

  return {
    subscribe,
    toggle() {
      update(current => {
        const next: 'light' | 'dark' = current === 'dark' ? 'light' : 'dark'
        localStorage.setItem('theme', next)
        document.documentElement.classList.toggle('dark', next === 'dark')
        return next
      })
    },
    setTheme(t: 'light' | 'dark') {
      localStorage.setItem('theme', t)
      document.documentElement.classList.toggle('dark', t === 'dark')
      set(t)
    },
  }
}
export const theme = createTheme()

export const monitors = writable<MonitorSummary[]>([])
export const channels = writable<NotificationChannel[]>([])

export const dashboardHealth = writable<{ up: number; down: number; pending: number; stale: number } | null>(null)
