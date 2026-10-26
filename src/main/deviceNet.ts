// The wire between paired Macs: TCP on the local network, length-prefixed frames, and the
// authenticated encryption from devicePairing.ts. Bonjour would need a native add-on, so Macs
// are found by the address the other Mac shows (host:port); there is no third-party server.
import net from 'node:net'
import type { PeerRequest, PeerResponse, PeerTransport } from '../shared/transfer'
import { PairingGuest, newNonce, sessionKeys, type PairingHost, type PairingMessage, type PairingPeer, type PairingResult, type SessionKeys } from './devicePairing'

export const DEFAULT_DEVICE_PORT = 47631
const MAX_FRAME = 2 * 1024 * 1024
const CHUNK = 1024 * 1024
/** A hand-off bigger than this is refused (it is held in memory on both ends). */
export const MAX_TRANSFER_BYTES = 512 * 1024 * 1024
const CONNECT_MS = 6_000
const REQUEST_MS = 60_000

/** Reads length-prefixed frames off a socket, one at a time. */
class Frames {
  private chunks: Buffer[] = []
  private size = 0
  private waiters: { resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = []
  private error: Error | null = null

  constructor(readonly socket: net.Socket) {
    socket.on('data', (d: Buffer) => {
      this.chunks.push(d)
      this.size += d.length
      this.pump()
    })
    const fail = (e: Error) => {
      this.error ??= e
      for (const w of this.waiters.splice(0)) w.reject(this.error)
    }
    socket.on('error', fail)
    socket.on('close', () => fail(new Error('The connection closed.')))
    socket.on('timeout', () => {
      fail(new Error('The other Mac stopped answering.'))
      socket.destroy()
    })
  }

  private take(n: number): Buffer {
    const all = Buffer.concat(this.chunks)
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    this.chunks = rest.length ? [rest] : []
    this.size = rest.length
    return out
  }

  private pump(): void {
    while (this.waiters.length && this.size >= 4) {
      const head = Buffer.concat(this.chunks).readUInt32BE(0)
      if (head > MAX_FRAME) {
        this.error = new Error('A frame was too large.')
        this.socket.destroy()
        for (const w of this.waiters.splice(0)) w.reject(this.error)
        return
      }
      if (this.size < 4 + head) return
      const frame = this.take(4 + head).subarray(4)
      this.waiters.shift()!.resolve(Buffer.from(frame))
    }
  }

  next(): Promise<Buffer> {
    if (this.error && this.size < 4) return Promise.reject(this.error)
    return new Promise((resolve, reject) => {
      this.waiters.push({ resolve, reject })
      this.pump()
    })
  }

  write(payload: Buffer): void {
    const head = Buffer.alloc(4)
    head.writeUInt32BE(payload.length)
    this.socket.write(Buffer.concat([head, payload]))
  }
}

const json = (value: unknown) => Buffer.from(JSON.stringify(value))
const parse = <T>(buf: Buffer): T => JSON.parse(buf.toString('utf8')) as T

export interface DeviceNetDeps {
  self(): PairingPeer
  /** The shared key of a paired Mac (hex), if this id is paired. */
  keyFor(deviceId: string): string | undefined
  /** Where to dial a paired Mac. */
  addressOf(deviceId: string): { host: string; port: number } | undefined
  /** A paired Mac just talked to us. */
  seen(deviceId: string): void
  /** A request from a paired Mac. */
  onRequest(from: string, request: PeerRequest, file?: Buffer): Promise<PeerResponse>
  /** The code being shown right now, if any. */
  pairingHost(): PairingHost | undefined
  /** A guest proved the code. */
  onPaired(result: PairingResult, address?: string): void
}

/** The listener and the dialer for hand-offs and pairing. */
export class DeviceNet implements PeerTransport {
  private server: net.Server | null = null

  constructor(private deps: DeviceNetDeps) {}

  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  listen(port = DEFAULT_DEVICE_PORT, host = '0.0.0.0'): Promise<number> {
    if (this.server) return Promise.resolve(this.port ?? port)
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => void this.serve(socket).catch(() => socket.destroy()))
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        this.server = server
        resolve(this.port ?? port)
      })
    })
  }

  close(): Promise<void> {
    const server = this.server
    this.server = null
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()))
  }

  // ---- serving ----

  private async serve(socket: net.Socket): Promise<void> {
    socket.setTimeout(REQUEST_MS)
    const frames = new Frames(socket)
    const first = parse<{ t: string } & Record<string, unknown>>(await frames.next())
    if (first.t === 'pair-hello') return this.servePairing(frames, first as unknown as PairingMessage, socket)
    if (first.t !== 'hello' || typeof first.deviceId !== 'string' || typeof first.nonce !== 'string') return void socket.destroy()
    const key = this.deps.keyFor(first.deviceId)
    if (!key) return void socket.destroy()
    const clientNonce = Buffer.from(first.nonce, 'hex')
    const serverNonce = newNonce()
    frames.write(json({ t: 'hello', deviceId: this.deps.self().deviceId, nonce: serverNonce.toString('hex') }))
    const keys = sessionKeys(key, clientNonce, serverNonce, false)
    // A peer without the key fails to decrypt here and is dropped.
    const header = parse<{ request: PeerRequest; fileBytes?: number }>(keys.open(await frames.next()))
    const file = header.fileBytes ? await this.readFile(frames, keys, header.fileBytes) : undefined
    this.deps.seen(first.deviceId)
    // Staging a large file can take a while; the sender's own timeout decides when to give up.
    socket.setTimeout(0)
    let response: PeerResponse
    try {
      response = await this.deps.onRequest(first.deviceId, header.request, file)
    } catch (err) {
      response = { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
    frames.write(keys.seal(json(response)))
    socket.end()
  }

  private async servePairing(frames: Frames, hello: PairingMessage, socket: net.Socket): Promise<void> {
    const host = this.deps.pairingHost()
    if (!host) {
      frames.write(json({ t: 'pair-error', error: 'This Mac isn’t showing a pairing code.' } satisfies PairingMessage))
      return void socket.end()
    }
    const first = host.receive(hello)
    frames.write(json(first.reply))
    if (first.reply.t === 'pair-error') return void socket.end()
    const confirm = host.receive(parse<PairingMessage>(await frames.next()))
    frames.write(json(confirm.reply))
    if (confirm.result) this.deps.onPaired(confirm.result, socket.remoteAddress)
    socket.end()
  }

  private async readFile(frames: Frames, keys: SessionKeys, bytes: number): Promise<Buffer> {
    if (bytes > MAX_TRANSFER_BYTES) throw new Error('That file is larger than this Mac will accept.')
    const parts: Buffer[] = []
    let got = 0
    while (got < bytes) {
      const part = keys.open(await frames.next())
      parts.push(part)
      got += part.length
    }
    if (got !== bytes) throw new Error('The file arrived with the wrong size.')
    return Buffer.concat(parts)
  }

  // ---- dialing ----

  private connect(host: string, port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Couldn’t reach ${host}:${port}.`))
      }, CONNECT_MS)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(new Error(`Couldn’t reach ${host}:${port}: ${err.message}`))
      })
    })
  }

  async send(peerId: string, request: PeerRequest, file?: Buffer, options: { timeoutMs?: number } = {}): Promise<PeerResponse> {
    const key = this.deps.keyFor(peerId)
    const address = this.deps.addressOf(peerId)
    if (!key || !address) throw new Error('That Mac isn’t paired, or its address isn’t known.')
    if (file && file.length > MAX_TRANSFER_BYTES) throw new Error('That is larger than a hand-off can carry.')
    const socket = await this.connect(address.host, address.port)
    socket.setTimeout(options.timeoutMs ?? REQUEST_MS)
    const frames = new Frames(socket)
    try {
      const clientNonce = newNonce()
      frames.write(json({ t: 'hello', deviceId: this.deps.self().deviceId, nonce: clientNonce.toString('hex') }))
      const reply = parse<{ t: string; deviceId: string; nonce: string }>(await frames.next())
      if (reply.t !== 'hello' || reply.deviceId !== peerId) throw new Error('That Mac isn’t the one that was paired.')
      const keys = sessionKeys(key, clientNonce, Buffer.from(reply.nonce, 'hex'), true)
      frames.write(keys.seal(json({ request, fileBytes: file?.length })))
      if (file) for (let at = 0; at < file.length; at += CHUNK) frames.write(keys.seal(file.subarray(at, at + CHUNK)))
      const response = parse<PeerResponse>(keys.open(await frames.next()))
      this.deps.seen(peerId)
      return response
    } finally {
      socket.destroy()
    }
  }

  /** Pair with the Mac showing `code` at host:port. */
  async pairWith(host: string, port: number, code: string): Promise<PairingResult> {
    const socket = await this.connect(host, port)
    socket.setTimeout(15_000)
    const frames = new Frames(socket)
    try {
      const guest = new PairingGuest(this.deps.self(), code)
      frames.write(json(guest.hello()))
      const confirm = guest.confirm(parse<PairingMessage>(await frames.next()))
      frames.write(json(confirm))
      return guest.finish(parse<PairingMessage>(await frames.next()))
    } finally {
      socket.destroy()
    }
  }
}
