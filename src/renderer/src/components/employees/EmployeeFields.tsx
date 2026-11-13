// The pieces the New employee page and the Edit view share (docs/ai-employees.md §5.3): the hat picker, the draft's
// words as editable fields, the precise access form, and "What it can do" in sentences with Change. All composed from
// ui/; feature CSS is layout only.
import { Plus, Shuffle, Trash2 } from 'lucide-react'
import { useId, useState, type ReactNode } from 'react'
import { canRunUnattended } from '../../../../shared/agentCatalog'
import { offers } from '../../../../shared/agentCapabilities'
import { chatAgentKinds, DEFAULT_MODEL, effortLabel, modelInfo, modelsFor, type AgentKind, type EffortLevel } from '../../../../shared/agents'
import {
  ACTION_POLICIES,
  EMPLOYEE_ACTIONS,
  EMPLOYEE_LIMIT_RANGES,
  EMPLOYEE_TEXT_LIMITS,
  HAT_COLOURS,
  MAX_RESPONSIBILITIES,
  MEMORY_WRITE_SCOPES,
  REPO_ACCESS,
  shuffledHatColour,
  type EmployeeActionPolicy,
  type EmployeeDefinition,
  type EmployeeRepoAccess
} from '../../../../shared/employees'
import { useT } from '../../i18n'
import { useCapabilities } from '../../store'
import { Button, Checkbox, Dialog, Field, HardHat, IconButton, LinkButton, RadioCards, RadioList, Segmented, Select, Tag, TextArea, TextInput, type HardHatColour } from '../../ui'
import { ACCESS_LABEL, actionName, agentLabel, canDoLines, colourName, MEMORY_SCOPE_LABEL, POLICY_LABEL, type CanDoSection } from './words'

/** A titled group of controls (a role="group" named by its heading). */
function Group({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <div className="employee-group" role="group" aria-labelledby={id}>
      <span id={id} className="employee-subheading">
        {title}
      </span>
      {children}
    </div>
  )
}

/** Who wears which colour in the organization (the employee being edited left out). */
export type Wearers = { colour: string; name: string }[]

/**
 * The twelve hats as radio cards, each named by its colour (§5.4). A colour someone wears is offered disabled, with
 * their name, while a free one is left; once all are worn any may repeat (the name always shows beside the hat).
 */
export function HatPicker({ value, onChange, worn, legend, hideLegend }: { value: string | undefined; onChange: (colour: string) => void; worn: Wearers; legend: string; hideLegend?: boolean }) {
  const t = useT()
  const taken = new Map<string, string[]>()
  for (const w of worn) taken.set(w.colour, [...(taken.get(w.colour) ?? []), w.name])
  const free = HAT_COLOURS.some((c) => !taken.has(c))
  return (
    <div className="employee-hats">
      <RadioCards
        legend={legend}
        hideLegend={hideLegend}
        layout="grid"
        columns={6}
        className="employee-hat-grid"
        value={value}
        onChange={onChange}
        options={HAT_COLOURS.map((colour) => {
          const wearers = taken.get(colour)
          return {
            value: colour,
            label: colourName(colour, t),
            icon: <HardHat colour={colour} size={32} />,
            ...(wearers ? (free ? { disabled: true, reason: t('employees.hat.wornBy', { name: wearers.join(t('employees.list.separator')) }) } : { description: t('employees.hat.wornBy', { name: wearers.join(t('employees.list.separator')) }) }) : {})
          }
        })}
      />
      <Button size="sm" icon={<Shuffle size={13} />} onClick={() => onChange(shuffledHatColour(worn.map((w) => w.colour), value))}>
        {t('employees.hat.shuffle')}
      </Button>
    </div>
  )
}

/** The words of an employee, each an editable field: name, role, description, personality, ask-me-about and responsibilities. */
export function WordFields({ value, onChange, nameError }: { value: EmployeeDefinition; onChange: (next: EmployeeDefinition) => void; nameError?: string }) {
  const t = useT()
  const set = (patch: Partial<EmployeeDefinition>) => onChange({ ...value, ...patch })
  const list = value.responsibilities
  return (
    <div className="employee-words">
      <div className="employee-row2">
        <Field label={t('employees.field.name')} error={nameError}>
          {(c) => <TextInput {...c} value={value.name} maxLength={EMPLOYEE_TEXT_LIMITS.name} onChange={(e) => set({ name: e.target.value })} />}
        </Field>
        <Field label={t('employees.field.role')}>{(c) => <TextInput {...c} value={value.role} maxLength={EMPLOYEE_TEXT_LIMITS.role} onChange={(e) => set({ role: e.target.value })} />}</Field>
      </div>
      <Field label={t('employees.field.description')}>
        {(c) => <TextInput {...c} value={value.description} maxLength={EMPLOYEE_TEXT_LIMITS.description} onChange={(e) => set({ description: e.target.value })} />}
      </Field>
      <Field label={t('employees.field.personality')}>
        {(c) => <TextInput {...c} value={value.personality} maxLength={EMPLOYEE_TEXT_LIMITS.personality} onChange={(e) => set({ personality: e.target.value })} />}
      </Field>
      <Group title={t('employees.field.responsibilities')}>
        {list.length > 0 && (
          <ol className="employee-responsibilities">
            {list.map((r, i) => (
              <li key={i} className="employee-responsibility">
                <TextInput
                  aria-label={t('employees.field.responsibility', { n: i + 1 })}
                  value={r}
                  maxLength={EMPLOYEE_TEXT_LIMITS.responsibility}
                  onChange={(e) => set({ responsibilities: list.map((x, j) => (j === i ? e.target.value : x)) })}
                />
                <IconButton label={t('employees.field.removeResponsibility', { n: i + 1 })} tone="danger" onClick={() => set({ responsibilities: list.filter((_, j) => j !== i) })}>
                  <Trash2 size={13} />
                </IconButton>
              </li>
            ))}
          </ol>
        )}
        <div>
          <Button size="sm" variant="ghost" icon={<Plus size={13} />} disabled={list.length >= MAX_RESPONSIBILITIES} onClick={() => set({ responsibilities: [...list, ''] })}>
            {t('employees.field.addResponsibility')}
          </Button>
        </div>
      </Group>
      <Field label={t('employees.field.askMeAbout')} description={t('employees.field.askMeAboutHint')}>
        {(c) => <TextInput {...c} value={value.ask_me_about} maxLength={EMPLOYEE_TEXT_LIMITS.ask_me_about} onChange={(e) => set({ ask_me_about: e.target.value })} />}
      </Field>
    </div>
  )
}

/** The full prompt, in its sections. */
export function InstructionsField({ value, onChange, rows = 14 }: { value: string; onChange: (text: string) => void; rows?: number }) {
  const t = useT()
  return (
    <Field label={t('employees.field.instructions')} description={t('employees.field.instructionsHint')}>
      {(c) => <TextArea {...c} mono rows={rows} value={value} maxLength={EMPLOYEE_TEXT_LIMITS.instructions} spellCheck={false} onChange={(e) => onChange(e.target.value)} />}
    </Field>
  )
}

const csv = (list: readonly string[]) => list.join(', ')
const fromCsv = (text: string) => text.split(',').map((s) => s.trim()).filter(Boolean)

/** A whole number field that keeps what is typed until it is a number in range. */
function NumberField({ label, description, value, min, max, onChange, optional }: { label: string; description?: string; value: number | undefined; min: number; max: number; onChange: (n: number | undefined) => void; optional?: boolean }) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const n = Number(text)
  const bad = text.trim() === '' ? !optional : !Number.isFinite(n) || n < min || n > max
  return (
    <Field label={label} description={description}>
      {(c) => (
        <TextInput
          {...c}
          type="number"
          width={110}
          min={min}
          max={max}
          value={text}
          aria-invalid={bad || undefined}
          onChange={(e) => {
            setText(e.target.value)
            const v = e.target.value.trim()
            if (!v && optional) onChange(undefined)
            else if (v && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max) onChange(Number(v))
          }}
        />
      )}
    </Field>
  )
}

/**
 * The precise form for what an employee may do, by section: repositories (None, Read or Write each), shared memory,
 * the execution profile and MCP servers, outward actions and delegation, limits, and the model with how it is attended.
 * Read and Write are offered only where the agent's capability record enforces them (§9).
 */
export function AccessFields({
  value,
  onChange,
  sections,
  repos,
  others
}: {
  value: EmployeeDefinition
  onChange: (next: EmployeeDefinition) => void
  sections: readonly CanDoSection[]
  // The organization's repository names (its memory repository left out).
  repos: readonly string[]
  // The organization's other employees, for delegation.
  others: { id: string; name: string }[]
}) {
  const t = useT()
  const record = useCapabilities(value.model.agent)
  const access = value.access
  const setAccess = (patch: Partial<EmployeeDefinition['access']>) => onChange({ ...value, access: { ...access, ...patch } })
  const show = (s: CanDoSection) => sections.includes(s)
  const readOk = Boolean(record?.enforcement.readOnly)
  const writeOk = Boolean(record && offers(record.enforcement.scopedWrites))
  const listed = [...repos, ...Object.keys(access.repos).filter((r) => !repos.includes(r))]
  const agent = value.model.agent
  const models = modelsFor(agent as AgentKind)
  const efforts = value.model.model ? modelInfo(agent as AgentKind, value.model.model, t).efforts : []
  const agents = [...new Set([...chatAgentKinds(), agent])]
  const setAgent = (next: string) =>
    onChange({
      ...value,
      model: { agent: next, model: DEFAULT_MODEL[next as AgentKind] ?? modelsFor(next as AgentKind)[0]?.id ?? '', fallbacks: [] },
      attendance: canRunUnattended(next) ? value.attendance : 'attended'
    })
  return (
    <div className="employee-access">
      {show('repos') && (
        <Group title={t('employees.access.repos')}>
          <p className="employee-faint">{t('employees.access.reposHint')}</p>
          {listed.length ? (
            <ul className="employee-repo-list">
              {listed.map((repo) => (
                <li key={repo} className="employee-repo-row">
                  <span className="employee-repo-name mono">{repo}</span>
                  {!repos.includes(repo) && <Tag tone="warn">{t('employees.access.notInOrg')}</Tag>}
                  <Segmented<EmployeeRepoAccess>
                    small
                    label={t('employees.access.repoLabel', { repo })}
                    value={access.repos[repo] ?? 'none'}
                    onChange={(level) => setAccess({ repos: { ...access.repos, [repo]: level } })}
                    options={REPO_ACCESS.map((level) => ({
                      value: level,
                      label: t(ACCESS_LABEL[level]),
                      ...(level === 'write' && !writeOk ? { disabled: true, title: t('employees.access.noWrite', { agent: agentLabel(agent) }) } : {}),
                      ...(level === 'read' && !readOk ? { disabled: true, title: t('employees.access.noRead', { agent: agentLabel(agent) }) } : {})
                    }))}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <p className="employee-faint">{t('employees.access.noRepos')}</p>
          )}
        </Group>
      )}
      {show('memory') && (
        <Group title={t('employees.access.memory')}>
          <p className="employee-faint">{t('employees.access.memoryHint')}</p>
          {MEMORY_WRITE_SCOPES.map((scope) => (
            <Checkbox
              key={scope}
              checked={access.memory_write.includes(scope)}
              onChange={(e) => setAccess({ memory_write: e.target.checked ? [...access.memory_write, scope] : access.memory_write.filter((s) => s !== scope) })}
            >
              {t(MEMORY_SCOPE_LABEL[scope])}
            </Checkbox>
          ))}
        </Group>
      )}
      {show('profile') && (
        <>
          <RadioList
            legend={t('employees.access.profile')}
            value={access.profile}
            onChange={(profile) => setAccess({ profile })}
            options={[
              { value: 'no-shell', label: t('employees.access.noShell'), description: t('employees.access.noShellHint') },
              { value: 'shell', label: t('employees.access.shell'), description: t('employees.access.shellHint') }
            ]}
          />
          <Field label={t('employees.access.mcp')} description={t('employees.access.mcpHint')}>
            {(c) => <TextInput {...c} mono value={csv(access.mcp)} onChange={(e) => setAccess({ mcp: fromCsv(e.target.value) })} />}
          </Field>
        </>
      )}
      {show('actions') && (
        <>
          <Group title={t('employees.access.actions')}>
            <p className="employee-faint">{t('employees.access.actionsHint')}</p>
            <ul className="employee-repo-list">
              {[...new Set([...EMPLOYEE_ACTIONS, ...Object.keys(access.actions)])].map((action) => (
                <li key={action} className="employee-repo-row">
                  <span className="employee-repo-name">{actionName(action, t)}</span>
                  <Segmented<EmployeeActionPolicy>
                    small
                    label={t('employees.access.actionLabel', { action: actionName(action, t) })}
                    value={access.actions[action] ?? 'held'}
                    onChange={(policy) => setAccess({ actions: { ...access.actions, [action]: policy } })}
                    options={ACTION_POLICIES.map((policy) => ({ value: policy, label: t(POLICY_LABEL[policy]) }))}
                  />
                </li>
              ))}
            </ul>
          </Group>
          <Group title={t('employees.access.delegates')}>
            {others.length ? (
              others.map((o) => (
                <Checkbox
                  key={o.id}
                  checked={access.delegate_to.includes(o.id)}
                  onChange={(e) => setAccess({ delegate_to: e.target.checked ? [...access.delegate_to, o.id] : access.delegate_to.filter((id) => id !== o.id) })}
                >
                  {o.name || o.id}
                </Checkbox>
              ))
            ) : (
              <p className="employee-faint">{t('employees.access.noOthers')}</p>
            )}
          </Group>
        </>
      )}
      {show('limits') && (
        <Group title={t('employees.access.limits')}>
          <div className="employee-limits">
            <NumberField
              label={t('employees.access.runs')}
              value={value.limits.runs_per_day}
              min={EMPLOYEE_LIMIT_RANGES.runs_per_day[0]}
              max={EMPLOYEE_LIMIT_RANGES.runs_per_day[1]}
              onChange={(n) => n !== undefined && onChange({ ...value, limits: { ...value.limits, runs_per_day: Math.round(n) } })}
            />
            <NumberField
              label={t('employees.access.minutes')}
              value={value.limits.minutes_per_run}
              min={EMPLOYEE_LIMIT_RANGES.minutes_per_run[0]}
              max={EMPLOYEE_LIMIT_RANGES.minutes_per_run[1]}
              onChange={(n) => n !== undefined && onChange({ ...value, limits: { ...value.limits, minutes_per_run: Math.round(n) } })}
            />
            <NumberField
              optional
              label={t('employees.access.cost')}
              description={t('employees.access.costHint')}
              value={value.limits.cost_per_day_usd}
              min={EMPLOYEE_LIMIT_RANGES.cost_per_day_usd[0]}
              max={EMPLOYEE_LIMIT_RANGES.cost_per_day_usd[1]}
              onChange={(n) => {
                const { cost_per_day_usd: _cost, ...rest } = value.limits
                onChange({ ...value, limits: n === undefined ? rest : { ...rest, cost_per_day_usd: n } })
              }}
            />
          </div>
        </Group>
      )}
      {show('model') && (
        <Group title={t('employees.access.model')}>
          <div className="employee-row2">
            <Field label={t('employees.access.agent')}>
              {(c) => <Select {...c} value={agent} onChange={setAgent} options={agents.map((a) => ({ value: a, label: agentLabel(a) }))} />}
            </Field>
            <Field label={t('employees.access.modelId')}>
              {(c) =>
                models.length ? (
                  <Select
                    {...c}
                    value={value.model.model}
                    onChange={(model) => onChange({ ...value, model: { ...value.model, model, effort: undefined } })}
                    options={[...(models.some((m) => m.id === value.model.model) ? [] : [{ value: value.model.model, label: value.model.model || t('common.default') }]), ...models.map((m) => ({ value: m.id, label: m.label }))]}
                  />
                ) : (
                  <TextInput {...c} mono value={value.model.model} onChange={(e) => onChange({ ...value, model: { ...value.model, model: e.target.value } })} />
                )
              }
            </Field>
          </div>
          {efforts.length > 0 && (
            <Field label={t('employees.access.effort')}>
              {(c) => (
                <Select<string>
                  {...c}
                  value={value.model.effort ?? ''}
                  onChange={(effort) => onChange({ ...value, model: { ...value.model, effort: (effort || undefined) as EffortLevel | undefined } })}
                  options={[{ value: '', label: t('employees.access.effortDefault') }, ...efforts.map((e) => ({ value: e, label: effortLabel(e, t) }))]}
                />
              )}
            </Field>
          )}
          <Field label={t('employees.access.fallbacks')} description={t('employees.access.fallbacksHint')}>
            {(c) => <TextInput {...c} mono value={csv(value.model.fallbacks)} onChange={(e) => onChange({ ...value, model: { ...value.model, fallbacks: fromCsv(e.target.value) } })} />}
          </Field>
          <RadioList
            legend={t('employees.access.attendance')}
            value={value.attendance}
            onChange={(attendance) => onChange({ ...value, attendance })}
            options={[
              {
                value: 'unattended',
                label: t('employees.access.unattended'),
                description: t('employees.access.unattendedHint'),
                ...(canRunUnattended(agent) ? {} : { disabled: true, reason: t('employees.access.unattendedNo', { agent: agentLabel(agent) }) })
              },
              { value: 'attended', label: t('employees.access.attended'), description: t('employees.access.attendedHint') }
            ]}
          />
        </Group>
      )}
    </div>
  )
}

const SECTION_TITLE: Record<CanDoSection, 'employees.access.repos' | 'employees.access.memory' | 'employees.access.profile' | 'employees.access.actions' | 'employees.access.limits' | 'employees.access.model' | 'employees.can.whenTitle'> = {
  repos: 'employees.access.repos',
  memory: 'employees.access.memory',
  profile: 'employees.access.profile',
  actions: 'employees.access.actions',
  when: 'employees.can.whenTitle',
  limits: 'employees.access.limits',
  model: 'employees.access.model'
}

/**
 * "What it can do": the definition's access in sentences, each with Change opening the precise controls for it in a
 * dialog (§5.3). Without `onChange` it only reads (the employee's page).
 */
export function CanDo({
  value,
  onChange,
  repos,
  others,
  heading
}: {
  value: EmployeeDefinition
  onChange?: (next: EmployeeDefinition) => void
  repos: readonly string[]
  others: { id: string; name: string }[]
  heading: string
}) {
  const t = useT()
  const [section, setSection] = useState<CanDoSection | null>(null)
  const [draft, setDraft] = useState(value)
  const names = (id: string) => others.find((o) => o.id === id)?.name || id
  const lines = canDoLines(value, t, names)
  const open = (s: CanDoSection) => {
    setDraft(value)
    setSection(s)
  }
  return (
    <section className="employee-can" aria-label={heading}>
      <ul className="employee-can-list">
        {lines.map((line, i) => (
          <li key={i} className="employee-can-line">
            <span>{line.text}</span>
            {onChange && line.section !== 'when' && (
              <LinkButton size="sm" aria-label={t('employees.can.changeLabel', { what: line.text })} onClick={() => open(line.section)}>
                {t('employees.can.change')}
              </LinkButton>
            )}
          </li>
        ))}
      </ul>
      {section && onChange && (
        <Dialog
          title={t(SECTION_TITLE[section])}
          closeLabel={t('common.close')}
          onClose={() => setSection(null)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSection(null)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  onChange(draft)
                  setSection(null)
                }}
              >
                {t('employees.access.done')}
              </Button>
            </>
          }
        >
          <AccessFields value={draft} onChange={setDraft} sections={[section]} repos={repos} others={others} />
        </Dialog>
      )}
    </section>
  )
}

/** The hat as it shows beside a name, decorative (the name is written next to it). */
export function Hat({ colour, size = 24 }: { colour: string; size?: number }) {
  return <HardHat colour={colour as HardHatColour} size={size} />
}
