// Pairing two Macs, and the encrypted channel they use afterwards. Local network only; no
// third-party server and no certificates to manage.
//
// Pairing: one Mac shows a 6-digit code, the other enters it. Both sides make an ephemeral X25519
// key and prove they know the code by sending an HMAC under the shared secret that covers both
// public keys. A passive listener can't compute the shared secret, so it can't test guesses of
// the code; someone in the middle gets exactly one guess (the code is spent by the first
// confirmation, right or wrong), and codes expire. A successful pairing leaves both sides with
// the same 32-byte key, which is all later connections need.
//
// Afterwards: each connection exchanges nonces, derives a session key from the paired key, and
// every frame is AES-256-GCM with a counter nonce, so the peer must hold the key to say anything.
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, randomInt, timingSafeEqual, type KeyObject } from 'node:crypto'

export const PAIRING_TTL_MS = 2 * 60_000

export interface PairingPeer {
  deviceId: string
  name: string
  // Where this Mac listens for hand-offs, so the other one can dial it later.
  port?: number
}

export type PairingMessage =
  | { t: 'pair-hello'; deviceId: string; name: string; pub: string; port?: number }
  | { t: 'pair-confirm'; mac: string }
  | { t: 'pair-error'; error: string }

export interface PairingResult {
  peer: PairingPeer
  // The long-lived shared key (hex). Store it with the peer's id.
  key: string
}

export const newPairingCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, '0')

const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex')

function publicFrom(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([X25519_SPKI, raw]), format: 'der', type: 'spki' })
}

function ephemeral(): { pub: Buffer; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('x25519')
  return { pub: publicKey.export({ format: 'der', type: 'spki' }).subarray(X25519_SPKI.length), priv: privateKey }
}

const kdf = (secret: Buffer, info: string, salt = Buffer.alloc(0)) => Buffer.from(hkdfSync('sha256', secret, salt, info, 32))

function mac(secret: Buffer, role: 'guest' | 'host', code: string, guestPub: string, hostPub: string): string {
  return createHmac('sha256', kdf(secret, 'foreman-pair-mac')).update(`${role}|${code}|${guestPub}|${hostPub}`).digest('hex')
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

/** The Mac that shows the code and waits. One guest, one confirmation; the code is spent after that. */
export class PairingHost {
  private spent = false
  private guest?: { peer: PairingPeer; secret: Buffer; guestPub: string; hostPub: string }
  readonly expiresAt: number

  constructor(
    private self: PairingPeer,
    readonly code: string,
    private now: () => number = Date.now,
    ttlMs = PAIRING_TTL_MS
  ) {
    this.expiresAt = now() + ttlMs
  }

  get expired(): boolean {
    return this.spent || this.now() > this.expiresAt
  }

  /** Handles the guest's next message. Returns the reply and, once the guest proved the code, the result. */
  receive(message: PairingMessage): { reply: PairingMessage; result?: PairingResult } {
    if (this.expired) return { reply: { t: 'pair-error', error: 'This code has expired or was already used. Show a new one.' } }
    if (message.t === 'pair-hello' && !this.guest) {
      const mine = ephemeral()
      const hostPub = mine.pub.toString('base64')
      let secret: Buffer
      try {
        secret = diffieHellman({ privateKey: mine.priv, publicKey: publicFrom(Buffer.from(message.pub, 'base64')) })
      } catch {
        this.spent = true
        return { reply: { t: 'pair-error', error: 'That wasn’t a valid pairing request.' } }
      }
      this.guest = { peer: { deviceId: message.deviceId, name: message.name, port: message.port }, secret, guestPub: message.pub, hostPub }
      return { reply: { t: 'pair-hello', deviceId: this.self.deviceId, name: this.self.name, pub: hostPub, port: this.self.port } }
    }
    if (message.t === 'pair-confirm' && this.guest) {
      // Spent by the first confirmation, whether or not it was right: one guess per code.
      this.spent = true
      const g = this.guest
      if (!same(message.mac, mac(g.secret, 'guest', this.code, g.guestPub, g.hostPub))) return { reply: { t: 'pair-error', error: 'The code didn’t match.' } }
      return {
        reply: { t: 'pair-confirm', mac: mac(g.secret, 'host', this.code, g.guestPub, g.hostPub) },
        result: { peer: g.peer, key: kdf(g.secret, 'foreman-pair-key').toString('hex') }
      }
    }
    this.spent = true
    return { reply: { t: 'pair-error', error: 'Unexpected pairing message.' } }
  }
}

/** The Mac that types the code in. */
export class PairingGuest {
  private mine = ephemeral()
  private host?: { peer: PairingPeer; secret: Buffer; hostPub: string }

  constructor(
    private self: PairingPeer,
    private code: string
  ) {}

  hello(): PairingMessage {
    return { t: 'pair-hello', deviceId: this.self.deviceId, name: this.self.name, pub: this.mine.pub.toString('base64'), port: this.self.port }
  }

  /** The host's hello: answer with the confirmation. */
  confirm(reply: PairingMessage): PairingMessage {
    if (reply.t === 'pair-error') throw new Error(reply.error)
    if (reply.t !== 'pair-hello') throw new Error('Unexpected pairing reply.')
    let secret: Buffer
    try {
      secret = diffieHellman({ privateKey: this.mine.priv, publicKey: publicFrom(Buffer.from(reply.pub, 'base64')) })
    } catch {
      throw new Error('The other Mac sent an invalid key.')
    }
    this.host = { peer: { deviceId: reply.deviceId, name: reply.name, port: reply.port }, secret, hostPub: reply.pub }
    return { t: 'pair-confirm', mac: mac(secret, 'guest', this.code, this.mine.pub.toString('base64'), reply.pub) }
  }

  /** The host's confirmation proves it knew the code too. */
  finish(reply: PairingMessage): PairingResult {
    if (reply.t === 'pair-error') throw new Error(reply.error)
    if (reply.t !== 'pair-confirm' || !this.host) throw new Error('Unexpected pairing reply.')
    const h = this.host
    if (!same(reply.mac, mac(h.secret, 'host', this.code, this.mine.pub.toString('base64'), h.hostPub))) throw new Error('The other Mac did not know the code.')
    return { peer: h.peer, key: kdf(h.secret, 'foreman-pair-key').toString('hex') }
  }
}

// ---- the encrypted channel ----

export interface SessionKeys {
  /** Encrypts what this side sends. */
  seal(plain: Buffer): Buffer
  /** Decrypts what the other side sent; throws if it wasn't made with the key or was changed. */
  open(frame: Buffer): Buffer
}

/** Both sides call this with the same two nonces (client's first). `client` says which end this is. */
export function sessionKeys(pairedKey: string, clientNonce: Buffer, serverNonce: Buffer, client: boolean): SessionKeys {
  const key = kdf(Buffer.from(pairedKey, 'hex'), 'foreman-session', Buffer.concat([clientNonce, serverNonce]))
  let sent = 0n
  let received = 0n
  // The direction is part of the nonce, so the two sides never use the same one.
  const nonce = (direction: number, counter: bigint) => {
    const n = Buffer.alloc(12)
    n[0] = direction
    n.writeBigUInt64BE(counter, 4)
    return n
  }
  return {
    seal(plain) {
      const cipher = createCipheriv('aes-256-gcm', key, nonce(client ? 0 : 1, sent++))
      const body = Buffer.concat([cipher.update(plain), cipher.final()])
      return Buffer.concat([body, cipher.getAuthTag()])
    },
    open(frame) {
      if (frame.length < 16) throw new Error('Frame too short')
      const decipher = createDecipheriv('aes-256-gcm', key, nonce(client ? 1 : 0, received++))
      decipher.setAuthTag(frame.subarray(frame.length - 16))
      return Buffer.concat([decipher.update(frame.subarray(0, frame.length - 16)), decipher.final()])
    }
  }
}

export const newNonce = () => randomBytes(16)
