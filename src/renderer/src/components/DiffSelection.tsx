// #15 Diff selection actions: the floating bar over selected diff lines (pick
// the tab first, then Explain / Change this / Ask… / Comment), its tab picker,
// and the comments that quote lines (sent, queued, or held because the lines
// changed). Sending goes through the main process, which checks the lines first.
import { ArrowRight, ChevronDown, MessageCircleQuestion, MessageSquarePlus, Pencil, Plus, Sparkles, TextQuote, Trash2, TriangleAlert } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { AGENTS, modelInfo } from '../../../shared/agents'
import { defaultTab, quoteChanges, splitPrefix } from '../../../shared/diffSelection'
import type { DiffComment, DiffSelection, SelectionSendResult, Session } from '../../../shared/types'
import { useT, type RendererT } from '../i18n'
import { formatClock } from '../../../shared/i18n/time'
import { activeSessionId, api, attempt, getState, openSessions, selectSession, showToast, useStore } from '../store'
import { Button, IconButton, LinkButton, MenuButton, MenuGroup, MenuLabel, MenuRadioItem, MenuSeparator, Tag, TextArea } from '../ui'
import { AgentIcon } from './composer/AgentPicker'
import './diffSelection.css'

// ---- which tab ----

const TAB_PREF = 'switchyard:diffSelectionTab'

function rememberedTabs(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(TAB_PREF) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

/** The tab used for the last selection action in this workspace (kept across restarts). */
export function rememberTab(workspaceId: string, sessionId: string | undefined): void {
  if (!sessionId) return
  try {
    localStorage.setItem(TAB_PREF, JSON.stringify({ ...rememberedTabs(), [workspaceId]: sessionId }))
  } catch {
    // Not remembered; fine.
  }
}

/** The tab the bar starts with: the last one used here, else the one on screen, else the first; 'new' when none is open. */
export function useDefaultTab(workspaceId: string): string {
  const open = useStore((s) => openSessions(s.snapshot!, workspaceId).map((x) => x.id).join('\n'))
  const active = useStore((s) => activeSessionId(s, workspaceId))
  return defaultTab(open ? open.split('\n') : [], rememberedTabs()[workspaceId], active)
}

/** "Tab 1 · Claude Code", "New chat", or "a closed tab". */
export function tabName(t: RendererT, sessions: Session[], id: string | undefined, short = false): string {
  if (!id || id === 'new') return t('diffSel.newChat')
  const n = sessions.findIndex((s) => s.id === id)
  if (n === -1) return t('diffSel.closedTab')
  return short ? t('diffSel.tabShort', { n: n + 1 }) : t('diffSel.tab', { n: n + 1, agent: AGENTS[sessions[n].agent].label })
}

/** G2: "changed by Tab 2" from the tabs whose turns touched the file; who did isn't known when none did. Null: not looked. */
export function changedByText(t: RendererT, tabs: Session[], changedBy: string[] | undefined): string | null {
  if (!changedBy) return null
  if (!changedBy.length) return t('diffSel.changedBy.unknown')
  return t('diffSel.changedBy.tabs', { tabs: changedBy.map((id) => tabName(t, tabs, id, true)).join(', ') })
}

function useOpenTabs(workspaceId: string): Session[] {
  const all = useStore((s) => s.snapshot!.sessions)
  return all.filter((s) => s.workspaceId === workspaceId && !s.closedAt)
}

/** The toast after a selection action, and the tab it is remembered by. */
export function reportSend(t: RendererT, workspaceId: string, result: SelectionSendResult | undefined): void {
  if (!result) return
  rememberTab(workspaceId, result.sessionId)
  const snapshot = getState().snapshot
  const tab = tabName(t, snapshot ? openSessions(snapshot, workspaceId) : [], result.sessionId)
  if (result.status === 'held') showToast(t('diffSel.toast.held'), 'error')
  else showToast(result.status === 'queued' ? t('diffSel.toast.queued', { tab }) : t('diffSel.toast.sent', { tab }))
}

/** "Send to: Tab 1 · Claude Code ▾" and its menu of this workspace's tabs, plus New chat. */
export function TabPicker({ workspaceId, value, onChange }: { workspaceId: string; value: string; onChange: (id: string) => void }) {
  const t = useT()
  const tabs = useOpenTabs(workspaceId)
  const loadout = useStore((s) => s.snapshot!.settings.loadouts[0])
  const current = tabs.find((s) => s.id === value)
  return (
    <MenuButton
      look="chip"
      className="sel-dest-wrap"
      menuClassName="sel-dest-menu"
      placement="bottom-start"
      label={t('diffSel.menu.heading')}
      title={t('diffSel.sendToTitle')}
      trigger={
        <>
          {current ? <AgentIcon agent={current.agent} size={12} /> : <Plus size={12} />} {t('diffSel.sendTo')} <b>{tabName(t, tabs, value)}</b>
          <ChevronDown size={12} className="faint" />
        </>
      }
    >
      <MenuLabel>{t('diffSel.menu.heading')}</MenuLabel>
      <MenuGroup label={t('diffSel.menu.heading')}>
        {tabs.map((s, n) => (
          <MenuRadioItem
            key={s.id}
            checked={s.id === value}
            onSelect={() => onChange(s.id)}
            icon={<AgentIcon agent={s.agent} size={12} />}
            hint={`${modelInfo(s.agent, s.model).label} · ${s.status === 'running' || s.queue.length ? t('diffSel.menu.working') : t('diffSel.menu.idle')}`}
          >
            <span className="sel-dest-num">{n + 1}</span> {s.title || t('diffSel.tabShort', { n: n + 1 })}
          </MenuRadioItem>
        ))}
        {tabs.length > 0 && <MenuSeparator />}
        <MenuRadioItem
          checked={value === 'new'}
          onSelect={() => onChange('new')}
          icon={<Plus size={12} />}
          hint={loadout ? modelInfo(loadout.agent, loadout.model).label : undefined}
        >
          {t('diffSel.newChat')}
        </MenuRadioItem>
      </MenuGroup>
      <MenuLabel>{t('diffSel.menu.note')}</MenuLabel>
    </MenuButton>
  )
}

export type BarAction = 'explain' | 'change' | 'ask' | 'comment'

/** The floating bar under the last selected line. */
export function SelectionBar({
  workspaceId,
  count,
  target,
  onTarget,
  onAction,
  busy
}: {
  workspaceId: string
  count: number
  target: string
  onTarget: (id: string) => void
  onAction: (action: BarAction) => void
  busy: boolean
}) {
  const t = useT()
  return (
    <div className="sel-bar" role="toolbar" aria-label={t('diffSel.barLabel')} onMouseDown={(e) => e.stopPropagation()}>
      <TabPicker workspaceId={workspaceId} value={target} onChange={onTarget} />
      <span className="sel-sep" />
      <Button size="sm" variant="ghost" icon={<Sparkles size={12} />} title={t('diffSel.explainTitle')} disabled={busy} onClick={() => onAction('explain')}>
        {t('diffSel.explain')}
      </Button>
      <Button size="sm" variant="ghost" icon={<Pencil size={12} />} title={t('diffSel.changeTitle')} disabled={busy} onClick={() => onAction('change')}>
        {t('diffSel.change')}
      </Button>
      <Button size="sm" variant="ghost" icon={<MessageCircleQuestion size={12} />} title={t('diffSel.askTitle')} disabled={busy} onClick={() => onAction('ask')}>
        {t('diffSel.ask')}
      </Button>
      <span className="sel-sep" />
      <Button size="sm" variant="ghost" icon={<MessageSquarePlus size={12} />} title={t('diffSel.commentTitle')} disabled={busy} onClick={() => onAction('comment')}>
        {t('diffSel.comment')}
      </Button>
      <span className="sel-count faint small">{t('diffSel.count', { count })}</span>
    </div>
  )
}

// ---- comments that quote lines ----

const base = (file: string) => file.slice(file.lastIndexOf('/') + 1)

export function quoteHead(t: RendererT, file: string, sel: DiffSelection): string {
  const range = sel.start === sel.end ? t('diffSel.line', { start: sel.start }) : t('diffSel.range', { count: sel.end - sel.start + 1, start: sel.start, end: sel.end })
  return `${base(file)} · ${range} · ${sel.side === 'new' ? t('diffSel.side.new') : t('diffSel.side.old')}`
}

function Quote({ head, rows, dim }: { head?: string; rows: { kind: string; no?: number; text: string }[]; dim?: boolean }) {
  return (
    <div className={`comment-quote ${dim ? 'dim' : ''}`}>
      {head && (
        <div className="comment-quote-head faint">
          <TextQuote size={11} /> {head}
        </div>
      )}
      <table>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.kind}>
              <td className="ln">{r.no ?? ''}</td>
              <td>
                {r.kind === 'add' ? '+ ' : r.kind === 'del' ? '- ' : ''}
                {r.text}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

const quoteRows = (sel: DiffSelection, lines: string[]) => lines.map((text, i) => ({ kind: sel.side === 'new' ? 'add' : 'del', no: sel.start + i, text }))

/** The selected lines a comment quotes, under "Sidebar.tsx · lines 40–46 · new side". */
export function SelectionQuote({ comment }: { comment: DiffComment }) {
  const t = useT()
  const sel = comment.selection!
  return <Quote head={quoteHead(t, comment.file, sel)} rows={quoteRows(sel, sel.lines)} />
}

/** The comment's text with its prefix ("Change this:") in bold. */
export function CommentText({ body }: { body: string }) {
  const { prefix, rest } = splitPrefix(body)
  return (
    <div className="comment-body">
      {prefix && <span className="comment-prefix">{prefix}</span>}
      {rest}
    </div>
  )
}

/** A diff comment that quotes selected lines: sent, queued, waiting with your next message, or held. */
export function SelectionComment({ comment, children }: { comment: DiffComment; children?: ReactNode }) {
  const t = useT()
  const sel = comment.selection!
  const tabs = useOpenTabs(comment.workspaceId)
  const fallback = useDefaultTab(comment.workspaceId)
  const [review, setReview] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const held = comment.state === 'held'
  // A held comment goes to its tab, or (when that tab is closed) to the one the bar would pick.
  const target = comment.sessionId && tabs.some((s) => s.id === comment.sessionId) ? comment.sessionId : fallback
  const tab = tabName(t, tabs, comment.sessionId ?? target)
  const run = async (how: 'check' | 'selected' | 'current') => {
    setBusy(true)
    const result = await attempt(() => api.resendDiffSelection(comment.id, how, target))
    setBusy(false)
    if (how !== 'current') reportSend(t, comment.workspaceId, result)
    if (result) setReview(false)
  }
  const saveEdit = async () => {
    if (editing === null) return
    if (editing.trim()) await attempt(() => api.updateComment(comment.id, { body: editing.trim() }))
    setEditing(null)
  }
  return (
    <div className={`inline-comment user ${comment.stale ? 'stale' : ''}`}>
      <div className="comment-meta faint small">
        <span>{t('changes.comment.you')}</span>
        {comment.state === 'sent' && <Tag>{t('diffSel.pill.sent', { tab })}</Tag>}
        {comment.state === 'sent' && comment.outdated && <Tag tone="warn">{t('diffSel.pill.outdated')}</Tag>}
        {comment.state === 'queued' && <Tag tone="info">{t('diffSel.pill.queued', { tab })}</Tag>}
        {held && <Tag tone="warn">{t('diffSel.pill.held')}</Tag>}
        {held && <span>{t('diffSel.for', { tab: tabName(t, tabs, target) })}</span>}
        {children}
        {comment.sentAt && <span>{formatClock(comment.sentAt, t.locale)}</span>}
        <span className="spacer" />
        {(comment.state === 'sent' || comment.state === 'queued') && comment.sessionId && tabs.some((s) => s.id === comment.sessionId) && (
          <LinkButton size="sm" className="sel-open-link" title={t('diffSel.openTitle')} onClick={() => selectSession(comment.workspaceId, comment.sessionId!)}>
            {t('diffSel.open', { tab: tabName(t, tabs, comment.sessionId, true) })} <ArrowRight size={11} />
          </LinkButton>
        )}
        <IconButton label={t('diffSel.delete')} onClick={() => void attempt(() => api.deleteComment(comment.id))}>
          <Trash2 size={12} />
        </IconButton>
      </div>
      {comment.stale && (
        <div className="stale-line">
          <TriangleAlert size={13} /> {t('diffSel.stale')} ·{' '}
          {changedByText(t, tabs, comment.stale.changedBy) && <>{changedByText(t, tabs, comment.stale.changedBy)} · </>}
          <LinkButton aria-expanded={review} onClick={() => setReview(!review)}>
            {review ? t('diffSel.hideReview') : t('diffSel.review')}
          </LinkButton>
        </div>
      )}
      {editing === null ? (
        <CommentText body={comment.body} />
      ) : (
        <div className="comment-box">
          <TextArea
            autoFocus
            rows={2}
            aria-label={t('diffSel.edit')}
            value={editing}
            onChange={(e) => setEditing(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void saveEdit()
              if (e.key === 'Escape') setEditing(null)
            }}
          />
        </div>
      )}
      {comment.stale && review ? (
        <div className="stale-review">
          <span className="faint small">{t('diffSel.reviewWhen', { selected: formatClock(sel.at, t.locale), checked: formatClock(comment.stale.checkedAt, t.locale) })}</span>
          {comment.stale.lines.length === 0 && <span className="faint small">{t('diffSel.gone')}</span>}
          <Quote rows={quoteChanges(sel.lines, comment.stale.lines, sel.start).map((c) => ({ kind: c.kind === 'same' ? 'context' : c.kind, no: c.no, text: c.text }))} />
        </div>
      ) : (
        <Quote head={quoteHead(t, comment.file, sel)} rows={quoteRows(sel, sel.lines)} dim={Boolean(comment.stale)} />
      )}
      {held && (
        <div className="comment-actions-row">
          {editing === null ? (
            <Button size="sm" icon={<Pencil size={12} />} disabled={busy} onClick={() => setEditing(comment.body)}>
              {t('diffSel.edit')}
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={() => setEditing(null)}>
                {t('diffSel.cancel')}
              </Button>
              <Button size="sm" variant="primary" disabled={!editing.trim()} onClick={() => void saveEdit()}>
                {t('diffSel.save')}
              </Button>
            </>
          )}
          <span className="spacer" />
          {comment.stale ? (
            <>
              <Button size="sm" disabled={busy || editing !== null} title={t('diffSel.sendSelectedTitle')} onClick={() => void run('selected')}>
                {t('diffSel.sendSelected')}
              </Button>
              <Button size="sm" variant="primary" disabled={busy || editing !== null || comment.stale.lines.length === 0} title={t('diffSel.quoteCurrentTitle')} onClick={() => void run('current')}>
                {t('diffSel.quoteCurrent')}
              </Button>
            </>
          ) : (
            <Button size="sm" variant="primary" disabled={busy || editing !== null} title={t('diffSel.sendNowTitle', { tab: tabName(t, tabs, target) })} onClick={() => void run('check')}>
              {t('diffSel.sendNow')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

/** The comment box for Change this / Ask… / Comment on a selection, prefilled with the action's prefix. */
export function SelectionDraftBox({
  initial,
  sendLabel,
  placeholder,
  onSend,
  onCancel
}: {
  initial: string
  sendLabel: string
  placeholder: string
  onSend: (body: string) => void
  onCancel: () => void
}) {
  const t = useT()
  const [body, setBody] = useState(initial)
  const ready = body.trim() && body.trim() !== initial.trim()
  return (
    <div className="comment-box" onMouseDown={(e) => e.stopPropagation()}>
      <TextArea
        autoFocus
        rows={2}
        aria-label={placeholder}
        placeholder={placeholder}
        value={body}
        onFocus={(e) => e.currentTarget.setSelectionRange(body.length, body.length)}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && ready) onSend(body)
          if (e.key === 'Escape') onCancel()
        }}
      />
      <div className="comment-actions">
        <Button size="sm" onClick={onCancel}>
          {t('diffSel.cancel')}
        </Button>
        <Button size="sm" variant="primary" onClick={() => onSend(body)} disabled={!ready}>
          {sendLabel}
        </Button>
      </div>
    </div>
  )
}
