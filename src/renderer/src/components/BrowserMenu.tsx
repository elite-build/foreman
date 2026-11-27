// The browser agents use (Foreman for Chrome, shared/browserLink.ts), as items in the workspace header's name menu:
// which of the user's allowed browsers this workspace's agents use. Shown only when Settings → Browser is on; the
// workspace view offers it for local workspaces only. Choosing writes Workspace.browser; 'none' keeps agents here off
// any browser.
import { browserFor } from '../../../shared/browserLink'
import type { Workspace } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, openSettingsPage, useStore } from '../store'
import { MenuGroup, MenuItem, MenuLabel, MenuRadioItem } from '../ui'

export function BrowserMenuItems({ ws }: { ws: Workspace }) {
  const t = useT()
  const settings = useStore((s) => s.snapshot?.settings)
  const links = useStore((s) => s.browserLinks)
  if (!settings?.browserControl) return null
  const allowed = links.filter((link) => link.allowed)
  const effective = browserFor(ws.browser, settings.browserDefault, links)
  // The checked item: the workspace's own choice, else the browser agents would get without one.
  const checked = ws.browser ?? effective?.id ?? 'none'
  const choose = (value: string) => void attempt(() => api.updateWorkspace(ws.id, { browser: value }))

  return (
    <>
      <MenuLabel>{t('workspace.browser.menu')}</MenuLabel>
      {allowed.length === 0 ? (
        <MenuLabel>{t('workspace.browser.noneYet')}</MenuLabel>
      ) : (
        <MenuGroup label={t('workspace.browser.menu')}>
          {allowed.map((link) => (
            <MenuRadioItem
              key={link.id}
              checked={checked === link.id}
              onSelect={() => choose(link.id)}
              description={link.connected ? t('settings.browser.status.connected') : t('settings.browser.status.notOpen')}
            >
              {link.name}
              {!ws.browser && effective?.id === link.id ? ` ${t('workspace.browser.defaultSuffix')}` : ''}
            </MenuRadioItem>
          ))}
          <MenuRadioItem checked={checked === 'none'} onSelect={() => choose('none')}>
            {t('workspace.browser.none')}
          </MenuRadioItem>
        </MenuGroup>
      )}
      <MenuItem onSelect={() => openSettingsPage({ section: 'browser' })}>{t('workspace.browser.settings')}</MenuItem>
    </>
  )
}
