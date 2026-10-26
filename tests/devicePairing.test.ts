import { describe, expect, it } from 'vitest'
import { PairingGuest, PairingHost, newNonce, newPairingCode, sessionKeys } from '../src/main/devicePairing'
import { Devices } from '../src/main/devices'

const host = { deviceId: 'mac-a', name: 'Studio', port: 47631 }
const guest = { deviceId: 'mac-b', name: 'Air', port: 47631 }

/** Run the whole exchange in process. */
function pair(code: string, typed: string, options: { now?: () => number } = {}) {
  const h = new PairingHost(host, code, options.now)
  const g = new PairingGuest(guest, typed)
  const hello = h.receive(g.hello())
  const confirm = g.confirm(hello.reply)
  const done = h.receive(confirm)
  return { h, g, hello, confirm, done }
}

describe('pairing code', () => {
  it('makes six digits', () => {
    for (let i = 0; i < 50; i++) expect(newPairingCode()).toMatch(/^\d{6}$/)
  })

  it('pairs when the code matches, with the same key and each other\'s identity on both sides', () => {
    const { g, done } = pair('123456', '123456')
    expect(done.result?.peer).toEqual(guest)
    const theirs = g.finish(done.reply)
    expect(theirs.peer).toEqual(host)
    expect(theirs.key).toBe(done.result!.key)
    expect(theirs.key).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a wrong code on both sides and gives away no key', () => {
    const h = new PairingHost(host, '123456')
    const g = new PairingGuest(guest, '654321')
    const hello = h.receive(g.hello())
    const done = h.receive(g.confirm(hello.reply))
    expect(done.result).toBeUndefined()
    expect(done.reply).toMatchObject({ t: 'pair-error', error: expect.stringMatching(/didn.t match/) })
    expect(() => g.finish(done.reply)).toThrow(/didn.t match/)
  })

  it('gives a wrong guess no second try: the code is spent', () => {
    const h = new PairingHost(host, '123456')
    const wrong = new PairingGuest(guest, '000000')
    h.receive(wrong.confirm(h.receive(wrong.hello()).reply))
    expect(h.expired).toBe(true)
    // The right code now gets nothing.
    const right = new PairingGuest(guest, '123456')
    expect(h.receive(right.hello()).reply).toMatchObject({ t: 'pair-error' })
  })

  it('expires', () => {
    let now = 1_000_000
    const h = new PairingHost(host, '123456', () => now, 60_000)
    now += 61_000
    const g = new PairingGuest(guest, '123456')
    expect(h.receive(g.hello()).reply).toMatchObject({ t: 'pair-error', error: expect.stringMatching(/expired/) })
  })

  it('does not accept a host that did not know the code', () => {
    // A stand-in host with the wrong code answers; the guest rejects its confirmation.
    const fake = new PairingHost(host, '999999')
    const g = new PairingGuest(guest, '123456')
    const hello = fake.receive(g.hello())
    g.confirm(hello.reply)
    expect(() => g.finish({ t: 'pair-confirm', mac: 'ab'.repeat(32) })).toThrow(/did not know the code/)
  })
})

describe('the encrypted channel', () => {
  const key = 'ab'.repeat(32)
  const nonces = [newNonce(), newNonce()] as const

  it('carries messages both ways', () => {
    const client = sessionKeys(key, ...nonces, true)
    const server = sessionKeys(key, ...nonces, false)
    expect(server.open(client.seal(Buffer.from('hello')))).toEqual(Buffer.from('hello'))
    expect(client.open(server.seal(Buffer.from('world')))).toEqual(Buffer.from('world'))
    expect(server.open(client.seal(Buffer.from('again')))).toEqual(Buffer.from('again'))
  })

  it('rejects a peer with another key, tampering and replays', () => {
    const client = sessionKeys(key, ...nonces, true)
    const other = sessionKeys('cd'.repeat(32), ...nonces, false)
    expect(() => other.open(client.seal(Buffer.from('x')))).toThrow()

    const a = sessionKeys(key, ...nonces, true)
    const b = sessionKeys(key, ...nonces, false)
    const frame = a.seal(Buffer.from('pay'))
    const tampered = Buffer.from(frame)
    tampered[0] ^= 1
    expect(() => b.open(tampered)).toThrow()

    const c = sessionKeys(key, ...nonces, true)
    const d = sessionKeys(key, ...nonces, false)
    const first = c.seal(Buffer.from('once'))
    d.open(first)
    expect(() => d.open(first)).toThrow()
  })
})

describe('paired devices', () => {
  it('stores the id, the key apart from state, and last seen', () => {
    const vault = new Map<string, string>()
    const store = { state: {} as { devices?: { selfId?: string; paired: never[] } }, save: () => undefined }
    const devices = new Devices({ store: store as never, keys: { get: (id) => vault.get(id), set: (id, key) => (key === null ? vault.delete(id) : vault.set(id, key)) }, machineName: () => 'Studio.local', changed: () => undefined })
    expect(devices.self().name).toBe('Studio')
    const id = devices.self().deviceId
    expect(devices.self().deviceId).toBe(id)

    devices.add({ peer: { deviceId: 'mac-b', name: 'Air' }, key: 'ff'.repeat(32) }, '192.168.1.9', 47631)
    expect(devices.list()).toHaveLength(1)
    expect(JSON.stringify(store.state)).not.toContain('ffff')
    expect(devices.keyFor('mac-b')).toBe('ff'.repeat(32))
    expect(devices.addressOf('mac-b')).toEqual({ host: '192.168.1.9', port: 47631 })
    expect(devices.list()[0].lastSeen).toBeDefined()
    devices.forget('mac-b')
    expect(devices.keyFor('mac-b')).toBeUndefined()
    expect(devices.list()).toHaveLength(0)
  })

  it('shows one code at a time and spends it', () => {
    const store = { state: {}, save: () => undefined }
    let now = 0
    const devices = new Devices({ store: store as never, keys: { get: () => undefined, set: () => undefined }, now: () => now, changed: () => undefined })
    const h = devices.showCode(47631)
    expect(devices.info(false, 47631).pairing?.code).toBe(h.code)
    now += 3 * 60_000
    expect(devices.pairingHost()).toBeUndefined()
    expect(devices.info(false, 47631).pairing).toBeUndefined()
  })
})
