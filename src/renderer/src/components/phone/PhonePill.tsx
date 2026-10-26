// The phone pill in the sidebar title bar: whether a phone is connected, and pairing in a popover.
import { Smartphone, X } from 'lucide-react'
import { useState } from 'react'
import { useT } from '../../i18n'
import { openPhoneSetup } from '../../store'
import { ChipButton, IconButton, LinkButton, Popover, Status, type ChipTone, type StatusTone } from '../../ui'
import { PairPanel } from './PairPanel'
import { phoneLabel, phoneStatus, type PhoneStatus } from './status'
import { useMobileInfo } from './useMobileInfo'
import './phone.css'

// The pill's state in shape and words (the old dot said it by colour alone).
const TONE: Record<PhoneStatus, StatusTone> = { loading: 'off', off: 'off', ready: 'info', pending: 'warn', paired: 'ok' }
// Not set up yet: invite, don't nag (neutral); a pairing waiting on you is amber.
const CHIP: Record<PhoneStatus, ChipTone> = { loading: 'neutral', off: 'neutral', ready: 'neutral', pending: 'warn', paired: 'neutral' }

export function PhonePill() {
  const t = useT()
  const [open, setOpen] = useState(false)
  // Faster while the popover is open: the phone finishes pairing on its own.
  const [info, setInfo] = useMobileInfo(open ? 2000 : 8000)
  const status = phoneStatus(info)

  return (
    <Popover
      className="phone-pill-wrap"
      panelClassName="phone-pop"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      label={t('phone.title')}
      trigger={(p) => (
        <ChipButton
          {...p}
          pill
          tone={CHIP[status]}
          className="phone-pill"
          title={status === 'paired' ? t('phone.pill.connected') : t('phone.pill.use')}
        >
          <Smartphone size={12} aria-hidden />
          <Status tone={TONE[status]} label={phoneLabel(info, t)} className="phone-pill-label" />
        </ChipButton>
      )}
    >
      <div className="phone-pop-head">
        <strong>{t('phone.title')}</strong>
        <IconButton label={t('common.close')} onClick={() => setOpen(false)}>
          <X size={12} />
        </IconButton>
      </div>
      <PairPanel info={info} onInfo={setInfo} compact />
      <div className="phone-pop-foot">
        <LinkButton
          size="sm"
          onClick={() => {
            setOpen(false)
            openPhoneSetup(true)
          }}
        >
          {t('phone.pill.networkSetup')}
        </LinkButton>
      </div>
    </Popover>
  )
}
