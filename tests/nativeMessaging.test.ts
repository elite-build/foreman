import { describe, expect, it } from 'vitest'
import { MAX_TO_EXTENSION, NativeReader, encodeNative } from '../src/cli/nativeMessaging'

describe('native messaging framing', () => {
  it('prefixes the UTF-8 JSON with its little-endian length', () => {
    const frame = encodeNative({ text: 'café' })
    const body = Buffer.from(JSON.stringify({ text: 'café' }), 'utf8')
    expect(frame.readUInt32LE(0)).toBe(body.length)
    expect(frame.subarray(4)).toEqual(body)
  })

  it('round trips a message split across chunks', () => {
    const frame = encodeNative({ type: 'hello', installId: 'abc' })
    const reader = new NativeReader()
    expect(reader.push(frame.subarray(0, 2))).toEqual([])
    expect(reader.push(frame.subarray(2, 9))).toEqual([])
    expect(reader.push(frame.subarray(9))).toEqual([{ type: 'hello', installId: 'abc' }])
  })

  it('returns every message in one chunk, in order', () => {
    const reader = new NativeReader()
    const chunk = Buffer.concat([encodeNative({ n: 1 }), encodeNative({ n: 2 }), encodeNative({ n: 3 })])
    expect(reader.push(chunk)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }])
  })

  it('keeps a partial message until its last bytes arrive, after a complete one', () => {
    const reader = new NativeReader()
    const second = encodeNative({ n: 2 })
    expect(reader.push(Buffer.concat([encodeNative({ n: 1 }), second.subarray(0, 5)]))).toEqual([{ n: 1 }])
    expect(reader.push(second.subarray(5))).toEqual([{ n: 2 }])
  })

  it('throws on a length over 64 MiB', () => {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(64 * 1024 * 1024 + 1, 0)
    expect(() => new NativeReader().push(header)).toThrow(/limit/)
  })

  it('keeps the host-to-extension limit at 1 MiB', () => {
    expect(MAX_TO_EXTENSION).toBe(1024 * 1024)
  })
})
