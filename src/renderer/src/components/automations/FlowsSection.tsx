// Flows on Automations (docs/loops-and-graphs.md), shown only while Settings → Experimental → Flows is on: the built-in,
// repository and personal flows as cards, and a dialog to read one or write a personal one with live validation.
// Nothing runs from here yet.
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { FLOW_STARTERS, type FlowStarter } from '../../../../shared/flowStarters'
import { parseFlow, type FlowListing } from '../../../../shared/flows'
import type { PlainKey } from '../../../../shared/i18n'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { ActionRow, Button, Callout, Dialog, Field, LinkButton, Select, Status, Tag, TextArea } from '../../ui'

const STARTER_NAME: Record<FlowStarter['id'], PlainKey> = {
  'fix-until-green': 'automations.flows.starter.fixUntilGreen',
  'research-then-implement': 'automations.flows.starter.researchThenImplement'
}

/** A flow's title: a built-in starter's in the app's language, otherwise the name in its file. */
function flowTitle(flow: FlowListing, t: RendererT): string {
  const starter = flow.starter as FlowStarter['id'] | undefined
  return starter && STARTER_NAME[starter] ? t(STARTER_NAME[starter]) : flow.name
}

type Editing = { flow?: FlowListing; toml: string; starter?: FlowStarter['id'] }

export function FlowsSection({ query }: { query: string }) {
  const on = useStore((s) => Boolean(s.snapshot?.settings.flows))
  return on ? <FlowList query={query} /> : null
}

function FlowList({ query }: { query: string }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const [flows, setFlows] = useState<FlowListing[]>([])
  const [open, setOpen] = useState<Editing | null>(null)
  const load = useCallback(async () => {
    const list = await attempt(() => api.listFlows())
    if (list) setFlows(list)
  }, [])
  // Again when repositories come or go: their flow files come with them.
  useEffect(() => {
    void load()
  }, [load, repos])

  const needle = query.trim().toLowerCase()
  const shown = needle ? flows.filter((f) => `${flowTitle(f, t)}\n${f.toml}`.toLowerCase().includes(needle)) : flows
  if (needle && !shown.length) return null
  const startNew = () => setOpen({ toml: FLOW_STARTERS[0].toml, starter: FLOW_STARTERS[0].id })

  return (
    <section aria-label={t('automations.flows')}>
      <div className="auto-side-head">
        <span>{t('automations.flows')}</span>
        <span className="auto-side-tools">
          <LinkButton size="sm" onClick={startNew}>
            <Plus size={12} aria-hidden /> {t('automations.flows.new')}
          </LinkButton>
        </span>
      </div>
      <p className="faint small auto-side-note">{t('automations.flows.note')}</p>
      <div className="auto-cards">
        {shown.map((flow) => (
          <FlowCard key={flow.id} flow={flow} onOpen={() => setOpen({ flow, toml: flow.toml })} />
        ))}
      </div>
      {open && (
        <FlowDialog
          editing={open}
          onCopy={(toml) => setOpen({ toml })}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null)
            void load()
          }}
        />
      )}
    </section>
  )
}

/** Where a flow comes from, in words: built-in, personal, or the repository with the file and its revision. */
function SourceTags({ flow }: { flow: FlowListing }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === flow.repoId)?.name)
  if (flow.source === 'built-in') return <Tag>{t('automations.flows.builtIn')}</Tag>
  if (flow.source === 'personal') return <Tag>{t('automations.flows.personal')}</Tag>
  return (
    <>
      <Tag>{t('automations.flows.fromRepo', { repo: repo ?? '' })}</Tag>
      <Tag mono>{t('automations.flows.fileRev', { file: flow.file ?? '', rev: flow.rev?.slice(0, 7) ?? '' })}</Tag>
    </>
  )
}

/** "6 steps · 2 loops · 1 gate". */
function summaryText(flow: FlowListing, t: RendererT): string {
  if (!flow.summary) return ''
  const { steps, loops, gates } = flow.summary
  return [t('automations.flows.steps', { count: steps }), t('automations.flows.loops', { count: loops }), t('automations.flows.gates', { count: gates })].join(' · ')
}

function FlowCard({ flow, onOpen }: { flow: FlowListing; onOpen: () => void }) {
  const t = useT()
  return (
    <ActionRow card className="auto-card" onPress={onOpen} primaryProps={{ className: 'auto-card-main' }}>
      <span className="auto-row-title">{flowTitle(flow, t)}</span>
      <span className="auto-card-foot">
        <SourceTags flow={flow} />
      </span>
      {flow.summary && <span className="auto-card-body">{summaryText(flow, t)}</span>}
      {(flow.problems.length > 0 || flow.warnings.length > 0) && (
        <span className="auto-card-foot">
          {flow.problems.length > 0 && <Status tone="error" label={t('automations.flows.problems', { count: flow.problems.length })} />}
          {flow.warnings.length > 0 && <Status tone="warn" label={t('automations.flows.warnings', { count: flow.warnings.length })} />}
        </span>
      )}
    </ActionRow>
  )
}

/**
 * A new personal flow (from a starter), a personal one to edit, or a built-in or repository one to read. The document
 * is checked as it is typed, with the same rules main applies when saving.
 */
function FlowDialog({ editing, onCopy, onClose, onSaved }: { editing: Editing; onCopy: (toml: string) => void; onClose: () => void; onSaved: () => void }) {
  const t = useT()
  const { flow } = editing
  const editable = !flow || flow.source === 'personal'
  const [toml, setToml] = useState(editing.toml)
  const [starter, setStarter] = useState<FlowStarter['id'] | undefined>(editing.starter)
  const [refused, setRefused] = useState<string[] | null>(null)
  const parsed = useMemo(() => parseFlow(toml, editable ? 'personal' : flow.source, t), [toml, editable, flow, t])
  const problems = refused ?? ('problems' in parsed ? parsed.problems : [])
  const { warnings } = parsed

  // A different document (Copy to personal) starts over.
  useEffect(() => {
    setToml(editing.toml)
    setStarter(editing.starter)
    setRefused(null)
  }, [editing])

  const save = async () => {
    const result = await attempt(() => api.savePersonalFlow({ id: flow?.id, toml }))
    if (!result) return
    if ('problems' in result) setRefused(result.problems)
    else onSaved()
  }
  const remove = async () => {
    if (!flow) return
    if ((await attempt(async () => (await api.deletePersonalFlow(flow.id), true))) === true) onSaved()
  }

  const title = !flow ? t('automations.flows.new') : editable ? t('automations.flows.edit') : flowTitle(flow, t)
  const footer = editable ? (
    <>
      {flow && (
        <LinkButton danger onClick={() => void remove()}>
          {t('common.delete')}
        </LinkButton>
      )}
      <Button onClick={onClose}>{t('common.cancel')}</Button>
      <Button variant="primary" disabled={problems.length > 0} onClick={() => void save()}>
        {t('common.save')}
      </Button>
    </>
  ) : (
    <>
      <Button onClick={() => onCopy(flow.toml)}>{t('automations.flows.copy')}</Button>
      <Button variant="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  )

  return (
    <Dialog title={title} onClose={onClose} closeOnBackdrop={!editable} size="lg" footer={footer}>
      <div className="flow-dialog">
        {editing.starter && (
          <Field label={t('automations.flows.startFrom')}>
            {(c) => (
              <Select
                {...c}
                value={starter ?? FLOW_STARTERS[0].id}
                options={FLOW_STARTERS.map((s) => ({ value: s.id, label: t(STARTER_NAME[s.id]) }))}
                onChange={(id) => {
                  setStarter(id)
                  setToml(FLOW_STARTERS.find((s) => s.id === id)!.toml)
                  setRefused(null)
                }}
              />
            )}
          </Field>
        )}
        {!editable && (
          <Callout tone="info" role="note">
            {t('automations.flows.readOnly')}
          </Callout>
        )}
        <Field label={t('automations.flows.toml')} description={editable ? t('automations.flows.tomlHelp') : undefined}>
          {(c) => (
            <TextArea
              {...c}
              mono
              rows={18}
              spellCheck={false}
              readOnly={!editable}
              value={toml}
              onChange={(e) => {
                setToml(e.target.value)
                setRefused(null)
              }}
            />
          )}
        </Field>
        {problems.length > 0 ? (
          <Callout tone="error" role="status" title={t('automations.flows.problemsTitle')}>
            <ProblemList items={problems} />
          </Callout>
        ) : (
          editable && (
            <Callout tone="ok" role="status">
              {t('automations.flows.valid')}
            </Callout>
          )
        )}
        {warnings.length > 0 && (
          <Callout tone="warn" role="status" title={t('automations.flows.warningsTitle')}>
            <ProblemList items={warnings} />
          </Callout>
        )}
      </div>
    </Dialog>
  )
}

function ProblemList({ items }: { items: string[] }) {
  return (
    <ul className="flow-problems">
      {items.map((item, i) => (
        <li key={i}>{item}</li>
      ))}
    </ul>
  )
}
