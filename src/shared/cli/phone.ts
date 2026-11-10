// Parameters and results of the `foreman phone` methods (src/main/cli/phone.ts). Each result has a `text` the command
// prints unless --json is given. Phones and browsers sign in the same way; `kind` says which signed in.
import type { MobileAccess } from '../mobile'

export type PhoneMode = 'private' | 'lan'
export type PhoneKind = 'phone' | 'browser'

export interface PhoneDeviceRow {
  id: string
  name: string
  kind: PhoneKind
  access: MobileAccess
  // Absent on a record paired before the transport was kept.
  transport?: PhoneMode
  pairedAt: string
  lastSeen?: string
}

export interface PhonePendingRow {
  name: string
  kind: PhoneKind
  // The six digits the phone or browser shows.
  code: string
  mode: PhoneMode
  expiresAt: number
}

export interface PhoneStatusResult {
  private: { on: boolean; url: string }
  lan: { on: boolean; address: string; port: number }
  devices: PhoneDeviceRow[]
  // A sign-in link that nobody has opened yet.
  link?: { mode: PhoneMode; expiresAt: number }
  pending?: PhonePendingRow
  text: string
}

export interface PhoneLinkParams {
  // Absent: private when an HTTPS address is configured, else same Wi-Fi.
  mode?: PhoneMode
  // Which page the link opens: the phone page, or the full app at /app in a browser.
  kind?: PhoneKind
  // Also render the link as a QR code in text.
  qr?: boolean
}

export interface PhoneLinkResult {
  mode: PhoneMode
  kind: PhoneKind
  url: string
  expiresAt: number
  // The connection this command turned on first, when it was off.
  turnedOn?: PhoneMode
  qr?: string
  text: string
}

export interface PhonePendingResult {
  pending: PhonePendingRow | null
  text: string
}

export interface PhoneApproveParams {
  code: string
  // Absent: operate.
  access?: MobileAccess
}

export interface PhoneApproveResult {
  device: PhoneDeviceRow
  text: string
}

export interface PhoneDenyResult {
  denied: PhonePendingRow
  text: string
}

export interface PhoneRevokeParams {
  // An id, the start of one, or a name only one device has.
  device: string
}

export interface PhoneRevokeResult {
  revoked: PhoneDeviceRow
  text: string
}
