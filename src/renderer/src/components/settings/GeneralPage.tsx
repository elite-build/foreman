import { ChevronDown, Download, Languages, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { completeness, LOCALES, localeName, resolveSystemLocale, type LanguageSetting, type PlainKey } from '../../../../shared/i18n'
import type { Settings, SoundSetting } from '../../../../shared/types'
import type { UpdateCheckResult } from '../../../../shared/appUpdate'
import { systemLanguages, useT, type RendererT } from '../../i18n'
import { playSound } from '../../sound'
import { api, attempt, showToast, startTour, useStore } from '../../store'
import { KeepAwakeOptions } from './KeepAwakeOptions'
import { TerminalShellSection } from './ShellSettings'
import { OpenInSection } from './OpenInSettings'
import { Button, Listbox, Popover, Select, Status, type ListboxOption } from '../../ui'
import { Page, resetSettings, Row, saveSettings, Section, ToggleRow, useSettings } from './controls'

const DEFAULTS = {
  language: 'system',
  messageSendKey: 'enter',
  followUpMode: 'steer',
  notifications: true,
  sound: 'chime',
  dockBadge: true,
  trayIcon: true,
  autoConvertLongText: true,
  notAbsolutelyRight: false,
  alwaysShowContextUsage: false,
  keepAwake: false,
  // O17 cutoffs; the keep-awake row's Reset resets them too.
  keepAwakeBatteryCutoff: true,
  keepAwakeBatteryPercent: 20,
  keepAwakeThermalCutoff: true,
  keepAwakeOnlyOnPower: false,
  checkForUpdates: true,
  expandToolCalls: false,
  assistantEnabled: true
} satisfies Partial<Settings>

const KEEP_AWAKE_KEYS = ['keepAwake', 'keepAwakeBatteryCutoff', 'keepAwakeBatteryPercent', 'keepAwakeThermalCutoff', 'keepAwakeOnlyOnPower'] as const

const SOUNDS: { value: SoundSetting; label: PlainKey }[] = [
  { value: 'chime', label: 'settings.general.sound.chime' },
  { value: 'bell', label: 'settings.general.sound.bell' },
  { value: 'pop', label: 'settings.general.sound.pop' },
  { value: 'marimba', label: 'settings.general.sound.marimba' },
  { value: 'none', label: 'settings.general.sound.none' }
]

/** Notifications need the system's permission; ask when turning them on. */
async function notificationsAllowed(): Promise<boolean> {
  if (typeof Notification === 'undefined') return true
  if (Notification.permission === 'default') return (await Notification.requestPermission().catch(() => 'denied')) !== 'denied'
  return Notification.permission !== 'denied'
}

export function GeneralPage() {
  const t = useT()
  const settings = useSettings()
  const platform = useStore((s) => s.snapshot!.platform)
  const mac = platform === 'darwin'
  const modEnter = mac ? '⌘ Enter' : 'Ctrl+Enter'
  const reset = (key: keyof typeof DEFAULTS) => (settings[key] === DEFAULTS[key] ? undefined : () => void resetSettings([key]))

  // The other follow-up mode is one shortcut away (see the composer).
  const oppositeKey = settings.messageSendKey === 'enter' ? modEnter : mac ? '⌥ Enter' : 'Alt+Enter'
  const oppositeDetail = settings.followUpMode === 'steer' ? 'settings.general.followUp.detailQueue' : 'settings.general.followUp.detailSteer'

  return (
    <Page title={t('settings.general.title')}>
      <Section title={t('settings.general.section.language')} description={t('settings.general.section.languageDesc')}>
        <Row id="language" label={languageRowLabel(t)} help={t('settings.language.help')} onReset={reset('language')}>
          <LanguagePicker value={settings.language} onChange={(language) => void saveSettings({ language })} />
        </Row>
      </Section>

      <Section title={t('settings.general.section.chat')}>
        <Row
          id="message-send-key"
          label={t('settings.general.sendKey.label')}
          help={t('settings.general.sendKey.help')}
          detail={settings.messageSendKey === 'enter' ? t('settings.general.sendKey.detailEnter') : t('settings.general.sendKey.detailModEnter')}
          onReset={reset('messageSendKey')}
        >
          {(control) => (
            <Select<Settings['messageSendKey']>
              {...control}
              width={140}
              value={settings.messageSendKey}
              options={[
                { value: 'enter', label: 'Enter' },
                { value: 'mod-enter', label: modEnter }
              ]}
              onChange={(messageSendKey) => void saveSettings({ messageSendKey })}
            />
          )}
        </Row>
        <Row
          id="follow-up-mode"
          label={t('settings.general.followUp.label')}
          help={t('settings.general.followUp.help')}
          detail={t(oppositeDetail, { keys: oppositeKey })}
          onReset={reset('followUpMode')}
        >
          {(control) => (
            <Select<Settings['followUpMode']>
              {...control}
              width={140}
              value={settings.followUpMode}
              options={[
                { value: 'queue', label: t('settings.general.followUp.queue') },
                { value: 'steer', label: t('settings.general.followUp.steer') }
              ]}
              onChange={(followUpMode) => void saveSettings({ followUpMode })}
            />
          )}
        </Row>
        <ToggleRow
          id="auto-convert-long-text"
          label={t('settings.general.autoConvert.label')}
          help={t('settings.general.autoConvert.help')}
          checked={settings.autoConvertLongText}
          onChange={(autoConvertLongText) => void saveSettings({ autoConvertLongText })}
          onReset={reset('autoConvertLongText')}
        />
        <ToggleRow
          id="not-absolutely-right"
          label={t('settings.general.notAbsolutelyRight.label')}
          help={t('settings.general.notAbsolutelyRight.help')}
          checked={settings.notAbsolutelyRight}
          onChange={(notAbsolutelyRight) => void saveSettings({ notAbsolutelyRight })}
          onReset={reset('notAbsolutelyRight')}
        />
        <ToggleRow
          id="always-show-context-usage"
          label={t('settings.general.contextUsage.label')}
          help={t('settings.general.contextUsage.help')}
          checked={settings.alwaysShowContextUsage}
          onChange={(alwaysShowContextUsage) => void saveSettings({ alwaysShowContextUsage })}
          onReset={reset('alwaysShowContextUsage')}
        />
        <ToggleRow
          id="expand-tool-calls"
          label={t('settings.general.expandToolCalls.label')}
          help={t('settings.general.expandToolCalls.help')}
          detail={t('settings.general.expandToolCalls.detail', { keys: mac ? '⌃O' : 'Ctrl+O' })}
          checked={settings.expandToolCalls}
          onChange={(expandToolCalls) => void saveSettings({ expandToolCalls })}
          onReset={reset('expandToolCalls')}
        />
      </Section>

      <Section title={t('assistant.title')}>
        <ToggleRow
          id="assistant"
          label={t('assistant.settings.enabled')}
          help={t('assistant.settings.enabledHelp')}
          checked={settings.assistantEnabled}
          onChange={(assistantEnabled) => void saveSettings({ assistantEnabled })}
          onReset={reset('assistantEnabled')}
        />
        <Row id="assistant-history" label={t('assistant.settings.history')} help={t('assistant.settings.historyHelp')}>
          <Button
            size="sm"
            onClick={() => window.confirm(t('assistant.settings.clearConfirm')) && void attempt(() => api.assistantClearHistory()).then(() => showToast(t('assistant.settings.cleared')))}
          >
            {t('assistant.settings.clear')}
          </Button>
        </Row>
        <Row id="welcome-tour" label={t('tour.label')} help={t('tour.settings.help')}>
          <Button size="sm" onClick={startTour}>
            {t('tour.settings.show')}
          </Button>
        </Row>
      </Section>

      <Section title={t('settings.general.section.notifications')}>
        <ToggleRow
          id="notifications"
          label={t('settings.general.notifications.label')}
          help={t('settings.general.notifications.help')}
          checked={settings.notifications}
          onChange={async (notifications) => {
            if (notifications && !(await notificationsAllowed())) return showToast(t('settings.general.notifications.denied'))
            void saveSettings({ notifications })
          }}
          onReset={reset('notifications')}
        />
        <Row id="completion-sound" label={t('settings.general.sound.label')} help={t('settings.general.sound.help')} onReset={reset('sound')}>
          {(control) => (
            <>
              <Select<SoundSetting>
                {...control}
                width={150}
                value={settings.sound}
                options={SOUNDS.map((s) => ({ value: s.value, label: t(s.label) }))}
                onChange={(sound) => {
                  playSound(sound)
                  void saveSettings({ sound })
                }}
              />
              <Button size="sm" variant="ghost" icon={<Volume2 size={13} />} disabled={settings.sound === 'none'} onClick={() => playSound(settings.sound)}>
                {t('settings.general.sound.test')}
              </Button>
            </>
          )}
        </Row>
        <ToggleRow
          id="dock-badge"
          label={t('settings.general.dockBadge.label')}
          help={t('settings.general.dockBadge.help')}
          checked={settings.dockBadge}
          onChange={(dockBadge) => void saveSettings({ dockBadge })}
          onReset={reset('dockBadge')}
        />
        {/* #3: the menu-bar extra (macOS) or tray icon (Windows), on by default. */}
        <ToggleRow
          id="tray-icon"
          label={t(mac ? 'attention.settings.menuBar' : 'attention.settings.tray')}
          help={t('attention.settings.help')}
          checked={settings.trayIcon}
          onChange={(trayIcon) => void saveSettings({ trayIcon })}
          onReset={reset('trayIcon')}
        />
      </Section>

      <Section title={t('settings.general.section.system')}>
        {mac && <FullDiskAccessRow />}
        <ToggleRow
          id="keep-awake"
          label={t('settings.general.keepAwake.label')}
          help={t('settings.general.keepAwake.help')}
          checked={settings.keepAwake}
          onChange={(keepAwake) => void saveSettings({ keepAwake })}
          onReset={KEEP_AWAKE_KEYS.every((key) => settings[key] === DEFAULTS[key]) ? undefined : () => void resetSettings([...KEEP_AWAKE_KEYS])}
          below={settings.keepAwake && <KeepAwakeOptions />}
        />
        <ToggleRow
          id="check-for-updates"
          label={t('settings.general.checkForUpdates.label')}
          help={t('settings.general.checkForUpdates.help')}
          checked={settings.checkForUpdates}
          onChange={(checkForUpdates) => void saveSettings({ checkForUpdates })}
          onReset={reset('checkForUpdates')}
          below={<CheckForUpdatesNow />}
        />
      </Section>

      <OpenInSection />

      {platform === 'win32' && <TerminalShellSection />}
    </Page>
  )
}

/** "Idioma · Language": the English word stays, so a language you can't read can be undone. */
export function languageRowLabel(t: RendererT): string {
  const label = t('settings.language.label')
  return label === 'Language' ? label : `${label} · Language`
}

/**
 * Language picker: System (and what it resolves to), English, then the other languages in their own names with how
 * much of Foreman each translates. A popover holding a listbox, so the arrow keys, Home, End and typing a name all work.
 */
function LanguagePicker({ value, onChange }: { value: LanguageSetting; onChange: (value: LanguageSetting) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const system = localeName(resolveSystemLocale(systemLanguages()))
  const systemLabel = t('settings.language.system', { language: system })
  const percent = new Intl.NumberFormat(t.locale, { style: 'percent' })
  const options: ListboxOption<LanguageSetting>[] = [
    { value: 'system', label: systemLabel },
    ...LOCALES.map((l) => ({
      value: l.code as LanguageSetting,
      label: l.name,
      // Each language's own name is in its own language; tell screen readers which.
      lang: l.code,
      trailing: l.code === 'en' ? undefined : <span className="lang-pct">{percent.format(completeness(l.code) / 100)}</span>
    }))
  ]
  const current = options.find((o) => o.value === value) ?? options[0]
  const pick = (next: LanguageSetting) => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  return (
    <Popover
      className="lang-anchor"
      panelClassName="lang-panel"
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      label={t('settings.language.menuLabel')}
      trigger={(popover) => (
        <Button
          {...popover}
          className="lang-trigger"
          aria-label={`${t('settings.language.label')}: ${current.label}`}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault()
              setOpen(true)
            }
          }}
        >
          <Languages size={14} aria-hidden />
          <span>{current.label}</span>
          <ChevronDown size={14} className="faint" aria-hidden />
        </Button>
      )}
    >
      <div className="lang-head faint small">{t('settings.language.menuLabel')}</div>
      <Listbox label={t('settings.language.menuLabel')} options={options} value={value} onChange={pick} />
      <div className="lang-foot faint small">{t('settings.language.fallbackNote')}</div>
    </Popover>
  )
}

/** The running version and "Check now", which works with the start-up check on or off; a newer release links to its page. */
function CheckForUpdatesNow() {
  const t = useT()
  const version = useStore((s) => s.snapshot!.appVersion)
  const [result, setResult] = useState<UpdateCheckResult | 'checking' | null>(null)
  const check = async () => {
    setResult('checking')
    setResult(await api.checkForUpdates().catch((): UpdateCheckResult => ({ state: 'failed', current: version ?? '' })))
  }
  const found = result && result !== 'checking' ? result : null
  return (
    <div className="update-check">
      {version && <span>{t('settings.general.checkForUpdates.version', { version })}</span>}
      <Button size="sm" disabled={result === 'checking'} onClick={() => void check()}>
        {t(result === 'checking' ? 'settings.general.checkForUpdates.checking' : 'settings.general.checkForUpdates.checkNow')}
      </Button>
      <span role="status">
        {found?.state === 'current' && <Status tone="ok" label={t('settings.general.checkForUpdates.upToDate')} />}
        {found?.state === 'failed' && <Status tone="error" label={t('settings.general.checkForUpdates.failed')} />}
        {found?.state === 'available' && <Status tone="info" label={t('update.available', { version: found.update.version })} />}
      </span>
      {found?.state === 'available' && (
        <Button size="sm" variant="primary" icon={<Download size={12} />} title={t('update.downloadTitle')} onClick={() => void attempt(() => api.openExternal(found.update.url))}>
          {t('update.download')}
        </Button>
      )}
    </div>
  )
}

/** macOS only: whether the app has Full Disk Access, checked while it doesn't. */
function FullDiskAccessRow() {
  const t = useT()
  // null while the first check runs.
  const [granted, setGranted] = useState<boolean | null>(null)
  const grantedRef = useRef(granted)
  grantedRef.current = granted

  useEffect(() => {
    let alive = true
    const check = () => {
      api.fullDiskAccess().then(
        (value) => {
          if (alive) setGranted(Boolean(value))
        },
        () => {
          if (alive) setGranted(false)
        }
      )
    }
    check()
    window.addEventListener('focus', check)
    // Poll until it's granted (the user may be in System Settings right now).
    const timer = setInterval(() => {
      if (!grantedRef.current) check()
    }, 5000)
    return () => {
      alive = false
      window.removeEventListener('focus', check)
      clearInterval(timer)
    }
  }, [])

  return (
    <Row id="full-disk-access" label={t('settings.general.fullDisk.label')} help={t('settings.general.fullDisk.help')}>
      {granted ? (
        <Status tone="ok" label={t('settings.general.fullDisk.granted')} />
      ) : (
        <Button
          size="sm"
          disabled={granted === null}
          onClick={() => void api.openFullDiskAccessSettings().catch(() => showToast(t('settings.general.fullDisk.openFailed')))}
        >
          {t('settings.general.fullDisk.open')}
        </Button>
      )}
    </Row>
  )
}
