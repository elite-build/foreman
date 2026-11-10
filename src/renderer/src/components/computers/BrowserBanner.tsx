// Across the top of the page in a browser (docs/server.md, "A browser") while its connection to the computer isn't live:
// reconnecting, signed out, browser access turned off, or a page older than the Foreman that served it. The same banner
// as RemoteBanner's, which says the same of a paired computer whose link dropped.
import { RefreshCw } from 'lucide-react'
import { useT } from '../../i18n'
import { useStore } from '../../store'
import { Button, Callout } from '../../ui'
import './computers.css'

export function BrowserBanner() {
  const t = useT()
  const client = useStore((s) => s.client)
  // Before the first welcome there is no page to put it on; live needs no banner.
  if (!client || client.status === 'live' || client.status === 'connecting') return null
  const { status } = client
  const stuck = status === 'signedOut' || status === 'outdated'
  return (
    <Callout
      banner
      tone={stuck ? 'error' : 'warn'}
      role={stuck ? 'alert' : 'status'}
      className="remote-banner"
      title={status === 'reconnecting' ? t('browser.banner.reconnecting', { name: client.name || t('browser.banner.computer') }) : t(`browser.banner.${status}`)}
      actions={
        status === 'outdated' ? (
          <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => location.reload()}>
            {t('browser.banner.reload')}
          </Button>
        ) : undefined
      }
    >
      {t(`browser.banner.${status}Detail`)}
    </Callout>
  )
}
