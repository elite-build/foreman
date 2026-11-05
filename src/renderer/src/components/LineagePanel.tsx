// The workspace's Lineage tab (docs/loops-and-graphs.md, "Recovering graphs from what happened"), behind Settings →
// Experimental → Flows: the work done here drawn through one of four lenses (Run · Context · Memory · Data) with the
// flow diagram's renderer, the outline as its accessible equivalent (each entry opening the turn or check run it stands
// for, tagged with the record it is drawn from or the one it needs), the records this history lacks, and "Make a flow
// from this…", which drafts a flow file to read, copy or save as a personal flow. Nothing here runs anything.
import { GitBranch } from 'lucide-react'
import { useEffect, useState } from 'react'
import { LENS_WORD } from '../../../shared/flowGraph'
import { LINEAGE_LENSES, leftOutText, type LineageFlowDraft, type LineageGap, type LineageLens, type LineageOutlineEntry, type WorkspaceLineage } from '../../../shared/lineage'
import type { PlainKey } from '../../../shared/i18n'
import { useT } from '../i18n'
import { api, attempt, openTurn, showChecksPanel, showToast, useStore } from '../store'
import { Button, Callout, Card, CardButton, Dialog, Field, Segmented, Spinner, Tag, TextArea } from '../ui'
import { FlowDiagram } from './FlowDiagram'
import './flowRun.css'

const GAP_WORD: Record<LineageGap, PlainKey> = {
  'Session.handedOffFrom': 'lineage.gap.handOff',
  'Workspace.startedBy': 'lineage.gap.delegation',
  MessageOrigin: 'lineage.gap.origin',
  'turn-end.usage': 'lineage.gap.usage',
  'turn-end.memoryWrites': 'lineage.gap.memory',
  'turn-end.tree': 'lineage.gap.tree',
  'WorkspaceChecks.startedBy': 'lineage.gap.checks'
}

/** Whether the Lineage tab is offered: only while Flows are on. */
export function useLineageOn(): boolean {
  return useStore((s) => Boolean(s.snapshot?.settings.flows))
}

/** What the lineage is read again on: a turn starting or ending in any of the workspace's chats, a check run, the PR. */
function useHistoryKey(workspaceId: string): string {
  return useStore((s) => {
    const snapshot = s.snapshot
    if (!snapshot) return ''
    const ws = snapshot.workspaces.find((w) => w.id === workspaceId)
    const tabs = snapshot.sessions.filter((x) => x.workspaceId === workspaceId).map((x) => `${x.id}:${x.turnId ?? ''}:${x.lastTurn?.endedAt ?? ''}:${x.closedAt ?? ''}`)
    return [...tabs, ws?.checks?.running ?? '', ws?.checks?.results.length ?? 0, ws?.checks?.results[0]?.startedAt ?? '', ws?.prInfo?.number ?? '', ws?.prInfo?.facts?.checks ?? ''].join('|')
  })
}

export function LineagePanel({ workspaceId }: { workspaceId: string }) {
  const t = useT()
  const [lens, setLens] = useState<LineageLens>('run')
  const history = useHistoryKey(workspaceId)
  const key = `${workspaceId}|${lens}|${history}`
  const [read, setRead] = useState<{ key: string; lineage?: WorkspaceLineage; failed?: string }>()
  const [drafting, setDrafting] = useState(false)
  useEffect(() => {
    let live = true
    api
      .workspaceLineage(workspaceId, lens)
      .then((lineage) => live && setRead({ key, lineage }))
      .catch((err: unknown) => live && setRead({ key, failed: err instanceof Error ? err.message : String(err) }))
    return () => {
      live = false
    }
    // `key` names everything the read depends on.
  }, [key])
  // The last read stays on screen while the next one (a lens switch, a turn ending) comes in.
  const lineage = read?.lineage
  const empty = lineage && !lineage.outline.some((e) => e.ref?.kind === 'turn')
  return (
    <div className="flow-run">
      <Segmented<LineageLens> small label={t('lineage.lensLabel')} value={lens} onChange={setLens} options={LINEAGE_LENSES.map((l) => ({ value: l, label: t(LENS_WORD[l]) }))} />
      {read?.failed ? (
        <Callout tone="error" role="status">
          {read.failed}
        </Callout>
      ) : !lineage ? (
        <Spinner label={t('lineage.loading')} />
      ) : empty ? (
        <p className="faint small">{t('lineage.empty')}</p>
      ) : (
        <>
          <FlowDiagram source={lineage.mermaid} label={lineage.graph.title} />
          {lineage.gaps.length > 0 && (
            <Callout tone="info" role="note" title={t('lineage.gaps.title')}>
              <p>{t('lineage.gaps.intro')}</p>
              <ul>
                {lineage.gaps.map((gap) => (
                  <li key={gap}>{t(GAP_WORD[gap])}</li>
                ))}
              </ul>
            </Callout>
          )}
          <span>
            <Button size="sm" onClick={() => setDrafting(true)}>
              <GitBranch size={12} aria-hidden /> {t('lineage.makeFlow')}
            </Button>
          </span>
          <ol className="flow-run-steps" aria-label={t('lineage.outline')}>
            {lineage.outline.map((entry) => (
              <li key={entry.id}>
                <OutlineEntry entry={entry} />
              </li>
            ))}
          </ol>
        </>
      )}
      {drafting && <DraftDialog workspaceId={workspaceId} onClose={() => setDrafting(false)} />}
    </div>
  )
}

/** One node of the outline: what it is, what links it (inferred ones say so), and the records behind it. */
function OutlineEntry({ entry }: { entry: LineageOutlineEntry }) {
  const t = useT()
  const body = (
    <>
      <strong>{entry.label}</strong>
      {entry.sublabel?.split('\n').map((line, i) => (
        <span key={i} className="faint small">
          {line}
        </span>
      ))}
      {entry.edges.map((e, i) => {
        const words =
          e.direction === 'from'
            ? e.label
              ? t('lineage.edge.from', { label: e.label, other: e.other })
              : t('lineage.edge.fromPlain', { other: e.other })
            : e.label
              ? t('lineage.edge.to', { label: e.label, other: e.other })
              : t('lineage.edge.toPlain', { other: e.other })
        return (
          <span key={i} className="small">
            {e.reconstructed ? t('lineage.edge.inferred', { edge: words }) : words}
          </span>
        )
      })}
      {(entry.recorded.length > 0 || entry.needs.length > 0) && (
        <span className="flow-lens-tags">
          {entry.recorded.map((field) => (
            <Tag key={field} tone="ok" mono>
              {t('lineage.tag.recorded', { field })}
            </Tag>
          ))}
          {entry.needs.map((field) => (
            <Tag key={field} tone="warn" mono>
              {t('lineage.tag.needs', { field })}
            </Tag>
          ))}
        </span>
      )}
    </>
  )
  const ref = entry.ref
  if (ref?.kind === 'turn')
    return (
      <CardButton className="flow-step" onClick={() => void openTurn(ref.workspaceId, ref.sessionId, ref.turnId)} title={t('lineage.open.turn')}>
        {body}
      </CardButton>
    )
  if (ref?.kind === 'checks')
    return (
      <CardButton className="flow-step" onClick={() => showChecksPanel(ref.workspaceId)} title={t('lineage.open.checks')}>
        {body}
      </CardButton>
    )
  return <Card className="flow-step">{body}</Card>
}

/** "Make a flow from this…": the draft, what it leaves out, and Save as personal flow, Copy TOML or Cancel. */
function DraftDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const t = useT()
  const [draft, setDraft] = useState<LineageFlowDraft>()
  const [problems, setProblems] = useState<string[] | null>(null)
  useEffect(() => {
    let live = true
    void attempt(() => api.lineageFlowDraft(workspaceId)).then((d) => live && d && setDraft(d))
    return () => {
      live = false
    }
  }, [workspaceId])
  const save = async () => {
    if (!draft) return
    const result = await attempt(() => api.savePersonalFlow({ toml: draft.toml }))
    if (!result) return
    if ('problems' in result) return setProblems(result.problems)
    showToast(t('lineage.draft.saved', { name: result.flow.name }))
    onClose()
  }
  const copy = () => {
    if (draft) void navigator.clipboard.writeText(draft.toml).then(() => showToast(t('lineage.draft.copied')))
  }
  const footer = (
    <>
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button disabled={!draft} onClick={copy}>
        {t('lineage.draft.copy')}
      </Button>
      <Button variant="primary" disabled={!draft} onClick={() => void save()}>
        {t('lineage.draft.save')}
      </Button>
    </>
  )
  return (
    <Dialog title={t('lineage.draft.title')} onClose={onClose} size="lg" footer={footer}>
      <div className="flow-run">
        <p className="small">{t('lineage.draft.intro')}</p>
        {!draft ? (
          <Spinner label={t('lineage.draft.reading')} />
        ) : (
          <>
            {draft.leftOut.length > 0 && (
              <Callout tone="info" role="note" title={t('lineage.draft.leftOutTitle')}>
                <ul>
                  {draft.leftOut.map((item) => (
                    <li key={item.kind}>{leftOutText(item, t)}</li>
                  ))}
                </ul>
              </Callout>
            )}
            <Field label={t('lineage.draft.toml')}>{(c) => <TextArea {...c} mono rows={16} spellCheck={false} readOnly value={draft.toml} />}</Field>
            {problems && (
              <Callout tone="error" role="status" title={t('lineage.draft.problems')}>
                <ul>
                  {problems.map((p, i) => (
                    <li key={i}>{p}</li>
                  ))}
                </ul>
              </Callout>
            )}
          </>
        )}
      </div>
    </Dialog>
  )
}
