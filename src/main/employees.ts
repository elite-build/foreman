// AI employees (docs/ai-employees.md §5): an organization's employees are its memory repository's `bots/<id>.toml`
// files, read and written only through the memory service; whether each is approved, paused or retired on this
// computer is in state.json (§12), never in the memory repository, so a cloned organization starts inert (§3).
//
// Creating one writes its definition and seeds `memory/bots/<id>/` in one commit, by the person who clicked Create.
// Approving records the definition's fingerprint here; a definition whose fingerprint has moved since is flagged
// "changed since approval" (Foreman refuses to run it until it is approved again). Generate and Refine draft an
// employee's words with one request to the person's default agent: no shell, no files, no tools, and nothing in the
// answer can grant access. Every method refuses while the organization has no memory repository.
import { createHash } from 'node:crypto'
import {
  draftTextOf,
  EMPLOYEE_DRAFT_SYSTEM_PROMPT,
  EMPLOYEE_TEXT_LIMITS,
  employeeDraftPrompt,
  employeeFingerprintText,
  employeeFromObject,
  employeeIdOfPath,
  employeeMemoryFolder,
  employeeNameProblem,
  employeePath,
  employeeRefinePrompt,
  freeHatColour,
  HAT_COLOURS,
  MAX_DRAFT_DESCRIPTION,
  MAX_REFINE_REQUEST,
  MAX_RESPONSIBILITIES,
  newEmployeeId,
  parseEmployee,
  parseEmployeeDraftAnswer,
  PERSONALITY_TRAITS,
  serializeEmployee,
  type EmployeeDefinition,
  type EmployeeDraftInput,
  type EmployeeDraftResult,
  type EmployeeDraftText,
  type EmployeeList,
  type EmployeeRecord,
  type EmployeeRoster,
  type EmployeeSummary,
  type EmployeeUpdateResult,
  type EmployeeView,
  type PersonalityTrait
} from '../shared/employees'
import { createT, type Locale } from '../shared/i18n'
import { isEmployeeId } from '../shared/memory'
import { reposInSpace, type Organization } from '../shared/organizations'
import type { MemoryService } from './memory'
import type { PersistedState } from './store'

/** The longest a drafting request may take before the window is told it didn't answer. */
export const DRAFT_TIMEOUT_MS = 3 * 60_000

export const PRIVACY_MODE_ON = 'Privacy mode is on, so nothing is sent to a model: use Save as is, or turn Privacy mode off in Settings → General.'

export interface EmployeeHost {
  state(): PersistedState
  memory: Pick<MemoryService, 'tree' | 'readBlob' | 'commitAsPerson'>
  // Save state.json and tell the windows.
  changed(): void
  /**
   * One request with no tools (the one-shot path chat titles use), on the person's default agent where its driver can
   * answer one: the system prompt and the prompt in, the answer's text out, with what answered. Null: no agent here can.
   */
  draft?(request: { system: string; prompt: string }): Promise<{ text: string; agent: string; model: string } | null>
  // The language a file's problems are shown in (the person's); English by default.
  locale?(): Locale
  // An employee was approved, paused, resumed or retired here: work held for it may now run, or must wait (employeeWork.ts).
  lifecycle?(orgId: string, id: string): void
  now?(): Date
}

/** What the service knows of one definition file at a head. */
interface FileEntry {
  id: string
  path: string
  blob: string
  text: string | null
  definition?: EmployeeDefinition
  problems: string[]
  fingerprint?: string
}

/** The SHA-256 an approval records: of the definition's normalized text, without its hat (shared/employees.ts). */
export function employeeFingerprint(definition: EmployeeDefinition): string {
  return createHash('sha256').update(employeeFingerprintText(definition)).digest('hex')
}

/** What a new employee's own memory starts with. */
export function seedMemoryFiles(definition: Pick<EmployeeDefinition, 'id' | 'name'>): Record<string, string> {
  const folder = employeeMemoryFolder(definition.id)
  return {
    [`${folder}/MEMORY.md`]: `# ${definition.name}\n\nWhat ${definition.name} knows and prefers: facts and preferences kept from one run to the next. ${definition.name} reads this first on every run.\n`,
    [`${folder}/journal.md`]: '# Journal\n\nOne entry per run, newest last. Entries are added, never rewritten.\n'
  }
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

export class EmployeeService {
  // Each organization's definition files at the head last read, for the snapshot.
  private cache = new Map<string, { head: string; entries: FileEntry[]; error?: string }>()
  // A file read and parsed once per blob (and language).
  private parsed = new Map<string, FileEntry>()
  private refreshing = new Map<string, Promise<void>>()

  constructor(private host: EmployeeHost) {}

  private get state(): PersistedState {
    return this.host.state()
  }

  private get locale(): Locale {
    return this.host.locale?.() ?? 'en'
  }

  private records(): EmployeeRecord[] {
    return (this.state.employees ??= [])
  }

  private record(orgId: string, id: string): EmployeeRecord | undefined {
    return this.records().find((r) => r.orgId === orgId && r.id === id)
  }

  private setRecord(orgId: string, id: string, patch: Partial<EmployeeRecord>): EmployeeRecord {
    let record = this.record(orgId, id)
    if (!record) {
      record = { orgId, id, state: 'draft' }
      this.records().push(record)
    }
    Object.assign(record, patch)
    for (const key of Object.keys(record) as (keyof EmployeeRecord)[]) if (record[key] === undefined) delete record[key]
    return record
  }

  /** The organization, or a refusal: no such organization, or no memory repository. */
  private organization(orgId: string): Organization {
    const org = (this.state.organizations ?? []).find((o) => o.id === orgId)
    if (!org) throw new Error('Organization not found')
    if (!org.memoryRepoId || !this.state.repos.some((r) => r.id === org.memoryRepoId)) throw new Error(`${org.name} has no memory repository. Choose one in Settings → Spaces.`)
    return org
  }

  // ---- reading ----

  /** The definition files at the head: `bots/<id>.toml`, each read and checked (a file with problems is listed with them). */
  private async read(orgId: string): Promise<{ head: string; entries: FileEntry[]; folders: Set<string> }> {
    const tree = await this.host.memory.tree(orgId)
    const locale = this.locale
    const t = createT(locale)
    const entries: FileEntry[] = []
    const folders = new Set<string>()
    for (const entry of tree.entries) {
      const folder = /^memory\/bots\/([^/]+)\//.exec(entry.path)
      if (folder) folders.add(folder[1])
      const id = employeeIdOfPath(entry.path)
      if (id === null) continue
      const key = `${locale}:${entry.path}:${entry.blob}`
      let file = this.parsed.get(key)
      if (!file) {
        const text = await this.host.memory.readBlob(orgId, entry.blob)
        file = { id, path: entry.path, blob: entry.blob, text, problems: [] }
        if (text === null) file.problems = [t('employees.problem.unreadable')]
        else {
          const parse = parseEmployee(text, t)
          if (parse.definition && parse.definition.id !== id) file.problems = [t('employees.problem.fileName', { file: entry.path, id: parse.definition.id })]
          else if (!isEmployeeId(id)) file.problems = [t('employees.problem.id')]
          else if (parse.definition) {
            file.definition = parse.definition
            file.fingerprint = employeeFingerprint(parse.definition)
          } else file.problems = parse.problems
        }
        this.parsed.set(key, file)
      }
      entries.push(file)
    }
    const name = (e: FileEntry) => (e.definition?.name ?? e.id).toLocaleLowerCase()
    entries.sort((a, b) => name(a).localeCompare(name(b)) || a.id.localeCompare(b.id))
    return { head: tree.head, entries, folders }
  }

  /** The file merged with its lifecycle here: a definition with no record is a draft (nothing approved here). */
  private summary(orgId: string, file: FileEntry): EmployeeSummary {
    const record = this.record(orgId, file.id)
    const d = file.definition
    const approved = record && (record.state === 'active' || record.state === 'paused') && record.approvedFingerprint
    return {
      id: file.id,
      path: file.path,
      name: d?.name ?? '',
      role: d?.role ?? '',
      colour: d?.look.colour ?? '',
      ...(d ? { agent: d.model.agent, model: d.model.model } : {}),
      responsibilities: d?.responsibilities ?? [],
      problems: file.problems,
      state: record?.state ?? 'draft',
      ...(record?.pausedKind ? { pausedKind: record.pausedKind } : {}),
      ...(record?.pausedDetail ? { pausedDetail: record.pausedDetail } : {}),
      triggers: d?.triggers ?? [],
      changed: Boolean(approved && file.fingerprint !== record!.approvedFingerprint),
      ...(record?.approvedAt ? { approvedAt: record.approvedAt } : {})
    }
  }

  private async view(orgId: string, file: FileEntry): Promise<EmployeeView> {
    const summary = this.summary(orgId, file)
    const record = this.record(orgId, file.id)
    const approvedText = summary.changed && record?.approvedBlob ? await this.host.memory.readBlob(orgId, record.approvedBlob) : null
    return {
      ...summary,
      blob: file.blob,
      text: file.text,
      ...(file.definition ? { definition: file.definition, fingerprint: file.fingerprint } : {}),
      ...(approvedText !== null ? { approvedText } : {})
    }
  }

  /** Read again and keep it for the snapshot; the windows hear of it when anything they show changed. */
  private async load(orgId: string): Promise<{ head: string; entries: FileEntry[]; folders: Set<string> }> {
    const read = await this.read(orgId)
    const before = this.cache.get(orgId)
    this.cache.set(orgId, { head: read.head, entries: read.entries })
    if (!before || before.head !== read.head || before.error || before.entries.map((e) => e.blob).join() !== read.entries.map((e) => e.blob).join()) this.host.changed()
    return read
  }

  /** An organization's employees in full, at the head. */
  async list(orgId: string): Promise<EmployeeList> {
    this.organization(orgId)
    const { head, entries } = await this.load(orgId)
    return { head, employees: await Promise.all(entries.map((e) => this.view(orgId, e))) }
  }

  private async entry(orgId: string, id: string): Promise<{ file: FileEntry; read: Awaited<ReturnType<EmployeeService['load']>> }> {
    if (!isEmployeeId(id)) throw new Error('Employee not found')
    const read = await this.load(orgId)
    const file = read.entries.find((e) => e.id === id)
    if (!file) throw new Error('Employee not found')
    return { file, read }
  }

  /**
   * One employee as it is now, for a run's admission (main/employeeWork.ts): its definition at the head (or the file's
   * problems), its lifecycle here and whether it changed since approval. Refuses like every method.
   */
  async current(orgId: string, id: string): Promise<{ summary: EmployeeSummary; definition?: EmployeeDefinition; head: string }> {
    this.organization(orgId)
    const { file, read } = await this.entry(orgId, id)
    return { summary: this.summary(orgId, file), ...(file.definition ? { definition: file.definition } : {}), head: read.head }
  }

  /**
   * The organization's employees at the head, each with its lifecycle here and its definition (none while its file has
   * problems), for bot_list (docs/ai-employees.md §7). Refuses like every method.
   */
  async members(orgId: string): Promise<{ summary: EmployeeSummary; definition?: EmployeeDefinition }[]> {
    this.organization(orgId)
    const { entries } = await this.load(orgId)
    return entries.map((file) => ({ summary: this.summary(orgId, file), ...(file.definition ? { definition: file.definition } : {}) }))
  }

  /** Each organization's employees as last read, with their lifecycle now, for the snapshot (while AI employees are on). */
  rosters(): Record<string, EmployeeRoster> {
    const out: Record<string, EmployeeRoster> = {}
    for (const org of this.state.organizations ?? []) {
      const cached = org.memoryRepoId ? this.cache.get(org.id) : undefined
      if (cached) out[org.id] = { head: cached.head || null, employees: cached.entries.map((e) => this.summary(org.id, e)), ...(cached.error ? { error: cached.error } : {}) }
    }
    return out
  }

  /**
   * Every readable definition as last read, with its lifecycle here, for the trigger clock (main/employeeTriggers.ts):
   * nothing is read from git, so a tick never touches a memory repository. Empty while AI employees are off.
   */
  triggerSources(): { orgId: string; summary: EmployeeSummary; definition: EmployeeDefinition }[] {
    const out: { orgId: string; summary: EmployeeSummary; definition: EmployeeDefinition }[] = []
    for (const org of this.state.organizations ?? []) {
      const cached = org.memoryRepoId ? this.cache.get(org.id) : undefined
      for (const entry of cached?.entries ?? []) if (entry.definition) out.push({ orgId: org.id, summary: this.summary(org.id, entry), definition: entry.definition })
    }
    return out
  }

  /**
   * A run of the employee ended (main/employeeWork.ts): one that finished resets the count of failing runs; one that
   * didn't adds to it, and the second in a row pauses an active employee for a person (§9), saying how the last ended.
   */
  runEnded(orgId: string, id: string, outcome: { failed: boolean; detail?: string }): void {
    const record = this.record(orgId, id)
    if (!record) return
    if (!outcome.failed) {
      if (!record.failures) return
      this.setRecord(orgId, id, { failures: undefined })
      this.host.changed()
      return
    }
    const failures = (record.failures ?? 0) + 1
    if (failures >= 2 && record.state === 'active') {
      this.setRecord(orgId, id, { failures, state: 'paused', pausedKind: 'failures', pausedDetail: outcome.detail?.slice(0, 500) })
      this.host.changed()
      this.host.lifecycle?.(orgId, id)
      return
    }
    this.setRecord(orgId, id, { failures })
    this.host.changed()
  }

  /** Read an organization's definitions again if its memory repository's head moved; a failure is kept to show. */
  refresh(orgId: string): Promise<void> {
    const running = this.refreshing.get(orgId)
    if (running) return running
    const run = (async () => {
      try {
        this.organization(orgId)
        await this.load(orgId)
      } catch (err) {
        const before = this.cache.get(orgId)
        const error = message(err)
        if (before?.error !== error) {
          this.cache.set(orgId, { head: '', entries: [], error })
          this.host.changed()
        }
      } finally {
        this.refreshing.delete(orgId)
      }
    })()
    this.refreshing.set(orgId, run)
    return run
  }

  /** At launch, and whenever a memory repository's status moves. */
  async refreshAll(): Promise<void> {
    await Promise.all((this.state.organizations ?? []).filter((o) => o.memoryRepoId).map((o) => this.refresh(o.id)))
  }

  // ---- creating and editing ----

  /** A definition from the window, checked as its file would be. */
  private checked(definition: unknown): EmployeeDefinition {
    const parse = employeeFromObject(JSON.parse(JSON.stringify(definition ?? null)) as unknown)
    if (!parse.definition) throw new Error(`The employee can’t be saved: ${parse.problems.join(' ')}`)
    return parse.definition
  }

  private checkName(definition: EmployeeDefinition, entries: FileEntry[], exceptId?: string): void {
    // Retired employees keep their names: their files and memory are still there under them.
    const others = entries.flatMap((e) => (e.definition ? [{ id: e.id, name: e.definition.name }] : []))
    const problem = employeeNameProblem(definition.name, others, exceptId)
    if (problem === 'empty') throw new Error('Give the employee a name.')
    if (problem === 'long') throw new Error(`Keep the employee’s name to ${EMPLOYEE_TEXT_LIMITS.name} characters.`)
    if (problem === 'taken') throw new Error(`There is already an employee named ${definition.name.trim()} in this organization.`)
  }

  /**
   * Create an employee: `bots/<id>.toml` and its memory folder (`MEMORY.md`, `journal.md`) in one commit by the person.
   * Its id is kept unless another employee, record or memory folder of the organization has it, when a new one is
   * given (an id is never reused). It is a draft; with `approve` it is approved on this computer as well.
   */
  async create(orgId: string, definition: EmployeeDefinition, options: { approve?: boolean } = {}): Promise<EmployeeView> {
    const org = this.organization(orgId)
    let d = this.checked(definition)
    const { entries, folders } = await this.load(orgId)
    this.checkName(d, entries)
    const taken = new Set([...entries.map((e) => e.id), ...folders, ...this.records().filter((r) => r.orgId === orgId).map((r) => r.id)])
    if (taken.has(d.id)) d = { ...d, id: newEmployeeId(taken) }
    // Its delegates must be the organization's other employees.
    const unknown = d.access.delegate_to.filter((id) => !entries.some((e) => e.id === id))
    if (unknown.length) throw new Error(`${d.name} can only hand tasks to employees of ${org.name}: ${unknown.join(', ')} isn’t one.`)
    const path = employeePath(d.id)
    const seeds = seedMemoryFiles(d)
    const result = await this.host.memory.commitAsPerson(
      orgId,
      [{ kind: 'write', path, text: serializeEmployee(d), expectedBlob: null }, ...Object.entries(seeds).map(([file, text]) => ({ kind: 'write' as const, path: file, text, expectedBlob: null }))],
      { subject: `Add AI employee ${d.name} (${path})` }
    )
    if (!result.ok) throw new Error(`${result.path} is already in ${org.name}’s memory repository. Look again and try once more.`)
    const now = (this.host.now?.() ?? new Date()).toISOString()
    this.setRecord(orgId, d.id, options?.approve === true ? { state: 'active', approvedFingerprint: employeeFingerprint(d), approvedBlob: result.blobs[path] ?? undefined, approvedAt: now } : { state: 'draft' })
    this.host.changed()
    const { file } = await this.entry(orgId, d.id)
    return this.view(orgId, file)
  }

  /**
   * Save an edit against the file as it was read (`expectedBlob`); a file changed since is a conflict, with how it is
   * now. The id can't change, and a retired employee isn't edited. If the fingerprint moved, an approved employee is
   * "changed since approval" until it is approved again.
   */
  async update(orgId: string, id: string, definition: EmployeeDefinition, expectedBlob: string): Promise<EmployeeUpdateResult> {
    this.organization(orgId)
    if (!isEmployeeId(id) || typeof expectedBlob !== 'string' || !expectedBlob) throw new Error('Invalid employee')
    const d = this.checked(definition)
    if (d.id !== id) throw new Error('An employee’s id never changes.')
    if (this.record(orgId, id)?.state === 'retired') throw new Error(`${d.name} is retired.`)
    const { entries } = await this.load(orgId)
    if (!entries.some((e) => e.id === id)) throw new Error('Employee not found')
    this.checkName(d, entries, id)
    const unknown = d.access.delegate_to.filter((other) => !entries.some((e) => e.id === other))
    if (unknown.length) throw new Error(`${d.name} can only hand tasks to employees of this organization: ${unknown.join(', ')} isn’t one.`)
    const path = employeePath(id)
    const result = await this.host.memory.commitAsPerson(orgId, [{ kind: 'write', path, text: serializeEmployee(d), expectedBlob }], { subject: `Edit AI employee ${d.name} (${path})` })
    if (!result.ok) return { ok: false, conflict: result.conflict }
    const { file } = await this.entry(orgId, id)
    return { ok: true, employee: await this.view(orgId, file) }
  }

  // ---- lifecycle and approval, on this computer ----

  /**
   * Approve the definition as it is now: its fingerprint, its file's blob and the time are recorded here. With
   * `expectedFingerprint` (what the plan the person read was made from), a definition that changed meanwhile is refused.
   * A paused employee stays paused.
   */
  async approve(orgId: string, id: string, expectedFingerprint?: string): Promise<EmployeeView> {
    this.organization(orgId)
    const { file } = await this.entry(orgId, id)
    if (!file.definition || !file.fingerprint) throw new Error(`${file.path} has problems to fix before it can be approved.`)
    const record = this.record(orgId, id)
    if (record?.state === 'retired') throw new Error(`${file.definition.name} is retired.`)
    if (expectedFingerprint !== undefined && expectedFingerprint !== file.fingerprint) throw new Error(`${file.definition.name}’s definition changed while you were reading the plan. Look at it again.`)
    const now = (this.host.now?.() ?? new Date()).toISOString()
    this.setRecord(orgId, id, { state: record?.state === 'paused' ? 'paused' : 'active', approvedFingerprint: file.fingerprint, approvedBlob: file.blob, approvedAt: now })
    this.host.changed()
    this.host.lifecycle?.(orgId, id)
    return this.view(orgId, file)
  }

  /** Hold an approved employee: nothing of it runs until Resume. A draft has nothing to hold. */
  async pause(orgId: string, id: string): Promise<void> {
    this.organization(orgId)
    const record = this.lifecycle(orgId, id)
    if (record.state === 'paused') return
    if (record.state !== 'active') throw new Error(record.state === 'retired' ? 'This employee is retired.' : 'Approve this employee first: a draft doesn’t run, so there is nothing to pause.')
    this.setRecord(orgId, id, { state: 'paused', pausedKind: 'person', pausedDetail: undefined })
    this.host.changed()
    this.host.lifecycle?.(orgId, id)
  }

  async resume(orgId: string, id: string): Promise<void> {
    this.organization(orgId)
    const record = this.lifecycle(orgId, id)
    if (record.state === 'active') return
    if (record.state !== 'paused') throw new Error(record.state === 'retired' ? 'This employee is retired.' : 'Approve this employee first.')
    // Resuming after failures is the person's say that it may try again: the count starts over.
    this.setRecord(orgId, id, { state: 'active', pausedKind: undefined, pausedDetail: undefined, failures: undefined })
    this.host.changed()
    this.host.lifecycle?.(orgId, id)
  }

  /** Retire: it never runs again on this computer. Its definition and memory stay in the memory repository. */
  async retire(orgId: string, id: string): Promise<void> {
    this.organization(orgId)
    const record = this.lifecycle(orgId, id)
    if (record.state === 'retired') return
    this.setRecord(orgId, id, { state: 'retired', pausedKind: undefined, pausedDetail: undefined, failures: undefined })
    this.host.changed()
    this.host.lifecycle?.(orgId, id)
  }

  /** The record of an employee the cache knows (its file read), or a draft for one that has none yet. */
  private lifecycle(orgId: string, id: string): EmployeeRecord {
    if (!isEmployeeId(id)) throw new Error('Employee not found')
    const known = this.cache.get(orgId)?.entries.some((e) => e.id === id) || this.record(orgId, id)
    if (!known) throw new Error('Employee not found')
    return this.record(orgId, id) ?? { orgId, id, state: 'draft' }
  }

  // ---- Generate and Refine ----

  /** The organization's repository names (its memory repository left out) and the hat colours its employees wear. */
  private async context(org: Organization): Promise<{ repos: string[]; worn: string[] }> {
    const repos = reposInSpace(this.state.repos, this.state.organizations ?? [], org.id)
      .filter((r) => r.id !== org.memoryRepoId)
      .map((r) => r.name)
    const { entries } = await this.load(org.id)
    const worn = entries.flatMap((e) => (e.definition && this.record(org.id, e.id)?.state !== 'retired' ? [e.definition.look.colour] : []))
    return { repos, worn }
  }

  private async ask(prompt: string): Promise<{ text: string; agent: string; model: string }> {
    if (this.state.settings.privacyMode) throw new Error(PRIVACY_MODE_ON)
    if (!this.host.draft) throw new Error('No agent here can draft an employee. Use Save as is.')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The model didn’t answer in time. Try again, or use Save as is.')), DRAFT_TIMEOUT_MS)
    })
    try {
      const answer = await Promise.race([this.host.draft({ system: EMPLOYEE_DRAFT_SYSTEM_PROMPT, prompt }), timeout])
      if (!answer) throw new Error('No agent here can draft an employee: sign in to one in Settings → Agents, or use Save as is.')
      return answer
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Generate (§5.3): one request with the person's description, the personality they picked, the organization's
   * repository names and the colours nobody wears. Returns the draft's words, a free colour (unless the person picked
   * one), and what it suggests; nothing in it is a grant. Refused under Privacy mode.
   */
  async generate(orgId: string, input: EmployeeDraftInput): Promise<EmployeeDraftResult> {
    const org = this.organization(orgId)
    const description = typeof input?.description === 'string' ? input.description.trim() : ''
    if (!description) throw new Error('Describe the employee first.')
    if (description.length > MAX_DRAFT_DESCRIPTION) throw new Error(`Keep the description under ${MAX_DRAFT_DESCRIPTION} characters.`)
    const traits = (Array.isArray(input.traits) ? input.traits : []).filter((t): t is PersonalityTrait => (PERSONALITY_TRAITS as readonly string[]).includes(t))
    const otherTrait = typeof input.otherTrait === 'string' ? input.otherTrait.trim().slice(0, 100) : ''
    const picked = typeof input.colour === 'string' && (HAT_COLOURS as readonly string[]).includes(input.colour) ? input.colour : undefined
    if (this.state.settings.privacyMode) throw new Error(PRIVACY_MODE_ON)
    const { repos, worn } = await this.context(org)
    const freeColours = HAT_COLOURS.filter((c) => !worn.includes(c))
    const answer = await this.ask(employeeDraftPrompt({ organization: org.name, description, traits, ...(otherTrait ? { otherTrait } : {}), repos, freeColours }))
    const parsed = parseEmployeeDraftAnswer(answer.text, { repos, freeColours })
    if (!parsed.ok) throw new Error(`The draft didn’t come back as expected: ${parsed.problem} Try again, or use Save as is.`)
    return { text: parsed.text, ...(picked ? {} : { colour: parsed.colour ?? freeHatColour(worn) }), suggested: parsed.suggested, agent: answer.agent, model: answer.model }
  }

  /** Refine: the same request with the current draft's words and the person's change. The hat and every setting stay. */
  async refine(orgId: string, draft: EmployeeDraftText, request: string): Promise<EmployeeDraftResult> {
    const org = this.organization(orgId)
    const text = typeof request === 'string' ? request.trim() : ''
    if (!text) throw new Error('Say what to change.')
    if (text.length > MAX_REFINE_REQUEST) throw new Error(`Keep the change under ${MAX_REFINE_REQUEST} characters.`)
    const current = checkedDraftText(draft)
    if (this.state.settings.privacyMode) throw new Error(PRIVACY_MODE_ON)
    const { repos, worn } = await this.context(org)
    const answer = await this.ask(employeeRefinePrompt({ organization: org.name, draft: current, request: text, repos }))
    const parsed = parseEmployeeDraftAnswer(answer.text, { repos, freeColours: HAT_COLOURS.filter((c) => !worn.includes(c)) })
    if (!parsed.ok) throw new Error(`The draft didn’t come back as expected: ${parsed.problem} Your draft is unchanged; try again.`)
    return { text: parsed.text, suggested: parsed.suggested, agent: answer.agent, model: answer.model }
  }
}

/** A draft's words from the window, each a text within its length (the responsibilities a short list of them). */
function checkedDraftText(draft: unknown): EmployeeDraftText {
  const d = draft as Record<string, unknown> | null
  const fields = ['name', 'role', 'description', 'personality', 'ask_me_about', 'instructions'] as const
  if (!d || typeof d !== 'object' || fields.some((f) => typeof d[f] !== 'string' || (d[f] as string).length > EMPLOYEE_TEXT_LIMITS[f])) throw new Error('Invalid draft')
  const responsibilities = d.responsibilities
  if (!Array.isArray(responsibilities) || responsibilities.length > MAX_RESPONSIBILITIES || responsibilities.some((r) => typeof r !== 'string' || r.length > EMPLOYEE_TEXT_LIMITS.responsibility)) throw new Error('Invalid draft')
  return draftTextOf({ ...(d as unknown as EmployeeDefinition), responsibilities: responsibilities as string[] })
}
