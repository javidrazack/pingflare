/**
 * Node.js shim for the Cloudflare Workers `cloudflare:sockets` API.
 *
 * Used exclusively during the Node.js / Docker build (via tsup alias).
 * The Cloudflare Workers build continues to use the real module.
 *
 * Implements the subset used by src/notifications/email.ts:
 *   connect(address, options) → { readable, writable, startTls(), close() }
 */

import net from 'node:net'
import tls from 'node:tls'

interface NodeSocketLike {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
  startTls(): NodeSocketLike
  close(): void
}

function wrapSocket(socket: net.Socket): NodeSocketLike {
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      socket.on('data', (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)))
      socket.on('end', () => controller.close())
      socket.on('error', (err) => controller.error(err))
    },
    cancel() {
      socket.destroy()
    },
  })

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      return new Promise<void>((resolve, reject) => {
        socket.write(chunk, (err) => (err ? reject(err) : resolve()))
      })
    },
    close() {
      return new Promise<void>((resolve) => socket.end(() => resolve()))
    },
    abort() {
      socket.destroy()
    },
  })

  return {
    readable,
    writable,
    startTls(): NodeSocketLike {
      // Upgrade the existing TCP connection to TLS (STARTTLS pattern).
      // tls.TLSSocket buffers writes until the handshake completes, so
      // SmtpConnection.cmd() works correctly without any extra awaiting.
      const tlsSocket = tls.connect({ socket, rejectUnauthorized: false })
      return wrapSocket(tlsSocket as unknown as net.Socket)
    },
    close() {
      socket.destroy()
    },
  }
}

export function connect(
  address: { hostname: string; port: number },
  options?: { secureTransport?: string; allowHalfOpen?: boolean },
): NodeSocketLike {
  const implicitTLS = options?.secureTransport === 'on'

  const socket = implicitTLS
    ? (tls.connect({
        host: address.hostname,
        port: address.port,
        rejectUnauthorized: false,
      }) as unknown as net.Socket)
    : net.connect({ host: address.hostname, port: address.port })

  return wrapSocket(socket)
}
