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
  close(): Promise<void>
}

function wrapSocket(socket: net.Socket, hostname: string): NodeSocketLike {
  let detach = () => {}
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      let ended = false
      const onData = (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk))
      const onEnd = () => { if (!ended) { ended = true; controller.close() } }
      const onError = (err: Error) => { if (!ended) { ended = true; controller.error(err) } }
      socket.on('data', onData)
      socket.on('end', onEnd)
      socket.on('error', onError)
      socket.on('close', onEnd)
      detach = () => {
        socket.off('data', onData)
        socket.off('end', onEnd)
        socket.off('error', onError)
        socket.off('close', onEnd)
      }
    },
    cancel() {
      detach()
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
      detach()
      const tlsSocket = tls.connect({ socket, servername: hostname, rejectUnauthorized: true })
      return wrapSocket(tlsSocket, hostname)
    },
    async close() {
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
    ? tls.connect({
        host: address.hostname,
        port: address.port,
        servername: address.hostname,
        rejectUnauthorized: true,
      })
    : net.connect({ host: address.hostname, port: address.port })

  return wrapSocket(socket, address.hostname)
}
