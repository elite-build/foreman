// Personas on Automations, beside Flows (docs/loops-and-graphs.md, "Personas: who a step is"), shown only while Settings →
// Experimental → Flows is on: the built-in, repository (.foreman/personas and .claude/agents) and personal personas, and
// an editor that presents one as settings (what it may do, what it is shown, how it should end) with the instructions
// beneath. Built-in and repository personas are read-only here, with Copy to personal; a persona is human-owned.
import { Plus } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { modelInfo } from '../../../../shared/agents'
import type { PlainKey } from '../../../../shared/i18n'
import { parsePersona, personaMarkdown, PERSONA_ENDS, PERSONA_SHOWS, type Persona, type PersonaEnd, type PersonaList, type PersonaListing, type PersonaShow } from '../../../../shared/personas'
import { useT, type RendererT } from '../../i18n'
import { api, attempt, useStore } from '../../store'
import { ActionRow, Button, Callout, Checkbox, Dialog, Disclosure, Field, LinkButton, Select, Status, Tag, TextArea, TextInput } from '../../ui'
import { Row, ToggleRow } from '../settings/controls'

const SHOW_LABEL: Record<PersonaShow, PlainKey> = {
  task: 'automations.personas.show.task',
  diff: 'automations.personas.show.diff',
  tree: 'automations.personas.show.tree',
  note: 'automations.personas.show.note',
  ledger: 'automations.personas.show.ledger',
  'checks.results': 'automations.personas.show.checks'
}

const END_LABEL: Record<PersonaEnd, PlainKey> = {
  review: 'automations.personas.end.review',
  done: 'automations.personas.end.done',
  findings: 'automations.personas.end.findings',
  plan: 'automations.personas.end.plan'
}

/** "read-only · ends with plan": what a persona may do and how it should end. */
function factsText(p: Persona, t: RendererT): string {
  return [
    p.read_only ? t('automations.personas.readOnly') : t('automations.personas.edits'),
    ...(p.ends_with?.length ? [t('automations.personas.endsWith', { list: p.ends_with.join(', ') })] : []),
    ...(p.loadout ? [t('automations.personas.loadout', { n: p.loadout })] : []),
    ...(p.source === 'claude-agents' ? [t('automations.personas.claudeOnly')] : [])
  ].join(' · ')
}

type Editing = { listing?: PersonaListing; markdown?: string }

/**
 * The Personas section. `usedBy` names the flows that name a persona (the Flows section has them); `onChanged` lets it
 * list the flows again after a save, since a persona's change can add or clear a flow's problems.
 */
export function PersonasSection({ query, usedBy, onChanged }: { query: string; usedBy: (name: string) => string[]; onChanged: () => void }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const [list, setList] = useState<PersonaList>({ personas: [], mcpServers: [] })
  const [open, setOpen] = useState<Editing | null>(null)
  const load = useCallback(async () => {
    const next = await attempt(() => api.listPersonas())
    if (next) setList(next)
  }, [])
  // Again when repositories come or go: their persona files come with them.
  useEffect(() => {
    void load()
  }, [load, repos])

  const needle = query.trim().toLowerCase()
  const shown = needle ? list.personas.filter((p) => `${p.name}\n${p.markdown}`.toLowerCase().includes(needle)) : list.personas
  if (needle && !shown.length) return null

  return (
    <section aria-label={t('automations.personas')}>
      <div className="auto-side-head">
        <span>{t('automations.personas')}</span>
        <span className="auto-side-tools">
          <LinkButton size="sm" onClick={() => setOpen({})}>
            <Plus size={12} aria-hidden /> {t('automations.personas.new')}
          </LinkButton>
        </span>
      </div>
      <p className="faint small auto-side-note">{t('automations.personas.note')}</p>
      <div className="auto-cards">
        {shown.map((p) => (
          <PersonaRow key={p.id} listing={p} onOpen={() => setOpen({ listing: p })} />
        ))}
      </div>
      {open && (
        <PersonaDialog
          editing={open}
          mcpServers={list.mcpServers}
          usedBy={usedBy}
          onCopy={(markdown) => setOpen({ markdown })}
          onClose={() => setOpen(null)}
          onSaved={() => {
            setOpen(null)
            void load()
            onChanged()
          }}
        />
      )}
    </section>
  )
}

/** Where a persona comes from, in words. */
function SourceTag({ listing }: { listing: PersonaListing }) {
  const t = useT()
  const repo = useStore((s) => s.snapshot!.repos.find((r) => r.id === listing.repoId)?.name ?? '')
  if (listing.source === 'built-in') return <Tag>{t('automations.flows.builtIn')}</Tag>
  if (listing.source === 'personal') return <Tag>{t('automations.flows.personal')}</Tag>
  return (
    <>
      <Tag>{listing.source === 'claude-agents' ? t('automations.personas.fromClaude', { repo }) : t('automations.flows.fromRepo', { repo })}</Tag>
      <Tag mono>{t('automations.flows.fileRev', { file: listing.file ?? '', rev: listing.rev?.slice(0, 7) ?? '' })}</Tag>
    </>
  )
}

function PersonaRow({ listing, onOpen }: { listing: PersonaListing; onOpen: () => void }) {
  const t = useT()
  return (
    <ActionRow
      card
      className="auto-card"
      actions={
        <Button size="sm" onClick={onOpen} aria-label={t('automations.personas.openNamed', { name: listing.name })}>
          {t('automations.personas.open')}
        </Button>
      }
    >
      <span className="auto-row-title">{listing.name}</span>
      <span className="auto-card-foot">
        <SourceTag listing={listing} />
      </span>
      {listing.persona && <span className="auto-card-body">{factsText(listing.persona, t)}</span>}
      {listing.problems.length > 0 && (
        <span className="auto-card-foot">
          <Status tone="error" label={t('automations.flows.problems', { count: listing.problems.length })} />
        </span>
      )}
    </ActionRow>
  )
}

/** The editor's fields: a persona's settings, the instructions beneath. */
type Form = Omit<Persona, 'source'>

const NEW_FORM: Form = { name: 'new-persona', read_only: true, shows: ['task', 'diff'], ends_with: ['findings'], instructions: '' }

function formOf(editing: Editing): Form | null {
  if (editing.listing) {
    const p = editing.listing.persona
    if (!p) return null
    const { source: _source, file: _file, rev: _rev, tools: _tools, ...rest } = p
    return rest
  }
  if (editing.markdown !== undefined) {
    const read = parsePersona(editing.markdown, 'personal')
    if ('persona' in read) {
      const { source: _source, file: _file, rev: _rev, tools: _tools, ...rest } = read.persona
      return rest
    }
  }
  return NEW_FORM
}

const toggle = <T extends string>(list: readonly T[] | undefined, item: T, on: boolean, order: readonly T[]): T[] => order.filter((x) => (x === item ? on : (list ?? []).includes(x)))

/**
 * A new personal persona, a personal one to change, or a built-in or repository one to read (with Copy to personal).
 * Checked as it is edited, with the rules main applies when saving.
 */
function PersonaDialog({
  editing,
  mcpServers,
  usedBy,
  onCopy,
  onClose,
  onSaved
}: {
  editing: Editing
  mcpServers: string[]
  usedBy: (name: string) => string[]
  onCopy: (markdown: string) => void
  onClose: () => void
  onSaved: () => void
}) {
  const t = useT()
  const loadouts = useStore((s) => s.snapshot!.settings.loadouts)
  const { listing } = editing
  const editable = !listing || listing.source === 'personal'
  const initial = useMemo(() => formOf(editing), [editing])
  const [form, setForm] = useState<Form | null>(initial)
  const [refused, setRefused] = useState<string[] | null>(null)
  const [seen, setSeen] = useState(editing)
  // A different persona (Copy to personal) starts over.
  if (seen !== editing) {
    setSeen(editing)
    setForm(initial)
    setRefused(null)
  }

  const markdown = form ? personaMarkdown(form) : listing?.markdown ?? ''
  const parsed = useMemo(() => (form ? parsePersona(markdown, 'personal', t) : null), [form, markdown, t])
  const problems = refused ?? (listing && !listing.persona ? listing.problems : parsed && 'problems' in parsed ? parsed.problems : [])
  const name = form?.name ?? listing?.name ?? ''
  const flows = usedBy(name)
  const set = (patch: Partial<Form>) => {
    setForm((f) => (f ? { ...f, ...patch } : f))
    setRefused(null)
  }

  const save = async () => {
    const result = await attempt(() => api.savePersonalPersona({ id: listing?.id, markdown }))
    if (!result) return
    if ('problems' in result) setRefused(result.problems)
    else onSaved()
  }
  const remove = async () => {
    if (!listing) return
    if ((await attempt(async () => (await api.deletePersonalPersona(listing.id), true))) === true) onSaved()
  }

  const title = !listing ? t('automations.personas.new') : editable ? t('automations.personas.edit') : listing.name
  const footer = editable ? (
    <>
      {listing && (
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
      <Button onClick={() => onCopy(form ? personaMarkdown(form) : listing.markdown)}>{t('automations.flows.copy')}</Button>
      <Button variant="primary" onClick={onClose}>
        {t('common.close')}
      </Button>
    </>
  )

  const slot = form?.loadout
  const loadoutOptions = [
    { value: 'none', label: t('automations.personas.loadoutNone') },
    ...loadouts.map((l, i) => ({ value: String(i + 1), label: t('automations.personas.loadoutSlot', { n: i + 1, model: modelInfo(l.agent, l.model, t).label }) })),
    ...(slot && slot > loadouts.length ? [{ value: String(slot), label: t('automations.personas.loadoutUnset', { n: slot }) }] : [])
  ]
  const servers = [...new Set([...mcpServers, ...(form?.mcp ?? [])])].sort()

  return (
    <Dialog title={title} onClose={onClose} closeOnBackdrop={!editable} size="lg" footer={footer}>
      <div className="flow-dialog">
        {!editable && (
          <Callout tone="info" role="note">
            {listing.source === 'claude-agents' ? t('automations.personas.claudeNote') : t('automations.personas.readOnlyNote')}
          </Callout>
        )}
        {form && (
          <div className="persona-form">
            <Row label={t('automations.personas.field.name')} help={t('automations.personas.field.nameHelp')}>
              {(c) => <TextInput {...c} mono value={form.name} readOnly={!editable} spellCheck={false} onChange={(e) => set({ name: e.target.value })} />}
            </Row>
            <Row label={t('automations.personas.field.description')}>
              {(c) => <TextInput {...c} value={form.description ?? ''} readOnly={!editable} onChange={(e) => set({ description: e.target.value || undefined })} />}
            </Row>
            <Row label={t('automations.personas.field.loadout')} help={t('automations.personas.field.loadoutHelp')}>
              {(c) => (
                <Select
                  {...c}
                  value={slot ? String(slot) : 'none'}
                  disabled={!editable}
                  options={loadoutOptions}
                  onChange={(v) => set({ loadout: v === 'none' ? undefined : Number(v) })}
                />
              )}
            </Row>
            <ToggleRow label={t('automations.personas.field.readOnly')} help={t('automations.personas.field.readOnlyHelp')} checked={Boolean(form.read_only)} disabled={!editable} onChange={(on) => set({ read_only: on || undefined })} />
            <Row label={t('automations.personas.field.shows')} help={t('automations.personas.field.showsHelp')} stacked>
              <div role="group" aria-label={t('automations.personas.field.shows')} className="persona-choices">
                {PERSONA_SHOWS.map((s) => (
                  <Checkbox key={s} checked={Boolean(form.shows?.includes(s))} disabled={!editable} onChange={(e) => set({ shows: toggle(form.shows, s, e.target.checked, PERSONA_SHOWS) })}>
                    {t(SHOW_LABEL[s])}
                  </Checkbox>
                ))}
              </div>
            </Row>
            <Row label={t('automations.personas.field.ends')} help={t('automations.personas.field.endsHelp')} stacked>
              <div role="group" aria-label={t('automations.personas.field.ends')} className="persona-choices">
                {PERSONA_ENDS.map((e) => (
                  <Checkbox key={e} checked={Boolean(form.ends_with?.includes(e))} disabled={!editable} onChange={(ev) => set({ ends_with: toggle(form.ends_with, e, ev.target.checked, PERSONA_ENDS) })}>
                    {t(END_LABEL[e])}
                  </Checkbox>
                ))}
              </div>
            </Row>
            <ToggleRow
              label={t('automations.personas.mcpSome')}
              help={t('automations.personas.mcpHelp')}
              checked={Boolean(form.mcp)}
              disabled={!editable}
              onChange={(on) => set({ mcp: on ? [...servers] : undefined })}
              below={
                form.mcp &&
                (servers.length ? (
                  <div role="group" aria-label={t('automations.personas.field.mcp')} className="persona-choices">
                    {servers.map((name) => (
                      <Checkbox key={name} checked={form.mcp!.includes(name)} disabled={!editable} onChange={(e) => set({ mcp: servers.filter((x) => (x === name ? e.target.checked : form.mcp!.includes(x))) })}>
                        <code>{name}</code>
                      </Checkbox>
                    ))}
                  </div>
                ) : (
                  <span className="faint small">{t('automations.personas.mcpNone')}</span>
                ))
              }
            />
            <Field label={t('automations.personas.field.instructions')} description={t('automations.personas.field.instructionsHelp')}>
              {(c) => <TextArea {...c} rows={8} value={form.instructions} readOnly={!editable} onChange={(e) => set({ instructions: e.target.value })} />}
            </Field>
            {listing?.persona?.tools && <p className="faint small">{t('automations.personas.tools', { tools: listing.persona.tools })}</p>}
          </div>
        )}
        <p className="small">
          <strong>{t('automations.personas.usedBy')}</strong> {flows.length ? flows.join(', ') : t('automations.personas.usedByNone')}
        </p>
        {editable && listing && flows.length > 0 && (
          <Callout tone="warn" role="note">
            {t('automations.personas.fingerprint', { count: flows.length })}
          </Callout>
        )}
        {problems.length > 0 && (
          <Callout tone="error" role="status" title={t('automations.personas.problemsTitle')}>
            <ul className="flow-problems">
              {problems.map((p, i) => (
                <li key={i}>{p}</li>
              ))}
            </ul>
          </Callout>
        )}
        <Disclosure label={t('automations.personas.source')} defaultOpen={!form}>
          <Field label={t('automations.personas.sourceLabel')} hideLabel>
            {(c) => <TextArea {...c} mono rows={12} readOnly spellCheck={false} value={markdown} />}
          </Field>
        </Disclosure>
      </div>
    </Dialog>
  )
}
