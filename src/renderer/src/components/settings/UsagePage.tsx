import { useEffect, useState } from 'react'
import { AGENTS, modelInfo } from '../../../../shared/agents'
import { formatNumber } from '../../../../shared/i18n/time'
import { costText, type UsageFigures, type UsageReport } from '../../../../shared/usageReport'
import { useT } from '../../i18n'
import { api, attempt, selectWorkspace, useStore } from '../../store'
import { formatDuration } from '../turnResult'
import { LinkButton, Segmented } from '../../ui'
import { Page, Section } from './controls'

const RANGES = [7, 30, 90]

/** Settings → Usage: what was reported, by repo and by model. Unknown stays unknown. */
export function UsagePage() {
  const t = useT()
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<UsageReport | null>(null)
  const repos = useStore((s) => s.snapshot!.repos)
  const workspaces = useStore((s) => s.snapshot!.workspaces)
  // Which row's workspace list is open.
  const [open, setOpen] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void attempt(() => api.usageReport(days)).then((r) => alive && r && setReport(r))
    return () => {
      alive = false
    }
  }, [days])

  const maxTurns = Math.max(1, ...(report?.byModel.map((m) => m.turns) ?? []), ...(report?.byRepo.map((r) => r.turns) ?? []))
  const workspaceLinks = (key: string, f: UsageFigures) =>
    open === key && (
      <div className="usage-workspaces">
        {f.workspaceIds.map((id) => {
          const ws = workspaces.find((w) => w.id === id)
          return ws ? (
            <LinkButton key={id} onClick={() => selectWorkspace(id)}>
              {ws.state === 'archived' ? t('settings.usage.archivedName', { name: ws.name }) : ws.name}
            </LinkButton>
          ) : null
        })}
      </div>
    )
  const opener = (key: string, f: UsageFigures, label: string) => (
    <LinkButton disabled={!f.workspaceIds.length} onClick={() => setOpen(open === key ? null : key)}>
      {label}
    </LinkButton>
  )
  const costCell = (f: UsageFigures) => {
    const text = costText(f)
    return text ? <span className="mono small">{text}</span> : <span className="mono small faint">{t('common.unknown')}</span>
  }
  const bar = (f: UsageFigures) => (
    <div className="usage-bar" title={t('settings.usage.barTitle', { known: f.costKnownTurns, unknown: f.costUnknownTurns })}>
      <div className="usage-bar-known" style={{ width: `${(f.costKnownTurns / maxTurns) * 100}%` }} />
      <div className="usage-bar-unknown" style={{ width: `${(f.costUnknownTurns / maxTurns) * 100}%` }} />
    </div>
  )

  return (
    <Page title={t('settings.page.usage')} description={t('settings.usage.desc')}>
      <Segmented
        plain
        small
        className="usage-range"
        label={t('settings.usage.range')}
        value={String(days)}
        options={RANGES.map((d) => ({ value: String(d), label: t('settings.usage.lastDays', { count: d }) }))}
        onChange={(d) => setDays(Number(d))}
      />
      {!report && <p className="set-help">{t('settings.usage.reading')}</p>}
      {report && (
        <>
          <div className="usage-stats">
            <div className="usage-stat">
              <b>{costText(report.total) ?? t('common.unknown')}</b>
              <span>{report.total.costUsd !== null && report.total.partial ? t('settings.usage.stat.costPartial') : t('settings.usage.stat.cost')}</span>
            </div>
            <div className="usage-stat">
              <b>{formatNumber(report.total.turns, t.locale)}</b>
              <span>{t('settings.usage.stat.turns')}</span>
            </div>
            <div className="usage-stat">
              <b>{formatDuration(report.total.agentMs)}</b>
              <span>{t('settings.usage.stat.agentTime')}</span>
            </div>
            <div className="usage-stat">
              <b>{opener('total', report.total, String(report.total.workspaceIds.length))}</b>
              <span>{t('settings.usage.stat.workspaces')}</span>
            </div>
          </div>
          {workspaceLinks('total', report.total)}
          {report.total.turns === 0 && <p className="set-help">{t('settings.usage.empty', { count: days })}</p>}

          {report.total.turns > 0 && (
            <>
              <Section title={t('settings.usage.byModel')} plain>
                <div className="set-card usage-card">
                  {report.byModel.map((m) => {
                    const key = `m:${m.agent}:${m.model}`
                    return (
                      <div key={key} className="usage-row">
                        <span className="usage-name">{modelInfo(m.agent, m.model).label || AGENTS[m.agent].label}</span>
                        {bar(m)}
                        {costCell(m)}
                        <span className="small faint">{t('settings.usage.rowFigures', { count: m.turns, duration: formatDuration(m.agentMs) })}</span>
                        {opener(key, m, t('settings.usage.workspaces', { count: m.workspaceIds.length }))}
                        {workspaceLinks(key, m)}
                      </div>
                    )
                  })}
                </div>
                <p className="set-help">{t('settings.usage.hatchedNote')}</p>
              </Section>
              <Section title={t('settings.usage.byRepo')} plain>
                <div className="set-card usage-card">
                  {report.byRepo.map((r) => {
                    const key = `r:${r.repoId}`
                    return (
                      <div key={key} className="usage-row">
                        <span className="usage-name">{repos.find((x) => x.id === r.repoId)?.name ?? t('settings.usage.removedRepo')}</span>
                        {bar(r)}
                        {costCell(r)}
                        <span className="small faint">{t('settings.usage.rowFigures', { count: r.turns, duration: formatDuration(r.agentMs) })}</span>
                        {opener(key, r, t('settings.usage.openWorkspaces', { count: r.workspaceIds.length }))}
                        {workspaceLinks(key, r)}
                      </div>
                    )
                  })}
                </div>
              </Section>
            </>
          )}
        </>
      )}
    </Page>
  )
}
