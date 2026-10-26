import { Check, Columns2, FoldVertical, Rows2, SquareArrowRight, SquareDot, SquareMinus, SquarePlus, TextSelect, Trash2, UnfoldVertical } from 'lucide-react'
import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react'
import { contextGaps, diffLayout, hiddenBefore, parseHunkHeader, splitRows, SPLIT_MIN_WIDTH } from '../../../shared/splitDiff'
import { ImageDiff, showsImageDiff } from './ImageDiff'
import { buildSelection, canSelect, pickLines, SELECTION_PREFIX, type Side } from '../../../shared/diffSelection'
import type { DiffComment, DiffFile, DiffLine, DiffScope, DiffSelection, FileContent, Workspace, WorkspaceDiff } from '../../../shared/types'
import { isViewed, viewedCount } from '../../../shared/viewed'
import { announce } from '../announce'
import { useT } from '../i18n'
import { fileSummary, hunkFromHeader, hunkSummary, type NarratedHunk } from '../../../shared/narration'
import { api, attempt, modKey, toggleLeftPanel, useStore } from '../store'
import { setDiffPrefs, useDiffPrefs } from './diffPrefs'
import { CommentText, reportSend, SelectionBar, SelectionComment, SelectionDraftBox, SelectionQuote, tabName, useDefaultTab, type BarAction } from './DiffSelection'
import { ActionRow, Button, Checkbox, ContextMenu, Kbd, LinkButton, MenuItem, MenuSeparator, Segmented, Tag, IconButton, TextArea, TextInput } from '../ui'
import { DiffBadge } from './Sidebar'

const LINES_PER_FILE = 2000

export function StatusIcon({ status }: { status: DiffFile['status'] }) {
  const props = { size: 15, className: `st ${status}` }
  if (status === 'added') return <SquarePlus {...props} />
  if (status === 'deleted') return <SquareMinus {...props} />
  if (status === 'renamed') return <SquareArrowRight {...props} />
  return <SquareDot {...props} />
}

// The status as a word, for the file list's accessible name (the icon is decoration).
const STATUS_WORD = {
  added: 'narration.file.status.added',
  deleted: 'narration.file.status.deleted',
  modified: 'narration.file.status.modified',
  renamed: 'narration.file.status.renamed'
} as const satisfies Record<DiffFile['status'], string>

function splitPath(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? { name: path, dir: '' } : { name: path.slice(slash + 1), dir: path.slice(0, slash + 1) }
}

function FileMenu({
  workspace,
  file,
  x,
  y,
  onOpen,
  dismiss,
  canDiscard = true
}: {
  workspace: Workspace
  file: DiffFile
  x: number
  y: number
  onOpen: () => void
  dismiss: () => void
  // O5: not on staged, commits or the PR, whose files aren't the working tree.
  canDiscard?: boolean
}) {
  const t = useT()
  const full = `${workspace.path ?? ''}/${file.path}`
  return (
    <ContextMenu x={x} y={y} label={t('changes.menu.label')} onClose={dismiss}>
      <MenuItem onSelect={onOpen}>{t('changes.menu.viewDiff')}</MenuItem>
      {file.status !== 'deleted' && <MenuItem onSelect={() => void attempt(() => api.openInEditor(full))}>{t('changes.menu.openInEditor')}</MenuItem>}
      <MenuItem onSelect={() => void navigator.clipboard.writeText(full)}>{t('changes.menu.copyPath')}</MenuItem>
      <MenuItem onSelect={() => void navigator.clipboard.writeText(file.path)}>{t('changes.menu.copyRelativePath')}</MenuItem>
      {canDiscard && <MenuSeparator />}
      {canDiscard && (
        <MenuItem
          variant="danger"
          onSelect={() => {
            if (window.confirm(t('changes.menu.discardConfirm', { path: file.path }))) {
              void attempt(() => api.revertFile(workspace.id, file.path))
            }
          }}
        >
          {t('changes.menu.discard')}
        </MenuItem>
      )}
    </ContextMenu>
  )
}

export function ChangesList({
  workspace,
  diff,
  selected,
  onOpen,
  onBackToAll
}: {
  workspace: Workspace
  diff: WorkspaceDiff
  selected: string | null
  onOpen: (path: string) => void
  // O5: back from another source to All changes.
  onBackToAll?: () => void
}) {
  const t = useT()
  const [filter, setFilter] = useState('')
  const [menu, setMenu] = useState<{ file: DiffFile; x: number; y: number } | null>(null)
  const comments = useStore((s) => s.snapshot!.comments)
  // O5: staged, commits and the PR aren't the working tree; viewed marks and comments stay with All changes.
  const workingTree = diff.scope === 'all' || diff.scope === 'uncommitted'
  const back = onBackToAll && !workingTree && (
    <LinkButton size="sm" onClick={onBackToAll}>
      {t('diffSource.backToAll')}
    </LinkButton>
  )

  if (diff.files.length === 0) {
    return (
      <div className="panel-empty faint">
        {diff.unavailable ? t(`diffSource.blocked.${diff.unavailable}`) : diff.scope === 'uncommitted' ? t('changes.empty.uncommitted') : workingTree ? t('changes.empty.all') : t('diffSource.empty')}
        {back && <div>{back}</div>}
      </div>
    )
  }
  const shown = filter ? diff.files.filter((f) => f.path.toLowerCase().includes(filter.toLowerCase())) : diff.files
  // Marks are for the full diff, and a cut-off diff can't say which versions it saw.
  const canMark = diff.scope === 'all' && !diff.truncated && Boolean(diff.mergeBase)
  const { viewed, total } = viewedCount(workspace.viewed, diff.files, diff.mergeBase)
  const noMarkReason = diff.truncated ? t('changes.viewed.tooLarge') : t('changes.viewed.fullDiffOnly')
  return (
    <div className="changes">
      {workingTree ? (
        <div className="changes-viewed faint small" title={canMark ? undefined : noMarkReason}>
          {t('changes.viewed.count', { viewed, total })}
        </div>
      ) : (
        <div className="changes-note faint small">
          {t('diffSource.marksNote')}
          {back}
        </div>
      )}
      {diff.files.length > 8 && <TextInput className="changes-filter" aria-label={t('changes.filter')} placeholder={t('changes.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />}
      {shown.map((f) => {
        const { name, dir } = splitPath(f.path)
        const count = workingTree ? comments.filter((c) => c.workspaceId === workspace.id && c.file === f.path && c.state !== 'resolved' && c.state !== 'sent').length : 0
        const marked = workingTree && isViewed(workspace.viewed, f, diff.mergeBase)
        return (
          <div key={f.path} className={`change-item ${marked ? 'viewed' : ''}`}>
            {workingTree && (
              <Checkbox
                className="change-viewed"
                checked={marked}
                disabled={!canMark || !f.blobId}
                title={canMark ? t('changes.viewed.markTitle') : noMarkReason}
                aria-label={t('changes.viewed.aria', { path: f.path })}
                onChange={(e) => void attempt(() => api.setFileViewed(workspace.id, { path: f.path, blobId: f.blobId!, mergeBase: diff.mergeBase! }, e.target.checked))}
              />
            )}
            <ActionRow
              className="change-entry"
              selected={selected === f.path}
              onPress={() => onOpen(f.path)}
              primaryProps={{
                className: 'change-row',
                title: f.oldPath ? `${f.oldPath} → ${f.path}` : f.path,
                onContextMenu: (e) => {
                  e.preventDefault()
                  setMenu({ file: f, x: e.clientX, y: e.clientY })
                }
              }}
            >
              <StatusIcon status={f.status} />
              <span className="sr-only">{t('narration.join', { a: t(STATUS_WORD[f.status]), b: '' })}</span>
              <span className="change-name mono">{name}</span>
              <span className="change-dir mono">
                {dir}
                {count > 0 && <span className="comment-count"> · {count} 💬</span>}
              </span>
              <DiffBadge additions={f.additions} deletions={f.deletions} />
            </ActionRow>
          </div>
        )
      })}
      {diff.truncated && <div className="panel-empty faint">{t('changes.truncated')}</div>}
      <div className="changes-base faint small">
        {diff.scope === 'uncommitted' ? (
          t('changes.base.uncommitted')
        ) : diff.scope === 'staged' ? (
          t('diffSource.base.staged')
        ) : diff.scope === 'pr' ? (
          t('diffSource.base.pr', { base: diff.baseRef })
        ) : diff.commits ? (
          t('diffSource.base.commits', { count: diff.commits.length })
        ) : (
          <>{t.rich('changes.base.all', { base: <span className="mono">{diff.baseRef}</span> })}</>
        )}
      </div>
      {menu && <FileMenu workspace={workspace} file={menu.file} x={menu.x} y={menu.y} onOpen={() => onOpen(menu.file.path)} dismiss={() => setMenu(null)} canDiscard={workingTree} />}
    </div>
  )
}

function CommentBox({ onSave, onCancel }: { onSave: (body: string) => void; onCancel: () => void }) {
  const t = useT()
  const [body, setBody] = useState('')
  return (
    <div className="comment-box">
      <TextArea
        autoFocus
        rows={2}
        aria-label={t('changes.comment.placeholder')}
        placeholder={t('changes.comment.placeholder')}
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) onSave(body)
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="comment-actions">
        <Button size="sm" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => onSave(body)} disabled={!body.trim()}>
          {t('diffSel.comment')}
        </Button>
      </div>
    </div>
  )
}

function InlineComment({ comment }: { comment: DiffComment }) {
  const t = useT()
  // #15: Explain / Change this / Ask went (or wait to go) to a tab, and say so.
  if (comment.selection && comment.selection.action !== 'comment') return <SelectionComment comment={comment} />
  const pending = comment.author === 'user' && comment.state === 'pending'
  return (
    <div className={`inline-comment ${comment.author}`}>
      <div className="comment-meta faint small">
        <span>{comment.author === 'user' ? t('changes.comment.you') : comment.authorLabel ?? t('changes.comment.agent')}</span>
        {pending && <Tag>{t('changes.comment.pending')}</Tag>}
        {comment.state === 'sent' && <Tag>{t('changes.comment.sent')}</Tag>}
        <span className="spacer" />
        {comment.author === 'agent' && comment.state === 'open' && (
          <IconButton label={t('gitPanel.comment.resolve')} onClick={() => void attempt(() => api.updateComment(comment.id, { state: 'resolved' }))}>
            <Check size={12} />
          </IconButton>
        )}
        <IconButton label={t('common.delete')} onClick={() => void attempt(() => api.deleteComment(comment.id))}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      {comment.selection ? <CommentText body={comment.body} /> : <div className="comment-body">{comment.body}</div>}
      {comment.selection && <SelectionQuote comment={comment} />}
    </div>
  )
}

// Unchanged lines around the hunks, read from the working tree when asked for.
type Context = { status: 'idle' | 'loading' | 'stale' | 'tooLarge' } | { status: 'ready'; gaps: DiffLine[][] }

const sign = (line: DiffLine) => (line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' ')

/**
 * One file's diff, unified or split (an app-wide choice), wrapped or not.
 * `expandable`: the new side is the working tree, so the unchanged lines
 * between hunks can be shown (not for diffs between checkpoints).
 */
export function FileDiffView({
  file,
  workspaceId,
  readonly,
  expandable,
  commentsHidden,
  scope,
  mergeBase,
  readContent,
  headingLevel = 2
}: {
  file: DiffFile
  workspaceId: string
  readonly?: boolean
  expandable?: boolean
  // G3 · O6: where the new side's full text comes from when it isn't the working tree (a sensitive alert's checkpoint).
  readContent?: (path: string) => Promise<FileContent>
  // O5: comments sit on All changes' line numbers, so other sources don't show them.
  commentsHidden?: boolean
  // #15: which diff this is (selection actions only on All changes and Uncommitted) and its base.
  scope?: DiffScope
  mergeBase?: string
  // The level of the file's heading (its name); each hunk's heading is one below. The file sits under the workspace's
  // level 1, beside the chat's level 2.
  headingLevel?: 2 | 3 | 4 | 5
}) {
  const t = useT()
  const prefs = useDiffPrefs()
  const screenReader = useStore((s) => s.snapshot!.screenReader)
  const layoutHint = useId()
  const mod = modKey(useStore((s) => s.snapshot!.platform))
  const leftPanelOpen = useStore((s) => s.leftPanelOpen)
  const [showAll, setShowAll] = useState(false)
  const [commenting, setCommenting] = useState<number | null>(null)
  const allComments = useStore((s) => s.snapshot!.comments)
  const comments = commentsHidden ? [] : allComments.filter((c) => c.workspaceId === workspaceId && c.file === file.path && c.state !== 'resolved')
  let budget = showAll ? Infinity : LINES_PER_FILE
  const total = file.hunks.reduce((n, h) => n + h.lines.length, 0)

  // The diff's own width decides whether a split fits (window, sidebar and side panel all change it).
  const root = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState<number | null>(null)
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const measure = () => setWidth(el.clientWidth)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const { layout, narrow, forced } = diffLayout(prefs.layout, width, prefs.forceSplit)
  const compact = width !== null && width < SPLIT_MIN_WIDTH
  const split = layout === 'split'
  const cols = split ? 4 : 3

  const canExpand = Boolean(expandable || readContent) && !file.binary && (file.status === 'modified' || file.status === 'renamed') && file.hunks.length > 0
  const hidden = useMemo(() => hiddenBefore(file.hunks), [file.hunks])
  const [expandAll, setExpandAll] = useState(false)
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set())
  const [context, setContext] = useState<Context>({ status: 'idle' })
  const shape = file.hunks.map((h) => h.header).join('\n')
  // Opened gaps are indexes into these hunks; different hunks, different gaps.
  useEffect(() => setOpened(new Set()), [file.path, shape])
  useEffect(() => setExpandAll(false), [file.path])
  const wantContext = canExpand && (expandAll || opened.size > 0)
  useEffect(() => {
    if (!wantContext) return
    let live = true
    setContext({ status: 'loading' })
    ;(readContent ? readContent(file.path) : api.readFile(workspaceId, file.path)).then(
      (content) => {
        if (!live) return
        if (content.tooLarge) return setContext({ status: 'tooLarge' })
        // Checked against every line the diff has on the new side; a mismatch shows nothing rather than a guess.
        const found = content.binary ? null : contextGaps(file.hunks, content.content)
        setContext(found ? { status: 'ready', gaps: found } : { status: 'stale' })
      },
      () => live && setContext({ status: 'stale' })
    )
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wantContext, workspaceId, file.path, file.blobId, shape])
  const gaps = context.status === 'ready' ? context.gaps : null
  const gapShown = (i: number) => gaps !== null && (expandAll || opened.has(i))

  // Split sizes its line-number columns up front, as wide as the largest number.
  const lastLine = Math.max(
    1,
    ...file.hunks.map((h) => {
      const r = parseHunkHeader(h.header)
      return r ? Math.max(r.oldStart + r.oldCount, r.newStart + r.newCount) : 1
    }),
    ...(gaps?.[gaps.length - 1].slice(-1).map((l) => Math.max(l.oldNo ?? 0, l.newNo ?? 0)) ?? [])
  )
  const lnWidth = `calc(${Math.max(String(lastLine).length, 2)}ch + 20px)`

  // The row a comment or selection began on. Focus comes back to it from a box or the bar, or when it was lost; a row or
  // heading that already has focus keeps it, and so does anything outside this table.
  const restoreFocus = () => {
    const at = anchorRow.current
    const active = document.activeElement
    if (!at || (active && active !== document.body && (!table.current?.contains(active) || active.matches('tr[data-row], [data-hunk-heading]')))) return
    table.current?.querySelector<HTMLElement>(`tr[data-row][data-${at.side}="${at.no}"]`)?.focus()
  }
  const save = (line: number, body: string) => {
    setCommenting(null)
    restoreFocus()
    if (body.trim()) void attempt(() => api.addComment(workspaceId, file.path, line, body))
  }

  // #15: lines selected on one side (drag or shift-click the numbers, or drag across the code), and the bar's actions.
  const selectable = !readonly && !commentsHidden && canSelect(scope)
  const table = useRef<HTMLTableElement>(null)
  const [sel, setSel] = useState<{ side: Side; anchor: number; focus: number } | null>(null)
  const [draft, setDraft] = useState<{ action: Exclude<BarAction, 'explain'>; selection: DiffSelection } | null>(null)
  const [sending, setSending] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const fallbackTab = useDefaultTab(workspaceId)
  const allSessions = useStore((s) => s.snapshot!.sessions)
  const openTabs = allSessions.filter((x) => x.workspaceId === workspaceId && !x.closedAt)
  const target = picked && (picked === 'new' || openTabs.some((x) => x.id === picked)) ? picked : fallbackTab
  const drag = useRef<{ side: Side; anchor: number; moved: boolean } | null>(null)
  const lastClick = useRef<{ side: Side; no: number } | null>(null)
  const nativeDown = useRef(false)
  // The keyboard's line, kept for putting focus back after a comment is written or dropped, and the half (old or new) the
  // arrows are on in split. Both are only ever read by handlers, so neither needs to render.
  const anchorRow = useRef<{ side: Side; no: number } | null>(null)
  const half = useRef<Side>('new')
  useEffect(() => {
    setSel(null)
    setDraft(null)
  }, [file.path])

  // What is drawn, in order: hunks and any opened gaps. The selection reads its lines from these.
  const segments: ({ key: string; lines: DiffLine[] } | { header: number; count: number })[] = []
  file.hunks.forEach((hunk, n) => {
    if (budget <= 0) return
    const lines = hunk.lines.slice(0, budget)
    budget -= lines.length
    if (gapShown(n)) segments.push({ key: `g${n}`, lines: gaps![n] })
    segments.push({ header: n, count: hidden?.[n] ?? 0 })
    segments.push({ key: `l${n}`, lines })
  })
  // The rest of the file after the last hunk (Expand all only; its length isn't known up front).
  const end = file.hunks.length
  if ((showAll || total <= LINES_PER_FILE) && gapShown(end)) segments.push({ key: `g${end}`, lines: gaps![end] })
  const shown = segments.flatMap((g) => ('lines' in g ? g.lines : []))
  const range = sel ? pickLines(shown, sel.side, sel.anchor, sel.focus) : null
  const inRange = (side: Side, no: number | undefined) => Boolean(range && sel?.side === side && no !== undefined && no >= range.start && no <= range.end)

  const clearSelection = () => {
    setSel(null)
    setDraft(null)
  }
  // A row's line number on one side, from its data attributes.
  const rowNo = (tr: Element | null | undefined, side: Side): number | undefined => {
    const value = (tr as HTMLElement | null | undefined)?.dataset?.[side]
    return value === undefined ? undefined : Number(value)
  }
  const lnDown = (side: Side, no: number | undefined) => (e: React.MouseEvent) => {
    // An open Change this / Ask box keeps its selection until it is sent or cancelled.
    if (!selectable || no === undefined || e.button !== 0 || draft) return
    e.preventDefault()
    const from = sel?.side === side ? sel.anchor : lastClick.current?.side === side ? lastClick.current.no : undefined
    if (e.shiftKey && from !== undefined) {
      setCommenting(null)
      setDraft(null)
      setSel({ side, anchor: from, focus: no })
      return
    }
    drag.current = { side, anchor: no, moved: false }
  }
  const onTableOver = (e: React.MouseEvent) => {
    const d = drag.current
    if (!d) return
    const no = rowNo((e.target as HTMLElement).closest('tr'), d.side)
    if (no === undefined) return
    if (no !== d.anchor) d.moved = true
    if (d.moved) setSel({ side: d.side, anchor: d.anchor, focus: no })
  }
  const onTableDown = (e: React.MouseEvent) => {
    nativeDown.current = selectable && !draft && e.button === 0 && Boolean((e.target as HTMLElement).closest('td.code'))
  }
  useEffect(() => {
    if (!selectable) return
    // The nearest row with a number on `side`, walking from `tr` towards `other`.
    const near = (tr: Element, side: Side, other: Element): number | undefined => {
      const forward = Boolean(tr.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)
      for (let row: Element | null = tr; row; row = forward ? row.nextElementSibling : row.previousElementSibling) {
        const no = rowNo(row, side)
        if (no !== undefined) return no
        if (row === other) return undefined
      }
      return undefined
    }
    const up = () => {
      const d = drag.current
      drag.current = null
      if (d) {
        setDraft(null)
        if (d.moved) return setCommenting(null)
        lastClick.current = { side: d.side, no: d.anchor }
        // A click on a new-side number is today's comment box; on an old-side number it selects that line.
        if (d.side === 'new') {
          setSel(null)
          setCommenting(d.anchor)
        } else {
          setCommenting(null)
          setSel({ side: 'old', anchor: d.anchor, focus: d.anchor })
        }
        return
      }
      if (!nativeDown.current) return
      nativeDown.current = false
      // Dragged across the code: snap to whole lines on the side the drag started (within one line it stays a text selection).
      const text = window.getSelection()
      const el = (node: Node | null | undefined) => (node instanceof Element ? node : (node?.parentElement ?? null))
      const a = el(text?.anchorNode)?.closest('tr[data-row]')
      const f = el(text?.focusNode)?.closest('tr[data-row]')
      if (!text || text.isCollapsed || !a || !f || a === f || !table.current?.contains(a) || !table.current.contains(f)) return
      const cell = el(text.anchorNode)?.closest('td') as HTMLTableCellElement | null
      const side: Side = split ? ((cell?.cellIndex ?? 2) < 2 ? 'old' : 'new') : rowNo(a, 'new') !== undefined ? 'new' : 'old'
      const anchor = near(a, side, f)
      const focus = near(f, side, a)
      if (anchor === undefined || focus === undefined) return
      text.removeAllRanges()
      setCommenting(null)
      setDraft(null)
      setSel({ side, anchor, focus })
    }
    window.addEventListener('mouseup', up)
    return () => window.removeEventListener('mouseup', up)
  }, [selectable, split])
  // Escape or a click elsewhere drops the selection (not while its comment box is open).
  useEffect(() => {
    if (!sel || draft) return
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      setSel(null)
      restoreFocus()
    }
    const down = (e: MouseEvent) => {
      const el = e.target as HTMLElement
      if (!el.closest?.('.sel-bar') && !el.closest?.('td.ln')) setSel(null)
    }
    window.addEventListener('keydown', key)
    window.addEventListener('mousedown', down)
    return () => {
      window.removeEventListener('keydown', key)
      window.removeEventListener('mousedown', down)
    }
  }, [sel, draft])

  const sendSelection = async (body: string, selection: DiffSelection) => {
    setSending(true)
    const result = await attempt(() => api.sendDiffSelection(workspaceId, { file: file.path, body, selection }, target))
    setSending(false)
    if (!result) return
    reportSend(t, workspaceId, result)
    setPicked(null)
    clearSelection()
    restoreFocus()
  }
  // `from` is the selection to act on: the bar's, or the one Enter just made from the focused row.
  const act = (action: BarAction, from = sel) => {
    if (!from || !canSelect(scope)) return
    const selection = buildSelection({ shown, side: from.side, anchor: from.anchor, focus: from.focus, action, scope, file, mergeBase, at: new Date().toISOString() })
    if (!selection) return
    setCommenting(null)
    if (action === 'explain') void sendSelection(SELECTION_PREFIX.explain, selection)
    else setDraft({ action, selection })
  }
  const cancelDraft = () => {
    clearSelection()
    restoreFocus()
  }
  const finishDraft = (text: string) => {
    if (!draft) return
    if (draft.action !== 'comment') return void sendSelection(text, draft.selection)
    // Comment is today's plain comment, quoting the lines: it goes with the next message.
    const { selection } = draft
    clearSelection()
    restoreFocus()
    if (text.trim()) void attempt(() => api.addComment(workspaceId, file.path, selection.end, text, selection))
  }
  const tabLabel = tabName(t, openTabs, target)

  // Comments sit on the new side's line numbers (an old-side selection's on the old side's), in both layouts.
  const newLn = (newNo: number | undefined, kind = '', extra = '') => (
    <td
      className={`ln ${kind} ${readonly ? '' : 'clickable'} ${extra}`}
      title={readonly ? undefined : t('changes.commentOnLine')}
      onMouseDown={lnDown('new', newNo)}
      onClick={() => !readonly && !selectable && newNo !== undefined && setCommenting(newNo)}
    >
      {newNo ?? ''}
    </td>
  )
  const oldLn = (oldNo: number | undefined, kind = '', extra = '') => (
    <td className={`ln ${kind} ${selectable && oldNo !== undefined ? 'clickable' : ''} ${extra}`} onMouseDown={lnDown('old', oldNo)}>
      {oldNo ?? ''}
    </td>
  )
  const code = (line: DiffLine, extra = '') => (
    <td className={`code ${extra}`}>
      {/* The visible sign stays; a reader hears the word instead of "plus" or "minus". Neither is copied with the line. */}
      <span className="sign">
        <span aria-hidden="true">{sign(line)}</span>
        {line.type !== 'ctx' && <span className="sr-only">{t(line.type === 'add' ? 'diff.sign.added' : 'diff.sign.removed')} </span>}
      </span>
      {line.text}
    </td>
  )
  const withComments = (key: string, row: ReactNode, newNo: number | undefined, oldNo: number | undefined) => {
    const here = comments.filter((c) => (c.selection?.side === 'old' ? oldNo !== undefined && c.line === oldNo : newNo !== undefined && c.line === newNo))
    const open = newNo !== undefined && commenting === newNo
    const last = (side: Side) => (side === 'new' ? newNo : oldNo)
    const barHere = Boolean(range && sel && !draft && last(sel.side) === range.end)
    const draftHere = Boolean(draft && last(draft.selection.side) === draft.selection.end)
    return (
      <Fragment key={key}>
        {row}
        {barHere && range && (
          <tr className="sel-anchor-tr">
            <td colSpan={cols}>
              <div className="sel-float">
                <SelectionBar workspaceId={workspaceId} count={range.end - range.start + 1} target={target} onTarget={setPicked} onAction={act} busy={sending} />
              </div>
            </td>
          </tr>
        )}
        {(here.length > 0 || open || draftHere) && (
          <tr className="comment-tr">
            <td colSpan={cols}>
              {here.map((c) => (
                <InlineComment key={c.id} comment={c} />
              ))}
              {open && (
                <CommentBox
                  onSave={(text) => save(newNo, text)}
                  onCancel={() => {
                    setCommenting(null)
                    restoreFocus()
                  }}
                />
              )}
              {draftHere && draft && (
                <SelectionDraftBox
                  key={`${draft.action}:${draft.selection.start}`}
                  initial={draft.action === 'comment' ? '' : SELECTION_PREFIX[draft.action]}
                  sendLabel={draft.action === 'comment' ? t('diffSel.comment') : t('diffSel.send', { tab: tabLabel })}
                  placeholder={draft.action === 'comment' ? t('changes.comment.placeholder') : t('diffSel.placeholder', { tab: tabLabel })}
                  onSend={finishDraft}
                  onCancel={cancelDraft}
                />
              )}
            </td>
          </tr>
        )}
      </Fragment>
    )
  }
  const rows = (key: string, lines: DiffLine[]) =>
    split
      ? splitRows(lines).map((row, k) => {
          const left = inRange('old', row.left?.oldNo)
          const right = inRange('new', row.right?.newNo)
          return withComments(
            `${key}.${k}`,
            <tr className={row.left === row.right ? 'ctx' : 'change'} tabIndex={-1} data-row="" data-old={row.left?.oldNo} data-new={row.right?.newNo}>
              {row.left ? (
                <>
                  {oldLn(row.left.oldNo, row.left.type, left ? 'sel sel-edge' : '')}
                  {code(row.left, `old ${row.left.type} ${left ? 'sel' : ''}`)}
                </>
              ) : (
                <>
                  <td className="ln empty" />
                  <td className="code old empty" />
                </>
              )}
              {row.right ? (
                <>
                  {newLn(row.right.newNo, row.right.type, right ? 'sel sel-edge' : '')}
                  {code(row.right, `${row.right.type} ${right ? 'sel' : ''}`)}
                </>
              ) : (
                <>
                  <td className="ln empty" />
                  <td className="code empty" />
                </>
              )}
            </tr>,
            row.right?.newNo,
            row.left?.oldNo
          )
        })
      : lines.map((line, k) => {
          const on = inRange('new', line.newNo) || inRange('old', line.oldNo)
          return withComments(
            `${key}.${k}`,
            <tr className={line.type} tabIndex={-1} data-row="" data-old={line.oldNo} data-new={line.newNo}>
              {oldLn(line.oldNo, '', on ? 'sel sel-edge' : '')}
              {newLn(line.newNo, '', on ? 'sel' : '')}
              {code(line, on ? 'sel' : '')}
            </tr>,
            line.newNo,
            line.oldNo
          )
        })

  // One tbody per hunk: its heading row and its lines (with the comments between them). Opened gaps of unchanged lines
  // between hunks are bodies of their own, without a heading.
  const bodies: { key: string; rows: ReactNode[] }[] = []
  const firstHunk = segments.find((g): g is { header: number; count: number } => 'header' in g)?.header
  for (const g of segments) {
    if ('lines' in g) {
      const drawn = rows(g.key, g.lines)
      if (g.key.startsWith('g')) bodies.push({ key: g.key, rows: drawn })
      else bodies[bodies.length - 1]?.rows.push(...drawn)
      continue
    }
    const n = g.header
    const info: NarratedHunk = hunkFromHeader(file.hunks[n].header, n + 1, file.hunks.length) ?? { index: n + 1, count: file.hunks.length, oldStart: 0, oldLines: 0, newStart: 0, newLines: 0 }
    bodies.push({
      key: `h${n}`,
      rows: [
        <tr key={`h${n}`} className="hunk-header">
          <td colSpan={cols}>
            {canExpand && g.count > 0 && !gapShown(n) && (
              <span className="hunk-expand">
                <Button size="sm" icon={<UnfoldVertical size={12} />} title={t('diff.expandGapTitle')} disabled={context.status === 'loading'} onClick={() => setOpened(new Set(opened).add(n))}>
                  {t('diff.expandGap', { count: g.count })}
                </Button>
              </span>
            )}
            {/* The heading is the hunk's tab stop (the file's first one; the rest are reached by the arrows) and its words are
                the summary; the raw @@ header stays on screen, unread. */}
            <span className="hunk-title" role="heading" aria-level={headingLevel + 1} tabIndex={n === firstHunk ? 0 : -1} data-hunk-heading="">
              <span aria-hidden="true">{file.hunks[n].header}</span>
              <span className="sr-only">{hunkSummary(t, info)}</span>
            </span>
          </td>
        </tr>
      ]
    })
  }

  // Arrow keys: Up and Down walk the hunk headings and the rows (comment, bar and header rows are skipped); Shift extends a
  // selection; Left and Right pick the old or new half in split; Enter comments; Escape (above) drops the selection.
  // One handler, on the table, for events whose target is a heading or a row itself.
  const sideOf = (tr: HTMLElement): Side => {
    const want: Side = split ? half.current : 'new'
    return rowNo(tr, want) !== undefined ? want : want === 'new' ? 'old' : 'new'
  }
  const say = (side: Side, start: number, end: number) =>
    announce(t('diff.kbd.selected', { count: end - start + 1, side: t(side === 'new' ? 'diff.kbd.sideNew' : 'diff.kbd.sideOld'), start, end }), 'diff:selection')
  const onTableKey = (e: ReactKeyboardEvent<HTMLTableElement>) => {
    const target = e.target as HTMLElement
    const isRow = target.matches('tr[data-row]')
    if ((!isRow && !target.hasAttribute('data-hunk-heading')) || e.altKey || e.ctrlKey || e.metaKey) return
    const stops = Array.from(table.current?.querySelectorAll<HTMLElement>('tr[data-row], [data-hunk-heading]') ?? [])
    const at = stops.indexOf(target)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      const dir = e.key === 'ArrowDown' ? 1 : -1
      if (e.shiftKey && isRow && selectable && !draft) {
        // Extend on the selection's side, to the next row that has a number there; never across a break in the numbers.
        const side = sel?.side ?? sideOf(target)
        const from = sel?.side === side ? sel.anchor : rowNo(target, side)
        if (from === undefined) return
        const ahead = dir > 0 ? stops.slice(at + 1) : stops.slice(0, at).reverse()
        const row = ahead.find((el) => el.matches('tr[data-row]') && rowNo(el, side) !== undefined)
        const focus = row ? rowNo(row, side)! : (rowNo(target, side) ?? from)
        const picked = pickLines(shown, side, from, focus)
        if (!picked || focus < picked.start || focus > picked.end) return
        setCommenting(null)
        setSel({ side, anchor: from, focus })
        anchorRow.current = { side, no: from }
        row?.focus()
        say(side, picked.start, picked.end)
        return
      }
      if (sel && !draft) setSel(null)
      stops[at + dir]?.focus()
      return
    }
    if (!isRow) return
    if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && split && !e.shiftKey) {
      e.preventDefault()
      const next: Side = e.key === 'ArrowLeft' ? 'old' : 'new'
      half.current = next
      if (sel && sel.side !== next) setSel(null)
      announce(t(next === 'new' ? 'diffSel.side.new' : 'diffSel.side.old'), 'diff:half')
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !draft) {
      const newNo = rowNo(target, 'new')
      if (selectable) {
        const side = sel?.side ?? sideOf(target)
        const no = rowNo(target, side)
        const current = sel ?? (no === undefined ? null : { side, anchor: no, focus: no })
        if (!current) return
        e.preventDefault()
        anchorRow.current = { side: current.side, no: current.anchor }
        setSel(current)
        act('comment', current)
      } else if (!readonly && newNo !== undefined) {
        // Staged, commits and the like: today's plain comment on the new line.
        e.preventDefault()
        anchorRow.current = { side: 'new', no: newNo }
        setCommenting(newNo)
      }
    }
  }

  const expandLabel = expandAll ? t('diff.collapseAll') : t('diff.expandAll')
  const contextNote = !wantContext
    ? null
    : context.status === 'loading'
      ? t('diff.context.loading')
      : context.status === 'stale'
        ? t('diff.context.stale')
        : context.status === 'tooLarge'
          ? t('diff.context.tooLarge')
          : null

  return (
    <div className="file-diff" ref={root}>
      <div className="file-diff-head">
        <StatusIcon status={file.status} />
        <span className="mono" role="heading" aria-level={headingLevel}>
          {file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
        </span>
        <DiffBadge additions={file.additions} deletions={file.deletions} />
        <span className="spacer" />
        {selectable && !compact && file.hunks.length > 0 && (
          <span className="sel-hint faint small">
            <TextSelect size={12} /> {t('diffSel.hint')}
          </span>
        )}
        {file.hunks.length > 0 && (
          <div className="diff-tools">
            <Segmented
              plain
              small
              label={t('diff.layout.label')}
              aria-describedby={screenReader ? layoutHint : undefined}
              value={prefs.layout}
              onChange={(next) => setDiffPrefs({ layout: next })}
              options={[
                {
                  value: 'unified',
                  label: (
                    <>
                      <Rows2 size={12} /> {t('diff.layout.unified')}
                    </>
                  ),
                  title: t('diff.layout.unifiedTitle')
                },
                {
                  value: 'split',
                  label: (
                    <>
                      <Columns2 size={12} /> {t('diff.layout.split')}
                    </>
                  ),
                  title: narrow ? t('diff.narrow') : t('diff.layout.splitTitle')
                }
              ]}
            />
            {screenReader && (
              <span id={layoutHint} className="sr-only">
                {t('diff.layout.screenReaderHint')}
              </span>
            )}
            <Checkbox className="review-select" title={compact ? t('diff.wrap') : undefined} checked={prefs.wrap} onChange={(e) => setDiffPrefs({ wrap: e.target.checked })}>
              {compact ? t('diff.wrapShort') : t('diff.wrap')}
            </Checkbox>
            {canExpand && (
              <Button
                size="sm"
                variant="ghost"
                icon={expandAll ? <FoldVertical size={12} /> : <UnfoldVertical size={12} />}
                aria-pressed={expandAll}
                title={expandAll ? expandLabel : t('diff.expandAllTitle')}
                aria-label={compact ? expandLabel : undefined}
                onClick={() => setExpandAll(!expandAll)}
              >
                {!compact && expandLabel}
              </Button>
            )}
          </div>
        )}
      </div>
      {narrow && (
        <div className="split-fallback">
          <Columns2 size={13} />
          <span>{t('diff.narrow')}</span>
          <span className="spacer" />
          {leftPanelOpen && (
            <LinkButton size="sm" className="split-link" onClick={toggleLeftPanel}>
              {t('diff.hideSidebar')} <Kbd>{mod}B</Kbd>
            </LinkButton>
          )}
          <LinkButton size="sm" className="split-link" title={t('diff.forceSplitTitle')} onClick={() => setDiffPrefs({ forceSplit: true })}>
            {t('diff.forceSplit')}
          </LinkButton>
        </div>
      )}
      {forced && (
        <div className="split-fallback">
          <Columns2 size={13} />
          <span>{t('diff.forcedNarrow')}</span>
          <span className="spacer" />
          <LinkButton size="sm" className="split-link" onClick={() => setDiffPrefs({ forceSplit: false })}>
            {t('diff.unforceSplit')}
          </LinkButton>
        </div>
      )}
      {contextNote && <div className="split-fallback">{contextNote}</div>}
      {/* G3 · #19: a changed picture in the working-tree diff shows before and after; other binaries stay a line. */}
      {file.binary && (expandable && showsImageDiff(file, mergeBase) ? <ImageDiff file={file} workspaceId={workspaceId} mergeBase={mergeBase} /> : <div className="panel-empty faint">{t('changes.binary')}</div>)}
      {file.hunks.length > 0 && (
        <table
          ref={table}
          className={`hunk ${split ? 'split' : ''} ${prefs.wrap ? '' : 'nowrap'} ${selectable ? 'selectable' : ''}`}
          onMouseOver={selectable ? onTableOver : undefined}
          onMouseDown={selectable ? onTableDown : undefined}
          onKeyDown={onTableKey}
        >
          <caption className="sr-only">{fileSummary(t, file)}</caption>
          {split && (
            <colgroup>
              <col style={{ width: lnWidth }} />
              <col />
              <col style={{ width: lnWidth }} />
              <col />
            </colgroup>
          )}
          <thead>
            <tr>
              {(split ? (['diff.col.oldLine', 'diff.col.oldCode', 'diff.col.newLine', 'diff.col.newCode'] as const) : (['diff.col.oldLine', 'diff.col.newLine', 'diff.col.code'] as const)).map((key) => (
                <th key={key} scope="col">
                  <span className="sr-only">{t(key)}</span>
                </th>
              ))}
            </tr>
          </thead>
          {bodies.map((b) => (
            <tbody key={b.key}>{b.rows}</tbody>
          ))}
        </table>
      )}
      {!showAll && total > LINES_PER_FILE && (
        <Button size="sm" className="show-all" onClick={() => setShowAll(true)}>
          {t('changes.showAll', { count: total })}
        </Button>
      )}
    </div>
  )
}
