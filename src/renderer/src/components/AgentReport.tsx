// #2: an agent's report in its chat. checkpoint and done (and anything answered) are a
// quiet "agent says" line; an open needs-input is a card that stays until the user
// replies in this tab or dismisses it. The words are the agent's, never Foreman's.
import { MessageCircleQuestion } from 'lucide-react'
import { isOpen, type ReportMarker } from '../../../shared/agentReports'
import { api, attempt, useStore } from '../store'
import { formatClock } from '../../../shared/i18n/time'
import { useT } from '../i18n'
import { LinkButton, Tag } from '../ui'
import './agentReports.css'

export function ReportRow({ marker, turnId, sessionId, workspaceId, readOnly }: { marker: ReportMarker; turnId?: string; sessionId: string; workspaceId: string; readOnly?: boolean }) {
  const t = useT()
  const open = useStore((s) => {
    const r = s.snapshot!.workspaces.find((w) => w.id === workspaceId)?.agentReports?.find((x) => x.id === marker.id)
    return Boolean(r && isOpen(r))
  })
  const tab = useStore((s) => {
    const tabs = s.snapshot!.sessions.filter((x) => x.workspaceId === workspaceId && !x.closedAt)
    return tabs.findIndex((x) => x.id === sessionId) + 1
  })
  const kind = t(`reports.kind.${marker.kind}`)
  const via = t(marker.via === 'mcp' ? 'reports.via.mcp' : 'reports.via.cli', { turn: turnId?.slice(0, 8) ?? '?' })
  const link = marker.link && (
    <a href={marker.link} target="_blank" rel="noreferrer">
      {t('reports.link')}
    </a>
  )

  if (open && marker.kind === 'needs-input') {
    return (
      <div className="report-card" title={via}>
        <div className="report-card-head">
          <MessageCircleQuestion size={13} aria-hidden />
          <Tag tone="outline" className="says" title={t('reports.saysTitle')}>
            {t('reports.says')}
          </Tag>
          {kind}
          <span className="report-time">
            {formatClock(marker.at, t.locale)}
            {tab > 0 && ` · ${t('reports.tab', { n: tab })}`}
          </span>
        </div>
        {marker.text && <div className="report-card-body">{marker.text}</div>}
        <div className="report-card-foot">
          <span>{t('reports.card.open')}</span>
          {link}
          <span className="spacer" />
          {!readOnly && (
            <LinkButton size="sm" title={t('reports.card.dismissTitle')} onClick={() => void attempt(() => api.closeAgentReport(workspaceId, marker.id, 'dismissed'))}>
              {t('reports.dismiss')}
            </LinkButton>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="report-marker" title={via}>
      <Tag tone="outline" className="says" title={t('reports.saysTitle')}>
        {t('reports.says')}
      </Tag>
      <span className="report-text">
        {kind}
        {marker.text && ` — ${marker.text}`}
      </span>
      {marker.late && <span>· {t('reports.earlier')}</span>}
      {link}
      <span className="report-time">{formatClock(marker.at, t.locale)}</span>
    </div>
  )
}
