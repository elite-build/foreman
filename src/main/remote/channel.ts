// A lasting, two-way channel between paired computers, for controlling one from the other (shared/remote.ts). It rides
// the same TCP connection and session keys as a hand-off request (deviceNet.ts), but stays open: either side sends JSON
// messages whenever it likes. A message bigger than one frame goes in parts (a snapshot or a long chat can be several
// megabytes); every part is sealed with the next counter nonce, so parts can't be dropped, reordered or replayed.
import type net from 'node:net'
import type { SessionKeys } from '../devicePairing'
import type { Frames } from '../deviceNet'

/** One frame's worth of message, leaving room for the seal and the part flag under deviceNet's 2 MB frame. */
export const PART_BYTES = 1024 * 1024
/** A message larger than this is refused (both ends hold it in memory). */
export const MAX_MESSAGE_BYTES = 64 * 1024 * 1024
/** Silence for this long means the other computer is gone; the client pings well inside it. */
export const IDLE_MS = 45_000

const MORE = 1
const LAST = 0

export class Channel {
  private ended = false
  private onClose: ((error?: Error) => void) | null = null

  constructor(
    private socket: net.Socket,
    private frames: Frames,
    private keys: SessionKeys
  ) {
    socket.setTimeout(IDLE_MS)
    socket.setNoDelay(true)
  }

  get closed(): boolean {
    return this.ended || this.socket.destroyed
  }

  /** Sends one message (any JSON value). Dropped silently once the channel is closed. */
  send(message: unknown): void {
    if (this.closed) return
    const body = Buffer.from(JSON.stringify(message))
    if (body.length > MAX_MESSAGE_BYTES) throw new Error('That is too large to send to the other computer.')
    for (let at = 0; at === 0 || at < body.length; at += PART_BYTES) {
      const part = body.subarray(at, at + PART_BYTES)
      const flag = Buffer.of(at + PART_BYTES < body.length ? MORE : LAST)
      this.frames.write(this.keys.seal(Buffer.concat([flag, part])))
    }
  }

  /** Reads messages until the channel closes. `onClose` runs once, with the reason when it wasn't a clean close. */
  start(onMessage: (message: unknown) => void, onClose: (error?: Error) => void): void {
    this.onClose = onClose
    void this.read(onMessage)
  }

  private async read(onMessage: (message: unknown) => void): Promise<void> {
    let parts: Buffer[] = []
    let size = 0
    try {
      for (;;) {
        // A frame that wasn't sealed with the session key (or was changed, dropped or replayed) throws here.
        const plain = this.keys.open(await this.frames.next())
        if (plain.length < 1) throw new Error('An empty frame arrived.')
        size += plain.length - 1
        if (size > MAX_MESSAGE_BYTES) throw new Error('A message was too large.')
        parts.push(plain.subarray(1))
        if (plain[0] === MORE) continue
        const body = Buffer.concat(parts)
        parts = []
        size = 0
        let message: unknown
        try {
          message = JSON.parse(body.toString('utf8'))
        } catch {
          throw new Error('A message wasn’t valid.')
        }
        onMessage(message)
      }
    } catch (err) {
      this.finish(this.ended ? undefined : err instanceof Error ? err : new Error(String(err)))
    }
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.socket.end()
    this.socket.destroy()
    this.finish()
  }

  private finish(error?: Error): void {
    this.ended = true
    if (!this.socket.destroyed) this.socket.destroy()
    const done = this.onClose
    this.onClose = null
    done?.(error)
  }
}
