// A sign-in command (claude, codex or gh login) run in an inline terminal,
// used on the Agents and Account pages.
import { LogIn, SquareTerminal, X } from 'lucide-react'
import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { Button, IconButton } from '../../ui'
import { TerminalView } from '../TerminalView'

// #22: `login:<agent id>` runs a catalog agent's own sign-in. 'claude-setup-token' prints a token for cloud workspaces.
export type LoginCommand = 'claude-login' | 'claude-setup-token' | 'codex-login' | 'gh-login' | `login:${string}`

interface LoginTerminalProps {
  command: LoginCommand
  // Shown to the user, e.g. "claude /login".
  commandLabel: string
  // Label for the button that opens the terminal.
  buttonLabel: string
  primary?: boolean
  // Called after the user clicks Done (refresh status here).
  onDone: () => void
  // #22: the Done button's label (catalog agents say "Check again"), and what to do in the terminal.
  doneLabel?: string
  hint?: string
  // Cloud workspaces: open straight into the terminal, and let the caller drop it when closed.
  startOpen?: boolean
  onClose?: () => void
}

/** A button that, when clicked, becomes a terminal running the login command. */
export function LoginTerminal({ command, commandLabel, buttonLabel, primary, onDone, doneLabel: doneText, hint, startOpen, onClose }: LoginTerminalProps) {
  const t = useT()
  const doneLabel = doneText ?? t('common.done')
  const [open, setOpen] = useState(Boolean(startOpen))
  const [exitCode, setExitCode] = useState<number | null>(null)
  const body = useRef<HTMLDivElement>(null)

  if (!open) {
    return (
      <div className="set-auth-actions">
        <Button
          size="sm"
          variant={primary ? 'primary' : 'default'}
          icon={<LogIn size={13} />}
          onClick={() => {
            setExitCode(null)
            setOpen(true)
          }}
        >
          {buttonLabel}
        </Button>
        <span className="set-help">
          {t.rich(hint ? 'loginTerminal.helpHint' : 'loginTerminal.help', { command: <code key="c">{commandLabel}</code>, hint: hint ?? '', done: doneLabel })}
        </span>
      </div>
    )
  }

  const status = exitCode === null ? t('loginTerminal.running', { command: commandLabel }) : exitCode === 0 ? t('loginTerminal.finished', { command: commandLabel }) : t('loginTerminal.exited', { command: commandLabel, code: exitCode })
  return (
    <div className="set-login">
      <div className="set-login-head">
        <SquareTerminal size={13} className="faint" />
        <span className="small">{status}</span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setOpen(false)
            onDone()
          }}
        >
          {doneLabel}
        </Button>
        <IconButton
          label={t('loginTerminal.close')}
          onClick={() => {
            setOpen(false)
            onClose?.()
          }}
        >
          <X size={13} />
        </IconButton>
      </div>
      <div className="set-login-body" ref={body}>
        <TerminalView
          workspaceId=""
          kind="command"
          command={command}
          visible
          // Login flows ask for input (e.g. a pasted code), so take focus.
          onSpawn={() => body.current?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus()}
          onExit={setExitCode}
        />
      </div>
    </div>
  )
}
