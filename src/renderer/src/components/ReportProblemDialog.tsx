// Help → Report a problem… and ⌘K (O20): describe it, check the diagnostics
// Foreman filled in, then open a pre-filled GitHub issue in the browser or copy
// the report. Nothing is ever sent from here; the user posts it themselves.
import { CircleDot, Copy, ExternalLink, Eye, PenLine } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  buildReport,
  formatDiagnostics,
  planIssue,
  redact,
  reportText,
  unredacted,
  type RedactionKind,
  type RedactSegment,
  type ReportDiagnostics
} from '../../../shared/reportProblem'
import { useT, type RendererT } from '../i18n'
import { api, attempt, openReportProblem, showToast, useStore } from '../store'
import { Button, Dialog, Field, LinkButton, Segmented, Switch, TextArea } from '../ui'
import './reportProblem.css'

type Destination = 'github' | 'copy'

const KINDS: RedactionKind[] = ['path', 'user', 'token', 'email']

/** "3 paths, 1 token" for the switch's help line. */
function redactionSummary(t: RendererT, counts: Record<RedactionKind, number>, total: number): string {
  const detail = KINDS.filter((k) => counts[k] > 0)
    .map((k) => t(`report.redact.${k}`, { count: counts[k] }))
    .join(', ')
  return t('report.redact.summary', { count: total, detail })
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

/** Text with each replacement highlighted; `source` shows what will be replaced instead of what replaces it. */
function Highlighted({ segments, source, t }: { segments: RedactSegment[]; source?: boolean; t: RendererT }): ReactNode {
  return segments.map((s, i) =>
    s.kind ? (
      <mark key={i} className="redact" title={source ? undefined : t('report.redact.was', { original: s.original ?? '' })}>
        {source ? s.original : s.text}
      </mark>
    ) : (
      s.text
    )
  )
}

export function ReportProblemDialog() {
  const t = useT()
  const close = () => openReportProblem(false)
  const [info, setInfo] = useState<ReportDiagnostics | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  // G4 O20: opened from an error toast's Report… link, the error starts What happened.
  const about = useStore((s) => s.reportProblemAbout)
  const [description, setDescription] = useState(() => (about ? `${about}\n\n` : ''))
  // What Foreman collected (for Reset), and the user's edited copy.
  const [collected, setCollected] = useState('')
  const [diagnostics, setDiagnostics] = useState('')
  const [redactOn, setRedactOn] = useState(true)
  const [destination, setDestination] = useState<Destination>('github')
  const [preview, setPreview] = useState(false)
  const [busy, setBusy] = useState(false)
  const backdrop = useRef<HTMLPreElement>(null)

  useEffect(() => {
    let live = true
    api.reportDiagnostics().then(
      (d) => {
        if (!live) return
        const text = formatDiagnostics(d)
        setInfo(d)
        setCollected(text)
        setDiagnostics(text)
        if (!d.repo) setDestination('copy')
      },
      (err: unknown) => live && setLoadError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      live = false
    }
  }, [])

  const loading = !info && !loadError
  const context = useMemo(() => ({ home: info?.home, user: info?.user }), [info])
  const repo = info?.repo ?? null
  const report = useMemo(() => buildReport(description, diagnostics, redactOn, context), [description, diagnostics, redactOn, context])
  // What the editor marks: the text each replacement will remove.
  const marks = useMemo(() => (redactOn ? redact(diagnostics, context) : unredacted(diagnostics)), [diagnostics, redactOn, context])
  const plan = useMemo(() => (repo ? planIssue(repo, report.title.text, report.body.text) : null), [repo, report])
  const toGithub = destination === 'github' && plan !== null

  const send = async () => {
    const text = reportText({ title: report.title.text, body: report.body.text })
    setBusy(true)
    try {
      if (!toGithub) {
        if (!(await copyText(text))) return showToast(t('report.copyFailed'), 'error', { report: false })
        showToast(t('report.copied'))
        return close()
      }
      if (plan.copy && !(await copyText(text))) return showToast(t('report.copyFailed'), 'error', { report: false })
      const opened = await attempt(async () => {
        await api.openExternal(plan.url)
        return true
      })
      if (!opened) return
      showToast(t(plan.copy ? 'report.openedCopied' : 'report.opened'))
      close()
    } finally {
      setBusy(false)
    }
  }

  const syncScroll = (el: HTMLTextAreaElement) => {
    if (!backdrop.current) return
    backdrop.current.scrollTop = el.scrollTop
    backdrop.current.scrollLeft = el.scrollLeft
  }

  return (
    <Dialog
      title={t('report.title')}
      size="lg"
      className="dlg report-modal"
      onClose={close}
      footer={
        <>
          <Button variant="ghost" className="dlg-start" icon={preview ? <PenLine size={13} /> : <Eye size={13} />} onClick={() => setPreview((p) => !p)}>
            {preview ? t('report.edit') : t('report.preview')}
          </Button>
          <Button onClick={close}>{t('report.cancel')}</Button>
          <Button variant="primary" icon={toGithub ? <ExternalLink size={13} /> : <Copy size={13} />} disabled={busy || loading} onClick={() => void send()}>
            {toGithub ? t('report.openIssue') : t('report.copyReport')}
          </Button>
        </>
      }
    >
      <p className="muted rp-lede">{t('report.lede')}</p>

      {preview ? (
        <div className="rp-preview" role="group" aria-label={t('report.previewHeading')}>
          <div className="faint small">{t('report.previewHeading')}</div>
          <div className="rp-preview-title">
            <Highlighted segments={report.title.segments} t={t} />
          </div>
          <pre className="rp-preview-body">
            <Highlighted segments={report.body.segments} t={t} />
          </pre>
        </div>
      ) : (
        <>
          <Field label={t('report.whatHappened')}>
            {(control) => (
              <TextArea
                {...control}
                rows={3}
                className="rp-desc"
                value={description}
                placeholder={t('report.whatHappenedPlaceholder')}
                onChange={(e) => setDescription(e.target.value)}
                autoFocus
              />
            )}
          </Field>

          <div className="dlg-group">
            <div className="rp-label-line">
              <span id="rp-diag-label" className="dlg-label">
                {t('report.diagnostics')}
              </span>
              <span className="spacer" />
              <span className="faint small">{t('report.diagnosticsHint')}</span>
              <LinkButton size="sm" title={t('report.resetTitle')} disabled={diagnostics === collected} onClick={() => setDiagnostics(collected)}>
                {t('report.reset')}
              </LinkButton>
            </div>
            <div className="rp-diag-wrap">
              <pre ref={backdrop} className="rp-diag rp-diag-copy rp-diag-marks" aria-hidden="true">
                <Highlighted segments={marks.segments} source t={t} />
                {'\n'}
              </pre>
              <TextArea
                bare
                mono
                className="rp-diag rp-diag-input"
                aria-labelledby="rp-diag-label"
                value={diagnostics}
                placeholder={loading ? t('report.loading') : undefined}
                disabled={loading}
                wrap="off"
                spellCheck={false}
                onChange={(e) => setDiagnostics(e.target.value)}
                onScroll={(e) => syncScroll(e.currentTarget)}
              />
            </div>
            {loadError && (
              <small className="error-text" role="alert">
                {t('report.loadFailed', { error: loadError })}
              </small>
            )}
            <small className="dlg-hint">{t('report.notIncluded')}</small>
          </div>
        </>
      )}

      <div className="rp-row">
        <div className="rp-row-text">
          <div className="set-label-line">
            <span className="set-label">{t('report.redact.label')}</span>
          </div>
          <div className="set-help">{redactOn ? redactionSummary(t, report.body.counts, report.body.total) : t('report.redact.off')}</div>
        </div>
        <Switch checked={redactOn} onChange={setRedactOn} label={t('report.redact.label')} />
      </div>

      <div className="rp-dest">
        <div className="rp-dest-label">{t('report.dest.label')}</div>
        <Segmented<Destination>
          plain
          label={t('report.dest.label')}
          value={loading ? destination : toGithub ? 'github' : 'copy'}
          onChange={setDestination}
          options={[
            {
              value: 'github',
              label: (
                <>
                  <CircleDot size={13} /> {t('report.dest.github')}
                </>
              ),
              disabled: !repo && !loading,
              title: !repo && !loading ? t('report.dest.noRepo') : undefined
            },
            {
              value: 'copy',
              label: (
                <>
                  <Copy size={13} /> {t('report.dest.copy')}
                </>
              )
            }
          ]}
        />
        <div className="faint small rp-dest-help">
          {toGithub
            ? plan.copy
              ? t('report.dest.tooLong')
              : t.rich('report.dest.githubHelp', { url: <span key="url" className="mono">{`github.com/${repo}/issues/new`}</span> })
            : !repo && !loading
              ? t('report.dest.noRepo')
              : t('report.dest.copyHelp')}
        </div>
      </div>

    </Dialog>
  )
}
