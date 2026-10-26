// #14: Settings → General → Open in apps. The default app, every catalogue app with where
// Foreman found it (or that it didn't), the user's own path per app, and the custom command
// (the old Editor command, unchanged).
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { foundApps, openInShortcut, type FoundWhere, type OpenInApp, type OpenInChoice } from '../../../../shared/openIn'
import type { PlainKey } from '../../../../shared/i18n'
import { useT } from '../../i18n'
import { appLabel, missingLabel, refreshOpenInApps, useDefaultApp, useOpenInApps } from '../../openIn'
import { api, getState, useStore } from '../../store'
import { AppIcon } from '../OpenIn'
import '../openIn.css'
import { Button, Select, Spinner, Tag, TextInput } from '../../ui'
import { resetSettings, Row, saveSettings, Section, TextRow, useDraft, useSettings } from './controls'

const WHERE: Record<FoundWhere, PlainKey> = {
  path: 'settings.openIn.where.path',
  registry: 'settings.openIn.where.registry',
  folder: 'settings.openIn.where.folder',
  toolbox: 'settings.openIn.where.toolbox',
  spotlight: 'settings.openIn.where.spotlight',
  applications: 'settings.openIn.where.applications',
  builtin: 'settings.openIn.where.builtin',
  user: 'settings.openIn.where.user'
}

async function savePath(id: string, file: string | null) {
  const current = { ...(getState().snapshot?.settings.openInPaths ?? {}) }
  if (file?.trim()) current[id] = file.trim()
  else delete current[id]
  if (await saveSettings({ openInPaths: current })) await refreshOpenInApps()
}

export function OpenInSection() {
  const t = useT()
  const settings = useSettings()
  const platform = useStore((s) => s.snapshot!.platform)
  const detection = useOpenInApps()
  const [checking, setChecking] = useState(false)
  const keys = openInShortcut(platform)
  const choice = settings.openInDefault
  const resolved = useDefaultApp(detection)
  const found = foundApps(detection)
  const auto = found.find((a) => a.kind === 'editor')

  const options: { value: OpenInChoice; label: string }[] = [
    { value: '', label: auto ? t('settings.openIn.default.auto', { app: appLabel(auto, platform, t) }) : t('settings.openIn.default.autoNone') },
    ...found.map((app) => ({ value: app.id, label: appLabel(app, platform, t) })),
    // A chosen app that's gone stays listed, marked, so the select doesn't lie about the setting.
    ...(choice && choice !== 'custom' && !found.some((a) => a.id === choice) ? [{ value: choice, label: t('settings.openIn.default.notFound', { app: missingLabel(choice, platform, t) }) }] : []),
    { value: 'custom', label: t('openIn.custom') }
  ]

  const refresh = async () => {
    setChecking(true)
    await refreshOpenInApps(true)
    setChecking(false)
  }

  return (
    <Section title={t('settings.openIn.section')} description={t('settings.openIn.sectionDesc', { keys })}>
      <Row
        id="open-in-apps"
        label={t('settings.openIn.default.label')}
        help={t('settings.openIn.default.help', { keys })}
        detail={resolved.kind === 'missing' ? t('settings.openIn.default.missing', { app: missingLabel(resolved.choice, platform, t) }) : undefined}
        onReset={choice === '' ? undefined : () => void resetSettings(['openInDefault'])}
      >
        <Select<OpenInChoice> label={t('settings.openIn.default.label')} width={210} value={choice} options={options} onChange={(openInDefault) => void saveSettings({ openInDefault })} />
      </Row>
      <Row
        id="open-in-list"
        label={t('settings.openIn.apps.label')}
        help={t('settings.openIn.apps.help')}
        below={
          <div className="open-in-apps">
            {!detection && <div className="open-in-app faint small">{t('openIn.looking')}</div>}
            {detection?.apps.map((app) => <AppRow key={app.id} app={app} isDefault={resolved.kind === 'app' && resolved.app.id === app.id} />)}
          </div>
        }
      >
        <Button size="sm" variant="ghost" disabled={checking} icon={checking ? <Spinner size={12} /> : <RefreshCw size={12} />} onClick={() => void refresh()}>
          {t('settings.openIn.refresh')}
        </Button>
      </Row>
      <TextRow
        id="editor-command"
        label={t('settings.openIn.custom.label')}
        help={t.rich('settings.openIn.custom.help', {
          code: <code key="code">code</code>,
          cursor: <code key="cursor">cursor</code>,
          zed: <code key="zed">zed</code>
        })}
        placeholder="code"
        mono
        wide
        value={settings.editorCommand}
        onCommit={(value) => void saveSettings({ editorCommand: value.trim() })}
        onReset={settings.editorCommand === 'code' ? undefined : () => void resetSettings(['editorCommand'])}
      />
    </Section>
  )
}

function AppRow({ app, isDefault }: { app: OpenInApp; isDefault: boolean }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const name = appLabel(app, platform, t)
  const own = app.userPath !== undefined
  const missing = !app.path

  const browse = async () => {
    const file = await api.pickPath({ title: t('settings.openIn.pickTitle', { app: name }), kind: 'file', defaultPath: app.path ?? app.detected ?? undefined }).catch(() => null)
    if (file) await savePath(app.id, file)
  }

  const where = app.found ? t(WHERE[app.found]) : null
  return (
    <div className={`open-in-app ${missing ? 'missing' : ''}`}>
      <AppIcon id={app.id} />
      <div className="open-in-app-main">
        <div className="open-in-app-title">
          <span>{name}</span>
          {app.atLine && <Tag tone="outline">{t('settings.openIn.atLine')}</Tag>}
          {isDefault && <Tag tone="accent">{t('openIn.default')}</Tag>}
          {own && !app.userPathMissing && <span className="faint small">{t('settings.openIn.where.user')}</span>}
        </div>
        {own ? (
          <OwnPath app={app} name={name} onBrowse={() => void browse()} />
        ) : missing ? (
          <span className="faint small">{t('settings.openIn.notFound')}</span>
        ) : app.found === 'builtin' ? (
          <span className="faint small mono">{where}</span>
        ) : (
          <span className="faint small mono open-in-app-path" title={app.path ?? undefined}>
            {app.path}
            {where ? `, ${where}` : ''}
          </span>
        )}
      </div>
      {app.kind !== 'files' && !own && (
        <div className="open-in-app-actions">
          <Button size="sm" variant="ghost" onClick={() => void browse()}>
            {missing ? t('settings.openIn.choose') : t('settings.openIn.change')}
          </Button>
        </div>
      )}
    </div>
  )
}

/** The user's own path: an input (Enter or leaving it saves), Browse…, and Use detected. */
function OwnPath({ app, name, onBrowse }: { app: OpenInApp; name: string; onBrowse: () => void }) {
  const t = useT()
  const draft = useDraft(app.userPath ?? '', (next) => void savePath(app.id, next))
  return (
    <>
      <div className="open-in-app-edit">
        <TextInput mono aria-label={t('settings.openIn.pathLabel', { app: name })} spellCheck={false} autoComplete="off" onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} {...draft} />
        <Button size="sm" onClick={onBrowse}>
          {t('settings.openIn.browse')}
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void savePath(app.id, null)}>
          {t('settings.openIn.useDetected')}
        </Button>
      </div>
      {app.userPathMissing && <span className="error-text small">{t('settings.openIn.userMissing')}</span>}
    </>
  )
}
