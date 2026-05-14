import { createHash } from 'node:crypto'
import type { Monitor } from '../db/schema'
import { msgTimeoutAfter } from '../notifications/messages'
import jp from 'jsonpath'

export interface CheckResult {
  status: 'up' | 'down'
  statusCode?: number
  responseTimeMs: number
  message: string
  sslError?: boolean
}

function isSslError(message: string): boolean {
  const lower = message.toLowerCase()
  return lower.includes('ssl') || lower.includes('certificate') || lower.includes('tls') || lower.includes('cert') || lower.includes('handshake')
}

export async function checkHttp(monitor: Monitor, locale = 'en'): Promise<CheckResult> {
  const start = Date.now()

  try {
    const headers: Record<string, string> = {}

    if (monitor.headers && monitor.headers !== '{}') {
      Object.assign(headers, JSON.parse(monitor.headers))
    }

    if (monitor.authType === 'bearer' && monitor.authToken) {
      headers['Authorization'] = `Bearer ${monitor.authToken}`
    } else if (monitor.authType === 'basic' && monitor.authUsername) {
      const creds = btoa(`${monitor.authUsername}:${monitor.authPassword ?? ''}`)
      headers['Authorization'] = `Basic ${creds}`
    }

    const method = monitor.method || 'GET'
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), (monitor.timeout || 30) * 1000)

    const init: RequestInit = {
      method,
      headers,
      redirect: monitor.followRedirects ? 'follow' : 'manual',
      signal: controller.signal,
    }

    if (monitor.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      init.body = monitor.body
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json'
      }
    }

    let targetUrl = monitor.url!
    if (monitor.cacheBooster) {
      const sep = targetUrl.includes('?') ? '&' : '?'
      targetUrl = `${targetUrl}${sep}pingflare=${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`
    }

    const response = await fetch(targetUrl, init)
    clearTimeout(timeoutId)
    const responseTimeMs = Date.now() - start

    if (monitor.authType === 'digest' && response.status === 401) {
      const digestResult = await doDigestAuth(monitor, response, method, responseTimeMs)
      if (digestResult) return digestResult
    }

    const expectedStatus = monitor.expectedStatus || 200
    if (response.status === expectedStatus) {
      if (monitor.jsonPath) {
        try {
          const bodyText = await response.text()
          const jsonData = JSON.parse(bodyText)
          const matched = jp.query(jsonData, monitor.jsonPath)

          if (matched.length === 0) {
            return { status: 'down', statusCode: response.status, responseTimeMs, message: `JSON query '${monitor.jsonPath}' not found` }
          }

          if (monitor.expectedValue !== null && monitor.expectedValue !== undefined) {
            const firstMatch = String(matched[0])
            if (firstMatch !== String(monitor.expectedValue)) {
              return { status: 'down', statusCode: response.status, responseTimeMs, message: `JSON value '${firstMatch}' != expected '${monitor.expectedValue}'` }
            }
          }
        } catch (e) {
          return { status: 'down', statusCode: response.status, responseTimeMs, message: `Failed to parse JSON for query: ${String(e)}` }
        }
      }
      return { status: 'up', statusCode: response.status, responseTimeMs, message: `HTTP ${response.status}` }
    }
    return { status: 'down', statusCode: response.status, responseTimeMs, message: `HTTP ${response.status} (expected ${expectedStatus})` }

  } catch (err) {
    const responseTimeMs = Date.now() - start
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'down', responseTimeMs, message: msgTimeoutAfter(locale, monitor.timeout ?? 30) }
    }
    const msg = String(err)
    return { status: 'down', responseTimeMs, message: msg, sslError: isSslError(msg) }
  }
}

async function doDigestAuth(
  monitor: Monitor,
  firstResponse: Response,
  method: string,
  firstRtt: number,
): Promise<CheckResult | null> {
  const wwwAuth = firstResponse.headers.get('WWW-Authenticate')
  if (!wwwAuth || !wwwAuth.toLowerCase().startsWith('digest')) return null

  const parse = (key: string) => {
    const m = wwwAuth.match(new RegExp(`${key}="([^"]+)"`))
    return m ? m[1] : ''
  }

  const realm  = parse('realm')
  const nonce  = parse('nonce')
  const qop    = wwwAuth.includes('qop=') ? 'auth' : ''
  const uri    = new URL(monitor.url!).pathname || '/'
  const nc     = '00000001'
  const cnonce = crypto.randomUUID().replace(/-/g, '').slice(0, 16)

  const md5 = (s: string) => createHash('md5').update(s).digest('hex')

  const ha1 = md5(`${monitor.authUsername}:${realm}:${monitor.authPassword ?? ''}`)
  const ha2 = md5(`${method}:${uri}`)
  const response = qop
    ? md5(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
    : md5(`${ha1}:${nonce}:${ha2}`)

  let authHeader = `Digest username="${monitor.authUsername}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`
  if (qop) authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`

  const headers: Record<string, string> = { Authorization: authHeader }
  if (monitor.headers && monitor.headers !== '{}') Object.assign(headers, JSON.parse(monitor.headers))

  const start2 = Date.now()
  try {
    const controller = new AbortController()
    const tid = setTimeout(() => controller.abort(), (monitor.timeout || 30) * 1000)
    const res2 = await fetch(monitor.url!, { method, headers, signal: controller.signal })
    clearTimeout(tid)
    const responseTimeMs = firstRtt + (Date.now() - start2)
    const expected = monitor.expectedStatus || 200
    if (res2.status === expected) {
      return { status: 'up', statusCode: res2.status, responseTimeMs, message: `HTTP ${res2.status} (digest)` }
    }
    return { status: 'down', statusCode: res2.status, responseTimeMs, message: `HTTP ${res2.status} (expected ${expected})` }
  } catch (err) {
    return { status: 'down', responseTimeMs: firstRtt, message: String(err) }
  }
}
