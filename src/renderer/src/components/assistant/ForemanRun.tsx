// A `foreman` command in the assistant's answers: a code block that starts with `foreman` gets a Copy chip, and a
// command the assistant proposed with run_foreman is shown with Run and Cancel (the only way it runs), then its output.
import { Check, CircleAlert, Copy, Play, X } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { ForemanRunInput } from '../../../../shared/assistant'
import type { ChatItem } from '../../../../shared/types'
import { announce } from '../../announce'
import { useT } from '../../i18n'
import { api, attempt } from '../../store'
import { Button, Card, Spinner } from '../../ui'

// A longer output is cut here until "Show all".
const COLLAPSED_LINES = 20

/** The wrapper for a fenced block whose first word is `foreman`: the block with a small Copy chip above it. */
export function wrapForemanCode(code: string, block: ReactNode): ReactNode | undefined {
  if (!/^foreman(\s|$)/.test(code.trim())) return undefined
  return <CommandBlock command={code.trim()}>{block}</CommandBlock>
}

function CommandBlock({ command, children }: { command: string; children: ReactNode }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <div className="shell-snippet assistant-command">
      <div className="snippet-toolbar" data-search-ignore>
        <span className="faint small">foreman</span>
        <span className="spacer" />
        <Button
          size="sm"
          variant="ghost"
          icon={copied ? <Check size={12} /> : <Copy size={12} />}
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            })
          }}
        >
          {copied ? t('assistant.run.copied') : t('assistant.run.copy')}
        </Button>
      </div>
      {children}
    </div>
  )
}

/** A proposed command and where it is: waiting for the click, running, finished or cancelled. */
export function ForemanRunRow({ threadId, item }: { threadId: string | null; item: Extract<ChatItem, { kind: 'tool' }> }) {
  const t = useT()
  const input = item.input as ForemanRunInput
  const [busy, setBusy] = useState(false)
  // A proposal is spoken once, as it appears: what it does, the exact command, and that Run is the way to go ahead.
  // The summary comes first when there is one ("approve the Bash call in api-fix: foreman approve 3f9a1c2").
  const pending = input.state === 'pending'
  const spoken = input.summary ? `${input.summary}: ${input.command}` : input.command
  useEffect(() => {
    if (pending) announce(t('assistant.run.proposed', { command: spoken }), 'ask:proposal')
    // Once per proposal: a re-render or a language change does not say it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, input.runId])
  const click = (call: (threadId: string, runId: string) => Promise<void>) => {
    if (!threadId || busy) return
    setBusy(true)
    void attempt(() => call(threadId, input.runId)).finally(() => setBusy(false))
  }
  return (
    <Card className={`assistant-run ${input.state}`} role="group" aria-label={t('a11y.assistant.proposedCommand', { command: input.command })}>
      {input.summary && <div className="assistant-run-summary faint small">{input.summary}</div>}
      <pre className="assistant-run-command">{input.command}</pre>
      {input.state === 'pending' && (
        <div className="assistant-run-actions">
          <Button size="sm" variant="primary" icon={<Play size={12} />} disabled={busy} onClick={() => click((id, run) => api.assistantConfirmRun(id, run))}>
            {t('assistant.run.run')}
          </Button>
          <Button size="sm" icon={<X size={12} />} disabled={busy} onClick={() => click((id, run) => api.assistantCancelRun(id, run))}>
            {t('assistant.run.cancel')}
          </Button>
        </div>
      )}
      {input.state === 'running' && (
        <div className="assistant-run-status faint small" role="status">
          <Spinner size={11} /> {t('assistant.run.running')}
        </div>
      )}
      {input.state === 'cancelled' && <div className="assistant-run-status faint small">{t('assistant.run.cancelled')}</div>}
      {input.state === 'done' && (
        <div className={`assistant-run-status small ${input.exitCode ? 'bad' : 'faint'}`}>
          {input.exitCode ? <CircleAlert size={11} /> : <Check size={11} />} {t('assistant.run.exit', { code: String(input.exitCode ?? 0) })}
        </div>
      )}
      {item.output !== undefined && input.state !== 'cancelled' && <Output text={item.output} />}
    </Card>
  )
}

/** A command's output in monospace, cut to its first lines until "Show all". */
function Output({ text }: { text: string }) {
  const t = useT()
  const [all, setAll] = useState(false)
  const lines = text.replace(/\s+$/, '').split('\n')
  if (!text.trim()) return <div className="assistant-run-output faint small">{t('assistant.run.noOutput')}</div>
  const cut = !all && lines.length > COLLAPSED_LINES
  return (
    <div className="assistant-run-output">
      <pre>{cut ? lines.slice(0, COLLAPSED_LINES).join('\n') : lines.join('\n')}</pre>
      {lines.length > COLLAPSED_LINES && (
        <Button size="sm" variant="ghost" onClick={() => setAll(!all)}>
          {all ? t('assistant.run.showLess') : t('assistant.run.showAll')}
        </Button>
      )}
    </div>
  )
}
