import { afterEach, describe, expect, it } from 'vitest'
import { DeviceNet } from '../src/main/deviceNet'
import { Devices } from '../src/main/devices'
import type { PeerRequest, PeerResponse } from '../src/shared/transfer'

// Two Macs on the loopback interface, talking through the real TCP and encryption code.
const open: DeviceNet[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((n) => n.close()))
})

function mac(name: string, handler: (from: string, req: PeerRequest, file?: Buffer) => Promise<PeerResponse>) {
  const vault = new Map<string, string>()
  const store = { state: {}, save: () => undefined }
  const devices = new Devices({ store: store as never, keys: { get: (id) => vault.get(id), set: (id, k) => (k === null ? vault.delete(id) : vault.set(id, k)) }, machineName: () => name, changed: () => undefined })
  let port = 0
  const net = new DeviceNet({
    self: () => devices.self(port),
    keyFor: (id) => devices.keyFor(id),
    addressOf: (id) => devices.addressOf(id),
    seen: (id) => devices.seen(id),
    onRequest: handler,
    pairingHost: () => devices.pairingHost(),
    onPaired: (result, address) => {
      devices.add(result, address?.replace(/^::ffff:/, ''), result.peer.port)
      devices.cancelCode()
    }
  })
  open.push(net)
  return { devices, net, listen: async () => (port = await net.listen(0, '127.0.0.1')) }
}

describe('device network', () => {
  it('pairs with a code and then sends a file and gets an answer, encrypted', async () => {
    const seen: { from: string; req: PeerRequest; bytes?: number }[] = []
    const studio = mac('Studio', async (from, req, file) => {
      seen.push({ from, req, bytes: file?.length })
      return { ok: true, stagedWorkspaceId: 'ws' }
    })
    const air = mac('Air', async () => ({ ok: true }))
    const port = await studio.listen()
    await air.listen()

    const host = studio.devices.showCode(port)
    const paired = await air.net.pairWith('127.0.0.1', port, host.code)
    air.devices.add(paired, '127.0.0.1', paired.peer.port)
    expect(paired.peer.name).toBe('Studio')
    // The host learned the guest too, from the connection, with no code reuse possible.
    expect(studio.devices.list().map((d) => d.name)).toEqual(['Air'])
    expect(studio.devices.pairingHost()).toBeUndefined()

    // 3 MB so it takes several encrypted frames.
    const file = Buffer.alloc(3 * 1024 * 1024 + 17, 7)
    const res = await air.net.send(studio.devices.self().deviceId, { type: 'offer', transferId: 't1', passphrase: 'p', bytes: file.length, sha256: 'x' }, file)
    expect(res).toEqual({ ok: true, stagedWorkspaceId: 'ws' })
    expect(seen).toHaveLength(1)
    expect(seen[0].from).toBe(air.devices.self().deviceId)
    expect(seen[0].bytes).toBe(file.length)
    expect(air.devices.list()[0].lastSeen).toBeDefined()
  })

  it('refuses a wrong code and an unpaired Mac', async () => {
    const studio = mac('Studio', async () => ({ ok: true }))
    const air = mac('Air', async () => ({ ok: true }))
    const port = await studio.listen()
    studio.devices.showCode(port)
    await expect(air.net.pairWith('127.0.0.1', port, '000000')).rejects.toThrow()
    expect(studio.devices.list()).toHaveLength(0)

    // Air holds a key Studio never agreed to.
    air.devices.add({ peer: { deviceId: studio.devices.self().deviceId, name: 'Studio' }, key: 'ab'.repeat(32) }, '127.0.0.1', port)
    await expect(air.net.send(studio.devices.self().deviceId, { type: 'status', transferId: 't' })).rejects.toThrow()
  })

  it('pairs only while a code is showing', async () => {
    const studio = mac('Studio', async () => ({ ok: true }))
    const air = mac('Air', async () => ({ ok: true }))
    const port = await studio.listen()
    await expect(air.net.pairWith('127.0.0.1', port, '123456')).rejects.toThrow(/isn.t showing a pairing code/)
  })

  it('says so when the other Mac is not there', async () => {
    const air = mac('Air', async () => ({ ok: true }))
    air.devices.add({ peer: { deviceId: 'ghost', name: 'Ghost' }, key: 'ab'.repeat(32) }, '127.0.0.1', 1)
    await expect(air.net.send('ghost', { type: 'status', transferId: 't' })).rejects.toThrow(/Couldn.t reach/)
  })
})
