import { networkInterfaces } from 'node:os'

export interface LanAddress {
  name: string
  address: string
  netmask: string
}

const octets = (address: string): number[] | null => {
  const parts = address.split('.').map(Number)
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) ? parts : null
}

const privateV4 = (address: string): boolean => {
  const ip = octets(address)
  if (!ip) return false
  return ip[0] === 10 || (ip[0] === 172 && ip[1] >= 16 && ip[1] <= 31) || (ip[0] === 192 && ip[1] === 168)
}

const validMask = (address: string): boolean => {
  const bytes = octets(address)
  if (!bytes || bytes[0] !== 255) return false
  const mask = ((bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]) >>> 0
  const inverse = (~mask) >>> 0
  return (inverse & (inverse + 1)) === 0
}

export function lanAddresses(interfaces = networkInterfaces()): LanAddress[] {
  const found: LanAddress[] = []
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal || !privateV4(entry.address) || !validMask(entry.netmask)) continue
      found.push({ name, address: entry.address, netmask: entry.netmask })
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name) || a.address.localeCompare(b.address))
}

export function onSameLan(peer: string, host: LanAddress): boolean {
  const remote = octets(peer.replace(/^::ffff:/, ''))
  const local = octets(host.address)
  const mask = octets(host.netmask)
  if (!remote || !local || !mask || !validMask(host.netmask)) return false
  if (!privateV4(peer.replace(/^::ffff:/, '')) && !(local[0] === 127 && remote[0] === 127)) return false
  return remote.every((byte, i) => (byte & mask[i]) === (local[i] & mask[i]))
}
