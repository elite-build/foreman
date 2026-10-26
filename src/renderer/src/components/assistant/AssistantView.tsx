// The Foreman assistant: threads on the left, the conversation on the right. Covers the workspace
// area like Settings and Automations, so open workspaces stay mounted. It runs on the default agent;
// when that can't run it, the gate says why and what to do, and saved threads stay readable.
import { ArrowUp, Check, CircleAlert, Plug, Plus, RotateCw, Settings2, Sparkles, Square, Trash2, TriangleAlert } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { agentName, assistantToolName, settingEntry, type AssistantGate, type AssistantThreadSummary } from '../../../../shared/assistant'
import { modelInfo } from '../../../../shared/agents'
import type { ChatItem } from '../../../../shared/types'
import { formatClock, formatDateTime } from '../../../../shared/i18n/time'
import { useT, type RendererT } from '../../i18n'
import {
  api,
  attempt,
  closeAssistant,
  deleteAssistantThread,
  loadAssistant,
  openSettingsPage,
  selectAssistantThread,
  sendToAssistant,
  showSettingFromAssistant,
  useStore
} from '../../store'
import { ActionRow, Button, CardButton, Callout, IconButton, Spinner, Status, TextArea } from '../../ui'
import { Markdown } from '../Markdown'
import { ForemanRunRow, wrapForemanCode } from './ForemanRun'
import './assistant.css'

const EMPTY: ChatItem[] = []
const STARTERS = ['assistant.starter.defaultAgent', 'assistant.starter.terminal', 'assistant.starter.newRepo', 'assistant.starter.loadouts'] as const

export function AssistantView() {
  const t = useT()
  const assistant = useStore((s) => s.assistant)
  const threadId = useStore((s) => s.assistantThreadId)
  const items = useStore((s) => (s.assistantThreadId ? s.assistantItems[s.assistantThreadId] ?? EMPTY : EMPTY))
  // "Use Claude Code for this chat": the default agent can't run the assistant, so this view runs on the alternative.
  const [useAlternative, setUseAlternative] = useState(false)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if ((e.target as Element | null)?.closest?.('.modal, input, textarea, select')) return
      e.preventDefault()
      closeAssistant()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const gate = assistant?.gate ?? { state: 'checking' as const }
  const thread = assistant?.threads.find((th) => th.id === threadId)
  const running = Boolean(thread?.running)
  // A thread keeps its agent: one that ran on the alternative can go on with it.
  const onAlternative = gate.state === 'unsupported' && Boolean(gate.alternative) && (useAlternative || thread?.agent === gate.alternative)
  const canSend = gate.state === 'ready' || onAlternative
  const runsOn = gate.state === 'ready' ? { agent: gate.agent, model: gate.model } : onAlternative && gate.state === 'unsupported' ? { agent: gate.alternative!, model: '' } : undefined

  return (
    <div className="assistant-view">
      <header className="titlebar drag assistant-head">
        <span className="assistant-title" role="heading" aria-level={1}>
          <Sparkles size={15} /> {t('assistant.title')}
        </span>
        {runsOn && (
          <span className="assistant-runs-on" title={t('assistant.runsOn.title')}>
            <Status compact tone="ok" label={t('assistant.runsOn.title')} />
            {agentName(runsOn.agent)}
            {runsOn.model && ` · ${modelInfo(runsOn.agent, runsOn.model, t).label}`}
          </span>
        )}
      </header>
      <div className="assistant-body">
        <ThreadList threads={assistant?.threads ?? []} selected={threadId} />
        <section className="assistant-conv">
          <div className="assistant-scroll">
            <div className="assistant-col">
              {items.length ? (
                <Conversation items={items} title={thread?.title ?? t('assistant.title')} />
              ) : canSend ? (
                <Welcome onPick={(text) => void sendToAssistant(text, onAlternative)} />
              ) : (
                <Gate gate={gate} onUseAlternative={() => setUseAlternative(true)} />
              )}
            </div>
          </div>
          <footer className="assistant-foot">
            <div className="assistant-col">
              {items.length > 0 && !canSend && <GateLine gate={gate} onUseAlternative={() => setUseAlternative(true)} />}
              <Composer disabled={!canSend} running={running} threadId={threadId} useAlternative={onAlternative} />
            </div>
          </footer>
        </section>
      </div>
    </div>
  )
}

// ---- threads ----

function ThreadList({ threads, selected }: { threads: AssistantThreadSummary[]; selected: string | null }) {
  const t = useT()
  const today = new Date().toDateString()
  const groups: [string, AssistantThreadSummary[]][] = [
    [t('assistant.threads.today'), threads.filter((th) => new Date(th.updatedAt).toDateString() === today)],
    [t('assistant.threads.earlier'), threads.filter((th) => new Date(th.updatedAt).toDateString() !== today)]
  ]
  return (
    <aside className="assistant-threads" aria-label={t('assistant.threads.label')}>
      <Button size="sm" className="assistant-new" icon={<Plus size={13} />} onClick={() => selectAssistantThread(null)}>
        {t('assistant.threads.new')}
      </Button>
      {!threads.length && <div className="faint small assistant-threads-empty">{t('assistant.threads.empty')}</div>}
      {groups.map(([label, list]) =>
        list.length ? (
          <div key={label} className="assistant-thread-group">
            <div className="assistant-thread-heading">{label}</div>
            <ul className="assistant-thread-list" aria-label={label}>
              {list.map((th) => (
                <li key={th.id}>
                  <ActionRow
                    selected={th.id === selected}
                    revealActions
                    onPress={() => selectAssistantThread(th.id)}
                    primaryProps={{ className: 'assistant-thread-open' }}
                    actions={
                      <IconButton label={t('assistant.threads.delete')} onClick={() => window.confirm(t('assistant.threads.deleteConfirm')) && void deleteAssistantThread(th.id)}>
                        <Trash2 size={12} />
                      </IconButton>
                    }
                  >
                    <span className="assistant-thread-title">{th.title}</span>
                    <span className="assistant-thread-meta">
                      {th.running ? <Spinner size={11} /> : null}
                      {th.running ? t('assistant.threads.answering') : formatDateTime(th.updatedAt, t.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </ActionRow>
                </li>
              ))}
            </ul>
          </div>
        ) : null
      )}
    </aside>
  )
}

// ---- conversation ----

function Welcome({ onPick }: { onPick: (text: string) => void }) {
  const t = useT()
  return (
    <div className="assistant-welcome">
      <div className="assistant-welcome-icon">
        <Sparkles size={20} />
      </div>
      <h2>{t('assistant.welcome.title')}</h2>
      <p className="muted">{t('assistant.welcome.body')}</p>
      <div className="assistant-starters">
        {STARTERS.map((key) => (
          <CardButton key={key} className="assistant-starter" onClick={() => onPick(t(key))}>
            <span className="assistant-starter-text">{t(key)}</span>
          </CardButton>
        ))}
      </div>
    </div>
  )
}

function Conversation({ items, title }: { items: ChatItem[]; title: string }) {
  const t = useT()
  const threadId = useStore((s) => s.assistantThreadId)
  const end = useRef<HTMLDivElement>(null)
  const last = items[items.length - 1]
  useLayoutEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [items.length, last?.kind === 'assistant' ? last.text.length : 0])
  return (
    <div className="assistant-items">
      {/* The title is the level 1 heading; the conversation is level 2, and each message below it level 3. */}
      <h2 className="sr-only">{t('a11y.assistant.conversation', { title })}</h2>
      {items.map((item, index) => (
        <Item key={item.id} item={item} t={t} threadId={threadId} askedAt={askedAt(items, index)} />
      ))}
      <div ref={end} />
    </div>
  )
}

/** When the message an item answers was sent: the latest message of the user's before it. */
function askedAt(items: ChatItem[], index: number): string | undefined {
  for (let i = index; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'user' && !item.system) return item.at
  }
  return undefined
}

function Item({ item, t, threadId, askedAt }: { item: ChatItem; t: RendererT; threadId: string | null; askedAt?: string }): ReactNode {
  const time = askedAt ? formatClock(askedAt, t.locale) : undefined
  const headingId = useId()
  switch (item.kind) {
    case 'user':
      // The result of a command the user ran, sent for them: the command's own row already shows it.
      if (item.system) return null
      return (
        <article className="assistant-user" aria-labelledby={headingId}>
          <h3 id={headingId} className="sr-only">{t('chat.message.youAt', { time: formatClock(item.at, t.locale) })}</h3>
          {item.text}
        </article>
      )
    case 'assistant':
      return (
        <article className="assistant-answer" aria-labelledby={headingId} aria-busy={item.streaming ? true : undefined}>
          <h3 id={headingId} className="sr-only">{time ? t('a11y.assistant.assistantAt', { time }) : t('assistant.title')}</h3>
          <Markdown text={item.text} streaming={item.streaming} wrapCode={wrapForemanCode} headingStart={4} />
        </article>
      )
    case 'tool':
      return <ToolRow item={item} t={t} threadId={threadId} />
    case 'notice':
      if (item.level !== 'error') return <div className="assistant-note faint small">{item.text}</div>
      return (
        <Callout
          tone="error"
          role="alert"
          className="assistant-error"
          actions={
            item.action === 'sign-in' && (
              <Button size="sm" onClick={() => openSettingsPage({ section: 'agents', agent: 'claude' })}>
                {t('assistant.gate.signIn', { agent: agentName('claude') })}
              </Button>
            )
          }
        >
          {item.text}
        </Callout>
      )
    case 'result':
      return item.costUsd ? <div className="assistant-note faint small">{t('assistant.cost', { cost: `$${item.costUsd.toFixed(2)}` })}</div> : null
    case 'turn-end':
      if (item.outcome === 'cancelled') return <div className="assistant-note faint small">{t('assistant.stopped')}</div>
      if (item.outcome === 'completed') return null
      return (
        <Callout tone="error" role="alert" className="assistant-error">
          {item.error ?? t('assistant.failed')}
        </Callout>
      )
    default:
      // Thinking stays out of the way here.
      return null
  }
}

const TOOL_LABELS = {
  get_settings: 'assistant.tool.read',
  agent_status: 'assistant.tool.agents',
  list_workspaces: 'assistant.tool.workspaces',
  cli_help: 'assistant.tool.cliHelp',
  cli_status: 'assistant.tool.cliStatus'
} as const

function ToolRow({ item, t, threadId }: { item: Extract<ChatItem, { kind: 'tool' }>; t: RendererT; threadId: string | null }) {
  const name = assistantToolName(item.name)
  // A proposed command shows as its own row (Run, Cancel, output), not as the agent's tool call.
  if (name === 'foreman') return <ForemanRunRow threadId={threadId} item={item} />
  if (name === 'run_foreman') return null
  const input = (item.input ?? {}) as { id?: string; query?: string }
  if (name === 'show_setting') {
    const entry = input.id ? settingEntry(input.id) : undefined
    if (!entry || entry.page.section === 'repo' || item.status === 'error') return null
    const title = entry.titleKey ? t(entry.titleKey) : entry.title
    return (
      <Button size="sm" className="assistant-show" icon={<Settings2 size={13} />} onClick={() => showSettingFromAssistant(entry.id)}>
        {t('assistant.tool.show', { setting: title })}
      </Button>
    )
  }
  const label =
    name === 'search_settings' ? t('assistant.tool.search', { query: input.query ?? '' }) : name in TOOL_LABELS ? t(TOOL_LABELS[name as keyof typeof TOOL_LABELS]) : name
  return (
    <span className={`assistant-tool ${item.status}`}>
      {item.status === 'running' ? <Spinner size={11} /> : item.status === 'error' ? <CircleAlert size={11} /> : <Check size={11} />}
      {label}
    </span>
  )
}

// ---- composer ----

function Composer({ disabled, running, threadId, useAlternative }: { disabled: boolean; running: boolean; threadId: string | null; useAlternative: boolean }) {
  const t = useT()
  const sendKey = useStore((s) => s.snapshot!.settings.messageSendKey)
  const mac = useStore((s) => s.snapshot!.platform === 'darwin')
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!disabled) box.current?.focus()
  }, [disabled, threadId])

  const send = async () => {
    if (disabled || running || sending || !text.trim()) return
    setSending(true)
    const ok = await sendToAssistant(text, useAlternative)
    setSending(false)
    if (ok) setText('')
  }

  return (
    <div className={`assistant-composer ${disabled ? 'disabled' : ''}`}>
      <TextArea
        bare
        ref={box}
        rows={2}
        value={text}
        disabled={disabled}
        aria-label={disabled ? t('assistant.composer.unavailable') : threadId ? t('assistant.composer.followUp') : t('assistant.composer.placeholder')}
        placeholder={disabled ? t('assistant.composer.unavailable') : threadId ? t('assistant.composer.followUp') : t('assistant.composer.placeholder')}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          const mod = mac ? e.metaKey : e.ctrlKey
          if (sendKey === 'mod-enter' ? mod : !e.shiftKey && !mod) {
            e.preventDefault()
            void send()
          }
        }}
      />
      <div className="assistant-composer-bar">
        <span className="faint small">{t('assistant.composer.hint')}</span>
        {running && threadId ? (
          <Button size="sm" icon={<Square size={11} />} onClick={() => void attempt(() => api.assistantCancel(threadId))}>
            {t('assistant.composer.stop')}
          </Button>
        ) : (
          <IconButton variant="primary" label={t('assistant.composer.send')} disabled={disabled || sending || !text.trim()} onClick={() => void send()}>
            <ArrowUp size={13} />
          </IconButton>
        )}
      </div>
    </div>
  )
}

// ---- when it can't run ----

function gateCopy(gate: AssistantGate, t: RendererT): { icon: ReactNode; title: string; body: string } {
  switch (gate.state) {
    case 'off':
      return { icon: <Sparkles size={20} />, title: t('assistant.gate.off.title'), body: t('assistant.gate.off.body') }
    case 'privacy':
      return { icon: <Sparkles size={20} />, title: t('assistant.gate.privacy.title'), body: t('assistant.gate.privacy.body') }
    case 'none':
      return { icon: <Plug size={20} />, title: t('assistant.gate.none.title'), body: t('assistant.gate.none.body') }
    case 'signed-out':
      return { icon: <TriangleAlert size={20} />, title: t('assistant.gate.signedOut.title'), body: t('assistant.gate.signedOut.body', { agent: agentName(gate.agent) }) }
    case 'unsupported':
      return {
        icon: <Plug size={20} />,
        title: t('assistant.gate.unsupported.title'),
        body: t(gate.alternative ? 'assistant.gate.unsupported.body' : 'assistant.gate.unsupported.bodyNoAlternative', { agent: agentName(gate.agent), alternative: agentName(gate.alternative ?? 'claude') })
      }
    default:
      return { icon: <Spinner size={20} />, title: t('assistant.gate.checking'), body: '' }
  }
}

function GateActions({ gate, onUseAlternative }: { gate: AssistantGate; onUseAlternative: () => void }) {
  const t = useT()
  const recheck = (
    <Button variant="ghost" icon={<RotateCw size={13} />} onClick={() => void loadAssistant(true)}>
      {t('assistant.gate.checkAgain')}
    </Button>
  )
  switch (gate.state) {
    case 'off':
      return (
        <Button variant="primary" onClick={() => void attempt(() => api.updateSettings({ assistantEnabled: true })).then(() => loadAssistant())}>
          {t('assistant.gate.off.turnOn')}
        </Button>
      )
    case 'privacy':
      return (
        <Button onClick={() => openSettingsPage({ section: 'account', scrollTo: 'privacy-mode' })}>{t('assistant.gate.privacy.open')}</Button>
      )
    case 'none':
      return (
        <>
          <Button variant="primary" onClick={() => openSettingsPage({ section: 'agents' })}>
            {t('assistant.gate.none.setUp')}
          </Button>
          {recheck}
        </>
      )
    case 'signed-out':
      return (
        <>
          <Button variant="primary" onClick={() => openSettingsPage({ section: 'agents', agent: gate.agent })}>
            {t('assistant.gate.signIn', { agent: agentName(gate.agent) })}
          </Button>
          {recheck}
        </>
      )
    case 'unsupported':
      return (
        <>
          {gate.alternative ? (
            <Button variant="primary" onClick={onUseAlternative}>
              {t('assistant.gate.useAlternative', { agent: agentName(gate.alternative) })}
            </Button>
          ) : (
            <Button variant="primary" onClick={() => openSettingsPage({ section: 'agents', agent: 'claude' })}>
              {t('assistant.gate.signIn', { agent: agentName('claude') })}
            </Button>
          )}
          <Button onClick={() => openSettingsPage({ section: 'models', scrollTo: 'loadout' })}>{t('assistant.gate.changeDefault')}</Button>
        </>
      )
    default:
      return null
  }
}

function Gate({ gate, onUseAlternative }: { gate: AssistantGate; onUseAlternative: () => void }) {
  const t = useT()
  const copy = gateCopy(gate, t)
  return (
    <div className="assistant-gate" role={gate.state === 'checking' ? 'status' : undefined}>
      <div className={`assistant-gate-icon ${gate.state === 'signed-out' ? 'warn' : ''}`}>{copy.icon}</div>
      <h2>{copy.title}</h2>
      {copy.body && <p className="muted">{copy.body}</p>}
      <div className="assistant-gate-actions">
        <GateActions gate={gate} onUseAlternative={onUseAlternative} />
      </div>
      {gate.state === 'unsupported' && gate.alternative && <p className="faint small">{t('assistant.gate.alternativeNote', { agent: agentName(gate.alternative) })}</p>}
    </div>
  )
}

/** Above the composer of a saved thread when the assistant can't run now. */
function GateLine({ gate, onUseAlternative }: { gate: AssistantGate; onUseAlternative: () => void }) {
  const t = useT()
  const copy = gateCopy(gate, t)
  return (
    <Callout tone="warn" role="status" className="assistant-gate-line" actions={<GateActions gate={gate} onUseAlternative={onUseAlternative} />}>
      {copy.title}
    </Callout>
  )
}
