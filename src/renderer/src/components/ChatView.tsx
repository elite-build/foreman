import { AlertTriangle, ArrowRight, ClipboardList, Copy, FolderPlus, GitBranch, Lock, MoreHorizontal, Pencil, Plus, RotateCcw, Settings, Sparkles, Users } from 'lucide-react'
import { agentControls } from '../../../shared/agentCatalog'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { AGENTS, modelInfo } from '../../../shared/agents'
import { isMixed, turnAuthors, type AgentSwitch, type ChatDivider, type TurnAuthor } from '../../../shared/switchAgent'
import { continueEligibility, continueFollowUp, turnAnswer } from '../../../shared/handOff'
import { partSize, receiptLine } from '../../../shared/context'
import type { PlainKey } from '../../../shared/i18n'
import type { ApprovalRequest, ChatItem, ContextPart, Session, TurnDelta, Workspace } from '../../../shared/types'
import { api, attempt, clearChatJump, copyTranscript, editAndResend, fillComposer, forkChat, loadChat, onUiCommand, openHandOffDialog, openNewWorkspace, openSettingsPage, sendUiCommand, showToast, useStore } from '../store'
import { editResendBlock } from '../../../shared/fork'
import { useT } from '../i18n'
import { announce } from '../announce'
import { spokenSnippet } from '../agentStatus'
import { reduceMotion } from '../theme'
import { formatClock } from '../../../shared/i18n/time'
import { Button, Callout, Checkbox, ChipButton, flash, LinkButton, MenuButton, MenuItem, MenuLabel, MenuSeparator, Pressable, Spinner, Tag } from '../ui'
import { hasNote } from '../../../shared/note'
import { formatDuration } from './turnResult'
import { QuestionPanel, ToolApprovalPanel } from './ApprovalPanel'
import { AttachmentChip, Composer } from './composer/Composer'
import { UserMessageText } from './composer/TerminalDraft'
import { AgentIcon } from './composer/AgentPicker'
import './switchAgent.css'
import { Markdown } from './Markdown'
import { SensitiveCard } from './SensitiveAlert'
import { ChatSearch } from './ChatSearch'
import { textMatches } from './findInChat'
import { describe, taskActivity, TaskMeta, ToolRow, type Root, type ToolItem } from './ToolRow'
import { toolRoots } from '../../../shared/portable'
import { sessionReadOnly } from '../../../shared/workspacePath'
import { workspacePerson } from '../../../shared/workspacePeople'
import { settleItems } from '../../../shared/liveItems'
import { ArchivedBanner } from './ArchivedView'
import { ClosedGapLine } from './KeepRunning'
import { ReportRow } from './AgentReport'
import { isReportCall } from '../../../shared/agentReports'
import { AutoFixReceipt } from './AutoFix'
import { LimitResumePart } from './LimitResume'
import { SignInNotice } from './SignInNotice'
import { AutoReviewFindings, AutoReviewReceipt } from './AutoReview'
import { withoutFindingsBlock } from '../../../shared/autoReview'

const EMPTY: ChatItem[] = []

// How long a streaming reply's Markdown waits between renders (accessibility plan, A3 step 2): a reader's browse buffer is
// rebuilt each time the text changes, and the stream flushes about every 50 ms.
const STREAM_RENDER_MS = 300

// Where focus was last, for the chat-switch rule (A7). Switching chats focuses the new chat's heading only when focus was in
// a chat log; the log being hidden drops focus without an event, so the last focus-in is what says where it was.
let focusWasInLog = false
let lastActiveChat: string | undefined
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => (focusWasInLog = e.target instanceof Element && Boolean(e.target.closest('.chat-scroll'))), true)
}
/** Forgets where focus was and which chat was last shown (for tests). */
export function resetChatFocusMemory(): void {
  focusWasInLog = false
  lastActiveChat = undefined
}

type Level = 2 | 3 | 4 | 5 | 6
const clampLevel = (level: number) => Math.min(Math.max(level, 2), 6) as Level
type HeadingTag = `h${Level}`

/** A heading for assistive technology only. `tabIndex` -1 lets a jump key move focus to it. */
function Hidden({ level, id, focusable, ref, children, ...data }: { level: number; id: string; focusable?: boolean; ref?: Ref<HTMLHeadingElement>; children: ReactNode; 'data-turn-heading'?: true }) {
  const Tag = `h${clampLevel(level)}` as HeadingTag
  return (
    <Tag ref={ref} id={id} className="sr-only" tabIndex={focusable ? -1 : undefined} data-search-ignore {...data}>
      {children}
    </Tag>
  )
}

// A turn is not a box in the design: it lays its rows out exactly as the log does (a column with the log's gap).
const TURN_LAYOUT = { display: 'flex', flexDirection: 'column', gap: 'inherit' } as const

type TurnGroup = { turnId: string; number: number; user: Extract<ChatItem, { kind: 'user' }>; items: ChatItem[] }

/**
 * The log as turns: a turn starts at a message the user sent (not one steered into a running turn) and holds everything up
 * to the next one. What comes before the first message, and the line where the chat switched agents, stays outside any turn.
 */
function groupTurns(items: ChatItem[]): (ChatItem | TurnGroup)[] {
  const out: (ChatItem | TurnGroup)[] = []
  let current: TurnGroup | null = null
  let number = 0
  for (const item of items) {
    if (item.kind === 'user' && !item.steered) {
      current = { turnId: item.turnId, number: ++number, user: item, items: [item] }
      out.push(current)
    } else if (item.kind === 'notice' && (item.switched || item.divider)) {
      current = null
      out.push(item)
    } else if (current) current.items.push(item)
    else out.push(item)
  }
  return out
}
const isTurn = (entry: ChatItem | TurnGroup): entry is TurnGroup => 'number' in entry

const OUTCOME_WORD = { completed: 'a11y.turn.outcome.finished', error: 'a11y.turn.outcome.failed', cancelled: 'a11y.turn.outcome.stopped', interrupted: 'a11y.turn.outcome.interrupted' } as const satisfies Record<'completed' | 'error' | 'cancelled' | 'interrupted', PlainKey>

/** The article for one turn, headed "Turn 7, Claude, 14:02, finished, 4 tool calls". Its messages are headed one level down. */
function TurnArticle({ heading, level, children }: { heading: string; level: number; children: ReactNode }) {
  const id = useId()
  return (
    <article className="chat-turn" style={TURN_LAYOUT} aria-labelledby={id} data-turn>
      <Hidden level={level} id={id} focusable data-turn-heading>
        {heading}
      </Hidden>
      {children}
    </article>
  )
}

/** Renders the text at most every STREAM_RENDER_MS while streaming; the final text at once. */
function useThrottledText(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text)
  const at = useRef(0)
  useEffect(() => {
    if (!streaming) return
    const wait = at.current + STREAM_RENDER_MS - Date.now()
    const show = () => {
      at.current = Date.now()
      setShown(text)
    }
    if (wait <= 0) {
      show()
      return
    }
    const timer = setTimeout(show, wait)
    return () => clearTimeout(timer)
  }, [text, streaming])
  return streaming ? shown : text
}

/**
 * `headingLevel` is the level of the chat's own heading: 2 on its own, 3 inside a tile (whose title is the level 2 above it).
 * Under it: a turn, then its messages, then whatever headings the agent wrote.
 */
export function ChatView({ session, workspace, active, headingLevel = 2 }: { session: Session; workspace: Workspace; active: boolean; headingLevel?: 2 | 3 }) {
  const t = useT()
  const logged = useStore((s) => s.chats[session.id]) ?? EMPTY
  // Only the turn running now can still be working; anything an earlier turn left running was stopped with it.
  const items = useMemo(() => settleItems(logged, session.turnId), [logged, session.turnId])
  const approvals = useStore((s) => s.approvals)
  const pending = approvals.filter((a) => a.sessionId === session.id)
  const running = session.status === 'running'
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [query, setQuery] = useState('')
  const hasHistory = items.some((i) => i.kind === 'user') || Boolean(session.agentSessionId)
  // O1: who answered each turn, in a chat that switched agents.
  const mixed = isMixed(items)
  const authors = useMemo(() => turnAuthors(items, session), [items, session])
  // When each turn's message was sent: a reply says which message it answers.
  const askedAt = useMemo(() => {
    const at = new Map<string, string>()
    for (const item of items) if (item.kind === 'user' && !item.steered && !at.has(item.turnId)) at.set(item.turnId, item.at)
    return at
  }, [items])
  const headingId = useId()
  const title = session.title || t('workspaceView.tab.newChat')
  const logHeading = useRef<HTMLHeadingElement>(null)
  const planHeading = useRef<HTMLDivElement>(null)
  const chatRoot = useRef<HTMLDivElement>(null)
  const turns = useMemo(() => groupTurns(items), [items])
  const strip = useStore((s) => s.snapshot?.settings.notAbsolutelyRight ?? false)
  // The person a generated workspace name comes from, introduced in the greeting.
  const namesake = workspacePerson(workspace)

  // A finished answer is announced once, when it stops streaming: never a chunk of it while it arrives. Only for the chat on
  // screen, and only for an answer this view watched finish (opening a chat full of old answers says nothing).
  const streamingIds = useRef(new Set<string>())
  const say = useRef({ t, session, authors, strip, active })
  say.current = { t, session, authors, strip, active }
  useEffect(() => {
    const now = new Set(items.filter((i) => i.kind === 'assistant' && i.streaming).map((i) => i.id))
    const { t: tNow, session: s, authors: by, strip: stripNow, active: onScreen } = say.current
    for (const id of streamingIds.current) {
      if (now.has(id) || !onScreen) continue
      const item = items.find((i) => i.id === id)
      if (item?.kind !== 'assistant') continue
      const text = s.autoReview ? withoutFindingsBlock(item.text) : item.text
      const snippet = spokenSnippet(stripNow ? stripAbsolutelyRight(text) : text)
      if (!snippet) continue
      const agent = by.get(item.turnId)?.agent ?? s.agent
      announce(tNow('chat.message.said', { name: AGENTS[agent]?.label ?? agent, text: snippet }), `message:${id}`)
    }
    streamingIds.current = now
  }, [items])

  useEffect(() => {
    void loadChat(session.id)
  }, [session.id])

  // Stay at the bottom while new output arrives, unless the user scrolled up.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current && !query) el.scrollTop = el.scrollHeight
  }, [items, pending.length, running, active, query])

  const onScroll = () => {
    const el = scroller.current
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
  }

  const lastUser = [...items].reverse().find((i) => i.kind === 'user')
  const last = items.at(-1)?.kind
  const finished = last === 'result' || last === 'turn-end'
  const lastTurnEnd = [...items].reverse().find((i) => i.kind === 'turn-end')
  const toolRequest = pending.find((a): a is Extract<ApprovalRequest, { kind: 'tool' }> => a.kind === 'tool')
  const question = pending.find((a): a is Extract<ApprovalRequest, { kind: 'question' }> => a.kind === 'question')
  const plan = pending.find((a): a is Extract<ApprovalRequest, { kind: 'plan' }> => a.kind === 'plan')
  const background = items.filter((i): i is ToolItem => i.kind === 'tool' && i.task?.status === 'running' && Boolean(i.task.background))

  // From search: scroll to the message once its chat is loaded, and flash it.
  const jump = useStore((s) => (s.chatJump?.sessionId === session.id ? s.chatJump : null))
  useEffect(() => {
    if (!jump) return
    const el = scroller.current?.querySelector(`[data-chat-item="${CSS.escape(jump.itemId)}"]`)
    if (!el) return
    pinned.current = false
    el.scrollIntoView({ block: 'center' })
    // ui/flash: the same neutral wash as a setting reached from search.
    if (el instanceof HTMLElement) flash(el, { duration: 1800 })
    clearChatJump(jump.nonce)
  }, [jump, items])

  const jumpTo = (id: string) => {
    const el = scroller.current?.querySelector(`[data-tool="${CSS.escape(id)}"]`)
    el?.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
  }

  // Switching to this chat (A7): its name is announced; focus moves to its heading only if it was in a chat's log, so a
  // person reading one chat starts at the top of the next, and someone in the composer or the sidebar stays there.
  useEffect(() => {
    if (!active) return
    const previous = lastActiveChat
    lastActiveChat = session.id
    if (previous === undefined || previous === session.id) return
    announce(t('a11y.chat.switched', { title, workspace: workspace.name }), 'chat:switch')
    if (focusWasInLog) logHeading.current?.focus({ preventScroll: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, session.id])

  // The jump keys (A2): focus goes to a heading in this chat, which is scrolled into view; never to a container.
  useEffect(
    () =>
      onUiCommand((command, workspaceId) => {
        if (!active || workspaceId !== workspace.id) return
        const log = scroller.current
        if (!log) return
        const say = (text: string) => announce(text, 'chat:jump')
        const go = (heading: HTMLElement) => {
          heading.focus({ preventScroll: true })
          pinned.current = false
          ;(heading.closest('[data-turn]') ?? heading).scrollIntoView({ block: 'start', behavior: reduceMotion() ? 'auto' : 'smooth' })
          requestAnimationFrame(onScroll)
        }
        const headings = [...log.querySelectorAll<HTMLElement>('[data-turn-heading]')]
        if (command === 'chat-latest-reply') {
          const latest = headings.at(-1)
          if (latest) go(latest)
          else say(t('a11y.chat.noTurns'))
        } else if (command === 'chat-previous-turn') {
          // The turn before the one focus is in; from the composer or anywhere outside the log, the latest; from the top, none.
          const focus = document.activeElement
          const own = focus ? focus.closest('[data-turn]') : null
          const index = own && log.contains(own) ? headings.indexOf(own.querySelector<HTMLElement>('[data-turn-heading]')!) : focus === logHeading.current ? 0 : headings.length
          const previous = headings[index - 1]
          if (previous) go(previous)
          else say(t(headings.length ? 'a11y.chat.firstTurn' : 'a11y.chat.noTurns'))
        } else if (command === 'chat-needs-me') {
          // The approval or question panel in place of the composer; else the plan the agent proposed.
          const panel = chatRoot.current?.querySelector<HTMLElement>('.approval-panel')
          if (panel) panel.focus()
          else if (planHeading.current) go(planHeading.current)
        } else if (command === 'chat-needs-none') say(t('narration.needs.lead', { count: 0 }))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, workspace.id, t]
  )

  // A throttled render grows the log between renders of this view: keep it pinned to the bottom when it was.
  const follow = useCallback(() => {
    const el = scroller.current
    if (el && pinned.current && !query) el.scrollTop = el.scrollHeight
  }, [query])

  const row = (item: ChatItem) => (
    <div key={item.id} data-chat-item={item.id}>
      {/* #17: an auto review's findings, as review threads, above its result line. */}
      {item.kind === 'turn-end' && session.autoReview && <AutoReviewFindings workspace={workspace} session={session} turnId={item.turnId} />}
      <ChatRow
        item={item}
        items={items}
        session={session}
        workspacePath={toolRoots(workspace)}
        workspaceId={workspace.id}
        running={running}
        query={query}
        isLatestEnd={item === lastTurnEnd}
        workspaceChanges={workspace.diffStat}
        readOnly={sessionReadOnly(workspace, session)}
        author={'turnId' in item && item.turnId ? authors.get(item.turnId) : undefined}
        mixed={mixed}
        askedAt={'turnId' in item && item.turnId ? askedAt.get(item.turnId) : undefined}
        level={headingLevel + 2}
        onGrow={follow}
      />
      {item.kind === 'user' && session.autoReview && <AutoReviewReceipt workspace={workspace} session={session} item={item} />}
      {item.kind === 'turn-end' &&
        (workspace.alerts ?? [])
          .filter((a) => a.sessionId === session.id && a.turnId === item.turnId)
          .map((a) => <SensitiveCard key={a.id} alert={a} workspaceId={workspace.id} />)}
    </div>
  )

  // "Turn 7, Claude, 14:02, finished, 4 tool calls": the heading a reader lands on when it jumps to a turn.
  const turnHeading = (turn: TurnGroup, last: boolean) => {
    const end = turn.items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
    const agent = authors.get(turn.turnId)?.agent ?? session.agent
    const calls = turn.items.filter((i) => i.kind === 'tool' && !isReportCall(i)).length
    const parts = [
      t('a11y.turn.title', { n: turn.number, agent: AGENTS[agent]?.label ?? agent, time: formatClock(turn.user.at, t.locale) }),
      end ? t(OUTCOME_WORD[end.outcome]) : last && running ? t('a11y.turn.outcome.running') : '',
      calls > 0 ? t('a11y.turn.toolCalls', { count: calls }) : ''
    ].filter(Boolean)
    return parts.reduce((a, b) => t('narration.join', { a, b }))
  }
  const lastTurn = turns.findLast(isTurn)

  return (
    <div className="chat" ref={chatRoot}>
      <ChatSearch root={scroller} items={items} active={active} workspaceId={workspace.id} query={query} onQuery={setQuery} />
      {/* The messages are a labelled region of articles, each headed with who wrote it and when. It is not a live region:
          answers are announced once they are finished (above), and a live log would speak every tool call and every token. */}
      <div className="chat-scroll" ref={scroller} onScroll={onScroll} role="region" aria-labelledby={headingId}>
        <Hidden level={headingLevel} id={headingId} focusable ref={logHeading}>
          {t('chat.log.heading', { title })}
        </Hidden>
        <div className="chat-inner">
          {items.length === 0 && (
            <div className="chat-greeting">
              <p>
                {t.rich('chat.greeting.copy', { name: <strong key="name">{workspace.name}</strong>, branch: <code key="branch">{workspace.branch}</code>, base: <code key="base">{workspace.baseBranch}</code> })}
                {namesake && (
                  <>
                    {' '}
                    {t.rich('chat.greeting.namesake', {
                      name: (
                        <LinkButton key="name" underline title={t('chat.greeting.namesakeSource', { name: namesake.fullName })} onClick={() => void attempt(() => api.openExternal(namesake.source))}>
                          {namesake.fullName}
                        </LinkButton>
                      ),
                      contribution: namesake.contribution
                    })}
                  </>
                )}
              </p>
              <p className="muted">{t('chat.greeting.ask', { agent: AGENTS[session.agent].label })}</p>
            </div>
          )}
          {turns.map((entry) =>
            isTurn(entry) ? (
              <TurnArticle key={entry.user.id} heading={turnHeading(entry, entry === lastTurn)} level={headingLevel + 1}>
                {entry.items.map(row)}
              </TurnArticle>
            ) : (
              row(entry)
            )
          )}
          {workspace.state === 'setup-failed' && workspace.heldMessage?.sessionId === session.id && (
            <div className="user-row">
              <div className="user-msg held">
                <div className="steered faint small">{t('chat.held')}</div>
                {workspace.heldMessage.text}
              </div>
            </div>
          )}
          {plan && (
            <div className="plan-card">
              <div className="plan-card-head" role="heading" aria-level={headingLevel + 1} tabIndex={-1} ref={planHeading}>
                <ClipboardList size={14} /> {t('chat.plan.title')}
              </div>
              <Markdown text={plan.plan} headingStart={headingLevel + 2} />
            </div>
          )}
          {running && !finished && pending.length === 0 && lastUser?.kind === 'user' && <LiveTimer since={lastUser.at} />}
        </div>
      </div>
      {background.length > 0 && <BackgroundTasks tasks={background} workspacePath={toolRoots(workspace)} onJump={jumpTo} />}
      {workspace.state === 'archived' ? (
        // Read-only (#13): the composer becomes a banner, and Restore is its own step.
        <div className="composer">
          <ArchivedBanner workspace={workspace} session={session} />
        </div>
      ) : toolRequest ? (
        <ToolApprovalPanel request={toolRequest} workspacePath={workspace.path ?? ''} />
      ) : question ? (
        <QuestionPanel request={question} />
      ) : (
        <>
          {!hasHistory && session.queue.length === 0 && hasNote(workspace.note) && (
            <Checkbox className="include-note" checked={Boolean(session.includeNote)} onChange={(e) => void attempt(() => api.updateSession(session.id, { includeNote: e.target.checked }))}>
              <span className="include-note-text">{t.rich('chat.includeNote', { revision: <Tag key="r">r{workspace.note.revision}</Tag> })}</span>
            </Checkbox>
          )}
          <Composer session={session} workspace={workspace} active={active} hasHistory={hasHistory} pendingPlan={plan} />
        </>
      )}
    </div>
  )
}

/** A quiet line under a sent message: what Foreman added to it, expandable to each part with its size and source. */
function ContextReceipt({ parts }: { parts: ContextPart[] }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  return (
    <div className="receipt">
      <LinkButton size="sm" className="receipt-ctx" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Plus size={12} /> {receiptLine(parts, t)}
      </LinkButton>
      {open && (
        <div className="ctx-open">
          {parts.map((p) => (
            <div key={p.kind}>
              <b>{p.label[0].toUpperCase() + p.label.slice(1)}</b> · {p.source} ({partSize(p, t, t.locale)}){p.detail && <span className="faint"> · {p.detail}</span>}
            </div>
          ))}
          <div className="faint">{t('chat.receipt.disclaimer')}</div>
        </div>
      )}
    </div>
  )
}

function LiveTimer({ since }: { since: string }) {
  const t = useT()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100)
    return () => clearInterval(timer)
  }, [])
  const seconds = Math.max(0, (now - new Date(since).getTime()) / 1000)
  return (
    <div className="live-timer">
      <Spinner size={14} />
      <span className="mono">{t('chat.seconds', { s: seconds.toFixed(1) })}</span>
    </div>
  )
}

/** Subagents and shells still running after their tool call returned. */
function BackgroundTasks({ tasks, workspacePath, onJump }: { tasks: ToolItem[]; workspacePath: Root; onJump: (id: string) => void }) {
  const t = useT()
  return (
    <div className="bg-tasks">
      <div className="bg-tasks-box">
        <div className="bg-tasks-head faint small">{t('chat.background.head')}</div>
        {tasks.map((item) => {
          const task = item.task!
          const activity = taskActivity(task, t)
          return (
            <Pressable key={item.id} className="tool-row bg-task" title={t('chat.background.show')} onClick={() => onJump(item.id)}>
              <span className="tool-icon"><Spinner size={14} /></span>
              <span className="tool-label">{describe(item, workspacePath, t).label}</span>
              {activity && <span className="bg-task-activity">{activity}</span>}
              <TaskMeta task={task} inStrip />
            </Pressable>
          )
        })}
      </div>
    </div>
  )
}

function ChatRow({
  item,
  items,
  session,
  workspacePath,
  workspaceId,
  running,
  query,
  isLatestEnd,
  workspaceChanges,
  readOnly,
  author,
  mixed,
  askedAt,
  level,
  onGrow
}: {
  item: ChatItem
  items: ChatItem[]
  session: Session
  workspacePath: Root
  workspaceId: string
  running: boolean
  query: string
  isLatestEnd: boolean
  workspaceChanges?: TurnDelta | { files: number; additions: number; deletions: number }
  readOnly?: boolean
  // O1: the agent and model that answered this item's turn, and whether the chat switched agents.
  author?: TurnAuthor
  mixed?: boolean
  // When the message this turn answers was sent.
  askedAt?: string
  // The heading level of a message in this row; what an agent writes inside it starts one level below.
  level: number
  onGrow: () => void
}) {
  const t = useT()
  const headingId = useId()
  switch (item.kind) {
    case 'user':
      return (
        <div className="user-row">
          {/* #22: agents that can't rewind (Chat agents over ACP) get no Restore. O1: the agent the message went to decides. */}
          {item.checkpoint && !item.steered && !readOnly && agentControls(author?.agent ?? session.agent).restore && (
            <span className="restore-wrap">
              <Button
                size="sm"
                icon={<RotateCcw size={12} />}
                title={t('chat.restore.title')}
                disabled={running}
                onClick={() => {
                  if (window.confirm(t('chat.restore.confirm'))) {
                    void attempt(() => api.restoreCheckpoint(session.id, item.turnId))
                  }
                }}
              >
                {t('chat.restore.label')}
              </Button>
            </span>
          )}
          {!readOnly && <UserMenu item={item} session={session} running={running} />}
          <article className="user-msg" aria-labelledby={headingId}>
            <Hidden level={level} id={headingId}>
              {t('chat.message.youAt', { time: formatClock(item.at, t.locale) })}
            </Hidden>
            {item.steered && <div className="steered faint small">{t('chat.steered')}</div>}
            {item.editRaced && <RacedEditTag />}
            <UserMessageText text={item.text} />
            {item.noteRevision !== undefined && <div className="note-tag faint small">{t('chat.noteTag', { revision: item.noteRevision })}</div>}
            {item.readOnly && <ReadOnlyReceipt how={item.readOnly} />}
            {item.attachments && item.attachments.length > 0 && (
              <div className="attachment-row">
                {item.attachments.map((a) => (
                  <AttachmentChip key={a.path} attachment={a} />
                ))}
              </div>
            )}
          </article>
          {item.origin && <AutoFixReceipt origin={item.origin} />}
          {item.added && item.added.length > 0 && <ContextReceipt parts={item.added} />}
        </div>
      )
    case 'assistant':
      // #17: a reviewer's findings block shows as cards instead of JSON.
      return (
        <AssistantMessage
          text={session.autoReview && !item.streaming ? withoutFindingsBlock(item.text) : item.text}
          streaming={item.streaming}
          workspaceId={workspaceId}
          who={AGENTS[author?.agent ?? session.agent]?.label ?? session.agent}
          askedAt={askedAt}
          level={level}
          onGrow={onGrow}
        />
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} forceOpen={textMatches(item.text, query).length > 0} />
    case 'tool':
      // #2: a call that only made a report is folded into the report's own line.
      if (isReportCall(item)) return null
      return <ToolRow item={item} workspacePath={workspacePath} forceOpen={textMatches(`${JSON.stringify(item.input, null, 2)}\n${item.output ?? ''}\n${item.task?.summary ?? ''}`, query).length > 0} />
    case 'notice':
      // O10: where Foreman was closed while this turn kept running in the background.
      if (item.gap) return <ClosedGapLine gap={item.gap} />
      // #2: what the agent reported ("agent says: checkpoint — …"); an open needs-input is a card.
      if (item.report) return <ReportRow marker={item.report} turnId={item.turnId} sessionId={session.id} workspaceId={workspaceId} readOnly={readOnly} />
      // O1: where the chat switched agents, and what the new one was given.
      if (item.switched) return <SwitchDivider switched={item.switched} />
      // O1 (G1): where the conversation was compacted, or moved to another model of the same agent.
      if (item.divider) return <ChatDividerLine divider={item.divider} />
      // The turn failed on sign-in: once the agent is signed in, this card says so and offers Retry.
      if (item.action === 'sign-in') return <SignInNotice item={item} items={items} session={session} running={running} readOnly={readOnly}>{item.text}</SignInNotice>
      return (
        <Callout
          tone={item.level === 'error' ? 'error' : 'neutral'}
          className="chat-notice"
          actions={
            item.action && (
              <Button size="sm" icon={<Settings size={12} />} onClick={() => openSettingsPage({ section: 'agents', agent: session.agent })}>
                {t('chat.notice.openSettings')}
              </Button>
            )
          }
        >
          {item.text}
        </Callout>
      )
    case 'turn-end':
      return <TurnEnd item={item} items={items} session={session} running={running} isLatestEnd={isLatestEnd} workspaceChanges={workspaceChanges} readOnly={readOnly} by={mixed ? author : undefined} />
    case 'result':
      // Superseded by the turn's result line, which carries the cost.
      if (items.some((i) => i.kind === 'turn-end' && i.turnId === item.turnId)) return null
      return (
        <div className={`result ${item.ok ? '' : 'error'}`}>
          {item.ok ? <Sparkles size={13} /> : null}
          <span className="mono">
            {item.ok ? '' : `${t('chat.result.error')} · `}
            {item.durationMs !== undefined && t('chat.seconds', { s: (item.durationMs / 1000).toFixed(1) })}
            {item.costUsd !== undefined && item.costUsd > 0 && ` · $${item.costUsd.toFixed(2)}`}
          </span>
        </div>
      )
  }
}

const OUTCOME_LABEL: Record<'completed' | 'error' | 'cancelled' | 'interrupted', PlainKey> = { completed: 'chat.outcome.completed', error: 'chat.outcome.error', cancelled: 'chat.outcome.cancelled', interrupted: 'chat.outcome.interrupted' }

/** How a turn ended: a compact result line, plus a recovery card when it failed or was cut off. */
function TurnEnd({
  item,
  items,
  session,
  running,
  isLatestEnd,
  workspaceChanges,
  readOnly,
  by
}: {
  item: Extract<ChatItem, { kind: 'turn-end' }>
  items: ChatItem[]
  session: Session
  running: boolean
  isLatestEnd: boolean
  workspaceChanges?: { additions: number; deletions: number }
  // The tab can't send (history only), so no recovery actions.
  readOnly?: boolean
  // O1: in a chat that switched agents, who wrote this answer.
  by?: TurnAuthor
}) {
  const t = useT()
  const failed = item.outcome === 'error' || item.outcome === 'interrupted'
  const workspaceRepoId = useStore((s) => s.snapshot!.workspaces.find((w) => w.id === session.workspaceId)?.repoId)
  const cost = items.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result' && i.turnId === item.turnId)?.costUsd
  // The workspace-wide figure is only honest for the latest turn, and is labelled as such.
  const changes = item.delta
    ? item.delta.additions || item.delta.deletions
      ? { label: 'chat.changes.thisTurn' as PlainKey, ...item.delta }
      : null
    : isLatestEnd && workspaceChanges && (workspaceChanges.additions || workspaceChanges.deletions)
      ? { label: 'chat.changes.workspace' as PlainKey, ...workspaceChanges }
      : null
  const message = items.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === item.turnId && !i.steered)
  // On the latest answer only, and only once the chat is idle, queue empty and the turn completed.
  const eligibility = isLatestEnd && !running && !readOnly ? continueEligibility(session, items) : null
  const suggested = eligibility?.ok ? continueFollowUp(items, eligibility.turnId) : null
  // Chips only on the latest completed answer of an idle chat; once it moves on they are gone from view.
  const forkable = useStore((s) => s.snapshot!.settings.forkToNewTab) && !readOnly && Boolean(message)
  const chips = item.outcome === 'completed' && isLatestEnd && !running && !readOnly && !session.queue.length ? item.suggestions ?? [] : []
  return (
    <>
      <div className={`result turn-result ${failed ? 'error' : ''}`}>
        {item.outcome === 'completed' ? <Sparkles size={13} /> : failed ? <AlertTriangle size={13} /> : null}
        <span className="mono">
          {[
            t(OUTCOME_LABEL[item.outcome]),
            item.durationMs !== undefined && formatDuration(item.durationMs),
            cost !== undefined && cost > 0 && `$${cost.toFixed(2)}`
          ]
            .filter(Boolean)
            .join(' · ')}
          {by && <span className="turn-by"> · {by.model ? modelInfo(by.agent, by.model).label : AGENTS[by.agent]?.label ?? by.agent}</span>}
        </span>
        <AnswerMenu
          sessionId={session.id}
          workspaceId={session.workspaceId}
          turnId={item.turnId}
          canFork={forkable}
          repoId={workspaceRepoId}
          answer={turnAnswer(items, item.turnId)}
          continueLabel={eligibility?.ok ? (suggested ? t('chat.continue.to', { title: suggested.title }) : t('chat.continue.another')) : undefined}
          continueTitle={suggested ? t('chat.continue.toTitle') : t('chat.continue.anotherTitle')}
        />
        {changes && (
          <span className="mono turn-changes" title={changes.label === 'chat.changes.thisTurn' ? t('chat.changes.thisTurnTitle') : t('chat.changes.workspaceTitle')}>
            {t(changes.label)} <span className="add">+{changes.additions}</span> <span className="del">−{changes.deletions}</span>
          </span>
        )}
      </div>
      {chips.length > 0 && (
        <div className="chips-row" data-testid="suggested-followups">
          <span className="faint small">{t('chat.suggested')}</span>
          {chips.map((text) => (
            <ChipButton key={text} pill className="sugg" title={t('chat.suggestedTitle')} onClick={() => fillComposer(session.workspaceId, session.id, text)}>
              {text}
            </ChipButton>
          ))}
        </div>
      )}
      {failed && (
        <Callout
          tone="error"
          actions={
            isLatestEnd && !running && !readOnly && (
              <>
                {message && (
                  <Button
                    size="sm"
                    icon={<RotateCcw size={12} />}
                    title={t('chat.recovery.retryTitle')}
                    onClick={() => void attempt(() => api.sendMessage(session.id, message.text, { attachments: message.attachments, templateId: message.followUp?.templateId }))}
                  >
                    {t('common.retry')}
                  </Button>
                )}
                <Button size="sm" title={t('chat.recovery.continueTitle')} onClick={() => sendUiCommand('focus-composer', session.workspaceId)}>
                  {t('common.continue')}
                </Button>
              </>
            )
          }
        >
          {item.outcome === 'interrupted' ? t('chat.recovery.interrupted') : t('chat.recovery.error')}
          {item.error && <div className="recovery-detail">{item.error}</div>}
          <LimitResumePart item={item} session={session} canAct={isLatestEnd && !running && !readOnly} />
        </Callout>
      )}
    </>
  )
}

/** O1: the line where a chat switched agents: "Switched to Codex · GPT-6.1 Sol · earlier messages passed as text …". */
function SwitchDivider({ switched }: { switched: AgentSwitch }) {
  const t = useT()
  const name = `${AGENTS[switched.to]?.label ?? switched.to} · ${modelInfo(switched.to, switched.model).label}`
  return (
    <div className="agent-switch" role="separator">
      <span className="agent-switch-text">
        <AgentIcon agent={switched.to} size={12} />
        <span>{t.rich(switched.carried === 'native' ? 'switchAgent.divider.native' : 'switchAgent.divider.history', { name: <b key="n">{name}</b> })}</span>
      </span>
    </div>
  )
}

/** O1 (G1): "Conversation compacted · …" or "Model changed to Sonnet 5.5 · same conversation", drawn like a switch. */
function ChatDividerLine({ divider }: { divider: ChatDivider }) {
  const t = useT()
  if (divider.kind === 'compact') {
    return (
      <div className="agent-switch" role="separator">
        <span className="agent-switch-text">{t('g1.divider.compact')}</span>
      </div>
    )
  }
  const to = modelInfo(divider.agent, divider.to).label
  return (
    <div className="agent-switch" role="separator">
      <span className="agent-switch-text">
        <AgentIcon agent={divider.agent} size={12} />
        <span>
          {divider.from === divider.to
            ? t.rich('g1.divider.modelBack', { model: <b key="m">{to}</b> })
            : t.rich('g1.divider.model', { from: modelInfo(divider.agent, divider.from).label, model: <b key="m">{to}</b>, agent: AGENTS[divider.agent]?.label ?? divider.agent })}
        </span>
      </span>
    </div>
  )
}

type UserItem = Extract<ChatItem, { kind: 'user' }>

/**
 * #16: "…" beside a sent message. Edit and resend forks from just before it (the first message opens a
 * new chat) with its text in the new tab's composer; nothing is sent and this chat stays as it is.
 */
function UserMenu({ item, session, running }: { item: UserItem; session: Session; running: boolean }) {
  const t = useT()
  const block = editResendBlock(item, running)
  const blockText = block ? t(block === 'steered' ? 'editResend.menu.steered' : 'editResend.menu.running') : undefined
  return (
    <MenuButton className="user-menu" look="icon" label={t('editResend.menu.label')} placement="bottom-start" trigger={<MoreHorizontal size={13} />}>
      <MenuItem icon={<Pencil size={12} />} disabled={Boolean(block)} title={blockText} onSelect={() => void editAndResend(session.workspaceId, session.id, { turnId: item.turnId, text: item.text })}>
        {t('editResend.menu.edit')}
      </MenuItem>
      <MenuItem
        icon={<Copy size={12} />}
        onSelect={() =>
          void attempt(async () => {
            await navigator.clipboard.writeText(item.text)
            showToast(t('editResend.menu.copied'))
          })
        }
      >
        {t('editResend.menu.copy')}
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>
        <span className="user-menu-hint">{blockText ?? t('editResend.menu.hint')}</span>
      </MenuLabel>
    </MenuButton>
  )
}

/** G4 #12: this message was edited in the queue after it had started, so it ran as it was. */
function RacedEditTag() {
  const t = useT()
  return (
    <div className="steered faint small" title={t('queue.sentBeforeEditTitle')}>
      {t('queue.sentBeforeEdit')}
    </div>
  )
}

/** #16: under a message that ran read-only, how Foreman enforced it. */
function ReadOnlyReceipt({ how }: { how: NonNullable<UserItem['readOnly']> }) {
  const t = useT()
  return (
    <div className="note-tag faint small read-only-receipt">
      <Lock size={10} /> {t(how === 'plan' ? 'readOnlyOpinion.receipt.plan' : 'readOnlyOpinion.receipt.sandbox')}
    </div>
  )
}

/**
 * "…" on a turn's result line: everything to do with that answer. Continue only shows on the
 * latest completed answer of an idle chat (`continueLabel` is absent otherwise).
 */
function AnswerMenu({
  sessionId,
  workspaceId,
  turnId,
  canFork,
  repoId,
  answer,
  continueLabel,
  continueTitle
}: {
  sessionId: string
  workspaceId: string
  turnId: string
  canFork: boolean
  repoId?: string
  answer: string
  continueLabel?: string
  continueTitle: string
}) {
  const t = useT()
  if (!repoId) return null
  return (
    <MenuButton className="answer-menu" look="icon" label={t('chat.answerMenu.label')} trigger={<MoreHorizontal size={13} />}>
      {continueLabel && (
        <MenuItem icon={<ArrowRight size={12} />} title={continueTitle} onSelect={() => openHandOffDialog({ sourceId: sessionId, kind: 'continue' })}>
          {continueLabel}
        </MenuItem>
      )}
      {canFork && (
        <MenuItem icon={<GitBranch size={12} />} title={t('chat.answerMenu.forkTitle')} onSelect={() => void forkChat(workspaceId, sessionId, turnId)}>
          {t('chat.answerMenu.fork')}
        </MenuItem>
      )}
      <MenuItem icon={<Users size={12} />} title={t('chat.answerMenu.secondOpinionTitle')} onSelect={() => openHandOffDialog({ sourceId: sessionId, kind: 'second-opinion' })}>
        {t('chat.answerMenu.secondOpinion')}
      </MenuItem>
      {answer && (
        <MenuItem icon={<FolderPlus size={12} />} title={t('chat.answerMenu.startWorkspaceTitle')} onSelect={() => openNewWorkspace(repoId, answer)}>
          {t('chat.answerMenu.startWorkspace')}
        </MenuItem>
      )}
      <MenuSeparator />
      <MenuItem icon={<Copy size={12} />} onSelect={() => void copyTranscript(sessionId, false)}>
        {t('chat.answerMenu.copyMessages')}
      </MenuItem>
      <MenuItem icon={<Copy size={12} />} onSelect={() => void copyTranscript(sessionId, true)}>
        {t('chat.answerMenu.copyTools')}
      </MenuItem>
      <MenuLabel>{t('chat.answerMenu.secrets')}</MenuLabel>
    </MenuButton>
  )
}

const ABSOLUTELY_RIGHT = /^\s*(\*\*|__)?(?:you['‘’`]re|you are) absolutely right(?:\s*([.!,]+)|(?=[ \t]*(?:\n|$)))\1?\s*/i
const ABSOLUTELY_RIGHT_STARTS = ["you're absolutely right", 'you are absolutely right']

/**
 * Drops a leading "You're absolutely right!" (and its variants). While the
 * reply streams in, a partial match is hidden too so it doesn't flash.
 */
function stripAbsolutelyRight(text: string, streaming?: boolean): string {
  const match = ABSOLUTELY_RIGHT.exec(text)
  if (match) {
    const rest = text.slice(match[0].length)
    // "You're absolutely right, the bug…" → "The bug…"
    return match[2]?.endsWith(',') ? rest.charAt(0).toUpperCase() + rest.slice(1) : rest
  }
  if (streaming) {
    const start = text.trimStart().replace(/^(\*\*|__)/, '').replace(/[‘’`]/g, "'").toLowerCase()
    if (start && ABSOLUTELY_RIGHT_STARTS.some((phrase) => phrase.startsWith(start))) return ''
  }
  return text
}

function AssistantMessage({ text, streaming, workspaceId, who, askedAt, level, onGrow }: { text: string; streaming?: boolean; workspaceId: string; who: string; askedAt?: string; level: number; onGrow: () => void }) {
  const t = useT()
  const headingId = useId()
  const strip = useStore((s) => s.snapshot?.settings.notAbsolutelyRight ?? false)
  // While the reply streams its Markdown is rendered every STREAM_RENDER_MS, not on each flush; the final text at once.
  const rendered = useThrottledText(text, Boolean(streaming))
  const shown = strip ? stripAbsolutelyRight(rendered, streaming) : rendered
  useLayoutEffect(onGrow, [shown, onGrow])
  if (text && !shown) return null
  return (
    <article className={`assistant ${streaming ? 'streaming' : ''}`} aria-labelledby={headingId} aria-busy={streaming ? true : undefined}>
      <Hidden level={level} id={headingId}>
        {askedAt ? t('chat.message.agentReplyAt', { name: who, time: formatClock(askedAt, t.locale) }) : who}
      </Hidden>
      <Markdown text={shown} workspaceId={workspaceId} streaming={streaming} headingStart={level + 1} />
    </article>
  )
}

function Thinking({ text, streaming, forceOpen }: { text: string; streaming?: boolean; forceOpen: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const expanded = open || forceOpen
  if (!text.trim()) return null
  return (
    <div className="thinking">
      <LinkButton size="sm" aria-expanded={expanded} onClick={() => setOpen(!open)}>
        {streaming ? t('chat.thinking.live') : expanded ? t('chat.thinking.hide') : t('chat.thinking.done')}
      </LinkButton>
      {expanded && <div className="thinking-text">{text}</div>}
    </div>
  )
}
