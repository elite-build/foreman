import { describe, expect, it } from 'vitest'
import { lanAddresses, onSameLan } from '../src/main/lan'

describe('LAN reachability', () => {
  it('offers only private IPv4 interfaces and accepts peers on the selected subnet', () => {
    const interfaces = {
      en0: [{ address: '192.168.5.12', netmask: '255.255.255.0', family: 'IPv4', internal: false }],
      utun4: [{ address: '100.101.1.2', netmask: '255.192.0.0', family: 'IPv4', internal: false }],
      lo0: [{ address: '127.0.0.1', netmask: '255.0.0.0', family: 'IPv4', internal: true }],
      other: [{ address: '203.0.113.7', netmask: '255.255.255.0', family: 'IPv4', internal: false }]
    } as unknown as Parameters<typeof lanAddresses>[0]
    const [host] = lanAddresses(interfaces)
    expect(host).toEqual({ name: 'en0', address: '192.168.5.12', netmask: '255.255.255.0' })
    expect(lanAddresses(interfaces)).toHaveLength(1)
    expect(onSameLan('192.168.5.91', host)).toBe(true)
    expect(onSameLan('192.168.6.91', host)).toBe(false)
    expect(onSameLan('203.0.113.91', host)).toBe(false)
    expect(onSameLan('::ffff:192.168.5.91', host)).toBe(true)
  })
})
