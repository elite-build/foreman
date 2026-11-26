// Chrome's native-messaging framing: each message is a 4-byte unsigned little-endian length, then that many
// bytes of UTF-8 JSON. Pure: used by the browser host (browserHostMain.ts) and its tests.

/** Chrome's limit for a message the host sends to the extension. */
export const MAX_TO_EXTENSION = 1024 * 1024
/** The most a message may be in either direction before the reader gives up on the stream. */
const MAX_MESSAGE = 64 * 1024 * 1024

/** One framed message: its length, then its JSON. */
export function encodeNative(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Reads framed messages from a byte stream. Partial messages wait for the next chunk. */
export class NativeReader {
  private pending: Buffer = Buffer.alloc(0)

  /** Every message completed by this chunk, in order. Throws on a length over 64 MiB or on JSON that doesn't parse. */
  push(chunk: Buffer): unknown[] {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    const messages: unknown[] = []
    while (this.pending.length >= 4) {
      const length = this.pending.readUInt32LE(0)
      if (length > MAX_MESSAGE) {
        this.pending = Buffer.alloc(0)
        throw new Error(`Native message of ${length} bytes is over the ${MAX_MESSAGE} byte limit`)
      }
      if (this.pending.length < 4 + length) break
      const body = this.pending.subarray(4, 4 + length).toString('utf8')
      this.pending = this.pending.subarray(4 + length)
      messages.push(JSON.parse(body) as unknown)
    }
    return messages
  }
}
