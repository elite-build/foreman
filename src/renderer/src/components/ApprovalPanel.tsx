import { MessageCircleQuestion, ShieldCheck } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import type { ApprovalRequest } from '../../../shared/types'
import { useT } from '../i18n'
import { api, attempt, modKey, useStore } from '../store'
import { Button, CardButton, Kbd, Tab, TabList, Tabs, TextArea, TextInput } from '../ui'
import { toolSummary } from './ToolRow'

type ToolRequest = Extract<ApprovalRequest, { kind: 'tool' }>
type QuestionRequest = Extract<ApprovalRequest, { kind: 'question' }>

const TOOL_TITLES: Record<string, PlainKey> = {
  Bash: 'approval.title.bash',
  Edit: 'approval.title.edit',
  MultiEdit: 'approval.title.edit',
  Write: 'approval.title.write',
  NotebookEdit: 'approval.title.notebook',
  WebFetch: 'approval.title.fetch',
  WebSearch: 'approval.title.search'
}

const isTyping = (target: EventTarget) => target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement

/** Takes the composer's place while the agent waits for permission. */
export function ToolApprovalPanel({ request, workspacePath }: { request: ToolRequest; workspacePath: string }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const [reason, setReason] = useState('')
  const panel = useRef<HTMLDivElement>(null)
  const mod = modKey(platform)
  const titleId = useId()
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
  const alternateLabel =
    request.alternate === 'edits-for-session' ? t('approval.alternate.edits') : request.alternate === 'always-allow' ? t('approval.alternate.always') : null

  return (
    <div className="composer">
      <div className="approval-panel" tabIndex={-1} ref={panel} onKeyDown={onKeyDown} role="group" aria-labelledby={titleId}>
        <div className="approval-title">
          <ShieldCheck size={15} />
          <strong id={titleId}>{TOOL_TITLES[request.toolName] ? t(TOOL_TITLES[request.toolName]) : t('approval.title.other', { tool: request.toolName.replace(/^mcp__[^_]+__/, '') })}</strong>
        </div>
        {summary && <code className="approval-summary">{summary}</code>}
        {request.reason && <div className="faint small">{request.reason}</div>}
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
      <div className="approval-panel question" tabIndex={-1} ref={panel} onKeyDown={onKeyDown} role="group" aria-labelledby={titleId}>
        <div className="approval-title">
          <MessageCircleQuestion size={15} />
          <strong id={titleId}>{question.header ? `${question.header}: ` : ''}{question.question}</strong>
        </div>
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
