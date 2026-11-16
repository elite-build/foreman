// An agent's or a flow's request for the person, as a decision card (components/DecisionCard.tsx), docked between the
// conversation and the message box, which stays mounted with its draft: a tool approval, questions, the plan, a flow's
// gate or pick. Nothing takes focus as it arrives; F6 reaches the card, and its keys work only there.
import { Copy, Info } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import type { PlainKey } from '../../../shared/i18n'
import type { ApprovalRequest, SubagentRef, Workspace } from '../../../shared/types'
import { isFallback } from '../../../shared/agentCapabilities'
import { AGENTS } from '../../../shared/agents'
import { commandParts, commandRule, joinLabel, partLabel, ruleReach, type CommandPart, type CommandRule } from '../../../shared/commandParts'
import { workspaceRelative } from '../../../shared/permissions'
import { announce } from '../announce'
import { useT, type RendererT } from '../i18n'
import { api, attempt, selectWorkspace, sendUiCommand, showChecksPanel, useCapabilities, useStore } from '../store'
import { shortcutHint } from '../shortcuts'
import { Button, CardButton, Checkbox, Disclosure, Field, Kbd, LinkButton, RadioList, Status, Tab, TabList, Tabs, Tag, TextArea, TextInput } from '../ui'
import { DecisionCard } from './DecisionCard'
import { Markdown } from './Markdown'
import { describe, EditPreview, toolSummary, type ToolItem } from './ToolRow'

type ToolRequest = Extract<ApprovalRequest, { kind: 'tool' }>
type QuestionRequest = Extract<ApprovalRequest, { kind: 'question' }>
type PlanRequest = Extract<ApprovalRequest, { kind: 'plan' }>
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

const EDIT_TOOLS = new Set(['Edit', 'MultiEdit', 'Write'])

/** Commands in code, joined the locale's way: `npm test`, `git push`. */
function codeList(items: readonly string[], t: RendererT): ReactNode {
  return items.map((item, n) => (
    <span key={item}>
      {n > 0 && t('approval.list.separator')}
      <code className="mono">{item}</code>
    </span>
  ))
}

/**
 * A command part by part: each as written, what it does when Foreman knows it, and a tag where it leaves this computer
 * or can't be undone (with ▲ and the words, never colour alone); between them, how each follows the one before.
 */
function CommandPartsList({ parts }: { parts: readonly CommandPart[] }) {
  const t = useT()
  return (
    <ul className="approval-summary approval-parts" aria-label={t('approval.parts')}>
      {parts.map((part, n) => (
        <li key={n} className="approval-part">
          {part.join && <span className="approval-part-join faint small">{joinLabel(part.join, t)}</span>}
          <code className="approval-part-text">{part.text}</code>
          <span className="approval-part-what small">{part.what ? partLabel(part.what, t) : null}</span>
          <span className="approval-part-tags">
            {part.leaves && <Tag tone="warn">{t('approval.part.leaves')}</Tag>}
            {part.destroys && <Tag tone="warn">{t('approval.part.cantUndo')}</Tag>}
            {!part.leaves && !part.destroys && part.what?.reach === 'local' && <Tag>{t('approval.part.local')}</Tag>}
            {!part.leaves && !part.destroys && part.what?.reach === 'network' && <Tag>{t('approval.part.network')}</Tag>}
          </span>
        </li>
      ))}
    </ul>
  )
}

/** An edit or a new file as the transcript draws it: the file, where it is, its counts, and the lines it changes. */
function EditChange({ request, workspacePath }: { request: ToolRequest; workspacePath: string }) {
  const t = useT()
  const input = request.input
  const item: ToolItem = { kind: 'tool', id: request.id, turnId: '', name: request.toolName, input, status: 'running' }
  const { file, meta } = describe(item, workspacePath, t)
  const path = typeof input.file_path === 'string' ? input.file_path : ''
  const inside = !path || !workspacePath || workspaceRelative(path, workspacePath) !== null
  const edits = request.toolName === 'Write' ? [] : ((input.edits as Record<string, unknown>[] | undefined) ?? [input])
  // Some agents (Codex) report the file but not the change itself: then only the file shows.
  const known = request.toolName === 'Write' ? typeof input.content === 'string' : edits.some((e) => e.old_string !== undefined || e.new_string !== undefined)
  return (
    <div className="approval-summary approval-change">
      <div className="approval-change-head">
        <code>{file}</code>
        <span className="approval-change-meta">
          {inside ? <Tag>{t('approval.edit.inWorkspace')}</Tag> : <Tag tone="warn">{t('approval.edit.outsideWorkspace')}</Tag>}
          {meta && <span className="tool-meta">{meta}</span>}
        </span>
      </div>
      {known && <EditPreview input={request.toolName === 'Write' ? { new_string: input.content } : input} />}
    </div>
  )
}

/**
 * What the second button adds, in words, above the buttons: the rule and where it lasts (this chat, or the rest of an
 * employee's run), what a command's rule leaves out and so still asks, and any part it lets through that leaves this
 * computer or can't be undone.
 */
function AlwaysRule({ request, command, workspaceName, agent, employee }: { request: ToolRequest; command?: string; workspaceName: string; agent: string; employee?: string }) {
  const t = useT()
  const where = employee !== undefined ? t('approval.rule.inRun') : t('approval.rule.inChat')
  const lines: ReactNode[] = []
  const warnings: string[] = []
  if (request.alternate === 'edits-for-session') lines.push(t('approval.rule.edits', { workspace: workspaceName, where }))
  else if (request.alternate === 'always-allow') {
    // Claude Code names its rules; an agent Foreman remembers for (ACP) remembers the exact command it was asked.
    const rules: CommandRule[] | undefined = request.alwaysRules?.length ? request.alwaysRules.map(commandRule) : command && request.alwaysScope ? [{ prefix: false, command }] : undefined
    if (command && rules) {
      for (const rule of rules)
        lines.push(
          rule.prefix
            ? t.rich('approval.rule.prefix', { command: <code className="mono">{rule.command}</code>, where })
            : t.rich('approval.rule.exact', { command: <code className="mono">{request.alwaysRules?.length ? rule.command : request.alwaysScope}</code>, where })
        )
      const reach = ruleReach(command, rules)
      if (reach.notCovered.length) lines.push(t.rich('approval.rule.notCovered', { count: reach.notCovered.length, commands: codeList(reach.notCovered, t) }))
      const plain = (items: string[]) => items.join(t('approval.list.separator'))
      if (reach.leaves.length) warnings.push(t('approval.rule.includesLeaves', { commands: plain(reach.leaves) }))
      if (reach.destroys.length) warnings.push(t('approval.rule.includesDestroys', { commands: plain(reach.destroys) }))
    } else if (request.alwaysScope) lines.push(t.rich('approval.rule.scope', { scope: <code className="mono">{request.alwaysScope}</code>, where }))
    else lines.push(t('approval.rule.agent', { agent, where }))
  }
  if (!lines.length) return null
  if (employee !== undefined) lines.push(t('approval.rule.employee', { name: employee }))
  return (
    <div className="approval-rule faint small">
      <Info size={13} aria-hidden className="approval-rule-icon" />
      <div className="approval-rule-text">
        <p>
          {lines.map((line, n) => (
            <span key={n}>
              {n > 0 && ' '}
              {line}
            </span>
          ))}
        </p>
        {warnings.map((warning) => (
          <Status key={warning} tone="warn" label={warning} />
        ))}
      </div>
    </div>
  )
}

/** What a tool's two answers are called: the act, and its refusal. A command's are worked out from its parts. */
const TOOL_ACTS: Record<string, [PlainKey, PlainKey]> = {
  Edit: ['approval.act.edit', 'approval.act.dontEdit'],
  MultiEdit: ['approval.act.edit', 'approval.act.dontEdit'],
  NotebookEdit: ['approval.act.edit', 'approval.act.dontEdit'],
  Write: ['approval.act.write', 'approval.act.dontWrite'],
  WebFetch: ['approval.act.fetch', 'approval.act.dontFetch'],
  WebSearch: ['approval.act.search', 'approval.act.dontSearch']
}

/** Where a decision is drawn: docked above a chat's message box (with the key that reaches it at the header's end). */
interface Placement {
  docked?: boolean
  headEnd?: ReactNode
}

/** How long a docked card ignores its keys after it appears, so a key meant for something else never answers it. */
const ARRIVAL_GUARD_MS = 600

/** Who is asking: the subagent, else the chat's agent. */
function useAsker(sessionId: string, subagent?: SubagentRef): string {
  const agent = useStore((s) => s.snapshot!.sessions.find((x) => x.id === sessionId)?.agent)
  return subagent?.name || (agent ? AGENTS[agent].label : '')
}

/** An agent asks to use a tool: the decision card, docked above the message box in a chat. */
export function ToolApprovalPanel({ request, workspacePath, docked, headEnd }: { request: ToolRequest; workspacePath: string } & Placement) {
  const t = useT()
  // An agent that can't remember an always-allow gets no button for it, and the card says why (docs/agents.md 8).
  const tab = useStore((s) => s.snapshot!.sessions.find((x) => x.id === request.sessionId))
  const workspace = useStore((s) => (tab ? s.snapshot!.workspaces.find((w) => w.id === tab.workspaceId) : undefined))
  // An AI employee's run (docs/ai-employees.md §6.3): a rule lasts for the run, and never widens what it was approved for.
  const by = workspace?.startedBy?.via === 'employee' ? workspace.startedBy : undefined
  const employee = useStore((s) => (by ? s.snapshot!.employees?.[by.orgId]?.employees.find((e) => e.id === by.employeeId)?.name || by.employeeId : undefined))
  const alwaysAllow = useCapabilities(tab?.agent ?? '', tab?.instanceId)?.approvals.alwaysAllow
  const onceOnly = tab && !request.alternate && alwaysAllow && isFallback(alwaysAllow, 'once-always')
  const command = request.toolName === 'Bash' && typeof request.input.command === 'string' ? request.input.command : undefined
  const parts = useMemo(() => (command ? commandParts(command) : []), [command])
  // A command Foreman can say something about is spelled out part by part; one it can't stays one line, as asked.
  const spelled = parts.length > 1 || parts.some((p) => p.what || p.leaves || p.destroys)
  // A part that leaves this computer (a push, a publish): neither the act nor always-allow has a key.
  const leaving = parts.filter((p) => p.leaves).map((p) => p.text)
  const outward = leaving.length > 0
  const [reason, setReason] = useState('')
  const reasonBox = useRef<HTMLInputElement>(null)
  const fromId = useId()
  const reasonHelpId = useId()
  const who = useAsker(request.sessionId, request.subagent)

  const answer = (allow: boolean, alternate = false) =>
    void attempt(() => api.respondApproval(request.id, { kind: 'tool', allow, alternate, message: allow ? undefined : reason.trim() || undefined }))

  // Enter in the reason box refuses, with the reason (the box says so to a screen reader).
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey && e.target === reasonBox.current) {
      e.preventDefault()
      answer(false)
    }
  }

  const summary = toolSummary(request.toolName, request.input, workspacePath, t)
  // An agent's terminal also names the folder and the variables it sets: under the parts, as the summary words them.
  const runsWhere = command && summary.startsWith(command) ? summary.slice(command.length).trim() : ''
  const scope = request.alwaysScope && request.alwaysScope.length > 32 ? `${request.alwaysScope.slice(0, 31)}…` : request.alwaysScope
  // Where Foreman knows the rule, the button names it (cut short; the line above the buttons has it whole).
  const alternateLabel =
    request.alternate === 'edits-for-session'
      ? by
        ? t('approval.alternate.editsRun')
        : t('approval.alternate.edits')
      : request.alternate === 'always-allow'
        ? scope
          ? t.rich('approval.alternate.alwaysScope', { scope: <code key="scope" className="mono">{scope}</code> })
          : t('approval.alternate.always')
        : null
  const title = command && parts.length > 1 ? t('approval.title.bashParts', { count: parts.length }) : TOOL_TITLES[request.toolName] ? t(TOOL_TITLES[request.toolName]) : t('approval.title.other', { tool: request.toolName.replace(/^mcp__[^_]+__/, '') })
  const acts = TOOL_ACTS[request.toolName]
  const [act, refuse] = command
    ? [parts.length > 1 ? t('approval.act.runCount', { count: parts.length }) : t('approval.act.run'), t('approval.act.dontRun')]
    : acts
      ? [t(acts[0]), t(acts[1])]
      : [t('approval.act.allow'), t('approval.act.dontAllow')]
  const kind = command ? t('decision.kind.command') : EDIT_TOOLS.has(request.toolName) || request.toolName === 'NotebookEdit' ? t('decision.kind.edit') : t('decision.kind.tool')
  const rule = alternateLabel ? <AlwaysRule request={request} command={command} workspaceName={workspace?.name ?? ''} agent={tab ? AGENTS[tab.agent].label : ''} employee={by ? employee : undefined} /> : null
  const consequence =
    outward || rule ? (
      <>
        {outward && <p>{t.rich('approval.consequence.leaves', { commands: codeList(leaving, t) })}</p>}
        {rule}
      </>
    ) : undefined

  return (
    <DecisionCard
      who={who}
      kind={kind}
      subject={title}
      headEnd={headEnd}
      docked={docked}
      guardMs={docked ? ARRIVAL_GUARD_MS : 0}
      className="approval-panel"
      onKeyDown={onKeyDown}
      leaves={outward}
      consequence={consequence}
      decline={{ label: refuse, onAct: () => answer(false) }}
      alternate={alternateLabel ? { label: alternateLabel, onAct: () => answer(true, true), outward } : undefined}
      main={{ label: act, onAct: () => answer(true), outward }}
    >
      <FromSubagent subagent={request.subagent} id={fromId} />
      {spelled ? (
        <>
          <CommandPartsList parts={parts} />
          {runsWhere && <div className="faint small mono">{runsWhere}</div>}
        </>
      ) : EDIT_TOOLS.has(request.toolName) ? (
        <EditChange request={request} workspacePath={workspacePath} />
      ) : (
        summary && <code className="approval-summary">{summary}</code>
      )}
      {request.reason && <div className="faint small">{request.reason}</div>}
      {onceOnly && <div className="faint small">{t('approval.onceAlways', { agent: AGENTS[tab.agent].label })}</div>}
      <TextInput
        ref={reasonBox}
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
      <Disclosure quiet label={t('approval.details')}>
        <pre className="approval-request">{JSON.stringify(request.input, null, 2)}</pre>
      </Disclosure>
    </DecisionCard>
  )
}

const isTextField = (el: EventTarget) => el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !['radio', 'checkbox'].includes(el.type))

/**
 * The agent's questions, the open one as the card's title. Several get tabs in the header, named by their headers, each
 * marked answered or not and showing its answer. A single-choice question's options are a quiet list of radios, each
 * description beside its label; a multiple-choice one's are checkboxes; then Other in your own words, keyed 1 to n+1.
 * The main button reads "Next: <header>" until every question has an answer, so nothing is ever sent unanswered.
 */
export function QuestionPanel({ request, docked, headEnd }: { request: QuestionRequest } & Placement) {
  const t = useT()
  const [index, setIndex] = useState(0)
  const [choices, setChoices] = useState<Record<number, string[]>>({})
  const [other, setOther] = useState<Record<number, string>>({})
  const otherInput = useRef<HTMLTextAreaElement>(null)
  const fromId = useId()
  const who = useAsker(request.sessionId, request.subagent)
  const questions = request.questions
  const question = questions[Math.min(index, questions.length - 1)]
  const many = questions.length > 1

  const answer = (n: number) => [...(choices[n] ?? []), ...(other[n]?.trim() ? [other[n].trim()] : [])].join(', ')
  const answered = (n: number) => answer(n) !== ''
  const done = questions.filter((_, n) => answered(n)).length
  const header = (n: number) => questions[n].header?.trim() || t('approval.question.tab', { n: n + 1 })
  // The next question without an answer, after this one (round to the start).
  const next = questions.map((_, k) => (index + 1 + k) % questions.length).find((n) => n !== index && !answered(n))

  const toggle = (label: string) => {
    const current = choices[index] ?? []
    const chosen = question.multiSelect ? (current.includes(label) ? current.filter((c) => c !== label) : [...current, label]) : [label]
    setChoices({ ...choices, [index]: chosen })
  }

  const submit = () => {
    if (done < questions.length) return
    const answers: Record<string, string> = {}
    questions.forEach((q, n) => {
      answers[q.question] = answer(n)
    })
    void attempt(() => api.respondApproval(request.id, { kind: 'question', answers }))
  }
  const skip = () => void attempt(() => api.respondApproval(request.id, { kind: 'question', skipped: true }))
  const send = t('approval.question.send', { count: questions.length })
  const main =
    done === questions.length
      ? { label: send, onAct: submit }
      : next !== undefined
        ? { label: t('approval.question.next', { header: header(next) }), onAct: () => setIndex(next) }
        : { label: send, onAct: submit, disabled: true }

  // Keys 1 to n pick an option, n+1 goes to Other; outside a text box. Left and Right on the card itself change question.
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (isTextField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return
    if (/^[1-9]$/.test(e.key)) {
      const n = Number(e.key) - 1
      if (n < question.options.length) {
        e.preventDefault()
        toggle(question.options[n].label)
      } else if (n === question.options.length) {
        e.preventDefault()
        otherInput.current?.focus()
      }
    } else if (e.target === e.currentTarget && e.key === 'ArrowRight') setIndex(Math.min(index + 1, questions.length - 1))
    else if (e.target === e.currentTarget && e.key === 'ArrowLeft') setIndex(Math.max(index - 1, 0))
  }

  const chosen = choices[index] ?? []
  // Several questions: a tab each, with its answer once it has one ("✓ Version · 1.2.0").
  const tabs = many ? (
    <Tabs className="question-tabs" variant="pill" value={String(index)} onChange={(v) => setIndex(Number(v))}>
      <TabList label={t('approval.question.tabs')}>
        {questions.map((_, n) => (
          <Tab key={n} value={String(n)}>
            <Status compact tone={answered(n) ? 'ok' : 'off'} label={answered(n) ? t('approval.question.isAnswered') : t('approval.question.notAnswered')} /> {header(n)}
            {answered(n) && (
              <span className="faint question-tab-answer">
                <span aria-hidden="true"> · </span>
                {answer(n)}
              </span>
            )}
          </Tab>
        ))}
      </TabList>
    </Tabs>
  ) : undefined
  return (
    <DecisionCard
      who={who}
      kind={t('decision.kind.question')}
      subject={question.question}
      headEnd={headEnd}
      headNav={tabs}
      docked={docked}
      guardMs={docked ? ARRIVAL_GUARD_MS : 0}
      className="approval-panel question"
      onKeyDown={onKeyDown}
      decline={{ label: t('approval.question.skip'), onAct: skip }}
      main={main}
    >
      <FromSubagent subagent={request.subagent} id={fromId} />
      {question.multiSelect ? (
        <div className="question-checks" role="group" aria-label={t('approval.question.chooseAny')}>
          <span className="faint small">{t('approval.question.chooseAny')}</span>
          {question.options.map((option, n) => (
            <Checkbox key={option.label} checked={chosen.includes(option.label)} onChange={() => toggle(option.label)}>
              <Kbd aria-hidden="true">{n + 1}</Kbd> <span className="option-label">{option.label}</span>
              {option.description && <span className="faint small"> {option.description}</span>}
            </Checkbox>
          ))}
        </div>
      ) : (
        <RadioList
          legend={t('approval.question.chooseOne')}
          hideLegend
          descriptions="beside"
          value={chosen[0]}
          onChange={toggle}
          options={question.options.map((option, n) => ({
            value: option.label,
            label: (
              <>
                <Kbd aria-hidden="true">{n + 1}</Kbd> <span className="option-label">{option.label}</span>
              </>
            ),
            ...(option.description ? { description: option.description } : {})
          }))}
        />
      )}
      <div className="question-other">
        <Kbd aria-hidden="true">{question.options.length + 1}</Kbd>
        <TextArea
          className="question-other-input"
          ref={otherInput}
          rows={1}
          aria-label={t('approval.question.otherOwn')}
          placeholder={t('approval.question.otherOwn')}
          value={other[index] ?? ''}
          onChange={(e) => setOther({ ...other, [index]: e.target.value })}
        />
      </div>
    </DecisionCard>
  )
}

/** The plan the agent proposes, with the plan bar folded in: Copy, Keep planning (back to the message box), Hand off, Approve. */
export function PlanPanel({ request, workspaceId, headingLevel = 3, docked, headEnd }: { request: PlanRequest; workspaceId: string; headingLevel?: number } & Placement) {
  const t = useT()
  const who = useAsker(request.sessionId)
  const respond = (handOff: boolean) => void attempt(() => api.respondApproval(request.id, { kind: 'plan', approve: !handOff, handOff }))
  return (
    <DecisionCard
      who={who}
      kind={t('decision.kind.plan')}
      subject={t('approval.plan.subject')}
      headEnd={headEnd}
      docked={docked}
      guardMs={docked ? ARRIVAL_GUARD_MS : 0}
      className="approval-panel plan"
      consequence={t('approval.plan.consequence')}
      footStart={
        <Button size="sm" variant="ghost" icon={<Copy size={12} />} onClick={() => void navigator.clipboard.writeText(request.plan)}>
          {t('common.copy')}
        </Button>
      }
      decline={{ label: t('approval.plan.keep'), onAct: () => sendUiCommand('focus-composer', workspaceId) }}
      alternate={{ label: t('composer.planBar.handOff'), title: t('composer.planBar.handOffTitle'), onAct: () => respond(true) }}
      main={{ label: t('approval.plan.approve'), onAct: () => respond(false) }}
    >
      <div className="plan-card-text">
        <Markdown text={request.plan} headingStart={headingLevel} />
      </div>
    </DecisionCard>
  )
}

/**
 * A flow's gate (docs/loops-and-graphs.md): the flow waits here for a person. What it shows are read-only lines; Continue
 * goes on, Send back carries the note to the next step, Stop ends the run.
 */
export function GatePanel({ request, workspaceId, docked, headEnd }: { request: GateRequest; workspaceId: string } & Placement) {
  const t = useT()
  const [note, setNote] = useState('')

  const answer = (choice: 'continued' | 'sent-back' | 'stopped') =>
    void attempt(() => api.respondApproval(request.id, choice === 'sent-back' && note.trim() ? { kind: 'gate', answer: choice, note: note.trim() } : { kind: 'gate', answer: choice }))
  const label = (kind: GateRequest['show'][number]['kind'], step?: string) =>
    kind === 'diff' ? t('flowRun.gate.show.diff') : kind === 'checks.results' ? t('flowRun.gate.show.checks') : kind === 'review.findings' ? t('flowRun.gate.show.findings') : t('flowRun.gate.show.answer', { step: step ?? '' })

  return (
    <DecisionCard
      who={request.flowName}
      kind={t('decision.kind.gate')}
      subject={t('flowRun.gate.heading', { flow: request.flowName, step: request.step })}
      headEnd={headEnd}
      docked={docked}
      guardMs={docked ? ARRIVAL_GUARD_MS : 0}
      className="approval-panel gate"
      consequence={t('approval.gate.consequence')}
      decline={{ label: t('flowRun.gate.stop'), onAct: () => answer('stopped') }}
      alternate={{ label: t('flowRun.gate.sendBack'), onAct: () => answer('sent-back') }}
      main={{ label: t('flowRun.gate.continue'), onAct: () => answer('continued') }}
    >
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
    </DecisionCard>
  )
}

/**
 * A flow's pick (docs/loops-and-graphs.md): the person chooses one of the sibling results the flow made, each a card
 * with how it stands (its changes, its last turn, its checks) and a link to open its workspace and look first. Nothing
 * is chosen until "Go on with …"; Stop ends the run with none chosen.
 */
export function PickPanel({ request, docked, headEnd }: { request: PickRequest } & Placement) {
  const t = useT()
  const [chosen, setChosen] = useState<string | null>(null)

  useEffect(() => setChosen(null), [request.id])

  const answer = (step: string | null) => void attempt(() => api.respondApproval(request.id, { kind: 'pick', chosen: step }))

  return (
    <DecisionCard
      who={request.flowName}
      kind={t('decision.kind.pick')}
      subject={t('flowRun.pick.heading', { flow: request.flowName, step: request.step })}
      headEnd={headEnd}
      docked={docked}
      guardMs={docked ? ARRIVAL_GUARD_MS : 0}
      className="approval-panel gate"
      decline={{ label: t('flowRun.gate.stop'), onAct: () => answer(null) }}
      main={{ label: chosen ? t('flowRun.pick.goOn', { step: chosen }) : t('flowRun.pick.chooseFirst'), onAct: () => chosen && answer(chosen), disabled: !chosen }}
    >
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
    </DecisionCard>
  )
}

/**
 * What waits for the person in a chat, docked between the conversation and the message box, which stays: the agent's
 * approval, question or plan, or a flow's gate or pick; else `fallback` (an AI employee's decision in its run's chat).
 * Focus stays where it was: the arrival is announced, F6 reaches the card and Ctrl+L goes back to the message box.
 */
export function NeedsYouDock({ requests, workspace, active, headingLevel, fallback }: { requests: readonly ApprovalRequest[]; workspace: Pick<Workspace, 'id' | 'path'>; active: boolean; headingLevel?: number; fallback?: ReactNode }) {
  const t = useT()
  const platform = useStore((s) => s.snapshot!.platform)
  const request = requests.find((a) => a.kind === 'tool') ?? requests.find((a) => a.kind === 'question') ?? requests.find((a) => a.kind === 'gate') ?? requests.find((a) => a.kind === 'pick') ?? requests.find((a) => a.kind === 'plan')
  const agent = useStore((s) => (request ? s.snapshot!.sessions.find((x) => x.id === request.sessionId)?.agent : undefined))
  const reach = shortcutHint('approval.focus', platform)
  const headEnd = reach ? <span className="decision-reach">{t.rich('decision.reach', { key: <Kbd key="key">{reach}</Kbd> })}</span> : undefined

  // Said once as it arrives, in the chat on screen; focus doesn't move.
  const said = useRef({ t, active, agent })
  said.current = { t, active, agent }
  useEffect(() => {
    if (!request) return
    const { t: tr, active: onScreen, agent: who } = said.current
    if (!onScreen) return
    const name = request.kind === 'gate' || request.kind === 'pick' ? request.flowName : 'subagent' in request && request.subagent?.name ? request.subagent.name : who ? AGENTS[who].label : ''
    const what = request.kind === 'tool' ? tr(request.toolName === 'Bash' ? 'decision.kind.command' : EDIT_TOOLS.has(request.toolName) ? 'decision.kind.edit' : 'decision.kind.tool') : request.kind === 'question' ? tr('decision.kind.question') : request.kind === 'plan' ? tr('decision.kind.plan') : request.kind === 'gate' ? tr('decision.kind.gate') : tr('decision.kind.pick')
    announce(tr('decision.arrived', { who: name, what, key: reach ?? '' }), `decision:${request.id}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id])

  const card = !request ? null : request.kind === 'tool' ? (
    <ToolApprovalPanel key={request.id} request={request} workspacePath={workspace.path ?? ''} docked headEnd={headEnd} />
  ) : request.kind === 'question' ? (
    <QuestionPanel key={request.id} request={request} docked headEnd={headEnd} />
  ) : request.kind === 'gate' ? (
    <GatePanel key={request.id} request={request} workspaceId={workspace.id} docked headEnd={headEnd} />
  ) : request.kind === 'pick' ? (
    <PickPanel key={request.id} request={request} docked headEnd={headEnd} />
  ) : (
    <PlanPanel key={request.id} request={request} workspaceId={workspace.id} headingLevel={headingLevel} docked headEnd={headEnd} />
  )
  if (!card && !fallback) return null
  return <div className="decision-dock">{card ?? fallback}</div>
}
