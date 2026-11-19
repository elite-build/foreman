import { ArrowRight, Copy, FolderPlus, GitBranch, History, Lock, MessageSquare, MoreHorizontal, Pencil, Plus, RotateCcw, Settings, Sparkles, Undo2, Users } from 'lucide-react'
import { Activity, memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type Ref } from 'react'
import { isFallback } from '../../../shared/agentCapabilities'
import { AGENTS, modelInfo } from '../../../shared/agents'
import { isMixed, turnAuthors, type AgentSwitch, type ChatDivider, type TurnAuthor } from '../../../shared/switchAgent'
import { continueEligibility, continueFollowUp, turnAnswer } from '../../../shared/handOff'
import { partSize, receiptLine } from '../../../shared/context'
import type { PlainKey } from '../../../shared/i18n'
import type { AgentKind, ApprovalRequest, ChatItem, ContextPart, Session, TurnDelta, TurnOutcome, Workspace } from '../../../shared/types'
import { useClock } from '../clock'
import { api, attempt, clearChatJump, copyTranscript, editAndResend, fillComposer, forkChat, loadChat, onUiCommand, openHandOffDialog, openNewWorkspace, openSettingsPage, showToast, useCapabilities, useStore } from '../store'
import { useHeldStore } from '../heldStore'
import { editResendBlock } from '../../../shared/fork'
import { useT } from '../i18n'
import { announce } from '../announce'
import { spokenSnippet } from '../agentStatus'
import { reduceMotion } from '../theme'
import { formatClock, formatNumber } from '../../../shared/i18n/time'
import { Button, Callout, Card, Checkbox, ChipButton, Dialog, Disclosure, flash, LinkButton, MenuButton, MenuItem, MenuLabel, MenuSeparator, Pressable, SplitButton, Spinner, Status, Tag, type StatusTone } from '../ui'
import { hasNote } from '../../../shared/note'
import { formatDuration } from './turnResult'
import { NeedsYouDock } from './ApprovalPanel'
import { EmployeeRunDecision } from './employees/EmployeeDecisions'
import { AttachmentChip, Composer } from './composer/Composer'
import { UserMessageText } from './composer/TerminalDraft'
import { AgentIcon } from './composer/AgentPicker'
import { MoveDivider, SwitchDivider } from './SwitchDivider'
import './switchAgent.css'
import { Markdown } from './Markdown'
import { SensitiveCard } from './SensitiveAlert'
import { ChatSearch } from './ChatSearch'
import { textMatches } from './findInChat'
import { describe, ResultWord, StopSubagent, SubagentSteps, taskActivity, TaskMeta, toolResult, ToolRow, type Root, type StopChild, type Subtree, type ToolItem } from './ToolRow'
import { childItemsOf, isChildItem, withoutChildren, type ChildItem } from '../../../shared/subagents'
import { fullPath, OpenFileChip, type FileAccess } from './OpenFileChip'
import { workspaceSurfaces } from '../archivedView'
import { toolRoots } from '../../../shared/portable'
import { sessionReadOnly } from '../../../shared/workspacePath'
import { workspacePerson } from '../../../shared/workspacePeople'
import { settleItems } from '../../../shared/liveItems'
import { ArchivedBanner } from './ArchivedView'
import { ClosedGapLine } from './KeepRunning'
import { ReportRow } from './AgentReport'
import { isReportCall } from '../../../shared/agentReports'
import { AutoFixReceipt } from './AutoFix'
import { LimitResumePart, PausedCard } from './LimitResume'
import { SignInNotice } from './SignInNotice'
import { AutoReviewFindings, AutoReviewReceipt } from './AutoReview'
import { withoutFindingsBlock } from '../../../shared/autoReview'

const EMPTY: ChatItem[] = []
const NO_TASKS: ReadonlySet<string> = new Set()
const NO_TOOLS: ToolItem[] = []

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
function groupTurns(items: ChatItem[], previous: (ChatItem | TurnGroup)[] = []): (ChatItem | TurnGroup)[] {
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
  // A turn that holds the same items as before stays the same object, so its heading isn't worked out again.
  const was = new Map(previous.filter(isTurn).map((turn) => [turn.user, turn]))
  return out.map((entry) => {
    if (!isTurn(entry)) return entry
    const old = was.get(entry.user)
    return old && old.number === entry.number && sameItems(old.items, entry.items) ? old : entry
  })
}
const isTurn = (entry: ChatItem | TurnGroup): entry is TurnGroup => 'number' in entry
const sameItems = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])
const turnOf = (item: ChatItem): string | undefined => item.turnId

/**
 * Each turn's items, by turn id, wherever they sit in the log. A turn whose items are all the same objects keeps its
 * array, so a finished turn's rows get the same props when the running turn adds an item.
 */
function itemsByTurn(items: ChatItem[], previous: Map<string, ChatItem[]>): Map<string, ChatItem[]> {
  const next = new Map<string, ChatItem[]>()
  for (const item of items) {
    const id = turnOf(item)
    if (!id) continue
    const list = next.get(id)
    if (list) list.push(item)
    else next.set(id, [item])
  }
  for (const [id, list] of next) {
    const old = previous.get(id)
    if (old && sameItems(old, list)) next.set(id, old)
  }
  return next
}

/**
 * Each Task call's subagent's own items (docs/agents.md 6): the call's id to its items and those of any Task call inside it.
 * A call whose items are all the same objects keeps its map, so its row isn't drawn again when another subagent adds one.
 */
function subtreesOf(all: ChatItem[], previous: Map<string, Subtree>): Map<string, Subtree> {
  const out = new Map<string, Subtree>()
  const by = childItemsOf(all)
  if (!by.size) return out
  for (const root of all) {
    if (root.kind !== 'tool' || isChildItem(root) || !by.has(root.id)) continue
    const tree = new Map<string, ChildItem[]>()
    const walk = (id: string) => {
      const kids = by.get(id)
      if (!kids || tree.has(id)) return
      tree.set(id, kids)
      for (const kid of kids) if (kid.kind === 'tool') walk(kid.id)
    }
    walk(root.id)
    const old = previous.get(root.id)
    out.set(root.id, old && old.size === tree.size && [...tree].every(([id, kids]) => old.has(id) && sameItems(old.get(id)!, kids)) ? old : tree)
  }
  return out
}

/** `turnAuthors`, keeping the previous object for a turn whose agent and model are the same. */
function stableAuthors(next: Map<string, TurnAuthor>, previous: Map<string, TurnAuthor>): Map<string, TurnAuthor> {
  for (const [id, author] of next) {
    const old = previous.get(id)
    if (old && old.agent === author.agent && old.model === author.model) next.set(id, old)
  }
  return next
}

// An item settled (shown stopped, see settleItems) stays one object while its original does, so its row isn't drawn again.
const settledOnce = new WeakMap<ChatItem, ChatItem>()
function settleStable(logged: ChatItem[], liveTurnId: string | undefined): ChatItem[] {
  const settled = settleItems(logged, liveTurnId)
  if (settled === logged) return logged
  return settled.map((item, n) => {
    const original = logged[n]
    if (item === original) return item
    const kept = settledOnce.get(original)
    if (kept) return kept
    settledOnce.set(original, item)
    return item
  })
}

// What chat search looks through in a tool call, written out once per call and only once someone searches.
const toolText = new WeakMap<ToolItem, string>()
function toolSearchText(item: ToolItem): string {
  let text = toolText.get(item)
  if (text === undefined) toolText.set(item, (text = `${JSON.stringify(item.input, null, 2)}\n${item.output ?? ''}\n${item.task?.summary ?? ''}`))
  return text
}

const OUTCOME_WORD = { completed: 'a11y.turn.outcome.finished', error: 'a11y.turn.outcome.failed', cancelled: 'a11y.turn.outcome.stopped', interrupted: 'a11y.turn.outcome.interrupted' } as const satisfies Record<'completed' | 'error' | 'cancelled' | 'interrupted', PlainKey>

/** The article for one turn, headed "Turn 7, Claude, 14:02, finished, 4 tool calls". Its messages are headed one level down. */
function TurnArticle({ turn, agent, live, level, children }: { turn: TurnGroup; agent: AgentKind; live: boolean; level: number; children: ReactNode }) {
  const id = useId()
  return (
    <article className="chat-turn" style={TURN_LAYOUT} aria-labelledby={id} data-turn>
      <Hidden level={level} id={id} focusable data-turn-heading>
        <TurnTitle turn={turn} agent={agent} live={live} />
      </Hidden>
      {children}
    </article>
  )
}

/** "Turn 7, Claude, 14:02, finished, 4 tool calls": the heading a reader lands on when it jumps to a turn. `live`: still running. */
const TurnTitle = memo(function TurnTitle({ turn, agent, live }: { turn: TurnGroup; agent: AgentKind; live: boolean }) {
  const t = useT()
  const end = turn.items.find((i): i is Extract<ChatItem, { kind: 'turn-end' }> => i.kind === 'turn-end')
  const calls = turn.items.filter((i) => i.kind === 'tool' && !isReportCall(i)).length
  const parts = [
    t('a11y.turn.title', { n: turn.number, agent: AGENTS[agent]?.label ?? agent, time: formatClock(turn.user.at, t.locale) }),
    end ? t(OUTCOME_WORD[end.outcome]) : live ? t('a11y.turn.outcome.running') : '',
    calls > 0 ? t('a11y.turn.toolCalls', { count: calls }) : ''
  ].filter(Boolean)
  return parts.reduce((a, b) => t('narration.join', { a, b }))
})

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

type ChatViewProps = {
  session: Session
  workspace: Workspace
  active: boolean
  headingLevel?: 2 | 3
  // Not on screen at all: its workspace is switched away from, or another tab is in front. See `ChatView` below.
  hidden?: boolean
}

/**
 * `headingLevel` is the level of the chat's own heading: 2 on its own, 3 inside a tile (whose title is the level 2 above it).
 * Under it: a turn, then its messages, then whatever headings the agent wrote.
 *
 * A hidden chat stays mounted (its scroll position, draft and approval panel survive) but stops working: it skips the
 * renders its parent asks for, stops following the log, and its transcript, background tasks and composer sit in a hidden
 * `Activity`, which takes their store subscriptions and timers down until it is shown again. The approval panels stay out
 * of it, because showing an Activity again runs their mount effects, and those move focus.
 */
export const ChatView = memo(ChatViewBody, (prev, next) => (prev.hidden && next.hidden) || shallowSame(prev, next))

function shallowSame(a: ChatViewProps, b: ChatViewProps): boolean {
  const keys = Object.keys(b) as (keyof ChatViewProps)[]
  return keys.length === Object.keys(a).length && keys.every((k) => Object.is(a[k], b[k]))
}

function ChatViewBody({ session, workspace, active, headingLevel = 2, hidden = false }: ChatViewProps) {
  const t = useT()
  const logged = useHeldStore((s) => s.chats[session.id], hidden) ?? EMPTY
  const mode = hidden ? 'hidden' : 'visible'
  // Only the turn running now can still be working; anything an earlier turn left running was stopped with it.
  const everything = useMemo(() => settleStable(logged, session.turnId), [logged, session.turnId])
  // What the agent itself said and did; a subagent's own calls and messages hang under its Task call's row (subtrees).
  const items = useMemo(() => withoutChildren(everything), [everything])
  const lastSubtrees = useRef(new Map<string, Subtree>())
  const subtrees = useMemo(() => (lastSubtrees.current = subtreesOf(everything, lastSubtrees.current)), [everything])
  // This chat's requests, kept as the same array while they are the same ones, so another chat's approval renders nothing
  // here. Not held while hidden: a request that arrives then is already in place (and has had its mount) when shown.
  const lastPending = useRef<ApprovalRequest[]>([])
  const pending = useStore((s) => {
    const mine = s.approvals.filter((a) => a.sessionId === session.id)
    const was = lastPending.current
    if (mine.length === was.length && mine.every((a, i) => a === was[i])) return was
    return (lastPending.current = mine)
  })
  const running = session.status === 'running'
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [query, setQuery] = useState('')
  // Everything worked out from the log is worked out once per change to it, not on each render.
  const asked = useMemo(() => items.some((i) => i.kind === 'user'), [items])
  const hasHistory = asked || Boolean(session.agentSessionId)
  // O1: who answered each turn, in a chat that switched agents.
  const mixed = useMemo(() => isMixed(items), [items])
  const lastAuthors = useRef(new Map<string, TurnAuthor>())
  const authors = useMemo(() => (lastAuthors.current = stableAuthors(turnAuthors(items, { agent: session.agent }), lastAuthors.current)), [items, session.agent])
  // When each turn's message was sent: a reply says which message it answers.
  const askedAt = useMemo(() => {
    const at = new Map<string, string>()
    for (const item of items) if (item.kind === 'user' && !item.steered && !at.has(item.turnId)) at.set(item.turnId, item.at)
    return at
  }, [items])
  const headingId = useId()
  const title = session.title || t('workspaceView.tab.newChat')
  const logHeading = useRef<HTMLHeadingElement>(null)
  const chatRoot = useRef<HTMLDivElement>(null)
  const lastTurns = useRef<(ChatItem | TurnGroup)[]>([])
  const turns = useMemo(() => (lastTurns.current = groupTurns(items, lastTurns.current)), [items])
  const lastByTurn = useRef(new Map<string, ChatItem[]>())
  const byTurn = useMemo(() => (lastByTurn.current = itemsByTurn(items, lastByTurn.current)), [items])
  // Read here once for every row, rather than by each row from the store.
  const strip = useStore((s) => s.snapshot?.settings.notAbsolutelyRight ?? false)
  const expandTools = useStore((s) => s.snapshot?.settings.expandToolCalls ?? false)
  const forkToNewTab = useStore((s) => s.snapshot?.settings.forkToNewTab ?? false)
  const repoId = useStore((s) => s.snapshot?.workspaces.find((w) => w.id === session.workspaceId)?.repoId)
  const roots = useMemo(() => toolRoots({ path: workspace.path, provenance: { sourceRoot: workspace.provenance?.sourceRoot } }), [workspace.path, workspace.provenance?.sourceRoot])
  // What a tool call's path may open: nothing in a cloud workspace (its files are in the sandbox); Foreman's own viewer
  // only for a worktree on this computer.
  const preview = workspaceSurfaces(workspace).local
  const files = useMemo<FileAccess | null>(
    () => (workspace.cloud ? null : { workspaceId: workspace.id, root: workspace.path, preview }),
    [workspace.cloud, workspace.id, workspace.path, preview]
  )
  const readOnly = sessionReadOnly(workspace, session)
  // The person a generated workspace name comes from, introduced in a divider at the top of the chat.
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
  // An answer that finishes while the chat is hidden was not watched finishing: coming back says nothing about it.
  useEffect(() => {
    if (hidden) streamingIds.current = new Set()
  }, [hidden])

  useEffect(() => {
    void loadChat(session.id)
  }, [session.id])

  // Stay at the bottom while new output arrives, unless the user scrolled up. The log growing (a new item, a reply's next
  // throttled render, rows drawn for the first time as they scroll near) is heard by a ResizeObserver, after the browser's
  // own layout: following costs no layout of its own, however many chats are on screen. What changes the room the log has
  // rather than its content follows here.
  const following = useRef({ query })
  following.current.query = query
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current && !query) el.scrollTop = el.scrollHeight
  }, [pending.length, running, active, query])
  // A ref callback, since the transcript's Activity detaches it while hidden and attaches it again when shown.
  const observeLog = useCallback((inner: HTMLDivElement | null) => {
    // Not `scroller`: on the first mount its ref is attached after this one.
    const el = inner?.closest<HTMLElement>('.chat-scroll')
    if (!inner || !el || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (pinned.current && !following.current.query && el.clientHeight > 0) el.scrollTop = el.scrollHeight
    })
    observer.observe(inner)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  // Where the reader had scrolled to, put back when the chat is shown again: a log hidden with display: none can come back
  // at the top. Scroll events while it has no height (being hidden) say nothing about where the reader was.
  const scrolledTo = useRef<number | null>(null)
  const onScroll = () => {
    const el = scroller.current
    if (!el || el.clientHeight === 0) return
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    scrolledTo.current = el.scrollTop
  }
  useLayoutEffect(() => {
    const el = scroller.current
    if (!el || hidden || pinned.current || scrolledTo.current === null) return
    el.scrollTop = scrolledTo.current
  }, [hidden])

  const lastUser = items.findLast((i) => i.kind === 'user')
  const last = items.at(-1)?.kind
  const finished = last === 'result' || last === 'turn-end'
  const lastTurnEnd = items.findLast((i) => i.kind === 'turn-end')
  // Subagents with a request waiting on the person: their rows say so.
  const waiting = useMemo(() => {
    const ids = pending.flatMap((a) => ((a.kind === 'tool' || a.kind === 'question') && a.subagent ? [a.subagent.id] : []))
    return ids.length ? new Set(ids) : NO_TASKS
  }, [pending])
  // A plan waiting for review: what is typed in the message box is feedback on it (its card docks above the box).
  const plan = pending.find((a): a is Extract<ApprovalRequest, { kind: 'plan' }> => a.kind === 'plan')
  // The running turn's background work, the finished tasks with it while any still runs; none once it all has ended.
  const background = useMemo(() => {
    const mine = items.filter((i): i is ToolItem => i.kind === 'tool' && Boolean(i.task?.background) && i.turnId === session.turnId)
    return mine.some((i) => i.task!.status === 'running') ? mine : NO_TOOLS
  }, [items, session.turnId])
  const answered = useMemo(() => background.length > 0 && items.some((i) => i.kind === 'result' && i.turnId === session.turnId), [background, items, session.turnId])
  // Stop on a subagent: only for an agent whose record says it can (docs/agents.md 6), as on its row in the log.
  const caps = useCapabilities(session.agent)
  const canStopChild = caps?.subagents.stop.level !== undefined && caps.subagents.stop.level !== 'none'
  const stopChild = useMemo<StopChild | undefined>(
    () => (canStopChild ? (childId) => attempt(async () => (await api.stopChild(session.id, childId), true)) : undefined),
    [canStopChild, session.id]
  )
  // Continue (on the latest answer's menu): only once the chat is idle, so it isn't worked out while a turn streams.
  const continuation = useMemo(() => {
    if (!lastTurnEnd || running || readOnly) return null
    const eligibility = continueEligibility(session, items)
    return eligibility.ok ? { suggested: continueFollowUp(items, eligibility.turnId) } : null
  }, [lastTurnEnd, running, readOnly, session, items])

  // From search: scroll to the message once its chat is loaded, and flash it.
  const jump = useStore((s) => (s.chatJump?.sessionId === session.id ? s.chatJump : null))
  useEffect(() => {
    // A hidden chat can't scroll; the jump waits until it is shown.
    if (!jump || hidden) return
    const el = scroller.current?.querySelector(`[data-chat-item="${CSS.escape(jump.itemId)}"]`)
    if (!el) return
    pinned.current = false
    el.scrollIntoView({ block: 'center' })
    // ui/flash: the same neutral wash as a setting reached from search.
    if (el instanceof HTMLElement) flash(el, { duration: 1800 })
    clearChatJump(jump.nonce)
  }, [jump, items, hidden])

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
          // The decision docked above the message box (an approval, a question, the plan, an employee's): F6 moves focus
          // to it, and Ctrl+L goes back to the message.
          const card = chatRoot.current?.querySelector<HTMLElement>('.decision-dock [data-decision]')
          if (card) card.focus()
          else say(t('narration.needs.lead', { count: 0 }))
        } else if (command === 'chat-needs-none') say(t('narration.needs.lead', { count: 0 }))
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [active, workspace.id, t]
  )

  // Each row is a memo'd ChatRow, and gets only what it reads: a new item, the next chunk of a reply or a keystroke in
  // search renders the rows it changes, not the whole log. Props a kind of row doesn't read are left out for it.
  const row = (item: ChatItem) => {
    const kind = item.kind
    const turnId = turnOf(item)
    const author = turnId ? authors.get(turnId) : undefined
    const latest = item === lastTurnEnd
    const signIn = kind === 'notice' && item.action === 'sign-in' && !item.gap && !item.report && !item.switched && !item.divider
    return (
      <div key={item.id} data-chat-item={item.id}>
        {/* #17: an auto review's findings, as review threads, above its result line. */}
        {kind === 'turn-end' && session.autoReview && <AutoReviewFindings workspace={workspace} session={session} turnId={item.turnId} />}
        <ChatRow
          item={item}
          sessionId={session.id}
          workspaceId={workspace.id}
          tabAgent={session.agent}
          agent={author?.agent ?? session.agent}
          autoReview={Boolean(session.autoReview)}
          readOnly={readOnly}
          level={headingLevel + 2}
          workspacePath={roots}
          files={kind === 'tool' || kind === 'turn-end' ? files : undefined}
          subtree={kind === 'tool' ? subtrees.get(item.id) : undefined}
          waiting={kind === 'tool' && item.childId ? waiting : undefined}
          strip={strip}
          expandTools={expandTools}
          running={kind === 'user' || kind === 'turn-end' || signIn ? running : undefined}
          query={kind === 'tool' || kind === 'thinking' ? query : undefined}
          askedAt={kind === 'assistant' && turnId ? askedAt.get(turnId) : undefined}
          turnItems={(kind === 'turn-end' || kind === 'result') && turnId ? byTurn.get(turnId) : undefined}
          session={kind === 'turn-end' || signIn ? session : undefined}
          items={signIn ? items : undefined}
          isLatestEnd={latest}
          continuation={latest ? continuation : null}
          workspaceName={kind === 'turn-end' ? workspace.name : undefined}
          employeeRun={kind === 'turn-end' && workspace.startedBy?.via === 'employee'}
          by={kind === 'turn-end' && mixed ? author : undefined}
          repoId={repoId}
          forkToNewTab={forkToNewTab}
        />
        {kind === 'user' && session.autoReview && <AutoReviewReceipt workspace={workspace} session={session} item={item} />}
        {kind === 'turn-end' &&
          (workspace.alerts ?? [])
            .filter((a) => a.sessionId === session.id && a.turnId === item.turnId)
            .map((a) => <SensitiveCard key={a.id} alert={a} workspaceId={workspace.id} />)}
      </div>
    )
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
        <Activity mode={mode}>
          <div className="chat-inner" ref={observeLog}>
            {namesake && (
              // The workspace's namesake, as a divider at the top of the chat: it stays above the first message and scrolls away with it.
              <p className="chat-namesake faint small">
                <span>
                  {t.rich('chat.greeting.namesake', {
                    name: (
                      <LinkButton key="name" underline title={t('chat.greeting.namesakeSource', { name: namesake.fullName })} onClick={() => void attempt(() => api.openExternal(namesake.source))}>
                        {namesake.fullName}
                      </LinkButton>
                    ),
                    contribution: namesake.contribution
                  })}
                </span>
              </p>
            )}
            {items.length === 0 && (
              <div className="chat-greeting">
                <p>
                  {workspace.branch
                    ? t.rich('chat.greeting.copy', { name: <strong key="name">{workspace.name}</strong>, branch: <code key="branch">{workspace.branch}</code>, base: <code key="base">{workspace.baseBranch}</code> })
                    : t.rich('chat.greeting.plain', { name: <strong key="name">{workspace.name}</strong> })}
                </p>
                <p className="muted">{t('chat.greeting.ask', { agent: AGENTS[session.agent].label })}</p>
              </div>
            )}
            {turns.map((entry) =>
              isTurn(entry) ? (
                <TurnArticle key={entry.user.id} turn={entry} agent={authors.get(entry.turnId)?.agent ?? session.agent} live={entry === lastTurn && running} level={headingLevel + 1}>
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
            {/* While background work runs, its block above the composer keeps the turn's time. */}
            {running && !finished && pending.length === 0 && background.length === 0 && lastUser?.kind === 'user' && <LiveTimer since={lastUser.at} />}
          </div>
        </Activity>
      </div>
      <Activity mode={mode}>
        {background.length > 0 && (
          <BackgroundTasks
            tasks={background}
            answered={answered}
            since={lastUser?.kind === 'user' ? lastUser.at : undefined}
            workspacePath={roots}
            subtrees={subtrees}
            onStopChild={stopChild}
            waiting={waiting}
            onJump={jumpTo}
          />
        )}
      </Activity>
      {workspace.state === 'archived' ? (
        // Read-only (#13): the composer becomes a banner, and Restore is its own step.
        <div className="composer">
          <ArchivedBanner workspace={workspace} session={session} />
        </div>
      ) : (
        <>
          {/* What waits for the person docks above the message box, which stays mounted with its draft, attachments and
              queue. Outside the Activity, so a request that arrives while the chat is hidden is in place when it's shown. */}
          <NeedsYouDock
            requests={pending}
            workspace={workspace}
            active={active}
            headingLevel={headingLevel + 2}
            fallback={workspace.startedBy?.via === 'employee' ? <EmployeeRunDecision ws={workspace} active={active} /> : undefined}
          />
          <Activity mode={mode}>
            {!hasHistory && session.queue.length === 0 && hasNote(workspace.note) && (
              <Checkbox className="include-note" checked={Boolean(session.includeNote)} onChange={(e) => void attempt(() => api.updateSession(session.id, { includeNote: e.target.checked }))}>
                <span className="include-note-text">{t.rich('chat.includeNote', { revision: <Tag key="r">r{workspace.note.revision}</Tag> })}</span>
              </Checkbox>
            )}
            <Composer session={session} workspace={workspace} active={active} hasHistory={hasHistory} pendingPlan={plan} />
          </Activity>
        </>
      )}
    </div>
  )
}

/** An AI employee's run's task, sent by Foreman: whose it is (docs/ai-employees.md §6.3). */
function EmployeeReceipt({ origin }: { origin: Extract<NonNullable<Extract<ChatItem, { kind: 'user' }>['origin']>, { kind: 'employee' }> }) {
  const t = useT()
  const name = useStore((s) => s.snapshot?.employees?.[origin.orgId]?.employees.find((e) => e.id === origin.employeeId)?.name) || origin.employeeId
  return <div className="note-tag faint small">{t('chat.receipt.employee', { name })}</div>
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
            // A run's pinned memory is a part per file, so the kind alone doesn't tell them apart.
            <div key={`${p.kind}:${p.label}`}>
              <b>{p.kind === 'memory' ? p.label : p.label[0].toUpperCase() + p.label.slice(1)}</b> · {p.source} ({partSize(p, t, t.locale)}){p.detail && <span className="faint"> · {p.detail}</span>}
            </div>
          ))}
          <div className="faint">{t('chat.receipt.disclaimer')}</div>
        </div>
      )}
    </div>
  )
}

/**
 * How long the running turn has taken, in whole seconds (as its result line will say it), so it renders once a second. It
 * is inside the transcript's Activity: in a hidden chat the interval is cleared, and it catches up when shown.
 */
function LiveTimer({ since }: { since: string }) {
  return (
    <div className="live-timer">
      <Spinner size={14} />
      <TurnClock since={since} />
    </div>
  )
}

function TurnClock({ since }: { since: string }) {
  const now = useClock(1000)
  const elapsed = Math.max(0, now - new Date(since).getTime())
  return <span className="mono">{formatDuration(Math.floor(elapsed / 1000) * 1000)}</span>
}

// How a finished background task ended: its mark's shape (never colour alone) and word.
const TASK_ENDED = {
  completed: { tone: 'ok', label: 'toolRow.child.done' },
  failed: { tone: 'error', label: 'toolRow.child.failed' },
  stopped: { tone: 'off', label: 'toolRow.child.stopped' }
} as const

/**
 * The running turn's background work, in one block above the composer: how many tasks it waits on and how long the
 * turn has run (in place of the log's own timer), then a row per subagent or shell, the finished ones ticked until the
 * last ends. A row shows what its task is doing now, jumps to its call in the log, and has the call's Stop; a subagent's
 * row opens to its latest steps.
 */
function BackgroundTasks({ tasks, answered, since, workspacePath, subtrees, onStopChild, waiting, onJump }: {
  tasks: ToolItem[]
  // The turn has given its answer: it is waiting on this work, not working beside it.
  answered: boolean
  since?: string
  workspacePath: Root
  subtrees: ReadonlyMap<string, Subtree>
  onStopChild?: StopChild
  waiting: ReadonlySet<string>
  onJump: (id: string) => void
}) {
  const t = useT()
  const running = tasks.filter((i) => i.task!.status === 'running').length
  const heading = t(answered ? 'chat.background.waitingOn' : 'chat.background.running', { count: running })
  return (
    <div className="bg-tasks">
      <Card as="section" className="bg-tasks-box" aria-label={t('chat.background.head')}>
        <div className="bg-tasks-head">
          <Spinner size={14} />
          <span className="bg-tasks-title">{heading}</span>
          {tasks.length > running && <span className="faint small">{t('chat.background.done', { done: tasks.length - running, total: tasks.length })}</span>}
          {since && <span className="bg-tasks-clock faint small"><TurnClock since={since} /></span>}
        </div>
        <ul className="bg-tasks-list">
          {tasks.map((item) => (
            <BackgroundTask key={item.id} item={item} workspacePath={workspacePath} subtree={subtrees.get(item.id)} onStopChild={onStopChild} waiting={waiting} onJump={onJump} />
          ))}
        </ul>
      </Card>
    </div>
  )
}

function BackgroundTask({ item, workspacePath, subtree, onStopChild, waiting, onJump }: { item: ToolItem; workspacePath: Root; subtree?: Subtree; onStopChild?: StopChild; waiting: ReadonlySet<string>; onJump: (id: string) => void }) {
  const t = useT()
  const task = item.task!
  const live = task.status === 'running'
  const ended = live ? null : TASK_ENDED[task.status as keyof typeof TASK_ENDED]
  const label = describe(item, workspacePath, t).label
  // Running: what it is doing now. Finished: the first line of how it ended.
  const activity = live ? taskActivity(task, t) : task.summary?.split(/\r?\n/).find((l) => l.trim())?.trim()
  const asking = item.childId !== undefined && waiting.has(item.childId)
  const stoppable = live && item.childId !== undefined && onStopChild !== undefined
  return (
    <li className="bg-task">
      <div className="tool-line tool-line-stop">
        <Pressable className="tool-row" title={t('chat.background.show')} onClick={() => onJump(item.id)}>
          <span className="tool-icon">{ended ? <Status compact tone={ended.tone} label={t(ended.label)} /> : <Spinner size={14} />}</span>
          <span className="tool-label">{label}</span>
          <TaskMeta task={task} inStrip />
        </Pressable>
        {asking && <Tag tone="warn">{t('toolRow.child.waiting')}</Tag>}
        {stoppable && <StopSubagent childId={item.childId!} name={label} onStop={onStopChild!} />}
      </div>
      {activity && <div className="task-activity">{activity}</div>}
      {subtree?.get(item.id)?.length ? (
        <Disclosure quiet className="bg-task-steps" label={t('chat.background.steps')}>
          <SubagentSteps rootId={item.id} subtree={subtree} workspacePath={workspacePath} />
        </Disclosure>
      ) : null}
    </li>
  )
}

type RowProps = {
  item: ChatItem
  sessionId: string
  workspaceId: string
  // The tab's agent, and (O1) the one that answered this item's turn.
  tabAgent: AgentKind
  agent: AgentKind
  autoReview: boolean
  readOnly: boolean
  // The heading level of a message in this row; what an agent writes inside it starts one level below.
  level: number
  workspacePath: Root
  // Only for tool rows: what their paths may open.
  files?: FileAccess | null
  // Only for a Task call: its subagent's own items, and the subagents with a request waiting for the person.
  subtree?: Subtree
  waiting?: ReadonlySet<string>
  strip: boolean
  expandTools: boolean
  repoId?: string
  forkToNewTab: boolean
  // Each of the rest only for the kinds of row that read it (undefined for the others, so they stay equal).
  running?: boolean
  query?: string
  // When the message this turn answers was sent.
  askedAt?: string
  // This item's turn: everything in the log with its turn id.
  turnItems?: ChatItem[]
  session?: Session
  items?: ChatItem[]
  isLatestEnd: boolean
  continuation: Continuation | null
  // Only for a turn's end: the workspace's name (a failed turn's card says its changes are still there), and whether an AI
  // employee's run made it (Retry is then the run banner's, docs/ai-employees.md §10).
  workspaceName?: string
  employeeRun?: boolean
  // O1: in a chat that switched agents, who wrote this answer.
  by?: TurnAuthor
}

type Continuation = { suggested: ReturnType<typeof continueFollowUp> }

/** One item of the log. Memo'd: a finished row isn't drawn again when the running turn adds to the log. */
const ChatRow = memo(function ChatRow({
  item,
  sessionId,
  workspaceId,
  tabAgent,
  agent,
  autoReview,
  readOnly,
  level,
  workspacePath,
  files,
  subtree,
  waiting,
  strip,
  expandTools,
  repoId,
  forkToNewTab,
  running = false,
  query = '',
  askedAt,
  turnItems = EMPTY,
  session,
  items = EMPTY,
  isLatestEnd,
  continuation,
  workspaceName,
  employeeRun = false,
  by
}: RowProps) {
  const t = useT()
  const headingId = useId()
  const caps = useCapabilities(agent)
  const restores = caps?.checkpointing.restoreFiles === true
  // Restore's confirmation says what happens to the agent's own conversation: rolled back, or (an agent that can't) started afresh.
  const rollback = caps?.checkpointing.conversationRollback
  const freshRestore = rollback ? isFallback(rollback, 'checkpoint-fresh-session') : false
  const [confirmRestore, setConfirmRestore] = useState(false)
  // Stop on a subagent: only for an agent whose record says it can (docs/agents.md 6).
  const canStopChild = caps?.subagents.stop.level !== undefined && caps.subagents.stop.level !== 'none'
  const stopChild = useMemo<StopChild | undefined>(
    () => (canStopChild ? (childId) => attempt(async () => (await api.stopChild(sessionId, childId), true)) : undefined),
    [canStopChild, sessionId]
  )
  switch (item.kind) {
    case 'user':
      // Foreman compacted this chat while it sat idle: the "Compacted while idle" row says so, not a message the person never wrote.
      if (item.origin?.kind === 'idle-compact') return null
      return (
        <div className="user-row">
          {/* #22: agents that can't rewind (Chat agents over ACP) get no Restore. O1: the agent the message went to decides. */}
          {item.checkpoint && !item.steered && !readOnly && restores && (
            <span className="restore-wrap">
              <Button
                size="sm"
                icon={<RotateCcw size={12} />}
                title={t(freshRestore ? 'chat.restore.titleFresh' : 'chat.restore.title')}
                disabled={running}
                onClick={() => setConfirmRestore(true)}
              >
                {t('chat.restore.label')}
              </Button>
              {confirmRestore && (
                <Dialog
                  title={t('chat.restore.dialogTitle')}
                  onClose={() => setConfirmRestore(false)}
                  footer={
                    <>
                      <Button onClick={() => setConfirmRestore(false)}>{t('common.cancel')}</Button>
                      <Button
                        variant="primary"
                        autoFocus
                        onClick={() => {
                          setConfirmRestore(false)
                          void attempt(() => api.restoreCheckpoint(sessionId, item.turnId))
                        }}
                      >
                        {t('chat.restore.label')}
                      </Button>
                    </>
                  }
                >
                  <p>{t(freshRestore ? 'chat.restore.confirmFresh' : rollback?.level === 'none' ? 'chat.restore.confirmFiles' : 'chat.restore.confirm')}</p>
                </Dialog>
              )}
            </span>
          )}
          {!readOnly && <UserMenu item={item} sessionId={sessionId} workspaceId={workspaceId} running={running} />}
          <article className="user-msg" aria-labelledby={headingId}>
            <Hidden level={level} id={headingId}>
              {t('chat.message.youAt', { time: formatClock(item.at, t.locale) })}
            </Hidden>
            {item.steered && <div className="steered faint small">{t('chat.steered')}</div>}
            {item.editRaced && <RacedEditTag />}
            <UserMessageText text={item.text} />
            {item.noteRevision !== undefined && <div className="note-tag faint small">{t('chat.noteTag', { revision: item.noteRevision })}</div>}
            {item.readOnly && <ReadOnlyReceipt how={item.readOnly} />}
            {item.origin?.kind === 'outside' && <div className="note-tag faint small">{t('chat.receipt.outside', { name: item.origin.name })}</div>}
            {item.origin?.kind === 'employee' && <EmployeeReceipt origin={item.origin} />}
            {item.attachments && item.attachments.length > 0 && (
              <div className="attachment-row">
                {item.attachments.map((a) => (
                  <AttachmentChip key={a.path} attachment={a} />
                ))}
              </div>
            )}
          </article>
          {item.origin?.kind === 'auto-fix' && <AutoFixReceipt origin={item.origin} />}
          {item.added && item.added.length > 0 && <ContextReceipt parts={item.added} />}
        </div>
      )
    case 'assistant':
      // #17: a reviewer's findings block shows as cards instead of JSON.
      return (
        <AssistantMessage
          text={autoReview && !item.streaming ? withoutFindingsBlock(item.text) : item.text}
          streaming={item.streaming}
          workspaceId={workspaceId}
          who={AGENTS[agent]?.label ?? tabAgent}
          askedAt={askedAt}
          level={level}
          strip={strip}
        />
      )
    case 'thinking':
      return <Thinking text={item.text} streaming={item.streaming} forceOpen={Boolean(query) && textMatches(item.text, query).length > 0} />
    case 'tool':
      // #2: a call that only made a report is folded into the report's own line.
      if (isReportCall(item)) return null
      // The call written out for search only while there is a query.
      return <ToolRow item={item} workspacePath={workspacePath} files={files} expandByDefault={expandTools} forceOpen={Boolean(query) && textMatches(toolSearchText(item), query).length > 0} subtree={subtree} onStopChild={stopChild} waiting={waiting} />
    case 'notice':
      // O10: where Foreman was closed while this turn kept running in the background.
      if (item.gap) return <ClosedGapLine gap={item.gap} />
      // #2: what the agent reported ("agent says: checkpoint — …"); an open needs-input is a card.
      if (item.report) return <ReportRow marker={item.report} turnId={item.turnId} sessionId={sessionId} workspaceId={workspaceId} readOnly={readOnly} />
      // O1: where the chat switched agents, and what the new one was given.
      if (item.switched) return <SwitchDivider switched={item.switched} />
      // #130: where the tab moved to another account that starts a new conversation, and what it was given.
      if (item.handOff) return <MoveDivider text={item.text} handOff={item.handOff} />
      // O1 (G1): where the conversation was compacted, or moved to another model of the same agent.
      if (item.divider) return <ChatDividerLine divider={item.divider} />
      // The turn failed on sign-in: once the agent is signed in, this card says so and offers Retry.
      if (item.action === 'sign-in' && session) return <SignInNotice item={item} items={items} session={session} running={running} readOnly={readOnly}>{item.text}</SignInNotice>
      return (
        <Callout
          tone={item.level === 'error' ? 'error' : 'neutral'}
          className="chat-notice"
          actions={
            item.action && (
              <Button size="sm" icon={<Settings size={12} />} onClick={() => openSettingsPage({ section: 'agents', agent: tabAgent })}>
                {/* "update": the agent's page has its Update button next to its version. */}
                {item.action === 'update' ? t('agentVersion.update') : t('chat.notice.openSettings')}
              </Button>
            )
          }
        >
          {item.text}
        </Callout>
      )
    case 'turn-end':
      if (!session) return null
      return (
        <TurnEnd
          item={item}
          turnItems={turnItems}
          session={session}
          agent={agent}
          running={running}
          isLatestEnd={isLatestEnd}
          continuation={continuation}
          files={files ?? null}
          workspaceName={workspaceName}
          employeeRun={employeeRun}
          restore={item.turnId && restores && !readOnly ? (freshRestore ? 'chat.restore.confirmFresh' : rollback?.level === 'none' ? 'chat.restore.confirmFiles' : 'chat.restore.confirm') : null}
          readOnly={readOnly}
          by={by}
          repoId={repoId}
          forkToNewTab={forkToNewTab}
        />
      )
    case 'result':
      // Superseded by the turn's result line, which carries the cost.
      if (turnItems.some((i) => i.kind === 'turn-end' && i.turnId === item.turnId)) return null
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
})

/** How a turn ended, as the receipt's Status: a shape and a word. A turn that ended by asking you waits for you. */
const OUTCOME: Record<TurnOutcome, { tone: StatusTone; label: PlainKey }> = {
  completed: { tone: 'ok', label: 'chat.outcome.completed' },
  error: { tone: 'error', label: 'chat.outcome.error' },
  cancelled: { tone: 'off', label: 'chat.outcome.cancelled' },
  interrupted: { tone: 'error', label: 'chat.outcome.interrupted' }
}

// The commands a receipt lists; earlier ones are counted.
const RECEIPT_COMMANDS = 6
// The lines of a failed command's output the recovery card shows.
const OUTPUT_LINES = 8

/** "+12 −3": lines added and removed, a zero left out, with a real minus sign. */
function LineDelta({ additions, deletions }: { additions: number; deletions: number }) {
  const t = useT()
  if (!additions && !deletions) return null
  return (
    <span className="mono turn-delta">
      {additions > 0 && <span className="add">+{formatNumber(additions, t.locale)}</span>}
      {additions > 0 && deletions > 0 && ' '}
      {deletions > 0 && <span className="del">−{formatNumber(deletions, t.locale)}</span>}
    </span>
  )
}

/** A file this turn changed: a path that opens it (where the files are on this computer), then its lines. */
function ChangedFile({ file, files }: { file: TurnDelta['files'][number]; files: FileAccess | null }) {
  const path = files ? fullPath(file.path, files.root) : null
  return (
    <span className="turn-receipt-file">
      {path && files ? <OpenFileChip path={path} label={file.path} access={files} /> : <span className="file-chip mono">{file.path}</span>}
      <LineDelta additions={file.additions} deletions={file.deletions} />
    </span>
  )
}

const firstLineOf = (text: string) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''
const commandOf = (item: ToolItem) => firstLineOf(String((item.input as { command?: unknown } | undefined)?.command ?? ''))

/** A failed turn's cause, as its card's title: the error's first line, without "The agent stopped:" or a closing full stop. */
function causeOf(error: string | undefined): { title: string; rest: string } | null {
  const text = (error ?? '').trim().replace(/^The agent stopped:\s*/i, '')
  if (!text) return null
  const [first, ...rest] = text.split(/\r?\n/)
  return { title: first.trim().replace(/[.。]$/, ''), rest: rest.join('\n').trim() }
}

/**
 * The receipt that closes a turn: how it ended, how long it took and what it cost, then what this turn did (its files and
 * commands) as one fact, folded to one line on every turn. Opened, it has a chip per file (which opens it) and per command
 * (which shows its row). Only this turn's own changes: a turn without both checkpoints names none.
 */
function TurnReceipt({
  outcome,
  numbers,
  by,
  delta,
  commands,
  files,
  menu
}: {
  outcome: { tone: StatusTone; label: string }
  numbers: string
  by?: TurnAuthor
  delta?: TurnDelta
  commands: ToolItem[]
  files: FileAccess | null
  menu: ReactNode
}) {
  const t = useT()
  const card = useRef<HTMLDivElement>(null)
  const changed = delta?.files ?? []
  const failed = commands.filter((c) => toolResult(c)?.tone === 'error').length
  const facts: ReactNode[] = []
  if (changed.length) {
    facts.push(
      <span key="files" className="turn-receipt-fact">
        {t('chat.receipt.files', { count: changed.length })} <LineDelta additions={delta!.additions} deletions={delta!.deletions} />
      </span>
    )
  }
  if (commands.length) {
    const ran = t('chat.receipt.commands', { count: commands.length })
    facts.push(
      <span key="commands" className="turn-receipt-fact">
        {failed ? t('narration.join', { a: ran, b: t('chat.receipt.failed', { count: failed }) }) : ran}
      </span>
    )
  }
  // The command's row: scrolled to, flashed and focused, so the keyboard lands where the eye does.
  const show = (id: string) => {
    const row = card.current?.closest('.chat-scroll')?.querySelector<HTMLElement>(`[data-tool="${CSS.escape(id)}"]`)
    if (!row) return
    row.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' })
    flash(row, { duration: 1800 })
    row.querySelector<HTMLElement>('.tool-row')?.focus({ preventScroll: true })
  }
  const shown = commands.slice(-RECEIPT_COMMANDS)
  return (
    <Card size="sm" className="turn-receipt" ref={card}>
      <div className="turn-receipt-line">
        <Status tone={outcome.tone} label={outcome.label} />
        {(numbers || by) && (
          <span className="mono turn-receipt-numbers">
            {numbers}
            {by && (
              <span className="turn-by">
                {numbers ? ' · ' : ''}
                {by.model ? modelInfo(by.agent, by.model).label : AGENTS[by.agent]?.label ?? by.agent}
              </span>
            )}
          </span>
        )}
        {facts.length > 0 && (
          <Disclosure quiet className="turn-receipt-fold" label={facts.flatMap((fact, n) => (n ? [<span key={`dot${n}`}> · </span>, fact] : [fact]))}>
            <div className="turn-receipt-facts">
              {changed.length > 0 && (
                <div className="turn-receipt-group">
                  <span className="faint small">{t('chat.receipt.changed')}</span>
                  {changed.map((file) => (
                    <ChangedFile key={file.path} file={file} files={files} />
                  ))}
                </div>
              )}
              {commands.length > 0 && (
                <div className="turn-receipt-group">
                  <span className="faint small">{t('chat.receipt.ran')}</span>
                  {commands.length > shown.length && <span className="faint small">{t('chat.receipt.earlier', { count: commands.length - shown.length })}</span>}
                  {shown.map((command) => {
                    const result = toolResult(command)
                    return (
                      <ChipButton key={command.id} className="turn-receipt-command" title={t('chat.receipt.showCommand')} onClick={() => show(command.id)}>
                        <code className="turn-receipt-code">{commandOf(command)}</code>
                        {result && <ResultWord result={result} />}
                      </ChipButton>
                    )
                  })}
                </div>
              )}
            </div>
          </Disclosure>
        )}
        {menu}
      </div>
    </Card>
  )
}

/** How a turn ended: its receipt, plus a recovery card that leads with the cause when it failed or was cut off. */
function TurnEnd({
  item,
  turnItems,
  session,
  agent,
  running,
  isLatestEnd,
  continuation,
  files,
  workspaceName,
  employeeRun,
  restore,
  readOnly,
  by,
  repoId,
  forkToNewTab
}: {
  item: Extract<ChatItem, { kind: 'turn-end' }>
  // Everything in the log from this turn.
  turnItems: ChatItem[]
  session: Session
  // The agent that answered this turn.
  agent: AgentKind
  running: boolean
  isLatestEnd: boolean
  // On the latest answer of an idle chat that can be continued (see `continueEligibility`), else null.
  continuation: Continuation | null
  // What the turn's paths may open (null: a cloud workspace's files are in its sandbox).
  files: FileAccess | null
  workspaceName?: string
  // An AI employee's run made the workspace: Retry is the run banner's (a fresh run), never the chat's.
  employeeRun: boolean
  // The agent can put the files back to before the message: what Restore's confirmation says. Null when it can't.
  restore: PlainKey | null
  // The tab can't send (history only), so no recovery actions.
  readOnly?: boolean
  // O1: in a chat that switched agents, who wrote this answer.
  by?: TurnAuthor
  repoId?: string
  forkToNewTab: boolean
}) {
  const t = useT()
  const [confirm, setConfirm] = useState<'retry' | 'only' | null>(null)
  const [outputOpen, setOutputOpen] = useState(false)
  // Docs/agents.md 7.2: the latest turn of a chat paused at a usage limit isn't a failure: it has its own card.
  const paused = Boolean(item.limit) && session.lastTurn?.turnId === item.turnId && session.lastTurn.outcome === 'limit'
  const failed = (item.outcome === 'error' || item.outcome === 'interrupted') && !paused
  const cost = turnItems.find((i): i is Extract<ChatItem, { kind: 'result' }> => i.kind === 'result' && i.turnId === item.turnId)?.costUsd
  const tools = turnItems.filter((i): i is ToolItem => i.kind === 'tool' && i.turnId === item.turnId)
  const commands = tools.filter((i) => i.name === 'Bash' && i.status !== 'running')
  // An employee's run that asked the person, or had an outward action held for them, ended waiting for you.
  const waiting = item.outcome === 'completed' && tools.some((i) => toolResult(i)?.tone === 'warn')
  const outcome = paused
    ? { tone: 'off' as const, label: t('usageLimit.paused.outcome') }
    : item.restartedBy
      ? { tone: 'off' as const, label: t('chat.outcome.restarted') }
      : waiting
        ? { tone: 'warn' as const, label: t('chat.outcome.waiting') }
        : { tone: OUTCOME[item.outcome].tone, label: t(OUTCOME[item.outcome].label) }
  const numbers = [item.durationMs !== undefined && formatDuration(item.durationMs), cost !== undefined && cost > 0 && `$${cost.toFixed(2)}`].filter(Boolean).join(' · ')
  const message = turnItems.find((i): i is Extract<ChatItem, { kind: 'user' }> => i.kind === 'user' && i.turnId === item.turnId && !i.steered)
  // On the latest answer only, and only once the chat is idle, queue empty and the turn completed.
  const suggested = continuation?.suggested ?? null
  const forkable = forkToNewTab && !readOnly && Boolean(message)
  // Chips only on the latest completed answer of an idle chat; once it moves on they are gone from view.
  const chips = item.outcome === 'completed' && isLatestEnd && !running && !readOnly && !session.queue.length ? item.suggestions ?? [] : []
  const canAct = isLatestEnd && !running && !readOnly
  const who = AGENTS[agent]?.label ?? agent

  // The failure, cause first: the call that failed last (a command, by preference), and what the turn left behind.
  const cause = causeOf(item.error)
  const failing = failed ? (tools.findLast((i) => i.status === 'error' && i.name === 'Bash') ?? tools.findLast((i) => i.status === 'error')) : undefined
  const failingCommand = failing?.name === 'Bash' ? commandOf(failing) : ''
  const output = failing?.output?.trimEnd() ? failing.output.trimEnd().split('\n').slice(-OUTPUT_LINES).join('\n') : ''
  const title = cause?.title ?? (item.outcome === 'interrupted' ? t('chat.recovery.interrupted') : t('chat.recovery.error'))
  const stopped =
    failed && item.outcome === 'error' && item.durationMs !== undefined
      ? failing
        ? t('chat.recovery.stoppedAt', { agent: who, step: describe(failing, '', t).label, time: formatDuration(item.durationMs) })
        : t('chat.recovery.stoppedAfter', { agent: who, time: formatDuration(item.durationMs) })
      : ''
  const send = (text: string) => api.sendMessage(session.id, text, { attachments: message?.attachments, templateId: message?.followUp?.templateId })
  const retry = () => message && attempt(() => send(message.text))
  const restoreThen = (resend: boolean) =>
    message &&
    attempt(async () => {
      await api.restoreCheckpoint(session.id, message.turnId)
      if (resend) await send(message.text)
    })
  // Ask to fix it: the composer gets the request and nothing is sent, as with the Suggested chips.
  const plainCause = title.replace(/[.。]$/, '')
  const fixText = failingCommand ? t('chat.recovery.fixPrompt', { cause: plainCause, command: failingCommand }) : t('chat.recovery.fixPromptNoCommand', { cause: plainCause })
  const canRestore = Boolean(message?.checkpoint) && restore !== null && !employeeRun

  return (
    <>
      <TurnReceipt
        outcome={outcome}
        numbers={numbers}
        by={by}
        delta={item.delta}
        commands={commands}
        files={files}
        menu={
          <AnswerMenu
            sessionId={session.id}
            workspaceId={session.workspaceId}
            turnId={item.turnId}
            canFork={forkable}
            repoId={repoId}
            answer={turnAnswer(turnItems, item.turnId)}
            continueLabel={continuation ? (suggested ? t('chat.continue.to', { title: suggested.title }) : t('chat.continue.another')) : undefined}
            continueTitle={suggested ? t('chat.continue.toTitle') : t('chat.continue.anotherTitle')}
          />
        }
      />
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
      {paused && <PausedCard item={item} session={session} canAct={isLatestEnd && !running && !readOnly} />}
      {failed && (
        <Callout
          tone="error"
          className="turn-recovery"
          title={title}
          actions={
            canAct && (
              <>
                {message &&
                  !employeeRun &&
                  (canRestore ? (
                    <SplitButton
                      variant="primary"
                      size="sm"
                      label={
                        <>
                          <RotateCcw size={12} aria-hidden /> {t('common.retry')}
                        </>
                      }
                      title={t('chat.recovery.retryTitle')}
                      menuLabel={t('chat.recovery.retryMenu')}
                      onClick={() => void retry()}
                    >
                      <MenuItem icon={<History size={12} />} description={t('chat.recovery.restoreRetryHint')} onSelect={() => setConfirm('retry')}>
                        {t('chat.recovery.restoreRetry')}
                      </MenuItem>
                      <MenuItem icon={<Undo2 size={12} />} description={t('chat.recovery.restoreOnlyHint')} onSelect={() => setConfirm('only')}>
                        {t('chat.recovery.restoreOnly')}
                      </MenuItem>
                    </SplitButton>
                  ) : (
                    <Button size="sm" variant="primary" icon={<RotateCcw size={12} />} title={t('chat.recovery.retryTitle')} onClick={() => void retry()}>
                      {t('common.retry')}
                    </Button>
                  ))}
                <Button
                  size="sm"
                  icon={<MessageSquare size={12} />}
                  title={t(employeeRun ? 'chat.recovery.askFixYoursTitle' : 'chat.recovery.askFixTitle', { agent: who })}
                  onClick={() => fillComposer(session.workspaceId, session.id, fixText)}
                >
                  {t(employeeRun ? 'chat.recovery.askFixYours' : 'chat.recovery.askFix', { agent: who })}
                </Button>
              </>
            )
          }
        >
          {stopped && <div>{stopped}</div>}
          {cause?.rest && <div className="recovery-detail">{cause.rest}</div>}
          {item.delta && (
            <div className="turn-recovery-left">
              {item.delta.files.length ? (
                <>
                  <span>{t('chat.recovery.left', { count: item.delta.files.length })}</span>
                  {item.delta.files.map((file) => (
                    <ChangedFile key={file.path} file={file} files={files} />
                  ))}
                  {workspaceName && <span>{t('chat.recovery.stillIn', { name: workspaceName })}</span>}
                </>
              ) : (
                <span>{t('chat.recovery.leftNone')}</span>
              )}
            </div>
          )}
          {output && (
            <Disclosure quiet open={outputOpen} onOpenChange={setOutputOpen} label={t(outputOpen ? 'chat.recovery.hideOutput' : 'chat.recovery.showOutput')}>
              <div className="tool-body turn-recovery-output">
                <pre className="tool-output">{output}</pre>
              </div>
            </Disclosure>
          )}
          <LimitResumePart item={item} session={session} canAct={canAct} />
        </Callout>
      )}
      {confirm && message && (
        <Dialog
          title={t('chat.restore.dialogTitle')}
          onClose={() => setConfirm(null)}
          footer={
            <>
              <Button onClick={() => setConfirm(null)}>{t('common.cancel')}</Button>
              <Button
                variant="primary"
                autoFocus
                onClick={() => {
                  const resend = confirm === 'retry'
                  setConfirm(null)
                  void restoreThen(resend)
                }}
              >
                {t(confirm === 'retry' ? 'chat.recovery.restoreRetry' : 'chat.restore.label')}
              </Button>
            </>
          }
        >
          <p>{t(restore ?? 'chat.restore.confirm')}</p>
        </Dialog>
      )}
    </>
  )
}

/** O1 (G1): "Conversation compacted · …" or "Model changed to Sonnet 5.5 · same conversation", drawn like a switch. */
function ChatDividerLine({ divider }: { divider: ChatDivider }) {
  const t = useT()
  if (divider.kind === 'compact') {
    // Idle compaction (Settings → Agents → Claude Code): what it held before and after, and when.
    const time = divider.at ? formatClock(divider.at, t.locale) : ''
    const text = !divider.idle
      ? t('g1.divider.compact')
      : divider.before && divider.after
        ? t('g1.divider.compactIdle', { before: formatNumber(divider.before, t.locale), after: formatNumber(divider.after, t.locale), time })
        : t('g1.divider.compactIdleNoCount', { time })
    return (
      <div className="agent-switch" role="separator">
        <span className="agent-switch-text">{text}</span>
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
function UserMenu({ item, sessionId, workspaceId, running }: { item: UserItem; sessionId: string; workspaceId: string; running: boolean }) {
  const t = useT()
  const block = editResendBlock(item, running)
  const blockText = block ? t(block === 'steered' ? 'editResend.menu.steered' : 'editResend.menu.running') : undefined
  return (
    <MenuButton className="user-menu" look="icon" label={t('editResend.menu.label')} placement="bottom-start" trigger={<MoreHorizontal size={13} />}>
      <MenuItem icon={<Pencil size={12} />} disabled={Boolean(block)} title={blockText} onSelect={() => void editAndResend(workspaceId, sessionId, { turnId: item.turnId, text: item.text })}>
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

/** A reply. The log's ResizeObserver keeps it in view as it grows (ChatView), so it reads no layout itself. */
const AssistantMessage = memo(function AssistantMessage({ text, streaming, workspaceId, who, askedAt, level, strip }: { text: string; streaming?: boolean; workspaceId: string; who: string; askedAt?: string; level: number; strip: boolean }) {
  const t = useT()
  const headingId = useId()
  // While the reply streams its Markdown is rendered every STREAM_RENDER_MS, not on each flush; the final text at once.
  const rendered = useThrottledText(text, Boolean(streaming))
  const shown = strip ? stripAbsolutelyRight(rendered, streaming) : rendered
  if (text && !shown) return null
  return (
    <article className={`assistant ${streaming ? 'streaming' : ''}`} aria-labelledby={headingId} aria-busy={streaming ? true : undefined}>
      <Hidden level={level} id={headingId}>
        {askedAt ? t('chat.message.agentReplyAt', { name: who, time: formatClock(askedAt, t.locale) }) : who}
      </Hidden>
      <Markdown text={shown} workspaceId={workspaceId} streaming={streaming} codeTools headingStart={level + 1} />
    </article>
  )
})

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
