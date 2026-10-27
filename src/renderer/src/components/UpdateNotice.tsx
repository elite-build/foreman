// A newer Foreman is out (main/updates.ts checks at each start): the sidebar's notice above the footer, until Later
// (this run) or Skip this version. Download opens the release page; installing stays with the user.
import { Download } from 'lucide-react'
import { useT } from '../i18n'
import { api, attempt, useStore } from '../store'
import { Button, Callout } from '../ui'

export function UpdateNotice() {
  const t = useT()
  const update = useStore((s) => s.snapshot!.update)
  if (!update) return null
  return (
    <Callout
      tone="info"
      role="status"
      className="update-notice"
      title={t('update.available', { version: update.version })}
      actions={
        <>
          <Button size="sm" variant="primary" icon={<Download size={12} />} title={t('update.downloadTitle')} onClick={() => void attempt(() => api.openExternal(update.url))}>
            {t('update.download')}
          </Button>
          <Button size="sm" title={t('update.laterTitle')} onClick={() => void attempt(() => api.dismissUpdate(false))}>
            {t('update.later')}
          </Button>
          <Button size="sm" variant="ghost" title={t('update.skipTitle', { version: update.version })} onClick={() => void attempt(() => api.dismissUpdate(true))}>
            {t('update.skip')}
          </Button>
        </>
      }
    >
      {t('update.body', { current: update.current })}
    </Callout>
  )
}
