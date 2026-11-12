import {
  Bot,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  MessageSquare,
  Plug,
  Search,
  Square,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { memo, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { TFunction } from '../../../shared/i18n'
import { toolSummary as sharedToolSummary } from '../../../shared/toolSummary'
import type { ChatItem, TaskProgress } from '../../../shared/types'
import { relativeToRoots } from '../../../shared/portable'
import { isSubagentCall, subagentName, SUBAGENT_TOOLS, type ChildItem } from '../../../shared/subagents'
import { t as storeT, useT } from '../i18n'
import { useWindowVisible } from '../store'
import { Button, Pressable, Spinner, Status, Tag, Tree, TreeItem } from '../ui'
import { Markdown } from './Markdown'
import { fullPath, OpenFileChip, type FileAccess } from './OpenFileChip'

export type ToolItem = Extract<ChatItem, { kind: 'tool' }>
type Input = Record<string, unknown>

export type Root = string | string[]

function relative(file: unknown, root: Root): string {
  return relativeToRoots(file, root)
}

function countLines(text: unknown): number {
  const s = String(text ?? '')
  return s ? s.replace(/\n$/, '').split('\n').length : 0
}

/** Lines added and removed by replacing `before` with `after`, ignoring shared leading and trailing lines. */
function changedLines(before: unknown, after: unknown): { added: number; removed: number } {
  const a = String(before ?? '').split('\n')
  const b = String(after ?? '').split('\n')
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let end = 0
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++
  return { added: b.length - start - end, removed: a.length - start - end }
}

/** One-line description of what a tool call does (also used by approval cards). */

const BRIDGE_LABELS: Record<string, string> = { 'foreman-linear': 'Linear', 'foreman-github': 'GitHub', 'foreman-slack': 'Slack' }
/** One line that says what a tool call does; the pure version lives in shared/toolSummary.ts so the narrator and the CLI say the same thing. */
export function toolSummary(name: string, input: unknown, root: Root, t: TFunction = storeT): string {
  return sharedToolSummary(name, input, root, t)
}

interface Described {
  icon: LucideIcon
  label: string
  file?: string
  // The path as the tool was given it, for opening the file (OpenFileChip).
  target?: unknown
  code?: string
  meta?: ReactNode
}

export function describe(item: ToolItem, root: Root, t: TFunction = storeT): Described {
  const i = (item.input ?? {}) as Input
  const done = item.status === 'done'
  switch (item.name) {
    case 'Read': {
      const lines = done ? countLines(item.output) : 0
      return { icon: FileText, label: lines ? t('toolRow.readLines', { count: lines }) : t('toolRow.read'), file: relative(i.file_path, root), target: i.file_path }
    }
    case 'Edit':
    case 'MultiEdit': {
      const edits = (i.edits as Input[] | undefined) ?? [i]
      const counts = edits.map((e) => changedLines(e.old_string, e.new_string))
      const added = counts.reduce((n, c) => n + c.added, 0)
      const removed = counts.reduce((n, c) => n + c.removed, 0)
      // Some agents (Codex) report the file but not the edit itself.
      const known = edits.some((e) => e.old_string !== undefined || e.new_string !== undefined)
      return {
        icon: FilePen,
        label: t('toolRow.edit'),
        file: relative(i.file_path, root),
        target: i.file_path,
        meta: known ? (
          <>
            <span className="add">+{added}</span> <span className="del">-{removed}</span>
          </>
        ) : undefined
      }
    }
    case 'Write':
      return { icon: FilePlus, label: t('toolRow.write'), file: relative(i.file_path, root), target: i.file_path, meta: i.content !== undefined ? t('toolRow.lines', { count: countLines(i.content) }) : undefined }
    case 'Bash':
      return { icon: SquareTerminal, label: String(i.description ?? t('toolRow.runCommand')), code: String(i.command ?? '') }
    case 'Grep': {
      const matches = done ? String(item.output ?? '').split('\n').filter(Boolean).length : 0
      return { icon: Search, label: t('toolRow.grep', { pattern: String(i.pattern ?? '') }), meta: done ? t('toolRow.matches', { count: matches }) : undefined }
    }
    case 'Glob': {
      const files = done ? String(item.output ?? '').split('\n').filter(Boolean).length : 0
      return { icon: FolderSearch, label: 'Glob', code: String(i.pattern ?? ''), meta: done ? t('toolRow.files', { count: files }) : undefined }
    }
    case 'WebFetch':
      return { icon: Globe, label: t('toolRow.fetch'), code: String(i.url ?? '') }
    case 'WebSearch':
      return { icon: Globe, label: t('toolRow.webSearch', { query: String(i.query ?? '') }) }
    case 'Task':
    case 'Agent':
      return { icon: Bot, label: String(i.description ?? t('toolRow.subagent')), meta: String(i.subagent_type ?? t('toolRow.subagentType')) }
    case 'ExitPlanMode':
      return { icon: ClipboardList, label: t('toolRow.plan') }
    case 'mcp__foreman__AskUserQuestion':
    // Chats saved before the rename.
    case 'mcp__switchyard__AskUserQuestion': {
      const count = Array.isArray(i.questions) ? i.questions.length : 1
      return { icon: MessageCircleQuestion, label: t('toolRow.asked', { count }) }
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(item.name)
      // Integrations' bridge servers name their service ("foreman-linear" → Linear).
      if (mcp) return { icon: Plug, label: mcp[2], meta: BRIDGE_LABELS[mcp[1]] ?? mcp[1] }
      return { icon: Wrench, label: item.name }
    }
  }
}

function Todos({ input }: { input: unknown }) {
  const t = useT()
  const todos = ((input as Input)?.todos ?? []) as { content: string; status: string }[]
  return (
    <div className="todo-card">
      <div className="tool-row static">
        <ListTodo size={14} className="tool-icon" />
        <span className="tool-label">{t('toolRow.todos.label')}</span>
        <span className="tool-meta">{t('toolRow.todos.count', { count: todos.length })}</span>
      </div>
      <ul className="todos">
        {todos.map((todo, n) => (
          <li key={n} className={todo.status}>
            <span className="box">{todo.status === 'completed' ? '✓' : ''}</span>
            {todo.content}
          </li>
        ))}
      </ul>
    </div>
  )
}

function EditPreview({ input }: { input: Input }) {
  const edits = (input.edits as Input[] | undefined) ?? [input]
  return (
    <div className="edit-preview">
      {edits.map((e, n) => (
        <div key={n}>
          {String(e.old_string ?? '')
            .split('\n')
            .map((line, k) => (
              <div key={`o${k}`} className="del">
                -{line}
              </div>
            ))}
          {String(e.new_string ?? '')
            .split('\n')
            .map((line, k) => (
              <div key={`n${k}`} className="add">
                +{line}
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

/** "42s", "2m 05s", "1h 02m". */
function duration(ms: number, t: TFunction): string {
  const s = Math.floor(ms / 1000)
  if (s < 60) return t('toolRow.duration.seconds', { s })
  const m = Math.floor(s / 60)
  if (m < 60) return t('toolRow.duration.minutes', { m, s: String(s % 60).padStart(2, '0') })
  return t('toolRow.duration.hours', { h: Math.floor(m / 60), m: String(m % 60).padStart(2, '0') })
}

/** The current time, ticking every second while `live` and the window is shown. */
function useNow(live: boolean): number {
  const visible = useWindowVisible()
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live || !visible) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live, visible])
  return now
}

/** "background · 12 tool uses · 1m 05s" for a subagent or shell. */
export function TaskMeta({ task, inStrip }: { task: TaskProgress; inStrip?: boolean }) {
  const t = useT()
  const running = task.status === 'running'
  const now = useNow(running)
  const elapsed = running && task.startedAt ? Math.max(task.durationMs ?? 0, now - new Date(task.startedAt).getTime()) : task.durationMs
  const parts = [
    // The background strip says so already.
    running && task.background && !inStrip ? t('toolRow.task.background') : null,
    task.status === 'stopped' ? t('toolRow.task.stopped') : task.status === 'failed' ? t('toolRow.task.failed') : null,
    task.toolUses ? t('toolRow.task.toolUses', { count: task.toolUses }) : null,
    elapsed !== undefined ? duration(elapsed, t) : null
  ].filter(Boolean)
  if (!parts.length) return null
  return <span className="tool-meta">{parts.join(' · ')}</span>
}

/** What a running task is doing right now. */
export function taskActivity(task: TaskProgress, t: TFunction = storeT): string {
  return task.summary || (task.lastTool ? t('toolRow.task.using', { tool: task.lastTool }) : '')
}

/** A subagent's own calls and messages by the call they sit under: the Task call's id, and any Task call inside it. */
export type Subtree = ReadonlyMap<string, ChildItem[]>

/** Stops one subagent; true once the agent was told, undefined if it could not be (the failure is shown as a toast). */
export type StopChild = (childId: string) => Promise<boolean | undefined>

/** Stop for one running subagent. Named for it, since several can run at once. Disabled from the press until its row says stopped. */
function StopSubagent({ childId, name, onStop }: { childId: string; name: string; onStop: StopChild }) {
  const t = useT()
  const [sent, setSent] = useState(false)
  return (
    <Button
      size="sm"
      icon={<Square size={11} />}
      disabled={sent}
      aria-label={t(sent ? 'toolRow.child.stoppingLabel' : 'toolRow.child.stopLabel', { name })}
      onClick={(e) => {
        // Not the row's own click, which would open or close the branch.
        e.stopPropagation()
        setSent(true)
        void onStop(childId).then((told) => {
          if (!told) setSent(false)
        })
      }}
    >
      {sent ? t('toolRow.child.stopping') : t('toolRow.child.stop')}
    </Button>
  )
}

interface ChildEntry {
  item: ChildItem
  depth: number
  // A subagent of its own (a Task call inside this one), shown with its status and Stop.
  subagent: boolean
  // It has calls to open.
  dir: boolean
  expanded: boolean
}

/** The visible rows under a Task call: its own calls and messages, and inside an open nested subagent, that one's. */
function childEntries(rootId: string, subtree: Subtree, expanded: ReadonlySet<string>): ChildEntry[] {
  const out: ChildEntry[] = []
  const walk = (parent: string, depth: number) => {
    for (const item of subtree.get(parent) ?? []) {
      const own = subtree.get(item.id)
      const subagent = item.kind === 'tool' && isSubagentCall(item, Boolean(own?.length))
      const dir = subagent && Boolean(own?.length)
      const open = dir && expanded.has(item.id)
      out.push({ item, depth, subagent, dir, expanded: open })
      if (open) walk(item.id, depth + 1)
    }
  }
  walk(rootId, 0)
  return out
}

const firstLine = (text: string) => text.split(/\r?\n/).find((l) => l.trim())?.trim() ?? ''

const CHILD_STATE = {
  running: 'toolRow.child.running',
  completed: 'toolRow.child.done',
  failed: 'toolRow.child.failed',
  stopped: 'toolRow.child.stopped'
} as const

/** What a subagent's task says it is doing: its own state, else its call's. */
function childState(item: ToolItem): keyof typeof CHILD_STATE {
  if (item.task) return item.task.status
  return item.status === 'running' ? 'running' : item.status === 'error' ? 'failed' : 'completed'
}

/**
 * What a subagent did, as a tree under its Task call (docs/agents.md 6): its calls and messages as leaves, and a Task call
 * inside it as a branch with its own status, counts and Stop. Folded by default; ↑ ↓ → ← Home End as in any Tree.
 */
function SubagentTree({ rootId, name, subtree, workspacePath, onStop, waiting }: { rootId: string; name: string; subtree: Subtree; workspacePath: Root; onStop?: StopChild; waiting?: ReadonlySet<string> }) {
  const t = useT()
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set())
  const entries = useMemo(() => childEntries(rootId, subtree, expanded), [rootId, subtree, expanded])
  // What typing matches is what the row shows, not the item's id.
  const rows = useMemo(() => entries.map((e) => ({ path: e.item.id, dir: e.dir, depth: e.depth, expanded: e.expanded, label: childLabel(e, workspacePath, t) })), [entries, workspacePath, t])
  if (!entries.length) return null
  const toggle = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })
  return (
    <Tree className="subagent-tree" label={t('toolRow.child.tree', { name })} rows={rows} onToggle={toggle} onOpen={() => undefined}>
      {entries.map((e) => (
        <ChildNode key={e.item.id} entry={e} workspacePath={workspacePath} onStop={onStop} waiting={waiting} />
      ))}
    </Tree>
  )
}

/** The words a subagent's row shows: a message's first line, a nested subagent's name, or a tool call's label and target. */
function childLabel(entry: ChildEntry, workspacePath: Root, t: TFunction): string {
  const { item } = entry
  if (item.kind !== 'tool') return firstLine(item.kind === 'assistant' ? item.text : '')
  if (entry.subagent) return subagentName(item.input, t('toolRow.subagent'))
  const d = describe(item, workspacePath, t)
  return [d.label, d.file ?? d.code].filter(Boolean).join(' ')
}

function ChildNode({ entry, workspacePath, onStop, waiting }: { entry: ChildEntry; workspacePath: Root; onStop?: StopChild; waiting?: ReadonlySet<string> }) {
  const t = useT()
  const { item } = entry
  const chevron = entry.dir ? entry.expanded ? <ChevronDown size={12} className="subagent-node-chev" /> : <ChevronRight size={12} className="subagent-node-chev" /> : <span className="subagent-node-chev" />
  if (item.kind !== 'tool') {
    const text = childLabel(entry, workspacePath, t)
    return (
      <TreeItem path={item.id} title={text}>
        {chevron}
        <MessageSquare size={14} className="tool-icon" />
        <span className="subagent-node-name">{text}</span>
      </TreeItem>
    )
  }
  if (entry.subagent) {
    const state = childState(item)
    const name = childLabel(entry, workspacePath, t)
    const running = state === 'running'
    return (
      <TreeItem path={item.id} title={name}>
        {chevron}
        {running ? <Spinner size={12} /> : <Status tone={state === 'completed' ? 'ok' : state === 'failed' ? 'error' : 'off'} label={t(CHILD_STATE[state])} />}
        {running && <span className="subagent-node-state">{t(CHILD_STATE.running)}</span>}
        <span className="subagent-node-name">{name}</span>
        <span className="subagent-node-end">
          {item.childId && waiting?.has(item.childId) && <Tag tone="warn">{t('toolRow.child.waiting')}</Tag>}
          {item.task && <TaskMeta task={item.task} />}
          {running && item.childId && onStop && <StopSubagent childId={item.childId} name={name} onStop={onStop} />}
        </span>
      </TreeItem>
    )
  }
  const Icon = describe(item, workspacePath, t).icon
  const text = childLabel(entry, workspacePath, t)
  return (
    <TreeItem path={item.id} title={text}>
      {chevron}
      {item.status === 'running' ? <Spinner size={12} /> : item.status === 'error' ? <Status compact tone="error" label={t('toolRow.child.failed')} /> : <Icon size={14} className="tool-icon" />}
      <span className="subagent-node-name">{text}</span>
    </TreeItem>
  )
}

/**
 * One tool call in the log. Memo'd, with what it shows worked out once per change to the call: a long chat has hundreds.
 * `expandByDefault` is the Expand tool calls setting (⌃O), read once by the chat rather than by every row.
 * `files` lets a finished call's path open the file (OpenFileChip); without it (a cloud workspace) the path is text.
 */
export const ToolRow = memo(function ToolRow({
  item,
  workspacePath,
  files,
  forceOpen = false,
  expandByDefault,
  subtree,
  onStopChild,
  waiting
}: {
  item: ToolItem
  workspacePath: Root
  files?: FileAccess | null
  forceOpen?: boolean
  expandByDefault: boolean
  // A Task call's subagent's own calls and messages (docs/agents.md 6); none for any other call.
  subtree?: Subtree
  // Only for an agent that can stop one subagent (its record's subagents.stop).
  onStopChild?: StopChild
  // Task ids of subagents that have an approval or question waiting for the person.
  waiting?: ReadonlySet<string>
}) {
  const t = useT()
  // null until the user opens or closes this row; until then it follows the setting (⌃O).
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = forceOpen || (toggled ?? expandByDefault)
  const d = useMemo(() => (item.name === 'TodoWrite' ? null : describe(item, workspacePath, t)), [item, workspacePath, t])
  if (!d) return <Todos input={item.input} />
  const task = item.task
  // A background task keeps going after its tool call has returned.
  const busy = item.status === 'running' || task?.status === 'running'
  const failed = item.status === 'error' || task?.status === 'failed'
  const Icon = d.icon
  const input = (item.input ?? {}) as Input
  const activity = task?.status === 'running' ? taskActivity(task, t) : ''
  const toggle = () => setToggled(!open)
  const icon = busy ? <span className="tool-icon"><Spinner size={14} /></span> : <Icon size={14} className="tool-icon" />
  // A path opens once the call has finished (never a file still being written); a failed call's file may be there.
  const path = d.file && files && !busy ? fullPath(d.target, files.root) : null
  const subagent = SUBAGENT_TOOLS.includes(item.name) && item.childId !== undefined
  const name = subagent ? subagentName(item.input, t('toolRow.subagent')) : ''
  const stoppable = subagent && task?.status === 'running' && onStopChild !== undefined
  const asking = subagent && item.childId !== undefined && waiting?.has(item.childId) === true
  const summaryRow = (
    <Pressable className="tool-row" aria-expanded={open} onClick={toggle}>
      {icon}
      <span className="tool-label">{d.label}</span>
      {d.file && <span className="file-chip mono">{d.file}</span>}
      {d.code && <code className="tool-code">{d.code}</code>}
      {d.meta && <span className="tool-meta">{d.meta}</span>}
      {task && <TaskMeta task={task} />}
    </Pressable>
  )
  return (
    <div className={`tool ${failed ? 'error' : item.status}`} data-tool={item.id}>
      {path && files ? (
        // The path is a button of its own between the row's two halves, which both expand it: a button can't hold one.
        <div className="tool-line">
          <Pressable className="tool-row" aria-expanded={open} onClick={toggle}>
            {icon}
            <span className="tool-label">{d.label}</span>
            {d.meta && <span className="sr-only">{d.meta}</span>}
          </Pressable>
          <OpenFileChip path={path} label={d.file!} access={files} />
          <Pressable className="tool-row tool-row-rest" aria-hidden="true" tabIndex={-1} onClick={toggle}>
            {d.meta && <span className="tool-meta">{d.meta}</span>}
          </Pressable>
        </div>
      ) : stoppable || asking ? (
        // Stop is its own control beside the row, which a button can't hold.
        <div className="tool-line tool-line-stop">
          {summaryRow}
          {asking && <Tag tone="warn">{t('toolRow.child.waiting')}</Tag>}
          {stoppable && item.childId && <StopSubagent childId={item.childId} name={name} onStop={onStopChild} />}
        </div>
      ) : (
        summaryRow
      )}
      {activity && <div className="task-activity">{activity}</div>}
      {open && (
        <div className="tool-body">
          {task && task.status !== 'running' && task.summary && <div className="task-summary">{task.summary}</div>}
          {subtree && <SubagentTree rootId={item.id} name={name || subagentName(item.input, t('toolRow.subagent'))} subtree={subtree} workspacePath={workspacePath} onStop={onStopChild} waiting={waiting} />}
          {item.name === 'Edit' || item.name === 'MultiEdit' ? (
            <EditPreview input={input} />
          ) : item.name === 'ExitPlanMode' ? (
            <Markdown text={String(input.plan ?? '')} />
          ) : (
            <pre>{JSON.stringify(item.input, null, 2)}</pre>
          )}
          {item.output !== undefined && item.output !== '' && <pre className="tool-output">{item.output}</pre>}
        </div>
      )}
    </div>
  )
})
