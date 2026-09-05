import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import tls from 'node:tls'
import net from 'node:net'
vi.mock('node:tls', () => ({ default: { connect: vi.fn() } }))
vi.mock('node:net', () => ({ default: { connect: vi.fn() } }))
vi.mock('cloudflare:sockets', async () => import('../shims/cloudflare-sockets'))
import { sendEmail } from '../notifications/email'
import { connect } from '../shims/cloudflare-sockets'

class FakeSocket extends EventEmitter {
  constructor(private responses: number[], greeting = true) {
    super()
    if (greeting) queueMicrotask(() => this.emit('data', Buffer.from('220 ready\r\n')))
  }
  write(_chunk: Uint8Array, callback: (error?: Error) => void) {
    callback()
    queueMicrotask(() => this.emit('data', Buffer.from(`${this.responses.shift()} response\r\n`)))
  }
  destroy() {}
  end(callback: () => void) { callback() }
}

describe('Node SMTP adapter contract', () => {
  const config = { host: 'mail.example.com', port: '465', user: 'synthetic-user', password: 'synthetic-password', from: 'a@example.com', to: 'b@example.com' }
  const payload = { message: 'Synthetic test', type: 'alert' as const, status: 'down' as const, monitor: { id: 'test', name: 'API', type: 'http' as const } }
  beforeEach(() => vi.clearAllMocks())

  it('completes successful SMTP delivery with the actual Node socket wrapper', async () => {
    vi.mocked(tls.connect).mockReturnValue(new FakeSocket([250, 334, 334, 235, 250, 250, 354, 250, 221]) as unknown as tls.TLSSocket)
    await expect(sendEmail(config, payload, 'en')).resolves.toBeUndefined()
    expect(tls.connect).toHaveBeenCalledWith(expect.objectContaining({ servername: config.host, rejectUnauthorized: true }))
  })

  it('never includes authentication payloads in SMTP errors', async () => {
    vi.mocked(tls.connect).mockReturnValue(new FakeSocket([250, 334, 334, 535]) as unknown as tls.TLSSocket)
    await expect(sendEmail(config, payload, 'en')).rejects.toThrow('SMTP: expected 235, got 535 (AUTH password)')
  })

  it('does not retry accepted mail when QUIT fails', async () => {
    vi.mocked(tls.connect).mockReturnValue(new FakeSocket([250, 334, 334, 235, 250, 250, 354, 250, 500]) as unknown as tls.TLSSocket)
    await expect(sendEmail(config, payload, 'en')).resolves.toBeUndefined()
  })

  it('finishes after DATA acceptance without waiting for a QUIT response', async () => {
    const socket = new FakeSocket([250, 334, 334, 235, 250, 250, 354, 250])
    const write = vi.spyOn(socket, 'write')
    vi.mocked(tls.connect).mockReturnValue(socket as unknown as tls.TLSSocket)
    await expect(sendEmail(config, payload, 'en')).resolves.toBeUndefined()
    expect(write.mock.calls.some(([chunk]) => new TextDecoder().decode(chunk).startsWith('QUIT'))).toBe(false)
  })

  it('does not close an already cancelled readable when the socket closes', async () => {
    const raw = new FakeSocket([], false)
    vi.mocked(net.connect).mockReturnValue(raw as unknown as net.Socket)
    const socket = connect({ hostname: config.host, port: 587 })
    await socket.readable.cancel()
    expect(() => raw.emit('close')).not.toThrow()
  })

  it('verifies STARTTLS host identity and detaches plaintext listeners', async () => {
    const plain = new FakeSocket([], false)
    vi.mocked(net.connect).mockReturnValue(plain as unknown as net.Socket)
    vi.mocked(tls.connect).mockReturnValue(new FakeSocket([], false) as unknown as tls.TLSSocket)
    const socket = connect({ hostname: config.host, port: 587 }, { secureTransport: 'starttls' })
    const secure = socket.startTls()
    expect(plain.listenerCount('data')).toBe(0)
    expect(tls.connect).toHaveBeenCalledWith({ socket: plain, servername: config.host, rejectUnauthorized: true })
    await expect(secure.close()).resolves.toBeUndefined()
  })
})
