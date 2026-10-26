import { Play, Square } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import { bridge } from '../store'
import { TerminalView } from './TerminalView'
import { useT } from '../i18n'
import { Button } from '../ui'

export function ShellSnippet({
  workspaceId,
  command,
  disabled,
  children
}: {
  workspaceId: string
  command: string
  disabled: boolean
  children: ReactNode
}) {
  const [execution, setExecution] = useState<{ id: number; command: string } | null>(null)
  const [status, setStatus] = useState<'idle' | 'running' | 'stopped' | 'finished'>('idle')
  const [exitCode, setExitCode] = useState<number | null>(null)
  const pty = useRef<string | null>(null)
  const stopping = useRef(false)
  const t = useT()

  return (
    <div className="shell-snippet">
      <div className="snippet-toolbar" data-search-ignore>
        <span className="faint small">Bash</span>
        <span className="spacer" />
        <span className={`small ${exitCode !== null && exitCode !== 0 && status !== 'stopped' ? 'bad' : 'faint'}`} role="status">
          {status === 'running' ? t('shellSnippet.running') : status === 'stopped' ? t('shellSnippet.stopped') : status === 'finished' ? t('shellSnippet.exit', { code: String(exitCode) }) : ''}
        </span>
        {status === 'running' ? (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square size={12} fill="currentColor" />}
            onClick={() => {
              stopping.current = true
              setStatus('stopped')
              if (pty.current) bridge.send.ptyKill(pty.current)
            }}
          >
            {t('common.stop')}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            icon={<Play size={12} />}
            disabled={disabled || !command.trim()}
            title={t('shellSnippet.runTitle')}
            onClick={() => {
              pty.current = null
              stopping.current = false
              setExitCode(null)
              setStatus('running')
              // Freeze the clicked command: a later Markdown edit must never
              // restart the terminal with different code on its own.
              setExecution((previous) => ({ id: (previous?.id ?? 0) + 1, command }))
            }}
          >
            {execution ? t('shellSnippet.runAgain') : t('shellSnippet.run')}
          </Button>
        )}
      </div>
      {children}
      {execution && (
        <div className="snippet-output" data-search-ignore>
          <TerminalView
            key={execution.id}
            workspaceId={workspaceId}
            kind="snippet"
            command={execution.command}
            // G4 #10: the name the agent sees in the block's label line (agent-facing text stays English).
            sendAs="Shell snippet"
            visible
            onSpawn={(id) => {
              pty.current = id
              if (stopping.current) bridge.send.ptyKill(id)
            }}
            onExit={(code) => {
              pty.current = null
              setExitCode(code)
              setStatus(stopping.current ? 'stopped' : 'finished')
            }}
          />
        </div>
      )}
    </div>
  )
}
