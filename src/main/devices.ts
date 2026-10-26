// The Macs this one is paired with: ids, addresses, last seen. Keys live in the secret vault,
// never in state.json. Also the pairing code this Mac is currently showing, if any.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import type { DevicesInfo, PairedDevice } from '../shared/transfer'
import { PairingHost, newPairingCode, type PairingResult } from './devicePairing'

export interface DeviceState {
  selfId?: string
  paired: PairedDevice[]
}

export interface DeviceKeys {
  get(deviceId: string): string | undefined
  set(deviceId: string, key: string | null): void
}

export interface DevicesDeps {
  store: { state: { devices?: DeviceState }; save(): void }
  keys: DeviceKeys
  machineName?: () => string
  now?: () => number
  changed(): void
}

/** "::ffff:192.168.1.5" is just 192.168.1.5. */
export const plainAddress = (address?: string): string | undefined => address?.replace(/^::ffff:/, '')

export function localAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address)
  }
  return out
}

export class Devices {
  private host?: PairingHost

  constructor(private deps: DevicesDeps) {}

  private get state(): DeviceState {
    return (this.deps.store.state.devices ??= { paired: [] })
  }

  /** This Mac's identity. The id is made once and kept. */
  self(port?: number): { deviceId: string; name: string; port?: number } {
    this.state.selfId ??= randomUUID()
    this.deps.store.save()
    return { deviceId: this.state.selfId, name: (this.deps.machineName ?? os.hostname)().replace(/\.local$/, ''), port }
  }

  list(): PairedDevice[] {
    return this.state.paired
  }

  find(id: string): PairedDevice | undefined {
    return this.state.paired.find((d) => d.id === id)
  }

  keyFor(id: string): string | undefined {
    return this.find(id) ? this.deps.keys.get(id) : undefined
  }

  addressOf(id: string): { host: string; port: number } | undefined {
    const d = this.find(id)
    return d?.host && d.port ? { host: d.host, port: d.port } : undefined
  }

  /** A pairing finished: remember the Mac and its key (an earlier pairing of the same Mac is replaced). */
  add(result: PairingResult, host: string | undefined, port: number | undefined): PairedDevice {
    const now = new Date((this.deps.now ?? Date.now)()).toISOString()
    const device: PairedDevice = { id: result.peer.deviceId, name: result.peer.name, host, port, pairedAt: now, lastSeen: now }
    this.state.paired = [...this.state.paired.filter((d) => d.id !== device.id), device]
    this.deps.keys.set(device.id, result.key)
    this.deps.store.save()
    this.deps.changed()
    return device
  }

  forget(id: string): void {
    this.state.paired = this.state.paired.filter((d) => d.id !== id)
    this.deps.keys.set(id, null)
    this.deps.store.save()
    this.deps.changed()
  }

  seen(id: string): void {
    const d = this.find(id)
    if (!d) return
    d.lastSeen = new Date((this.deps.now ?? Date.now)()).toISOString()
    this.deps.store.save()
  }

  // ---- showing a code ----

  /** Start showing a code. Valid for two minutes, for one attempt. */
  showCode(port: number | undefined): PairingHost {
    this.host = new PairingHost(this.self(port), newPairingCode(), this.deps.now)
    this.deps.changed()
    return this.host
  }

  pairingHost(): PairingHost | undefined {
    if (this.host?.expired) this.host = undefined
    return this.host
  }

  cancelCode(): void {
    this.host = undefined
    this.deps.changed()
  }

  info(accepting: boolean, port: number): DevicesInfo {
    const self = this.self(port)
    const host = this.pairingHost()
    return {
      self: { id: self.deviceId, name: self.name },
      accepting,
      port,
      addresses: localAddresses(),
      paired: this.list(),
      pairing: host ? { code: host.code, expiresAt: new Date(host.expiresAt).toISOString() } : undefined
    }
  }
}
