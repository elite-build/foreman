// The New employee page (docs/ai-employees.md §5.3): describe the employee, optionally pick a personality and a hat,
// then Generate with AI (one request) or Save as is. The draft is words to read and edit in place, with Refine; what it
// can do starts at the safest settings whatever the words say, and what the draft suggests is listed switched off: the
// AI drafts, it never grants. Create saves `bots/<id>.toml` and the employee's memory folder in one commit, as a draft;
// Create and approve shows the plan first. Nothing is written before Create.
import { Check, RotateCcw, Wand2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  defaultEmployee,
  draftTextOf,
  employeeNameProblem,
  employeePath,
  employeeProblems,
  freeHatColour,
  MAX_DRAFT_DESCRIPTION,
  MAX_REFINE_REQUEST,
  newEmployeeId,
  PERSONALITY_TRAITS,
  saveAsIsText,
  withDraftText,
  type EmployeeDefinition,
  type EmployeeDraftText,
  type EmployeeSuggestion,
  type PersonalityTrait
} from '../../../../shared/employees'
import { reposInSpace } from '../../../../shared/organizations'
import { useT } from '../../i18n'
import { api, openEmployees, showToast, useStore } from '../../store'
import { Button, Callout, Card, ChipButton, Disclosure, Field, HardHat, LinkButton, Spinner, Status, Switch, Tag, TextArea, TextInput, type HardHatColour } from '../../ui'
import { ApproveDialog } from './ApproveDialog'
import { CanDo, HatPicker, InstructionsField, WordFields, type Wearers } from './EmployeeFields'
import type { EmployeesData } from './EmployeesView'
import { agentLabel, colourName, modelText, TRAIT_LABEL } from './words'

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export function NewEmployeePage({ orgId, data }: { orgId: string; data: EmployeesData }) {
  const t = useT()
  const snapshot = useStore((s) => s.snapshot!)
  const organization = snapshot.organizations?.find((o) => o.id === orgId)
  const orgName = organization?.name ?? ''
  const memory = snapshot.repos.find((r) => r.id === organization?.memoryRepoId)?.name ?? ''
  const roster = snapshot.employees?.[orgId]?.employees ?? []
  const privacy = Boolean(snapshot.settings.privacyMode)
  const repos = useMemo(
    () => reposInSpace(snapshot.repos, snapshot.organizations ?? [], orgId).filter((r) => r.id !== organization?.memoryRepoId).map((r) => r.name),
    [snapshot.repos, snapshot.organizations, orgId, organization?.memoryRepoId]
  )
  const worn: Wearers = roster.filter((e) => e.state !== 'retired' && e.colour).map((e) => ({ colour: e.colour, name: e.name || e.id }))
  const others = roster.map((e) => ({ id: e.id, name: e.name }))

  const [description, setDescription] = useState('')
  const [traits, setTraits] = useState<PersonalityTrait[]>([])
  const [otherOn, setOtherOn] = useState(false)
  const [other, setOther] = useState('')
  const [hat, setHat] = useState<string | undefined>(undefined)
  const [draft, setDraft] = useState<EmployeeDefinition | null>(null)
  // What drafted it; null: the person's own words (Save as is).
  const [source, setSource] = useState<{ agent: string; model: string } | null>(null)
  const [suggested, setSuggested] = useState<EmployeeSuggestion[]>([])
  const [working, setWorking] = useState<'generate' | 'refine' | 'create' | null>(null)
  const [error, setError] = useState('')
  const [editingWords, setEditingWords] = useState(false)
  const [request, setRequest] = useState('')
  const [undo, setUndo] = useState<{ text: EmployeeDraftText; suggested: EmployeeSuggestion[] } | null>(null)
  const [refined, setRefined] = useState('')
  const [approveOpen, setApproveOpen] = useState(false)

  const personalityWords = () => [...traits.map((tr) => t(TRAIT_LABEL[tr])), ...(otherOn && other.trim() ? [other.trim()] : [])].join(', ')
  const newDraft = (text: EmployeeDraftText, colour: string) => defaultEmployee({ id: newEmployeeId(others.map((o) => o.id)), colour, repos, loadouts: snapshot.settings.loadouts, text })

  const generate = async () => {
    setWorking('generate')
    setError('')
    try {
      const result = await api.generateEmployeeDraft(orgId, { description, traits, ...(otherOn && other.trim() ? { otherTrait: other.trim() } : {}), ...(hat ? { colour: hat } : {}) })
      const colour = hat ?? result.colour ?? freeHatColour(worn.map((w) => w.colour))
      // Generate again keeps the id and every setting the person chose; only the words and the hat are new.
      setDraft((before) => (before ? { ...withDraftText(before, result.text), look: { family: 'hardhat', colour } } : newDraft(result.text, colour)))
      setSuggested(result.suggested)
      setSource({ agent: result.agent, model: result.model })
      setEditingWords(false)
      setUndo(null)
      setRefined('')
    } catch (err) {
      setError(message(err))
    } finally {
      setWorking(null)
    }
  }

  const saveAsIs = () => {
    setError('')
    const text = saveAsIsText(description, personalityWords())
    setDraft((before) => (before ? withDraftText(before, { ...text, name: before.name, role: before.role }) : newDraft(text, hat ?? freeHatColour(worn.map((w) => w.colour)))))
    setSource(null)
    setSuggested([])
    setEditingWords(false)
    setUndo(null)
    setRefined('')
  }

  const refine = async () => {
    if (!draft) return
    setWorking('refine')
    setError('')
    const before = { text: draftTextOf(draft), suggested }
    try {
      const result = await api.refineEmployeeDraft(orgId, before.text, request)
      setDraft((d) => (d ? withDraftText(d, result.text) : d))
      setSuggested(result.suggested)
      setSource({ agent: result.agent, model: result.model })
      setUndo(before)
      setRefined(request.trim())
      setRequest('')
    } catch (err) {
      setError(message(err))
    } finally {
      setWorking(null)
    }
  }

  const startOver = () => {
    setDescription('')
    setTraits([])
    setOtherOn(false)
    setOther('')
    setHat(undefined)
    setDraft(null)
    setSource(null)
    setSuggested([])
    setError('')
    setRequest('')
    setUndo(null)
    setRefined('')
  }

  const create = async (approve: boolean) => {
    if (!draft) return
    setWorking('create')
    setError('')
    try {
      const created = await api.createEmployee(orgId, draft, { approve })
      showToast(approve ? t('employees.new.createdApproved', { name: created.name }) : t('employees.new.created', { name: created.name }))
      data.reload()
      openEmployees({ orgId, page: 'team' })
    } catch (err) {
      // Create and approve says why in its dialog; Create, here.
      if (!approve) setError(message(err))
      setWorking(null)
      throw err
    }
  }

  const nameProblem = draft ? employeeNameProblem(draft.name, others) : null
  const nameError = nameProblem === 'empty' ? t('employees.name.empty') : nameProblem === 'long' ? t('employees.name.long') : nameProblem === 'taken' ? t('employees.name.taken') : undefined
  // The name has its own error under its field; every other problem the file would have is listed above Create.
  const problems = draft ? employeeProblems({ ...draft, name: draft.name.trim() || draft.id }, t) : []
  const canCreate = Boolean(draft) && !nameProblem && !problems.length && working === null
  const describing = !draft || editingWords
  const busy = working !== null

  return (
    <div className="new-employee">
      <p className="employee-faint">{t('employees.new.intro')}</p>
      {error && (
        <Callout tone="error" role="alert" title={t('employees.new.failed')}>
          {error}
        </Callout>
      )}
      {describing ? (
        <Card as="section" className="new-employee-card" aria-label={t('employees.new.describe')}>
          <Field label={t('employees.new.describe')}>
            {(c) => <TextArea {...c} rows={4} value={description} maxLength={MAX_DRAFT_DESCRIPTION} placeholder={t('employees.new.describePlaceholder')} onChange={(e) => setDescription(e.target.value)} />}
          </Field>
          <div className="new-employee-group" role="group" aria-labelledby="new-employee-personality">
            <span id="new-employee-personality" className="employee-subheading">
              {t('employees.new.personality')}
            </span>
            <span className="employee-faint">{t('employees.new.personalityHint')}</span>
            <div className="new-employee-chips">
              {PERSONALITY_TRAITS.map((trait) => {
                const pressed = traits.includes(trait)
                return (
                  <ChipButton key={trait} pill pressed={pressed} onClick={() => setTraits(pressed ? traits.filter((x) => x !== trait) : [...traits, trait])}>
                    {pressed && <Check size={12} aria-hidden />}
                    {t(TRAIT_LABEL[trait])}
                  </ChipButton>
                )
              })}
              <ChipButton pill pressed={otherOn} onClick={() => setOtherOn(!otherOn)}>
                {otherOn && <Check size={12} aria-hidden />}
                {t('employees.trait.other')}
              </ChipButton>
            </div>
            {otherOn && <TextInput aria-label={t('employees.trait.otherLabel')} value={other} maxLength={100} onChange={(e) => setOther(e.target.value)} />}
          </div>
          <Disclosure label={hat ? t('employees.new.hatPicked', { colour: colourName(hat, t) }) : t('employees.new.hat')}>
            <p className="employee-faint">{t('employees.new.hatHint', { organization: orgName })}</p>
            <HatPicker legend={t('employees.hat.legend')} value={hat} onChange={setHat} worn={worn} />
          </Disclosure>
          <div className="new-employee-actions">
            <Button variant="primary" icon={working === 'generate' ? <Spinner size={13} /> : <Wand2 size={14} />} disabled={busy || privacy || !description.trim()} title={privacy ? t('employees.new.privacy') : undefined} onClick={() => void generate()}>
              {working === 'generate' ? t('employees.new.generating') : t('employees.new.generate')}
            </Button>
            <Button disabled={busy || !description.trim()} onClick={saveAsIs}>
              {t('employees.new.saveAsIs')}
            </Button>
            <span className="employee-faint">{t('employees.new.saveAsIsHint')}</span>
          </div>
          {privacy ? (
            <Callout tone="info" role="status">
              {t('employees.new.privacy')}
            </Callout>
          ) : (
            <p className="employee-faint">{t('employees.new.sends', { organization: orgName })}</p>
          )}
          {!draft && (
            <section aria-labelledby="new-employee-next" className="new-employee-next">
              <h2 id="new-employee-next" className="employee-subheading">
                {t('employees.new.nextLabel')}
              </h2>
              <ol>
                <li>{t('employees.new.next1')}</li>
                <li>{t('employees.new.next2')}</li>
                <li>{t('employees.new.next3', { memory })}</li>
              </ol>
            </section>
          )}
        </Card>
      ) : (
        <Card as="section" className="new-employee-card" aria-label={t('employees.draft.yourWords')}>
          <div className="new-employee-folded">
            <span className="employee-subheading">{t('employees.draft.yourWords')}</span>
            <LinkButton size="sm" onClick={() => setEditingWords(true)}>
              {t('employees.draft.editWords')}
            </LinkButton>
          </div>
          <p className="new-employee-quote">{description}</p>
          {(traits.length > 0 || (otherOn && other.trim())) && (
            <div className="new-employee-chips">
              {traits.map((tr) => (
                <Tag key={tr} tone="outline">
                  {t(TRAIT_LABEL[tr])}
                </Tag>
              ))}
              {otherOn && other.trim() && <Tag tone="outline">{other.trim()}</Tag>}
            </div>
          )}
        </Card>
      )}

      {draft && (
        <>
          <Card as="section" className="new-employee-card" aria-labelledby="new-employee-draft">
            <div className="new-employee-draft-head">
              <HardHat colour={draft.look.colour as HardHatColour} size={48} />
              <div className="new-employee-draft-title">
                <h2 id="new-employee-draft" className="employee-subheading">
                  {t('employees.draft.heading')}
                </h2>
                <span className="employee-faint">{source ? (source.model ? t('employees.draft.byModel', { model: modelText(source.agent, source.model, t) }) : t('employees.draft.by', { agent: agentLabel(source.agent) })) : t('employees.draft.yours')}</span>
              </div>
            </div>
            <Disclosure label={t('employees.draft.hat', { colour: colourName(draft.look.colour, t) })}>
              <HatPicker legend={t('employees.hat.legend')} value={draft.look.colour} onChange={(colour) => setDraft({ ...draft, look: { family: 'hardhat', colour } })} worn={worn} />
            </Disclosure>
            <WordFields value={draft} onChange={setDraft} nameError={nameError} />
            <Disclosure label={t('employees.field.showInstructions')}>
              <InstructionsField value={draft.instructions} onChange={(instructions) => setDraft({ ...draft, instructions })} />
            </Disclosure>
            {!privacy && (
              <div className="new-employee-refine">
                <Field label={t('employees.refine.label')} description={t('employees.refine.keeps')}>
                  {(c) => (
                    <TextInput
                      {...c}
                      value={request}
                      maxLength={MAX_REFINE_REQUEST}
                      placeholder={t('employees.refine.placeholder')}
                      onChange={(e) => setRequest(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && request.trim() && !busy) void refine()
                      }}
                    />
                  )}
                </Field>
                <div className="new-employee-actions">
                  <Button icon={working === 'refine' ? <Spinner size={13} /> : <RotateCcw size={13} />} disabled={busy || !request.trim()} onClick={() => void refine()}>
                    {working === 'refine' ? t('employees.refine.working') : t('employees.refine.regenerate')}
                  </Button>
                  {refined && <Status tone="ok" label={t('employees.refine.done', { request: refined })} />}
                  {undo && (
                    <LinkButton
                      size="sm"
                      onClick={() => {
                        setDraft((d) => (d ? withDraftText(d, undo.text) : d))
                        setSuggested(undo.suggested)
                        setUndo(null)
                        setRefined('')
                      }}
                    >
                      {t('employees.refine.undo')}
                    </LinkButton>
                  )}
                </div>
              </div>
            )}
          </Card>

          <Card as="section" className="new-employee-card" aria-labelledby="new-employee-can">
            <h2 id="new-employee-can" className="employee-subheading">
              {draft.name.trim() ? t('employees.can.heading', { name: draft.name.trim() }) : t('employees.can.headingUnnamed')}
            </h2>
            <p className="employee-faint">{t('employees.can.safest')}</p>
            <CanDo value={draft} onChange={setDraft} repos={repos} others={others} heading={t('employees.can.headingUnnamed')} />
          </Card>

          {suggested.length > 0 && (
            <Card as="section" className="new-employee-card" aria-labelledby="new-employee-suggested">
              <h2 id="new-employee-suggested" className="employee-subheading">
                {t('employees.suggest.heading')}
              </h2>
              <p className="employee-faint">{t('employees.suggest.intro')}</p>
              <ul className="new-employee-suggestions">
                {suggested.map((s, i) => {
                  const label = s.kind === 'repo-write' ? t('employees.suggest.repoWrite', { repo: s.detail }) : s.kind === 'schedule' ? t('employees.suggest.schedule', { detail: s.detail }) : t('employees.suggest.event', { detail: s.detail })
                  const on = s.kind === 'repo-write' && draft.access.repos[s.detail] === 'write'
                  const id = `new-employee-suggestion-${i}`
                  return (
                    <li key={`${s.kind}:${s.detail}`} className="new-employee-suggestion">
                      <Switch
                        aria-labelledby={id}
                        checked={on}
                        disabled={s.kind !== 'repo-write'}
                        onChange={(checked) => setDraft({ ...draft, access: { ...draft.access, repos: { ...draft.access.repos, [s.detail]: checked ? 'write' : 'read' } } })}
                      />
                      <span className="new-employee-suggestion-text">
                        <span id={id}>{label}</span>
                        <span className="employee-faint">{s.reason}</span>
                        {s.kind !== 'repo-write' && <span className="employee-faint">{s.kind === 'schedule' ? t('employees.suggest.scheduleLater') : t('employees.suggest.eventLater')}</span>}
                      </span>
                      {on && <Tag tone="outline">{t('employees.suggest.on')}</Tag>}
                    </li>
                  )
                })}
              </ul>
              <Callout tone="neutral">{t('employees.suggest.never')}</Callout>
            </Card>
          )}

          {problems.length > 0 && (
            <Callout tone="warn" role="status" title={t('employees.new.problems')}>
              <ul className="employee-plan-bullets">
                {problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </Callout>
          )}
          <div className="new-employee-footer">
            <span className="employee-faint">{t('employees.new.target', { path: employeePath(draft.id), memory })}</span>
            <Button variant="ghost" disabled={busy} onClick={startOver}>
              {t('employees.new.startOver')}
            </Button>
            <Button disabled={!canCreate} onClick={() => void create(false).catch(() => undefined)}>
              {working === 'create' ? t('employees.new.creating') : t('employees.new.create')}
            </Button>
            <Button variant="primary" disabled={!canCreate} onClick={() => setApproveOpen(true)}>
              {t('employees.new.createApprove')}
            </Button>
          </div>
          {approveOpen && (
            <ApproveDialog
              creating
              definition={draft}
              memory={memory}
              names={(id) => others.find((o) => o.id === id)?.name || id}
              onClose={() => setApproveOpen(false)}
              onConfirm={async () => {
                await create(true)
                setApproveOpen(false)
              }}
            />
          )}
        </>
      )}
    </div>
  )
}
