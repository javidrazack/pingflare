export const SENSITIVE_FIELDS: Record<string, string[]> = {
  telegram: ['botToken'],
  email:    ['password'],
  ntfy:     ['token'],
  pushover: ['user'],
  webhook:  ['secret'],
  apprise:  ['token'],
  matrix:   ['accessToken'],
  pagerduty: ['routingKey'],
  twilio:   ['authToken'],
}

const ENCRYPTED_PREFIX = 'enc:'

async function deriveAesKey(secret: string): Promise<CryptoKey> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return crypto.subtle.importKey('raw', hash, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}

export function isEncryptedValue(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENCRYPTED_PREFIX)
}

export async function encryptField(value: string, secret: string): Promise<string> {
  const key = await deriveAesKey(secret)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(value))
  const ivB64 = btoa(String.fromCharCode(...iv))
  const ctB64 = btoa(String.fromCharCode(...new Uint8Array(ct)))
  return `${ENCRYPTED_PREFIX}${ivB64}:${ctB64}`
}

export async function decryptField(encrypted: string, secret: string): Promise<string> {
  if (!isEncryptedValue(encrypted)) return encrypted
  const rest = encrypted.slice(ENCRYPTED_PREFIX.length)
  const colonIdx = rest.indexOf(':')
  const iv = Uint8Array.from(atob(rest.slice(0, colonIdx)), c => c.charCodeAt(0))
  const ct = Uint8Array.from(atob(rest.slice(colonIdx + 1)), c => c.charCodeAt(0))
  const key = await deriveAesKey(secret)
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(plain)
}

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

export async function hashPassword(password: string): Promise<string> {
  const enc = new TextEncoder()
  const salt = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map(b => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 10000 },
    key,
    256,
  )
  const hash = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
  return `${salt}:${hash}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const colonIdx = stored.indexOf(':')
  if (colonIdx === -1) {
    return (await sha256(password)) === stored
  }
  const salt = stored.slice(0, colonIdx)
  const hash = stored.slice(colonIdx + 1)
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: 10000 },
    key,
    256,
  )
  const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('')
  return computed === hash
}
