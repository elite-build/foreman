import { ExternalLink, RotateCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PullRequestInfo, ReviewThread } from '../../../shared/types'
import { activeSessionId, api, getState, requestOpenFile, selectSession, showToast } from '../store'
import { useT } from '../i18n'
import { Button, Callout, Checkbox, IconButton, LinkButton, Spinner, Tag } from '../ui'
import { formatDateTime } from '../../../shared/i18n/time'
import { Markdown } from './Markdown'

export function Reviews({ workspaceId, pr, onCount }: { workspaceId: string; pr: PullRequestInfo; onCount?: (unresolved: number | null) => void }) {
  const [threads, setThreads] = useState<ReviewThread[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  const t = useT()
  // O2: GitLab discussions, read-only, in the same list.
  const gitlab = pr.provider === 'gitlab'

  useEffect(() => {
    let disposed = false
    setLoading(true)
    setError('')
    void api
      .reviewThreads(workspaceId)
      .then((found) => {
        if (disposed) return
        setThreads(found)
        setSelected((ids) => ids.filter((id) => found.some((t) => t.id === id && !t.isResolved)))
      })
      .catch((err) => {
        if (!disposed) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!disposed) setLoading(false)
      })
    return () => {
      disposed = true
    }
  }, [workspaceId, pr.number, pr.url, refresh])

  const unresolved = threads.filter((t) => !t.isResolved)
  // The checks row quotes this count; unknown while loading or after an error.
  const count = loading || error ? null : unresolved.length
  useEffect(() => onCount?.(count), [count, onCount])
  const send = async () => {
    setSending(true)
    setError('')
    try {
      const sessionId = await api.sendReviewThreads(workspaceId, selected, activeSessionId(getState(), workspaceId))
      selectSession(workspaceId, sessionId)
      setSelected([])
      showToast(t('reviews.sent'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="checks-group reviews">
      <div className="checks-head">
        <span>{t('reviews.title')}{!loading && ` · ${t('reviews.unresolved', { count: unresolved.length })}`}</span>
        <span className="spacer" />
        <IconButton label={t('reviews.refresh')} disabled={loading || sending} onClick={() => setRefresh((n) => n + 1)}>
          {loading ? <Spinner size={13} /> : <RotateCw size={13} />}
        </IconButton>
      </div>
      {pr.reviewDecision && (
        <div className="faint small review-summary">
          {pr.reviewDecision === 'APPROVED'
            ? t('reviews.approved')
            : pr.reviewDecision === 'CHANGES_REQUESTED'
              ? t('gitPanel.changesRequested')
              : t('reviews.required')}
        </div>
      )}
      {pr.body && (
        <details className="pr-description">
          <summary>{gitlab ? t('gitlab.reviews.description') : t('reviews.description')}</summary>
          <Markdown text={pr.body} />
        </details>
      )}
      {loading && (
        <div className="faint small pad" role="status">
          {t('reviews.loading')}
        </div>
      )}
      {error && (
        <Callout tone="error" role="alert">
          {error}
        </Callout>
      )}
      {!loading && !error && !unresolved.length && <div className="faint small pad">{t('reviews.none')}</div>}
      {gitlab && !loading && unresolved.length > 0 && <div className="faint small pad">{t('gitlab.reviews.noContext')}</div>}
      {!loading && unresolved.length > 0 && (
        <div className="review-actions">
          <Checkbox
            className="review-select"
            aria-label={t('reviews.selectAllAria')}
            checked={selected.length === unresolved.length}
            disabled={sending}
            onChange={(e) => setSelected(e.target.checked ? unresolved.map((t) => t.id) : [])}
          >
            {t('reviews.selectAll')}
          </Checkbox>
          <Button size="sm" icon={sending ? <Spinner size={12} /> : undefined} disabled={!selected.length || sending || Boolean(error)} onClick={() => void send()}>
            {t('reviews.send', { count: selected.length })}
          </Button>
        </div>
      )}
      {unresolved.map((thread) => (
        <div className="review-thread" key={thread.id}>
          <div className="review-thread-head">
            <Checkbox
              aria-label={t('reviews.selectThread', { place: `${thread.path}${thread.line ? `:${thread.line}` : ''}` })}
              disabled={sending || loading}
              checked={selected.includes(thread.id)}
              onChange={(e) => setSelected((ids) => (e.target.checked ? [...ids, thread.id] : ids.filter((id) => id !== thread.id)))}
            />
            {!thread.path ? (
              <span className="small">{t('gitlab.reviews.general')}</span>
            ) : (
              <LinkButton
                size="sm"
                mono
                title={thread.path}
                onClick={() =>
                  requestOpenFile(
                    workspaceId,
                    thread.path,
                    thread.side === 'RIGHT' && !thread.isOutdated ? (thread.line ?? undefined) : undefined
                  )
                }
              >
                {thread.path}
                {thread.line ? `:${thread.line}` : ''}
              </LinkButton>
            )}
            {thread.side === 'LEFT' && <Tag>{t('reviews.base')}</Tag>}
            {thread.isOutdated && <Tag>{t('reviews.outdated')}</Tag>}
          </div>
          {thread.comments.map((comment, i) => (
            <div key={comment.id} className={`review-comment ${i ? 'review-reply' : ''}`}>
              <div className="review-comment-meta faint small">
                <span>@{comment.author}</span>
                {comment.updatedAt !== comment.createdAt && <span title={formatDateTime(comment.updatedAt, t.locale)}>{t('reviews.edited')}</span>}
                <span className="spacer" />
                <IconButton
                  label={gitlab ? `${t('gitlab.reviews.openComment')} (@${comment.author})` : t('reviews.openCommentBy', { author: comment.author })}
                  onClick={() => void api.openExternal(comment.url)}
                >
                  <ExternalLink size={11} />
                </IconButton>
              </div>
              <Markdown text={comment.body} />
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
