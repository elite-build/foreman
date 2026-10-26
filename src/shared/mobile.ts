export interface MobileDevice {
  id: string
  name: string
  pairedAt: string
  transport?: 'private' | 'lan'
  lastSeen?: string
  push?: { endpoint: string; keys: { p256dh: string; auth: string } }
}

export interface MobileInfo {
  enabled: boolean
  url: string
  port: number
  lan: {
    enabled: boolean
    address: string
    port: number
    candidates: { name: string; address: string }[]
  }
  devices: MobileDevice[]
  pairing?: { mode: 'private' | 'lan'; url: string; qr: string; expiresAt: number }
  pending?: { id: string; name: string; code: string; mode: 'private' | 'lan'; expiresAt: number }
}
