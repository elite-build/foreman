import {
  Bot,
  ClipboardList,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  MessageCircleQuestion,
  Plug,
  Search,
  SquareTerminal,
  Wrench,
  type LucideIcon
} from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { TFunction } from '../../../shared/i18n'
import { toolSummary as sharedToolSummary } from '../../../shared/toolSummary'
import type { ChatItem, TaskProgress } from '../../../shared/types'
import { relativeToRoots } from '../../../shared/portable'
import { t as storeT, useT } from '../i18n'
import { useStore } from '../store'
import { Pressable, Spinner } from '../ui'
import { Markdown } from './Markdown'

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
  code?: string
  meta?: ReactNode
}

export function describe(item: ToolItem, root: Root, t: TFunction = storeT): Described {
  const i = (item.input ?? {}) as Input
  const done = item.status === 'done'
  switch (item.name) {
    case 'Read': {
      const lines = done ? countLines(item.output) : 0
      return { icon: FileText, label: lines ? t('toolRow.readLines', { count: lines }) : t('toolRow.read'), file: relative(i.file_path, root) }
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
        meta: known ? (
          <>
            <span className="add">+{added}</span> <span className="del">-{removed}</span>
          </>
        ) : undefined
      }
    }
    case 'Write':
      return { icon: FilePlus, label: t('toolRow.write'), file: relative(i.file_path, root), meta: i.content !== undefined ? t('toolRow.lines', { count: countLines(i.content) }) : undefined }
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

/** The current time, ticking every second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (!live) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [live])
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

export function ToolRow({ item, workspacePath, forceOpen = false }: { item: ToolItem; workspacePath: Root; forceOpen?: boolean }) {
  const t = useT()
  const expandByDefault = useStore((s) => s.snapshot?.settings.expandToolCalls ?? false)
  // null until the user opens or closes this row; until then it follows the setting (⌃O).
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = forceOpen || (toggled ?? expandByDefault)
  if (item.name === 'TodoWrite') return <Todos input={item.input} />

  const d = describe(item, workspacePath, t)
  const task = item.task
  // A background task keeps going after its tool call has returned.
  const busy = item.status === 'running' || task?.status === 'running'
  const failed = item.status === 'error' || task?.status === 'failed'
  const Icon = d.icon
  const input = (item.input ?? {}) as Input
  const activity = task?.status === 'running' ? taskActivity(task, t) : ''
  return (
    <div className={`tool ${failed ? 'error' : item.status}`} data-tool={item.id}>
      <Pressable className="tool-row" aria-expanded={open} onClick={() => setToggled(!open)}>
        {busy ? <span className="tool-icon"><Spinner size={14} /></span> : <Icon size={14} className="tool-icon" />}
        <span className="tool-label">{d.label}</span>
        {d.file && <span className="file-chip mono">{d.file}</span>}
        {d.code && <code className="tool-code">{d.code}</code>}
        {d.meta && <span className="tool-meta">{d.meta}</span>}
        {task && <TaskMeta task={task} />}
      </Pressable>
      {activity && <div className="task-activity">{activity}</div>}
      {open && (
        <div className="tool-body">
          {task && task.status !== 'running' && task.summary && <div className="task-summary">{task.summary}</div>}
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
}
