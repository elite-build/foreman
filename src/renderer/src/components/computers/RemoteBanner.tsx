// Across the top of the window while it shows another computer (shared/remote.ts): which one, that the work runs there,
// and the way back. When the link drops it says so and keeps retrying; the work over there carries on.
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore, viewComputer } from '../../store'
import { Button, Callout } from '../../ui'
import './computers.css'

export function RemoteBanner() {
  const t = useT()
  const viewing = useStore((s) => s.computers?.viewing)
  if (!viewing) return null
  const lost = viewing.state === 'lost'
  const waiting = viewing.state === 'waiting'
  return (
    <Callout
      banner
      tone={lost || waiting ? 'warn' : 'info'}
      role={lost ? 'alert' : 'status'}
      className="remote-banner"
      title={t(lost ? 'computers.banner.lost' : waiting ? 'computers.banner.waiting' : 'computers.banner.controlling', { name: viewing.name })}
      actions={
        <>
          {lost && (
            <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void viewComputer(viewing.id)}>
              {t('computers.banner.retry')}
            </Button>
          )}
          <Button size="sm" icon={<ArrowLeft size={12} />} onClick={() => void viewComputer(null)}>
            {t('computers.banner.back')}
          </Button>
        </>
      }
    >
      {t(lost ? 'computers.banner.lostDetail' : 'computers.banner.detail')}
    </Callout>
  )
}
