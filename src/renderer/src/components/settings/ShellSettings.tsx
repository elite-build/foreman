// O4, Windows only: Settings → General → Terminal (the Shell list, what scripts run with,
// and the new-terminal menu it feeds), and Settings → Advanced → Script shell.
import { ChevronDown } from 'lucide-react'
import { Fragment, useState } from 'react'
import {
  autoShell,
  newTerminalShells,
  SCRIPT_SHELLS,
  scriptShellPath,
  SHELL_CHOICES,
  shellName,
  shellPath,
  type ScriptShellChoice,
  type ShellChoice,
  type ShellDetection
} from '../../../../shared/shells'
import { useT, type RendererT } from '../../i18n'
import { openSettingsPage } from '../../store'
import { Button, LinkButton, Listbox, Popover, Select, type ListboxOption } from '../../ui'
import { useShells } from '../useShells'
import { resetSettings, Row, saveSettings, Section, TextRow, useSettings } from './controls'

// How each script shell reads a variable, for the help text.
const VARIABLE: Record<ScriptShellChoice, string> = { cmd: '%FOREMAN_PORT%', powershell: '$env:FOREMAN_PORT', gitbash: '$FOREMAN_PORT' }
const EXECUTABLE: Record<ScriptShellChoice, string> = { cmd: 'cmd.exe', powershell: 'powershell.exe', gitbash: 'bash.exe' }

/** "pwsh" for C:\…\pwsh.exe: Automatic's pick, as the mock writes it. */
const exeName = (file: string | null) => (file ?? '').split(/[\\/]/).pop()?.replace(/\.exe$/i, '') ?? ''

/** The Shell list's label for a choice: "Automatic (pwsh)", "WSL (Ubuntu)", "Custom…". */
function choiceLabel(choice: ShellChoice, found: ShellDetection | null, t: RendererT): string {
  if (choice === 'auto') {
    const pick = found && autoShell(found)
    return pick ? t('settings.terminal.shell.autoLabel', { shell: exeName(found.paths[pick]) }) : t('terminal.shell.name.auto')
  }
  if (choice === 'custom') return t('settings.terminal.shell.custom')
  return shellName(choice, t, found)
}

export function TerminalShellSection() {
  const t = useT()
  const settings = useSettings()
  const { found, refresh } = useShells()
  const choice = settings.terminalShell
  const path = found ? shellPath(choice, found) : null
  const missing = found !== null && choice !== 'auto' && !path
  const script = settings.scriptShell

  const detail = !found ? (
    t('terminal.shell.looking')
  ) : missing ? (
    t('settings.terminal.shell.fallback')
  ) : (
    <>
      {t.rich('settings.terminal.shell.using', { path: <code key="path">{path}</code> })}
      {choice === 'wsl' && <div>{t('settings.terminal.shell.wslSlow')}</div>}
    </>
  )

  return (
    <Section title={t('settings.general.section.terminal')} description={t('settings.general.section.terminalDesc')}>
      <Row
        id="terminal-shell"
        label={t('settings.terminal.shell.label')}
        help={t('settings.terminal.shell.help')}
        detail={detail}
        onReset={choice === 'auto' ? undefined : () => void resetSettings(['terminalShell'])}
      >
        <ShellPicker value={choice} found={found} onOpen={refresh} onChange={(terminalShell) => void saveSettings({ terminalShell })} />
      </Row>
      {choice === 'custom' && (
        <TextRow
          id="terminal-shell-custom"
          label={t('settings.terminal.custom.label')}
          help={t.rich('settings.terminal.custom.help', { example: <code key="example">C:\msys64\usr\bin\zsh.exe -l</code> })}
          detail={found && settings.terminalShellCustom.trim() && !found.custom.path ? t('settings.terminal.shell.fallback') : undefined}
          placeholder="C:\msys64\usr\bin\zsh.exe -l"
          mono
          value={settings.terminalShellCustom}
          onCommit={(value) => {
            void saveSettings({ terminalShellCustom: value.trim() }).then(refresh)
          }}
          onReset={settings.terminalShellCustom ? () => void resetSettings(['terminalShellCustom']).then(refresh) : undefined}
        />
      )}
      <Row
        id="scripts-run-with"
        label={t('settings.terminal.scripts.label')}
        help={t.rich('settings.terminal.scripts.help', { shell: t(`terminal.shell.name.${script}`), variable: <code key="var">{VARIABLE[script]}</code> })}
      >
        <span className="shell-scripts">
          <code>{EXECUTABLE[script]}</code>
          <span className="faint">·</span>
          <LinkButton onClick={() => openSettingsPage({ section: 'advanced', scrollTo: 'script-shell' })}>{t('settings.terminal.scripts.change')}</LinkButton>
        </span>
      </Row>
      <Row id="new-terminal-menu" label={t('settings.terminal.menu.label')} help={t('settings.terminal.menu.help')} stacked>
        {found && (
          <div className="shell-preview" aria-hidden>
            {newTerminalShells(choice, found).map(({ shell, isDefault }, i) => (
              <Fragment key={shell}>
                {i > 0 && <span className="faint">·</span>}
                <span className={isDefault ? 'shell-preview-default' : 'muted'}>
                  {shell === 'custom' ? t('terminal.shell.name.custom') : shellName(shell, t, found)}
                  {isDefault && <span className="faint"> {t('terminal.shell.default')}</span>}
                </span>
              </Fragment>
            ))}
          </div>
        )}
      </Row>
    </Section>
  )
}

/**
 * The Shell list: a popover with a listbox rather than a native select, because each option shows the
 * executable Foreman found on a second line. Shells that weren't found say so and can't be picked.
 * Arrows, Home/End, type-to-find and Esc work as in a select.
 */
function ShellPicker({ value, found, onOpen, onChange }: { value: ShellChoice; found: ShellDetection | null; onOpen: () => void; onChange: (value: ShellChoice) => void }) {
  const t = useT()
  const [open, setOpen] = useState(false)

  const pick = (next: ShellChoice) => {
    setOpen(false)
    if (next !== value) onChange(next)
  }

  const options: ListboxOption<ShellChoice>[] = SHELL_CHOICES.map((choice) => {
    const name = choiceLabel(choice, found, t)
    const path = found && choice !== 'auto' && choice !== 'custom' ? found.paths[choice] : null
    const missing = found !== null && choice !== 'auto' && choice !== 'custom' && !path
    const second =
      choice === 'auto'
        ? t('settings.terminal.shell.autoNote')
        : choice === 'custom'
          ? (found?.custom.path ?? t('settings.terminal.shell.customNote'))
          : missing
            ? choice === 'wsl'
              ? t.rich('settings.terminal.shell.wslNotFound', { command: <code key="cmd">wsl --list</code> })
              : t('settings.terminal.shell.notFound')
            : (path ?? '')
    const mono = Boolean(path) || (choice === 'custom' && Boolean(found?.custom.path))
    return {
      value: choice,
      label: name,
      disabled: missing,
      title: path ?? undefined,
      description: (
        <span className="shell-opt">
          <span className={mono ? 'shell-opt-path' : 'shell-opt-note'}>{second}</span>
          {choice === 'wsl' && !missing && <span className="shell-opt-note">{t('settings.terminal.shell.wslSlow')}</span>}
        </span>
      )
    }
  })

  return (
    <Popover
      className="shell-anchor"
      panelClassName="shell-menu"
      open={open}
      onOpenChange={(next) => {
        if (next) onOpen()
        setOpen(next)
      }}
      label={t('settings.terminal.shell.label')}
      side="bottom"
      trigger={(p) => (
        <Button
          {...p}
          className="shell-trigger"
          aria-label={t('settings.terminal.shell.label')}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
              e.preventDefault()
              onOpen()
              setOpen(true)
            }
          }}
        >
          <span>{choiceLabel(value, found, t)}</span>
          <ChevronDown size={14} className="faint" aria-hidden />
        </Button>
      )}
    >
      <Listbox label={t('settings.terminal.shell.label')} options={options} value={value} onChange={pick} />
    </Popover>
  )
}

/** Settings → Advanced → Script shell: cmd.exe unless the repositories' scripts are written for another shell. */
export function ScriptShellRow() {
  const t = useT()
  const settings = useSettings()
  const { found } = useShells()
  const value = settings.scriptShell
  const missing = found !== null && !scriptShellPath(value, found)
  return (
    <Row
      id="script-shell"
      label={t('settings.advanced.scriptShell.label')}
      help={t.rich('settings.advanced.scriptShell.help', {
        cmd: <code key="cmd">%FOREMAN_PORT%</code>,
        ps: <code key="ps">$env:FOREMAN_PORT</code>,
        bash: <code key="bash">$FOREMAN_PORT</code>
      })}
      detail={missing ? t('settings.advanced.scriptShell.notFound', { shell: t(`terminal.shell.name.${value}`) }) : t('settings.advanced.scriptShell.detail')}
      onReset={value === 'cmd' ? undefined : () => void resetSettings(['scriptShell'])}
    >
      <Select<ScriptShellChoice>
        label={t('settings.advanced.scriptShell.label')}
        width={190}
        value={value}
        options={SCRIPT_SHELLS.map((shell) => ({
          value: shell,
          label: found && !scriptShellPath(shell, found) ? `${t(`terminal.shell.name.${shell}`)} · ${t('settings.terminal.shell.notFound')}` : t(`terminal.shell.name.${shell}`)
        }))}
        onChange={(scriptShell) => void saveSettings({ scriptShell })}
      />
    </Row>
  )
}
