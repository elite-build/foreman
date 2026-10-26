// What the phone pill says: whether a phone is paired, a pairing waits for confirmation, or
// access is on but nothing is paired yet.
import { createT, type TFunction } from '../../../../shared/i18n'
import type { MobileInfo } from '../../../../shared/mobile'

const enT = createT('en')

export type PhoneStatus = 'loading' | 'off' | 'ready' | 'pending' | 'paired'

export function phoneStatus(info: MobileInfo | null): PhoneStatus {
  if (!info) return 'loading'
  if (info.pending) return 'pending'
  if (info.devices.length) return 'paired'
  if (info.enabled || info.lan.enabled) return 'ready'
  return 'off'
}

export function phoneLabel(info: MobileInfo | null, t: TFunction = enT): string {
  switch (phoneStatus(info)) {
    case 'paired':
      return info!.devices.length === 1 ? info!.devices[0].name : t('phone.label.phones', { count: info!.devices.length })
    case 'pending':
      return t('phone.label.confirm')
    case 'loading':
      return t('phone.label.loading')
    default:
      return t('phone.label.connect')
  }
}
