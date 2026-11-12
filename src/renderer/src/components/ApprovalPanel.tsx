import { MessageCircleQuestion, ShieldCheck, Workflow } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import type { ApprovalRequest, SubagentRef } from '../../../shared/types'
import { isFallback } from '../../../shared/agentCapabilities'
import { AGENTS } from '../../../shared/agents'
import { useT } from '../i18n'
import { api, attempt, modKey, selectWorkspace, showChecksPanel, useCapabilities, useStore } from '../store'
import { Button, CardButton, Field, Kbd, LinkButton, Tab, TabList, Tabs, TextArea, TextInput } from '../ui'
import { toolSummary } from './ToolRow'

type ToolRequest = Extract<ApprovalRequest, { kind: 'tool' }>
type QuestionRequest = Extract<ApprovalRequest, { kind: 'question' }>
type GateRequest = Extract<ApprovalRequest, { kind: 'gate' }>
type PickRequest = Extract<ApprovalRequest, { kind: 'pick' }>

const TOOL_TITLES: Record<string, PlainKey> = {
  Bash: 'approval.title.bash',
  Edit: 'approval.title.edit',
  MultiEdit: 'approval.title.edit',
  Write: 'approval.title.write',
  NotebookEdit: 'approval.title.notebook',
  WebFetch: 'approval.title.fetch',
  WebSearch: 'approval.title.search'
}

/** "From subagent explore-tests": who is asking, when it isn't the agent itself (docs/agents.md 6). */
function FromSubagent({ subagent, id }: { subagent?: SubagentRef; id: string }) {
  const t = useT()
  if (!subagent) return null
  return (
    <div className="faint small" id={id}>
      {subagent.name ? t.rich('approval.fromSubagent', { name: <strong key="name" className="mono">{subagent.name}</strong> }) : t('approval.fromSubagent.unnamed')}
    </div>
  )
}

const isTyping = (target: EventTarget) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement

/** Takes the composer's place while the agent waits for permission. */
export function ToolApprovalPanel({ request, workspacePath }: { request: ToolRequest; workspacePath: string }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  // An agent that can't remember an always-allow gets no button for it, and the card says why (docs/agents.md 8).
  const tab = useStore((s) => s.snapshot!.sessions.find((x) => x.id === request.sessionId))
  const alwaysAllow = useCapabilities(tab?.agent ?? '', tab?.instanceId)?.approvals.alwaysAllow
  const onceOnly = tab && !request.alternate && alwaysAllow && isFallback(alwaysAllow, 'once-always')
  const [reason, setReason] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const mod = modKey(platform)
  const titleId = useId()
  const fromId = useId()
  const reasonHelpId = useId()

  useEffect(() => panel.current?.focus(), [request.id])

  const answer = (allow: boolean, alternate = false) =>
    void attempt(() =>
      api.respondApproval(request.id, { kind: 'tool', allow, alternate, message: allow ? undefined : reason.trim() || undefined })
    )

  // Panel shortcuts fire only when the panel itself has focus (or the reason box, where Enter denies). A focused
  // button activates natively, so Enter on No denies and Enter on the alternate answer takes it. Mod+Enter is the
  // alternate shortcut from anywhere in the panel.
  const onKeyDown = (e: KeyboardEvent) => {
    const modDown = platform === 'darwin' ? e.metaKey : e.ctrlKey
    const onPanel = e.target === panel.current
    if (e.key === 'Enter' && modDown) {
      e.preventDefault()
      answer(true, Boolean(request.alternate))
    } else if (e.key === 'Enter' && onPanel) {
      e.preventDefault()
      answer(true)
    } else if (e.key === 'Backspace' && onPanel) {
      e.preventDefault()
      answer(false)
    } else if (e.key === 'Enter' && isTyping(e.target)) {
      e.preventDefault()
      answer(false)
    }
  }

  const summary = toolSummary(request.toolName, request.input, workspacePath, t)
  // Where Foreman remembers it for the session, the button says exactly what: the command or path it will let through.
  const alternateLabel =
    request.alternate === 'edits-for-session'
      ? t('approval.alternate.edits')
      : request.alternate === 'always-allow'
        ? request.alwaysScope
          ? t.rich('approval.alternate.alwaysScope', { scope: <code key="scope" className="mono">{request.alwaysScope}</code> })
          : t('approval.alternate.always')
        : null

  return (
    <div className="composer">
      <div className="approval-panel" tabIndex={-1} ref={panel} onKeyDown={onKeyDown} role="group" aria-labelledby={titleId} aria-describedby={request.subagent ? fromId : undefined}>
        <div className="approval-title">
          <ShieldCheck size={15} />
          <strong id={titleId}>{TOOL_TITLES[request.toolName] ? t(TOOL_TITLES[request.toolName]) : t('approval.title.other', { tool: request.toolName.replace(/^mcp__[^_]+__/, '') })}</strong>
        </div>
        <FromSubagent subagent={request.subagent} id={fromId} />
        {summary && <code className="approval-summary">{summary}</code>}
        {request.reason && <div className="faint small">{request.reason}</div>}
        {onceOnly && <div className="faint small">{t('approval.onceAlways', { agent: AGENTS[tab.agent].label })}</div>}
        <details>
          <summary>{t('approval.details')}</summary>
          <pre>{JSON.stringify(request.input, null, 2)}</pre>
        </details>
        <div className="approval-actions">
          <TextInput
            className="approval-reason"
            aria-label={t('approval.reasonPlaceholder')}
            aria-describedby={reasonHelpId}
            placeholder={t('approval.reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <span id={reasonHelpId} className="sr-only">
            {t('approval.reason.enterDenies')}
          </span>
          <Button onClick={() => answer(false)}>
            {t('approval.no')} <Kbd>⌫</Kbd>
          </Button>
          {alternateLabel && (
            <Button onClick={() => answer(true, true)}>
              {alternateLabel} <Kbd>{mod}↵</Kbd>
            </Button>
          )}
          <Button variant="primary" onClick={() => answer(true)}>
            {t('approval.yes')} <Kbd>↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/** Multiple-choice questions from the agent, answered with keys 1–9 or free text. */
export function QuestionPanel({ request }: { request: QuestionRequest }) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const [choices, setChoices] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const panel = useRef<HTMLDivElement>(null)
  const otherInput = useRef<HTMLTextAreaElement>(null)
  const titleId = useId()
  const fromId = useId()
  const question = request.questions[index]

  useEffect(() => panel.current?.focus(), [request.id])

  const toggle = (label: string) => {
    const current = choices[index] ?? []
    const next = question.multiSelect ? (current.includes(label) ? current.filter((c) => c !== label) : [...current, label]) : [label]
    setChoices({ ...choices, [index]: next })
    if (!question.multiSelect && index < request.questions.length - 1) setIndex(index + 1)
  }

  const submit = (skipped = false) => {
    const answers: Record<string, string> = {}
    request.questions.forEach((q, n) => {
      const parts = [...(choices[n] ?? [])]
      if (other[n]?.trim()) parts.push(other[n].trim())
      answers[q.question] = parts.join(', ') || '(no answer)'
    })
    void attempt(() => api.respondApproval(request.id, skipped ? { kind: 'question', skipped: true } : { kind: 'question', answers }))
  }

  const onKeyDown = (e: KeyboardEvent) => {
    // Only when the panel itself has focus: a focused option, tab or button does its own thing. (Arrows on the
    // question tabs are handled by the tab list.)
    if (e.target !== panel.current || e.defaultPrevented) return
    if (/^[1-9]$/.test(e.key)) {
      const option = question.options[Number(e.key) - 1]
      if (option) toggle(option.label)
    } else if (e.key === '0') {
      e.preventDefault()
      otherInput.current?.focus()
    } else if (e.key === 'ArrowRight') setIndex(Math.min(index + 1, request.questions.length - 1))
    else if (e.key === 'ArrowLeft') setIndex(Math.max(index - 1, 0))
    else if (e.key === 'Enter') submit()
  }

  return (
    <div className="composer">
      <div className="approval-panel question" tabIndex={-1} ref={panel} onKeyDown={onKeyDown} role="group" aria-labelledby={titleId} aria-describedby={request.subagent ? fromId : undefined}>
        <div className="approval-title">
          <MessageCircleQuestion size={15} />
          <strong id={titleId}>{question.header ? `${question.header}: ` : ''}{question.question}</strong>
        </div>
        <FromSubagent subagent={request.subagent} id={fromId} />
        {request.questions.length > 1 && (
          <Tabs className="question-tabs" variant="pill" value={String(index)} onChange={(v) => setIndex(Number(v))}>
            <TabList label={t('approval.question.tabs')}>
              {request.questions.map((q, n) => (
                <Tab key={n} value={String(n)}>
                  {t('approval.question.tab', { n: n + 1 })}
                  {(choices[n]?.length || other[n]) && ' ✓'}
                </Tab>
              ))}
            </TabList>
          </Tabs>
        )}
        <div className="question-options">
          {question.options.map((option, n) => {
            const selected = (choices[index] ?? []).includes(option.label)
            return (
              <CardButton key={option.label} size="sm" selected={selected} className="question-option" aria-pressed={selected} onClick={() => toggle(option.label)}>
                <Kbd>{n + 1}</Kbd>
                <span>
                  <span className="option-label">{option.label}</span>
                  {option.description && <span className="faint small"> — {option.description}</span>}
                </span>
              </CardButton>
            )
          })}
          <label className="question-other">
            <Kbd>0</Kbd>
            <TextArea
              className="question-other-input"
              ref={otherInput}
              rows={1}
              aria-label={t('approval.question.other')}
              placeholder={t('approval.question.other')}
              value={other[index] ?? ''}
              onChange={(e) => setOther({ ...other, [index]: e.target.value })}
            />
          </label>
        </div>
        <div className="approval-actions">
          <span className="spacer" />
          <Button onClick={() => submit(true)}>{t('approval.question.skip')}</Button>
          <Button variant="primary" onClick={() => submit()}>
            {t('approval.question.submit')} <Kbd>↵</Kbd>
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * A flow's gate (docs/loops-and-graphs.md): the flow waits here for a person. What it shows are read-only lines; Continue
 * goes on, Send back carries the note to the next step, Stop ends the run.
 */
export function GatePanel({ request, workspaceId }: { request: GateRequest; workspaceId: string }) {
  const t = useT()
  const [note, setNote] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => panel.current?.focus(), [request.id])

  const answer = (choice: 'continued' | 'sent-back' | 'stopped') =>
    void attempt(() => api.respondApproval(request.id, choice === 'sent-back' && note.trim() ? { kind: 'gate', answer: choice, note: note.trim() } : { kind: 'gate', answer: choice }))
  const label = (kind: GateRequest['show'][number]['kind'], step?: string) =>
    kind === 'diff' ? t('flowRun.gate.show.diff') : kind === 'checks.results' ? t('flowRun.gate.show.checks') : kind === 'review.findings' ? t('flowRun.gate.show.findings') : t('flowRun.gate.show.answer', { step: step ?? '' })

  return (
    <div className="composer">
      <div className="approval-panel gate" tabIndex={-1} ref={panel} role="group" aria-labelledby={titleId}>
        <div className="approval-title">
          <Workflow size={15} aria-hidden />
          <strong id={titleId}>{t('flowRun.gate.heading', { flow: request.flowName, step: request.step })}</strong>
        </div>
        <p className="gate-ask">{request.ask}</p>
        {request.show.length > 0 && (
          <ul className="gate-show">
            {request.show.map((item, n) =>
              item.kind === 'file' ? (
                // A file the flow shows by its path: its content, read-only, labelled by the path.
                <li key={n}>
                  <Field label={t('flowRun.gate.show.file', { path: item.path ?? '' })}>{(c) => <TextArea {...c} mono readOnly rows={8} value={item.summary} />}</Field>
                </li>
              ) : (
                <li key={n}>
                  <span className="faint">{label(item.kind, item.step)}:</span> {item.summary}
                  {item.kind === 'checks.results' && (
                    <>
                      {' '}
                      <LinkButton size="sm" onClick={() => showChecksPanel(workspaceId)}>
                        {t('flowRun.gate.openChecks')}
                      </LinkButton>
                    </>
                  )}
                </li>
              )
            )}
          </ul>
        )}
        <Field label={t('flowRun.gate.note')}>{(c) => <TextArea {...c} rows={2} value={note} onChange={(e) => setNote(e.target.value)} />}</Field>
        <div className="approval-actions">
          <span className="spacer" />
          <Button onClick={() => answer('stopped')}>{t('flowRun.gate.stop')}</Button>
          <Button onClick={() => answer('sent-back')}>{t('flowRun.gate.sendBack')}</Button>
          <Button variant="primary" onClick={() => answer('continued')}>
            {t('flowRun.gate.continue')}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * A flow's pick (docs/loops-and-graphs.md): the person chooses one of the sibling results the flow made, each a card
 * with how it stands (its changes, its last turn, its checks) and a link to open its workspace and look first. Nothing
 * is chosen until "Go on with …"; Stop ends the run with none chosen.
 */
export function PickPanel({ request }: { request: PickRequest }) {
  const t = useT()
  const [chosen, setChosen] = useState<string | null>(null)
  const panel = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => {
    setChosen(null)
    panel.current?.focus()
  }, [request.id])

  const answer = (step: string | null) => void attempt(() => api.respondApproval(request.id, { kind: 'pick', chosen: step }))

  return (
    <div className="composer">
      <div className="approval-panel gate" tabIndex={-1} ref={panel} role="group" aria-labelledby={titleId}>
        <div className="approval-title">
          <Workflow size={15} aria-hidden />
          <strong id={titleId}>{t('flowRun.pick.heading', { flow: request.flowName, step: request.step })}</strong>
        </div>
        <p className="gate-ask">{request.ask}</p>
        <ul className="question-options pick-choices" aria-label={t('flowRun.pick.choices')}>
          {request.choices.map((choice) => {
            const selected = chosen === choice.step
            return (
              <li key={choice.step} className="pick-choice">
                <CardButton size="sm" selected={selected} className="question-option" aria-pressed={selected} onClick={() => setChosen(selected ? null : choice.step)}>
                  <span>
                    <span className="option-label">{choice.step}</span>
                    <span className="faint small"> — {choice.summary}</span>
                  </span>
                </CardButton>
                <LinkButton size="sm" onClick={() => selectWorkspace(choice.workspaceId)} aria-label={t('flowRun.pick.openNamed', { step: choice.step })}>
                  {t('flowRun.pick.open')}
                </LinkButton>
              </li>
            )
          })}
        </ul>
        <div className="approval-actions">
          <span className="spacer" />
          <Button onClick={() => answer(null)}>{t('flowRun.gate.stop')}</Button>
          <Button variant="primary" disabled={!chosen} onClick={() => chosen && answer(chosen)}>
            {chosen ? t('flowRun.pick.goOn', { step: chosen }) : t('flowRun.pick.chooseFirst')}
          </Button>
        </div>
      </div>
    </div>
  )
}
