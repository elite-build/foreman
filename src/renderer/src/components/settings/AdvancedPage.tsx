import { FolderOpen } from 'lucide-react'
import { useEffect, useState } from 'react'
import { BACKGROUND_WAIT_CHOICES, choicesWith, RUNNING_AGENT_CHOICES } from '../../../../shared/agentSlots'
import type { CliInstallStatus } from '../../../../shared/types'
import { useT } from '../../i18n'
import { api, attempt, showToast, useStore } from '../../store'
import { Button, Select, Spinner, TextInput } from '../../ui'
import { Page, resetSettings, Row, saveSettings, Section, TextRow, ToggleRow, useDraft, useSettings } from './controls'
import { ScriptShellRow } from './ShellSettings'

const SCROLLBACK_DEFAULT = 10
const SCROLLBACK_MIN = 1
const SCROLLBACK_MAX = 1000

export function AdvancedPage() {
  const settings = useSettings()
  const t = useT()
  const homeDir = useStore((s) => s.snapshot!.homeDir)
  const platform = useStore((s) => s.snapshot!.platform)
  const sep = platform === 'win32' ? '\\' : '/'
  const defaultRoot = [homeDir, 'foreman', 'workspaces'].join(sep)

  const chooseFolder = async () => {
    const dir = await attempt(() => api.pickPath({ kind: 'directory', title: t('settings.advanced.workspacesFolder.pick'), defaultPath: settings.workspacesRoot }))
    if (dir && dir !== settings.workspacesRoot) void saveSettings({ workspacesRoot: dir })
  }

  return (
    <Page title={t('settings.page.advanced')}>
      <Section title={t('settings.advanced.section.storage')}>
        <TextRow
          id="workspaces-folder"
          label={t('settings.advanced.workspacesFolder.label')}
          help={t('settings.advanced.workspacesFolder.help')}
          detail={t('settings.advanced.workspacesFolder.detail')}
          mono
          wide
          value={settings.workspacesRoot}
          onCommit={(value) => (value.trim() ? void saveSettings({ workspacesRoot: value.trim() }) : false)}
          onReset={settings.workspacesRoot === defaultRoot ? undefined : () => void resetSettings(['workspacesRoot'])}
          after={
            <Button size="sm" icon={<FolderOpen size={13} />} onClick={() => void chooseFolder()}>
              {t('settings.openIn.choose')}
            </Button>
          }
        />
      </Section>

      <Section title={t('settings.general.section.terminal')}>
        {platform === 'win32' && <ScriptShellRow />}
        <ScrollbackRow />
        <ToggleRow
          id="terminal-copy-on-select"
          label={t('settings.advanced.copyOnSelect.label')}
          help={t('settings.advanced.copyOnSelect.help')}
          checked={settings.terminalCopyOnSelect}
          onChange={(terminalCopyOnSelect) => void saveSettings({ terminalCopyOnSelect })}
          onReset={settings.terminalCopyOnSelect ? () => void resetSettings(['terminalCopyOnSelect']) : undefined}
        />
        <ToggleRow
          id="terminal-restore"
          label={t('settings.advanced.restoreTerminals.label')}
          help={t('settings.advanced.restoreTerminals.help')}
          detail={t('settings.advanced.restoreTerminals.detail')}
          checked={settings.restoreTerminals}
          onChange={(restoreTerminals) => void saveSettings({ restoreTerminals })}
          onReset={settings.restoreTerminals ? undefined : () => void resetSettings(['restoreTerminals'])}
        />
      </Section>

      <Section title={t('keepRunning.settings.section')}>
        <ToggleRow
          id="keep-agents-running"
          label={t('keepRunning.settings.label')}
          help={t('keepRunning.settings.help')}
          detail={t('keepRunning.settings.detail')}
          checked={settings.keepAgentsRunning}
          onChange={(keepAgentsRunning) => void saveSettings({ keepAgentsRunning })}
          onReset={settings.keepAgentsRunning ? () => void resetSettings(['keepAgentsRunning']) : undefined}
        />
        <MaxAgentsRow />
        <BackgroundWaitRow />
      </Section>

      <Section title={t('settings.advanced.section.commandLine')}>
        <CliRow />
      </Section>
    </Page>
  )
}

function ScrollbackRow() {
  const t = useT()
  const settings = useSettings()
  const draft = useDraft(String(settings.terminalScrollbackMb), (value) => {
    const n = Number(value.trim())
    if (!value.trim() || !Number.isFinite(n)) return false
    const mb = Math.min(SCROLLBACK_MAX, Math.max(SCROLLBACK_MIN, Math.round(n)))
    // Put the saved value back when nothing changes (e.g. 5000 clamps to the current 1000).
    if (mb === settings.terminalScrollbackMb) return false
    void saveSettings({ terminalScrollbackMb: mb })
  })

  return (
    <Row
      id="terminal-scrollback"
      label={t('settings.advanced.scrollback.label')}
      help={t('settings.advanced.scrollback.help')}
      onReset={settings.terminalScrollbackMb === SCROLLBACK_DEFAULT ? undefined : () => void resetSettings(['terminalScrollbackMb'])}
    >
      {(control) => (
        <div className="set-number">
          <TextInput
            {...control}
            type="number"
            inputMode="numeric"
            min={SCROLLBACK_MIN}
            max={SCROLLBACK_MAX}
            step={1}
            onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
            {...draft}
          />
          <span className="muted">{t('settings.advanced.scrollback.unit')}</span>
        </div>
      )}
    </Row>
  )
}

/** How many turns may run here at once; over it, new turns queue (0: no limit, the default). */
function MaxAgentsRow() {
  const t = useT()
  const settings = useSettings()
  const value = settings.maxRunningAgents ?? 0
  return (
    <Row
      id="max-running-agents"
      label={t('settings.advanced.maxAgents.label')}
      help={t('settings.advanced.maxAgents.help')}
      onReset={value ? () => void resetSettings(['maxRunningAgents']) : undefined}
    >
      {(control) => (
        <Select<string>
          {...control}
          width={140}
          value={String(value)}
          options={choicesWith(RUNNING_AGENT_CHOICES, value).map((n) => ({ value: String(n), label: n ? String(n) : t('settings.advanced.maxAgents.none') }))}
          onChange={(next) => void saveSettings({ maxRunningAgents: Number(next) })}
        />
      )}
    </Row>
  )
}

/** How long a Claude Code turn that has answered waits for its background work (0: as long as it runs, the default). */
function BackgroundWaitRow() {
  const t = useT()
  const settings = useSettings()
  const value = settings.backgroundWaitMinutes ?? 0
  return (
    <Row
      id="background-wait"
      label={t('settings.advanced.backgroundWait.label')}
      help={t('settings.advanced.backgroundWait.help')}
      onReset={value ? () => void resetSettings(['backgroundWaitMinutes']) : undefined}
    >
      {(control) => (
        <Select<string>
          {...control}
          width={160}
          value={String(value)}
          options={choicesWith(BACKGROUND_WAIT_CHOICES, value).map((n) => ({ value: String(n), label: n ? t('settings.advanced.backgroundWait.after', { count: n }) : t('settings.advanced.backgroundWait.never') }))}
          onChange={(next) => void saveSettings({ backgroundWaitMinutes: Number(next) })}
        />
      )}
    </Row>
  )
}

/** The `foreman` command: start a workspace from a prompt template in a terminal. */
function CliRow() {
  const t = useT()
  // null while the first check runs.
  const [status, setStatus] = useState<CliInstallStatus | null>(null)
  const [installing, setInstalling] = useState(false)

  useEffect(() => {
    let alive = true
    api.cliStatus().then(
      (value) => alive && setStatus(value),
      () => alive && setStatus({ installed: false, path: null })
    )
    return () => {
      alive = false
    }
  }, [])

  const install = async () => {
    setInstalling(true)
    const result = await attempt(() => api.installCli())
    setInstalling(false)
    if (!result) return
    setStatus(result)
    showToast(result.note ? t('settings.advanced.cli.installedNote', { note: result.note }) : t('settings.advanced.cli.installedToast'))
  }

  return (
    <Row
      id="cli-command"
      label={t('settings.advanced.cli.label')}
      help={t.rich('settings.advanced.cli.help', { example: <code key="example">foreman run issue ENG-123</code> })}
      detail={status?.installed && status.path ? <code>{status.path}</code> : undefined}
    >
      {status?.installed ? (
        <span className="set-granted">{t('settings.advanced.cli.installed')}</span>
      ) : (
        <Button size="sm" disabled={status === null || installing} icon={installing ? <Spinner size={13} /> : undefined} onClick={() => void install()}>
          {t('settings.advanced.cli.install')}
        </Button>
      )}
    </Row>
  )
}
