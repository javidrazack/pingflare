import { connect } from 'cloudflare:sockets'
import type { NotificationPayload } from './index'
import { typeLabel as getTypeLabel, metaFields } from './messages'

function utf8ToBase64(str: string): string {
  const bytes = new TextEncoder().encode(str)
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary)
}

function encodeHeader(value: string): string {
  value = value.replace(/[\r\n]+/g, ' ')
  if (/[^\x00-\x7f]/.test(value)) return `=?UTF-8?B?${utf8ToBase64(value)}?=`
  return value
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function sanitizeAddress(value: string): string {
  return value.replace(/[\r\n]/g, '').trim()
}

class SmtpConnection {
  private reader: ReadableStreamDefaultReader<Uint8Array>
  private writer: WritableStreamDefaultWriter<Uint8Array>
  private decoder = new TextDecoder()
  private encoder = new TextEncoder()
  private buf = ''

  constructor(
    socket: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
    private readonly signal?: AbortSignal,
  ) {
    this.reader = socket.readable.getReader()
    this.writer = socket.writable.getWriter()
  }

  async readResponse(): Promise<number> {
    this.signal?.throwIfAborted()
    while (true) {
      const idx = this.buf.indexOf('\r\n')
      if (idx !== -1) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 2)
        const code = parseInt(line.slice(0, 3), 10)
        if (line[3] !== '-') return code
        continue
      }
      const { done, value } = await this.reader.read()
      if (done) {
        this.signal?.throwIfAborted()
        throw new Error('SMTP: connection closed unexpectedly')
      }
      this.buf += this.decoder.decode(value, { stream: true })
    }
  }

  async cmd(command: string, expect: number): Promise<void> {
    this.signal?.throwIfAborted()
    await this.writer.write(this.encoder.encode(command + '\r\n'))
    const code = await this.readResponse()
    if (code !== expect) throw new Error(`SMTP: expected ${expect}, got ${code} (${command.split(' ')[0]})`)
  }

  async sendData(message: string): Promise<void> {
    this.signal?.throwIfAborted()
    await this.writer.write(this.encoder.encode('DATA\r\n'))
    const code = await this.readResponse()
    if (code !== 354) throw new Error(`SMTP: expected 354 for DATA, got ${code}`)
    const stuffed = message.replace(/^\./gm, '..')
    await this.writer.write(this.encoder.encode(stuffed + '\r\n.\r\n'))
    const end = await this.readResponse()
    if (end !== 250) throw new Error(`SMTP: message rejected with ${end}`)
  }

  release(): void {
    this.reader.releaseLock()
    this.writer.releaseLock()
  }
}

export async function sendEmail(
  config: Record<string, string>,
  payload: NotificationPayload,
  locale: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted()
  const { host, port, user, password, from, to } = config
  const smtpPort = parseInt(port ?? '587', 10)
  const implicitTLS = smtpPort === 465

  const icon = payload.status === 'up' ? '✅' : '🔴'
  const label = getTypeLabel(payload.type, locale)
  const subject = `${icon} ${label}: ${payload.monitor.name}`

  const bodyLines = [`<h2>${escapeHtml(subject)}</h2>`]
  if (payload.message) bodyLines.push(`<p>${escapeHtml(payload.message)}</p>`)

  for (const field of metaFields(payload, locale)) {
    bodyLines.push(`<p><b>${escapeHtml(field.name)}:</b> ${escapeHtml(String(field.value))}</p>`)
  }

  const sender = sanitizeAddress(from)
  const recipients = to.split(',').map(sanitizeAddress).filter(Boolean)
  if (!sender || recipients.length === 0) throw new Error('SMTP sender and recipient are required')

  const message = [
    `Date: ${new Date().toUTCString()}`,
    `From: ${sender}`,
    `To: ${recipients.join(', ')}`,
    `Subject: ${encodeHeader(subject)}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/html; charset=UTF-8`,
    `Content-Transfer-Encoding: 8bit`,
    ``,
    bodyLines.join('\n'),
  ].join('\r\n')

  let socket = connect(
    { hostname: host, port: smtpPort },
    { secureTransport: implicitTLS ? 'on' : 'starttls', allowHalfOpen: false },
  )
  let conn = new SmtpConnection(socket, signal)
  const closeOnAbort = () => {
    void socket.close().catch(() => {})
  }
  signal?.addEventListener('abort', closeOnAbort, { once: true })

  try {
    await conn.readResponse()

    await conn.cmd('EHLO pingflare', 250)

    if (!implicitTLS) {
      await conn.cmd('STARTTLS', 220)
      conn.release()
      socket = socket.startTls()
      conn = new SmtpConnection(socket, signal)
      await conn.cmd('EHLO pingflare', 250)
    }

    await conn.cmd('AUTH LOGIN', 334)
    await conn.cmd(utf8ToBase64(user), 334)
    await conn.cmd(utf8ToBase64(password), 235)

    await conn.cmd(`MAIL FROM:<${sender}>`, 250)
    for (const rcpt of recipients) {
      await conn.cmd(`RCPT TO:<${rcpt}>`, 250)
    }

    await conn.sendData(message)

    await conn.cmd('QUIT', 221)
  } finally {
    signal?.removeEventListener('abort', closeOnAbort)
    try {
      conn.release()
    } catch {
      // The stream may already have released its lock during STARTTLS.
    }
    await socket.close().catch(() => {})
  }
}
