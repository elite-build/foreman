import { useEffect, useState } from 'react'
import { BACKFILL_DAYS, type LangfuseExportStatus } from '../../../../shared/langfuseExport'
import { formatDateTime, formatNumber } from '../../../../shared/i18n/time'
import { useT } from '../../i18n'
import { api, attempt, showToast, useStore } from '../../store'
import { Button, Callout, Select, Spinner } from '../../ui'
import { flashSaved, Row, Section, ToggleRow } from './controls'

/**
 * Settings → Data → Langfuse (docs/telemetry.md, "Langfuse"): where this computer sends Foreman's own traces. Its calls
 * are the window's own, so a phone or browser showing Settings draws nothing here.
 */
export function LangfuseExportSection() {
  const t = useT()
  // The store's own array, filtered here: a selector that made a new array each time would never settle.
  const connections = useStore((s) => s.snapshot!.integrations.connections).filter((c) => c.service === 'langfuse')
  const [status, setStatus] = useState<LangfuseExportStatus | null>(null)
  const [days, setDays] = useState<string>(String(BACKFILL_DAYS[1]))
  const sending = Boolean(status?.backfill)
  const refresh = () => void api.langfuseExportStatus().then(setStatus, () => setStatus(null))
  useEffect(() => {
    refresh()
    // Faster while earlier turns are being sent, so the count moves.
    const timer = setInterval(refresh, sending ? 2_000 : 10_000)
    return () => clearInterval(timer)
  }, [sending])

  if (!status) return null
  const on = status.connectionId !== null
  const choose = async (connectionId: string) => {
    const next = await attempt(() => api.setLangfuseExport({ connectionId: connectionId || null, content: connectionId ? status.content : false }))
    if (next) {
      setStatus(next)
      flashSaved()
    }
  }
  const setContent = async (content: boolean) => {
    const next = await attempt(() => api.setLangfuseExport({ connectionId: status.connectionId, content }))
    if (next) {
      setStatus(next)
      flashSaved()
    }
  }
  const sendEarlier = async () => {
    const next = await attempt(() => api.sendEarlierToLangfuse(Number(days)))
    if (next) {
      setStatus(next)
      showToast(t('settings.langfuse.backfillStarted'))
    }
  }

  const options = [
    { value: '', label: t('common.off') },
    ...connections.map((c) => ({ value: c.id, label: c.identity?.org ? `${c.name} · ${c.identity.org}` : c.name }))
  ]
  const sent = status.lastSentAt
    ? t('settings.langfuse.lastSent', { date: formatDateTime(status.lastSentAt, t.locale), turns: formatNumber(status.sentTurns, t.locale), events: formatNumber(status.sentEvents, t.locale) })
    : t('settings.langfuse.nothingSent')

  return (
    <>
      <Section part="langfuse" title={t('settings.langfuse.title')} description={t('settings.langfuse.desc')}>
        <Row
          id="langfuse-export"
          label={t('settings.langfuse.project')}
          help={connections.length ? t('settings.langfuse.project.help', { device: status.device.name }) : t('settings.langfuse.noConnection')}
          detail={status.otherMachine ? t('settings.langfuse.otherMachine', { machine: status.otherMachine }) : undefined}
        >
          {(control) => <Select {...control} value={status.connectionId ?? ''} onChange={(id) => void choose(id)} options={options} disabled={!connections.length && !on} />}
        </Row>
        <ToggleRow
          id="langfuse-content"
          label={t('settings.langfuse.content')}
          help={t('settings.langfuse.content.help')}
          checked={status.content}
          disabled={!on}
          onChange={(content) => void setContent(content)}
        />
        {on && (
          <Row
            id="langfuse-backfill"
            label={t('settings.langfuse.backfill')}
            help={status.backfill ? t('settings.langfuse.backfillProgress', { done: formatNumber(status.backfill.done, t.locale), total: formatNumber(status.backfill.total, t.locale) }) : sent}
          >
            <Select
              label={t('settings.langfuse.backfillDays')}
              value={days}
              onChange={setDays}
              disabled={sending}
              options={BACKFILL_DAYS.map((d) => ({ value: String(d), label: t('settings.langfuse.days', { count: d }) }))}
            />
            <Button size="sm" disabled={sending} icon={sending ? <Spinner size={13} /> : undefined} onClick={() => void sendEarlier()}>
              {t('settings.langfuse.send')}
            </Button>
          </Row>
        )}
      </Section>
      {on && status.lastError && (
        <Callout tone="error" role="alert" className="set-after-card">
          {status.lastError}
        </Callout>
      )}
    </>
  )
}
