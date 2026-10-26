// Preview responds (W-2): the wording and rules around the probe. The probe
// itself lives in the main process; this is what is pure.
import { createT, type TFunction } from './i18n'

const enT = createT('en')

/** One look at a run script's preview URL. */
export interface PreviewProbe {
  // The URL actually asked (ports expanded).
  url: string
  state: 'responding' | 'not-responding' | 'skipped'
  // The HTTP status when something answered; any answer counts as responding.
  status?: number
  // Why it did not respond or was not asked.
  reason?: string
  at: string
}

/** Only this machine is ever asked, over http or https. */
export function isLocalPreviewUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host)
}

export function agoText(fromIso: string, now: number, t: TFunction = enT): string {
  const seconds = Math.max(0, Math.round((now - new Date(fromIso).getTime()) / 1000))
  if (seconds < 60) return t('previewProbe.secondsAgo', { n: seconds })
  const minutes = Math.floor(seconds / 60)
  return minutes < 60 ? t('previewProbe.minutesAgo', { n: minutes }) : t('previewProbe.hoursAgo', { n: Math.floor(minutes / 60) })
}

/** "responding · checked 12s ago" / "not responding · checked 3s ago". Nothing before the first probe. */
export function probeText(probe: PreviewProbe | undefined, now: number, t: TFunction = enT): string | null {
  if (!probe) return null
  if (probe.state === 'skipped') return probe.reason ?? t('previewProbe.notChecked')
  return t(probe.state === 'responding' ? 'previewProbe.responding' : 'previewProbe.notResponding', { ago: agoText(probe.at, now, t) })
}

/** "Responding isn’t the same as correct." */
export function probeNote(t: TFunction = enT): string {
  return t('previewProbe.note')
}

/** How often the Run panel looks again while the script is running. */
export const PROBE_EVERY_MS = 10_000
