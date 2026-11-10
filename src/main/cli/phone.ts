// `foreman phone status|link|pending|approve|deny|revoke`: signing a phone or a browser in from a terminal. A headless
// Foreman (docs/server.md, "Headless") has no window to click Approve in, so the pairing dialog's steps are here too,
// through the same MobileService calls the dialog makes. Approving takes the six digits the phone shows, so the person
// approving has seen the device that is asking.
import { timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'
import { deviceAccess, MOBILE_ACCESS, type MobileAccess, type MobileDevice, type MobileInfo } from '../../shared/mobile'
import type { PhoneApproveResult, PhoneDenyResult, PhoneDeviceRow, PhoneKind, PhoneLinkResult, PhoneMode, PhonePendingResult, PhonePendingRow, PhoneRevokeResult, PhoneStatusResult } from '../../shared/cli/phone'
import { columns, flagParam, invalid, paramsObject, textParam, type MethodDef } from './kit'
import { durationText, findByRef, notFound, refused, utcText } from './refs'

const ACCESS_WORDS: Record<MobileAccess, string> = {
  read: 'it can watch, but not send, approve or change anything',
  operate: 'it can work on workspaces and chats, but not change settings',
  admin: 'full control, settings included'
}

const MODE_WORDS: Record<PhoneMode, string> = { private: 'private HTTPS', lan: 'same Wi-Fi' }

function deviceRow(d: MobileDevice): PhoneDeviceRow {
  return { id: d.id, name: d.name, kind: d.kind ?? 'phone', access: deviceAccess(d), ...(d.transport ? { transport: d.transport } : {}), pairedAt: d.pairedAt, ...(d.lastSeen ? { lastSeen: d.lastSeen } : {}) }
}

function pendingRow(p: NonNullable<MobileInfo['pending']>): PhonePendingRow {
  return { name: p.name, kind: p.kind, code: p.code, mode: p.mode, expiresAt: p.expiresAt }
}

const expiresText = (at: number): string => `expires in ${durationText(at - Date.now())}`

function pendingText(p: PhonePendingRow): string {
  return `Waiting for approval: “${p.name}” (${p.kind}, ${MODE_WORDS[p.mode]}), code ${p.code}, ${expiresText(p.expiresAt)}.\nIf the ${p.kind} shows the same code, approve it with \`foreman phone approve <code>\`, or refuse it with \`foreman phone deny\`.`
}

// Compared in constant time, as mobile.ts compares the pairing secret.
function sameCode(given: string, expected: string): boolean {
  const a = Buffer.from(given)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The waiting sign-in, or the error that says there is none. */
function waiting(info: MobileInfo): NonNullable<MobileInfo['pending']> {
  if (!info.pending) throw notFound('No sign-in is waiting.', 'Make a link with `foreman phone link` and open it on the phone or browser first.')
  return info.pending
}

/** `https://host/?pair=x` → `https://host/app?pair=x`: the full app, which signs a browser in through the same pairing. */
function appUrl(url: string): string {
  const u = new URL(url)
  return `${u.origin}/app${u.search}`
}

const status: MethodDef = {
  tier: 'read',
  async handle(host): Promise<PhoneStatusResult> {
    const info = await host.api.mobileInfo()
    const devices = info.devices.map(deviceRow)
    const asking = info.pending ? pendingRow(info.pending) : undefined
    const lines = columns([
      ['Private (Tailscale HTTPS)', info.enabled ? 'on' : 'off', info.url || 'no address set'],
      ['Same Wi-Fi', info.lan.enabled ? 'on' : 'off', info.lan.address ? `${info.lan.address}:${info.lan.port}` : 'no address chosen']
    ])
    lines.push('')
    if (devices.length) {
      lines.push(...columns([['NAME', 'KIND', 'ACCESS', 'CONNECTION', 'LAST SEEN', 'ID'], ...devices.map((d) => [d.name, d.kind, d.access, d.transport ?? '', d.lastSeen ? utcText(d.lastSeen) : 'never', d.id])]))
    } else lines.push('No phones or browsers are signed in.')
    if (info.pairing && !asking) lines.push('', `A sign-in link (${MODE_WORDS[info.pairing.mode]}) is open; it ${expiresText(info.pairing.expiresAt)}.`)
    if (asking) lines.push('', pendingText(asking))
    return {
      private: { on: info.enabled, url: info.url },
      lan: { on: info.lan.enabled, address: info.lan.address, port: info.lan.port },
      devices,
      ...(info.pairing ? { link: { mode: info.pairing.mode, expiresAt: info.pairing.expiresAt } } : {}),
      ...(asking ? { pending: asking } : {}),
      text: lines.join('\n')
    }
  }
}

const link: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<PhoneLinkResult> {
    const p = paramsObject(params)
    const modeParam = textParam(p, 'mode', { optional: true })
    if (modeParam !== undefined && modeParam !== 'private' && modeParam !== 'lan') throw invalid('mode is private or lan.')
    const kindParam = textParam(p, 'kind', { optional: true })
    if (kindParam !== undefined && kindParam !== 'phone' && kindParam !== 'browser') throw invalid('kind is phone or browser.')
    const kind: PhoneKind = kindParam ?? 'phone'
    let info = await host.api.mobileInfo()
    const mode: PhoneMode = modeParam ?? (info.url ? 'private' : 'lan')
    const notes: string[] = []
    let turnedOn: PhoneMode | undefined
    if (mode === 'private') {
      if (!info.url) {
        throw refused('No private HTTPS address is set for this computer.', 'Run `tailscale serve --bg 47632`, then `foreman settings set devices.mobile-url https://<computer>.<tailnet>.ts.net`; or use --lan on the same Wi-Fi.')
      }
      if (!info.enabled) {
        info = await host.api.mobileConfigure(true, info.url)
        turnedOn = 'private'
        notes.push(`Turned on private access at ${info.url}.`)
      }
    } else if (!info.lan.enabled) {
      // The address chosen before, while it is still this computer's; otherwise the first one, as the dialog does.
      const address = info.lan.candidates.find((c) => c.address === info.lan.address) ?? info.lan.candidates[0]
      if (!address) throw refused('This computer has no private network address for same-Wi-Fi access.', 'Connect it to a network, or use --private with Tailscale.')
      info = await host.api.mobileConfigureLan(true, address.address)
      turnedOn = 'lan'
      notes.push(`Turned on same-Wi-Fi access on ${address.address} (${address.name}). It is plain HTTP: use it only on a network you trust.`)
    }
    const started = await host.api.mobileStartPairing(mode)
    if (!started.pairing) throw new Error('Foreman did not make a sign-in link.')
    const url = kind === 'browser' ? appUrl(started.pairing.url) : started.pairing.url
    const qr = flagParam(p, 'qr') ? await QRCode.toString(url, { type: 'utf8', margin: 2 }) : undefined
    const minutes = Math.max(1, Math.round((started.pairing.expiresAt - Date.now()) / 60_000))
    const lines = [
      ...notes,
      `Open this link ${kind === 'browser' ? 'in the browser' : 'on the phone'} within ${minutes} minute${minutes === 1 ? '' : 's'}; it works once:`,
      url,
      ...(qr ? [qr] : []),
      'When it shows a six-digit code, check it with `foreman phone pending` and approve it with `foreman phone approve <code>`.'
    ]
    return { mode, kind, url, expiresAt: started.pairing.expiresAt, ...(turnedOn ? { turnedOn } : {}), ...(qr ? { qr } : {}), text: lines.join('\n') }
  }
}

const pending: MethodDef = {
  tier: 'read',
  async handle(host): Promise<PhonePendingResult> {
    const info = await host.api.mobileInfo()
    if (!info.pending) return { pending: null, text: 'No sign-in is waiting.' }
    const row = pendingRow(info.pending)
    return { pending: row, text: pendingText(row) }
  }
}

const approve: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<PhoneApproveResult> {
    const p = paramsObject(params)
    const code = textParam(p, 'code').replace(/\s+/g, '')
    if (!/^\d{6}$/.test(code)) throw invalid('The code is the six digits the phone or browser shows.')
    const access = (textParam(p, 'access', { optional: true }) ?? 'operate') as MobileAccess
    if (!MOBILE_ACCESS.includes(access)) throw invalid(`access is one of ${MOBILE_ACCESS.join(', ')}.`)
    const info = await host.api.mobileInfo()
    const asking = waiting(info)
    if (!sameCode(code, asking.code)) throw notFound('That code doesn’t match the sign-in that is waiting.', 'Type the six digits the phone or browser shows; `foreman phone pending` says which device is asking.')
    const before = new Set(info.devices.map((d) => d.id))
    const after = await host.api.mobileApprovePairing(asking.id, true, access)
    const added = after.devices.find((d) => !before.has(d.id))
    if (!added) throw new Error('Foreman approved the sign-in but did not record the device.')
    const device = deviceRow(added)
    return { device, text: `Approved “${device.name}” (${device.kind}) with access ${device.access}: ${ACCESS_WORDS[device.access]}.\nIt is signed in once its page notices, within a few seconds. \`foreman phone revoke ${device.id}\` signs it out.` }
  }
}

const deny: MethodDef = {
  tier: 'admin',
  async handle(host): Promise<PhoneDenyResult> {
    const asking = waiting(await host.api.mobileInfo())
    await host.api.mobileApprovePairing(asking.id, false)
    const denied = pendingRow(asking)
    return { denied, text: `Denied the sign-in from “${denied.name}” (${denied.kind}).` }
  }
}

const revoke: MethodDef = {
  tier: 'admin',
  async handle(host, params): Promise<PhoneRevokeResult> {
    const p = paramsObject(params)
    const info = await host.api.mobileInfo()
    const found = findByRef(info.devices, textParam(p, 'device'), 'device', {
      id: (d) => d.id,
      names: (d) => [d.name],
      describe: (d) => `${d.name} (${d.kind ?? 'phone'}, id ${d.id})`
    })
    await host.api.mobileRevokeDevice(found.id)
    const revoked = deviceRow(found)
    return { revoked, text: `Revoked “${revoked.name}” (${revoked.kind}). It is signed out now; signing in again needs a new link.` }
  }
}

export const PHONE_METHODS: Record<string, MethodDef> = {
  'phone-status': status,
  'phone-link': link,
  'phone-pending': pending,
  'phone-approve': approve,
  'phone-deny': deny,
  'phone-revoke': revoke
}
