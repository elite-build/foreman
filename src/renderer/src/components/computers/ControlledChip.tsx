// Shown to the person sitting at this computer while another computer controls it (shared/remote.ts): who, since when,
// and a way to end it. Ending it stops only the other window's control; the work here keeps running.
import { X } from 'lucide-react'
import { useState } from 'react'
import { formatDateTime } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, ChipButton, IconButton, Popover, Status } from '../../ui'
import { ComputerIcon } from './ComputerChip'
import './computers.css'

export function ControlledChip() {
  const t = useT()
  const [open, setOpen] = useState(false)
  const controllers = useStore((s) => s.computers?.controllers) ?? []
  if (!controllers.length) return null
  const label = controllers.length === 1 ? controllers[0].name : t('computers.controlled.many', { count: controllers.length })
  return (
    <Popover
      className="controlled-chip-wrap"
      panelClassName="controlled-pop"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      label={t('computers.controlled.popTitle')}
      trigger={(p) => (
        <ChipButton {...p} pill className="controlled-chip" title={t('computers.controlled.chipTitle', { name: label })}>
          <ComputerIcon platform={controllers[0].platform} />
          <Status tone="info" label={label} className="controlled-chip-label" />
        </ChipButton>
      )}
    >
      <div className="controlled-pop-head">
        <strong>{t('computers.controlled.popTitle')}</strong>
        <IconButton label={t('common.close')} onClick={() => setOpen(false)}>
          <X size={12} />
        </IconButton>
      </div>
      {controllers.map((c) => (
        <div key={c.id} className="controlled-row">
          <strong>{t('computers.controlled.title', { name: c.name })}</strong>
          {c.since && <span className="small muted">{t('computers.controlled.since', { when: formatDateTime(c.since, t.locale) })}</span>}
          <p className="small">{t('computers.controlled.detail')}</p>
          <Button size="sm" variant="danger" icon={<X size={12} />} onClick={() => void attempt(() => api.disconnectController(c.id))}>
            {t('computers.controlled.disconnect')}
          </Button>
        </div>
      ))}
    </Popover>
  )
}
