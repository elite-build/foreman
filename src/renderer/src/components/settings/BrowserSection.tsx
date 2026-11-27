// Settings → Browser (Foreman for Chrome, shared/browserLink.ts): whether agents in a workspace may use one of the user's
// browsers, how to load the extension, which browsers have connected (allow, make default, rename, forget) and the sites
// no agent may open or act on. The browser list is the store's `browserLinks`, kept current by the browser-links event.
import { FolderOpen } from 'lucide-react'
import { useState } from 'react'
import { BROWSER_KIND_LABEL, DEFAULT_BLOCKED_SITES, type BrowserLinkInfo } from '../../../../shared/browserLink'
import { useT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { Button, Callout, Field, Status, Tag, TextArea, TextInput } from '../../ui'
import { Page, saveSettings, Section, ToggleRow, useSettings } from './controls'
import './browser.css'

export function BrowserPage() {
  const t = useT()
  const settings = useSettings()
  return (
    <Page title={t('settings.page.browser')} description={t('settings.browser.desc')}>
      <Section>
        <ToggleRow
          id="browser-control"
          label={t('settings.browser.control.label')}
          help={t('settings.browser.control.help')}
          checked={Boolean(settings.browserControl)}
          onChange={(browserControl) => void saveSettings({ browserControl })}
        />
      </Section>
      {settings.browserControl && (
        <>
          <Section title={t('settings.browser.install.title')} setting="browser-install" description={t('settings.browser.install.help')}>
            <InstallSteps />
          </Section>
          <Section title={t('settings.browser.list.title')} setting="browser-list" description={t('settings.browser.list.help')}>
            <BrowserList />
          </Section>
          <Section title={t('settings.browser.blocked.title')} setting="browser-blocked" description={t('settings.browser.blocked.help')}>
            <BlockedSites />
          </Section>
          <Callout tone="neutral">{t('settings.browser.callout')}</Callout>
        </>
      )}
    </Page>
  )
}

/** The three steps to load the unpacked extension, and a button that shows its folder in the file manager (and registers the host). */
function InstallSteps() {
  const t = useT()
  return (
    <div className="browser-install">
      <ol className="browser-steps">
        <li>{t('settings.browser.install.step1')}</li>
        <li>{t('settings.browser.install.step2')}</li>
        <li>{t('settings.browser.install.step3')}</li>
      </ol>
      <Button icon={<FolderOpen size={13} />} onClick={() => void attempt(() => api.revealBrowserExtension())}>
        {t('settings.browser.install.reveal')}
      </Button>
    </div>
  )
}

/** Every browser that has connected or is allowed. Empty until the extension has said hello from one. */
function BrowserList() {
  const t = useT()
  const links = useStore((s) => s.browserLinks)
  const defaultId = useSettings().browserDefault
  if (!links.length) return <p className="set-section-desc">{t('settings.browser.list.empty')}</p>
  return (
    <ul className="browser-list" aria-label={t('settings.browser.list.title')}>
      {links.map((link) => (
        <li key={link.id}>
          <BrowserRow link={link} isDefault={link.id === defaultId} />
        </li>
      ))}
    </ul>
  )
}

/** One browser: its state in words, then Allow (waiting) or Make default, Rename and Forget (allowed). */
function BrowserRow({ link, isDefault }: { link: BrowserLinkInfo; isDefault: boolean }) {
  const t = useT()
  // The name typed for a waiting browser, or the new name while renaming an allowed one.
  const [name, setName] = useState(BROWSER_KIND_LABEL[link.kind])
  const [renaming, setRenaming] = useState(false)
  const state = link.connected ? (
    <Status tone="ok" label={t('settings.browser.status.connected')} />
  ) : link.allowed ? (
    <Status tone="off" label={t('settings.browser.status.notOpen')} />
  ) : (
    <Status tone="warn" label={t('settings.browser.status.waiting')} />
  )
  const allow = async () => {
    // attempt() gives undefined both on success (allowBrowser returns nothing) and on failure, so report success explicitly.
    const saved = await attempt(async () => (await api.allowBrowser(link.id, name.trim() || BROWSER_KIND_LABEL[link.kind]), true))
    if (saved) setRenaming(false)
  }

  if (!link.allowed) {
    return (
      <div className="browser-row">
        <div className="browser-head">
          <span>{link.name}</span> {state}
        </div>
        <Field label={t('settings.browser.allow.name')} description={t('settings.browser.allow.help')}>
          {(control) => <TextInput {...control} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void allow()} />}
        </Field>
        <div className="browser-actions">
          <Button variant="primary" size="sm" onClick={() => void allow()}>
            {t('settings.browser.allow')}
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="browser-row">
      <div className="browser-head">
        <span>{link.name}</span> {state}
      </div>
      {renaming && (
        <Field label={t('settings.browser.rename.name')}>
          {(control) => <TextInput {...control} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !e.nativeEvent.isComposing && void allow()} />}
        </Field>
      )}
      <div className="browser-actions">
        {isDefault ? (
          <Tag>{t('settings.browser.default')}</Tag>
        ) : (
          <Button size="sm" onClick={() => void saveSettings({ browserDefault: link.id })}>
            {t('settings.browser.makeDefault')}
          </Button>
        )}
        {renaming ? (
          <>
            <Button variant="primary" size="sm" onClick={() => void allow()}>
              {t('common.save')}
            </Button>
            <Button size="sm" onClick={() => setRenaming(false)}>
              {t('common.cancel')}
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            onClick={() => {
              setName(link.name)
              setRenaming(true)
            }}
          >
            {t('common.rename')}
          </Button>
        )}
        <Button size="sm" variant="danger" onClick={() => void attempt(() => api.forgetBrowser(link.id))}>
          {t('settings.browser.forget')}
        </Button>
      </div>
    </div>
  )
}

/** The sites no agent may open or act on, one per line. Saved with the button, as the other text fields save on leaving. */
function BlockedSites() {
  const t = useT()
  const saved = useSettings().browserBlocked ?? DEFAULT_BLOCKED_SITES
  const [text, setText] = useState(saved.join('\n'))
  const save = async (sites: string[]) => {
    if (await saveSettings({ browserBlocked: sites })) setText(sites.join('\n'))
  }
  return (
    <div className="browser-blocked">
      <Field label={t('settings.browser.blocked.title')} hideLabel>
        {(control) => <TextArea {...control} mono rows={6} value={text} onChange={(e) => setText(e.target.value)} />}
      </Field>
      <div className="browser-actions">
        <Button variant="primary" size="sm" onClick={() => void save(text.split('\n').map((line) => line.trim()).filter(Boolean))}>
          {t('common.save')}
        </Button>
        <Button size="sm" onClick={() => void save([...DEFAULT_BLOCKED_SITES])}>
          {t('settings.browser.blocked.restore')}
        </Button>
      </div>
    </div>
  )
}
