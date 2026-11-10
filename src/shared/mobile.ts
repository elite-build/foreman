import type { ApiSession, Scope } from './api'

/** What a phone or browser was approved to do (docs/server.md, "Sessions"): Watch, Operate or Full control. */
export type MobileAccess = 'read' | 'operate' | 'admin'

export const MOBILE_ACCESS = ['read', 'operate', 'admin'] as const satisfies readonly MobileAccess[]

/** The scopes each access gives. Never `window`: that stays with the computer's own screen. */
export const ACCESS_SCOPES: Record<MobileAccess, readonly Scope[]> = {
  read: ['read'],
  operate: ['read', 'operate'],
  admin: ['read', 'operate', 'admin']
}

// Saved in state.json (`mobileDevices`). The shape only grows: `kind` and `scopes` are optional, and a record saved before
// they existed reads as a phone that may operate (what every phone could do then), so no migration is needed.
export interface MobileDevice {
  id: string
  name: string
  pairedAt: string
  /** Absent: a phone. */
  kind?: 'phone' | 'browser'
  /** Absent: ['read', 'operate']. */
  scopes?: Scope[]
  transport?: 'private' | 'lan'
  lastSeen?: string
  push?: { endpoint: string; keys: { p256dh: string; auth: string } }
}

/**
 * The scopes a paired device holds. `window` is dropped even if a hand-edited record names it: a session over the
 * network never has it, however it was approved.
 */
export function deviceScopes(device: Pick<MobileDevice, 'scopes'>): Scope[] {
  if (!Array.isArray(device.scopes)) return [...ACCESS_SCOPES.operate]
  return device.scopes.filter((s): s is Scope => s === 'read' || s === 'operate' || s === 'admin')
}

/** The strongest access a device holds, for the pairing dialog's list. */
export function deviceAccess(device: Pick<MobileDevice, 'scopes'>): MobileAccess {
  const scopes = deviceScopes(device)
  return scopes.includes('admin') ? 'admin' : scopes.includes('operate') ? 'operate' : 'read'
}

/** The session a paired device's requests and socket run under: its own id, kind, name and scopes. */
export function deviceSession(device: MobileDevice): ApiSession {
  return { id: device.id, kind: device.kind ?? 'phone', name: device.name, scopes: deviceScopes(device) }
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
  pending?: { id: string; name: string; kind: 'phone' | 'browser'; code: string; mode: 'private' | 'lan'; expiresAt: number }
}
