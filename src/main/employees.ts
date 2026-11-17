// AI employees (docs/ai-employees.md §5): an organization's employees are its memory repository's `bots/<id>.toml`
// files, each with its own prompt beside it in `bots/<id>.md`, read and written only through the memory service; whether each is approved, paused or retired on this
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
  employeeIdOfPromptPath,
  employeeMemoryFolder,
  employeeNameProblem,
  employeePath,
  employeePromptFile,
  employeePromptPath,
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
  withFullAccess,
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
import { ownPromptNote } from '../shared/employeePrompts'
import { programManagerDefinition } from '../shared/employeeTeams'
import { isEmployeeTemplateId, jobTitle, templateDefinitions, type EmployeeTemplateId } from '../shared/employeeTemplates'
import { createT, type Locale } from '../shared/i18n'
import { isEmployeeId } from '../shared/memory'
import { reposInSpace, type Organization } from '../shared/organizations'
import { jobOfEarlierPrompt } from './earlierJobPrompts'
import type { MemoryService } from './memory'
import type { PersistedState } from './store'

/** The longest a drafting request may take before the window is told it didn't answer. */
export const DRAFT_TIMEOUT_MS = 3 * 60_000

export const PRIVACY_MODE_ON = 'Privacy mode is on, so nothing is sent to a model: press Use my words, or turn Privacy mode off in Settings → General.'

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

/** What the service knows of one definition file, with its own prompt file, at a head. */
interface FileEntry {
  id: string
  path: string
  blob: string
  text: string | null
  // `bots/<id>.md`'s blob and text; null while there is none (a definition written before prompts had their own).
  promptBlob: string | null
  prompt: string | null
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

/**
 * state.migrations: `<this>:<organization id>` once its employees were given what every employee now has (withFullAccess):
 * a shell, and their files written without the MCP list and limits nothing reads any more. Its earlier version,
 * `employees-full-access`, gave Write and pushes; this one does that too, for an organization that never had it.
 */
export const FULL_ACCESS_MIGRATION = 'employees-shell'

/** state.migrations: `<this>:<organization id>` once its employees whose prompt was a job's, word for word, were linked to that job. */
export const JOB_PROMPTS_MIGRATION = 'employees-job-prompts'

/** The changes that write a definition and its own prompt file, each against the version read (null: a new file). */
function definitionWrites(d: EmployeeDefinition, read?: { blob: string; promptBlob: string | null }) {
  return [
    { kind: 'write' as const, path: employeePath(d.id), text: serializeEmployee(d), expectedBlob: read ? read.blob : null },
    { kind: 'write' as const, path: employeePromptPath(d.id), text: employeePromptFile(d), expectedBlob: read ? read.promptBlob : null }
  ]
}

/**
 * The definition with the job prompt it was given word for word linked instead (shared/employeePrompts): its job
 * recorded and its own file starting with the note for whoever edits it. Unchanged when its prompt is no earlier job's.
 */
function linkedToJob(d: EmployeeDefinition): EmployeeDefinition {
  if (d.template) return d
  const job = jobOfEarlierPrompt(d.instructions)
  return job ? { ...d, template: job, instructions: ownPromptNote(jobTitle(job), d.id) } : d
}

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
    const prompts = new Map<string, string>()
    for (const entry of tree.entries) {
      const id = employeeIdOfPromptPath(entry.path)
      if (id !== null) prompts.set(id, entry.blob)
    }
    for (const entry of tree.entries) {
      const folder = /^memory\/bots\/([^/]+)\//.exec(entry.path)
      if (folder) folders.add(folder[1])
      const id = employeeIdOfPath(entry.path)
      if (id === null) continue
      const promptBlob = prompts.get(id) ?? null
      const key = `${locale}:${entry.path}:${entry.blob}:${promptBlob ?? ''}`
      let file = this.parsed.get(key)
      if (!file) {
        const text = await this.host.memory.readBlob(orgId, entry.blob)
        const prompt = promptBlob === null ? null : await this.host.memory.readBlob(orgId, promptBlob)
        file = { id, path: entry.path, blob: entry.blob, text, promptBlob, prompt, problems: [] }
        if (text === null || (promptBlob !== null && prompt === null)) file.problems = [t('employees.problem.unreadable')]
        else {
          const parse = parseEmployee(text, t, prompt)
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
    const approved = summary.changed && record ? await this.approvedFiles(orgId, record) : null
    return {
      ...summary,
      blob: file.blob,
      text: file.text,
      promptBlob: file.promptBlob,
      prompt: file.prompt,
      ...(file.definition ? { definition: file.definition, fingerprint: file.fingerprint } : {}),
      ...(approved ? { approvedText: approved.text, approvedPrompt: approved.prompt } : {})
    }
  }

  /**
   * The files as they were approved, for a diff: the definition and its own prompt. One approved before prompts had
   * their own is shown split as it would be now, so the diff shows what changed, not where the prompt moved.
   */
  private async approvedFiles(orgId: string, record: EmployeeRecord): Promise<{ text: string; prompt: string } | null> {
    const text = record.approvedBlob ? await this.host.memory.readBlob(orgId, record.approvedBlob) : null
    if (text === null) return null
    if (record.approvedPromptBlob) {
      const prompt = await this.host.memory.readBlob(orgId, record.approvedPromptBlob)
      return prompt === null ? null : { text, prompt }
    }
    const before = parseEmployee(text).definition
    return before ? { text: serializeEmployee(before), prompt: employeePromptFile(before) } : { text, prompt: '' }
  }

  /** The definition approved here, read back from its files; undefined when they are gone or don't read as one. */
  private async approvedDefinition(orgId: string, record: EmployeeRecord): Promise<EmployeeDefinition | undefined> {
    const text = record.approvedBlob ? await this.host.memory.readBlob(orgId, record.approvedBlob) : null
    if (text === null) return undefined
    const prompt = record.approvedPromptBlob ? await this.host.memory.readBlob(orgId, record.approvedPromptBlob) : null
    if (record.approvedPromptBlob && prompt === null) return undefined
    return parseEmployee(text, undefined, prompt).definition
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

  /** Read an organization's definitions again if its memory repository's head moved; a failure is kept to show. */
  refresh(orgId: string): Promise<void> {
    const running = this.refreshing.get(orgId)
    if (running) return running
    const run = (async () => {
      try {
        this.organization(orgId)
        let read = await this.load(orgId)
        if (await this.ownPromptFiles(orgId, read.entries)) read = await this.load(orgId)
        await this.widenOnce(orgId, read.entries)
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

  /**
   * Every employee's prompt in its own file (`bots/<id>.md`): a definition that still keeps its prompt in the TOML is
   * written as the two files, which changes nothing it runs with, so its fingerprint and approval stay. Once per
   * organization on this computer, an employee whose prompt is a job's prompt word for word, as an earlier build wrote it
   * (a template employee, or the program manager), is linked to that job instead (linkedToJob), so it is given the job's
   * prompt as Foreman has it now and improves when that does; an approval of it as it was moves with it, here and on a
   * computer that reads the commit, since the person asked for exactly this. One commit by the person; a conflict or a
   * refused commit is tried again at the next refresh, and never stops the roster loading. True when it committed.
   */
  private async ownPromptFiles(orgId: string, entries: FileEntry[]): Promise<boolean> {
    const key = `${JOB_PROMPTS_MIGRATION}:${orgId}`
    const done = (this.state.migrations ??= [])
    const linking = !done.includes(key)
    try {
      const readable = entries.filter((e) => e.definition && e.fingerprint)
      const writes = readable.flatMap((e) => {
        const next = linking ? linkedToJob(e.definition!) : e.definition!
        return next !== e.definition || e.promptBlob === null ? [{ entry: e, next }] : []
      })
      let blobs: Record<string, string | null> = {}
      if (writes.length) {
        const linked = writes.filter((w) => w.next.template && !w.entry.definition!.template).length
        const result = await this.host.memory.commitAsPerson(
          orgId,
          writes.flatMap(({ entry, next }) => definitionWrites(next, entry)),
          { subject: linked ? 'Give every AI employee its own prompt file, and its job’s prompt as Foreman has it' : 'Give every AI employee its own prompt file' }
        )
        if (!result.ok) return false
        blobs = result.blobs
      }
      // The approval of each as it was before the change (here, or on the computer that made the commit).
      for (const e of readable) {
        const record = this.record(orgId, e.id)
        if (!record?.approvedFingerprint) continue
        const write = writes.find((w) => w.entry === e)
        const after = write ? employeeFingerprint(write.next) : e.fingerprint!
        const files = write ? { approvedBlob: blobs[e.path] ?? undefined, approvedPromptBlob: blobs[employeePromptPath(e.id)] ?? undefined } : {}
        if (record.approvedFingerprint === after) {
          if (write) this.setRecord(orgId, e.id, files)
          continue
        }
        if (!linking) continue
        // The file the approval recorded: an approval from before a build that writes no MCP list or limits has a
        // fingerprint this build can't take again (widenOnce).
        const before = await this.approvedDefinition(orgId, record)
        if (!before || employeeFingerprint(linkedToJob(before)) !== after) continue
        this.setRecord(orgId, e.id, { approvedFingerprint: after, ...(write ? files : { approvedBlob: e.blob, approvedPromptBlob: e.promptBlob ?? undefined }) })
      }
      if (linking) done.push(key)
      if (linking || writes.length) this.host.changed()
      return writes.length > 0
    } catch (err) {
      console.warn(`[employees] couldn't give ${orgId}'s employees their own prompt files yet: ${message(err)}`)
      return false
    }
  }

  /**
   * Once per organization on this computer: every employee it had before all of them had a shell, could write their
   * repositories, push and open pull requests gets that (withFullAccess), in one commit by the person, who asked for
   * exactly this change, and each file is written without the MCP list and limits nothing reads any more. So an approval
   * of the file as it was moves to the file as it is, here and on another computer that reads the commit: nothing else
   * changed, so nothing else is approved. The file as it was is the one the approval recorded (its blob): its
   * fingerprint was taken over the MCP list and limits, which this build no longer reads, so it can't be taken again.
   * Retired employees are left as they are. A conflict or a refused commit is tried again at the next refresh, and never
   * stops the roster loading.
   */
  private async widenOnce(orgId: string, entries: FileEntry[]): Promise<void> {
    const key = `${FULL_ACCESS_MIGRATION}:${orgId}`
    const done = (this.state.migrations ??= [])
    if (done.includes(key)) return
    try {
      const live = entries.filter((e) => e.definition && e.fingerprint && this.record(orgId, e.id)?.state !== 'retired')
      const writes = live.flatMap((e) => {
        const wider = withFullAccess(e.definition!)
        return employeeFingerprint(wider) === e.fingerprint && serializeEmployee(wider) === e.text ? [] : [{ entry: e, wider }]
      })
      let blobs: Record<string, string | null> = {}
      if (writes.length) {
        const result = await this.host.memory.commitAsPerson(
          orgId,
          writes.flatMap(({ entry, wider }) => definitionWrites(wider, entry)),
          { subject: 'Give every AI employee a shell, every MCP server and no limits' }
        )
        if (!result.ok) return
        blobs = result.blobs
      }
      // The approval of each file as it was before the change (here, or on the computer that made the commit).
      for (const e of live) {
        const record = this.record(orgId, e.id)
        if (!record?.approvedFingerprint) continue
        const write = writes.find((w) => w.entry === e)
        const after = write ? employeeFingerprint(write.wider) : e.fingerprint!
        if (record.approvedFingerprint === after) continue
        const before = await this.approvedDefinition(orgId, record)
        if (!before || employeeFingerprint(withFullAccess(before)) !== after) continue
        this.setRecord(orgId, e.id, {
          approvedFingerprint: after,
          approvedBlob: (write ? blobs[e.path] : e.blob) ?? undefined,
          approvedPromptBlob: (write ? blobs[employeePromptPath(e.id)] : e.promptBlob) ?? undefined
        })
      }
      done.push(key)
      this.host.changed()
      if (writes.length) await this.load(orgId)
    } catch (err) {
      console.warn(`[employees] couldn't give ${orgId}'s employees full access yet: ${message(err)}`)
    }
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
   * Create an employee: `bots/<id>.toml`, its own prompt `bots/<id>.md` and its memory folder (`MEMORY.md`,
   * `journal.md`) in one commit by the person.
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
      [...definitionWrites(d), ...Object.entries(seeds).map(([file, text]) => ({ kind: 'write' as const, path: file, text, expectedBlob: null }))],
      { subject: `Add AI employee ${d.name} (${path})` }
    )
    if (!result.ok) throw new Error(`${result.path} is already in ${org.name}’s memory repository. Look again and try once more.`)
    const now = (this.host.now?.() ?? new Date()).toISOString()
    this.setRecord(
      orgId,
      d.id,
      options?.approve === true
        ? { state: 'active', approvedFingerprint: employeeFingerprint(d), approvedBlob: result.blobs[path] ?? undefined, approvedPromptBlob: result.blobs[employeePromptPath(d.id)] ?? undefined, approvedAt: now }
        : { state: 'draft' }
    )
    this.host.changed()
    const { file } = await this.entry(orgId, d.id)
    return this.view(orgId, file)
  }

  /**
   * Several at once (docs/ai-employees.md §15: the program manager, the employees a plan proposes): every definition and
   * its memory folder in one commit by the person, each a draft here (nothing is approved). Their hand-offs may name each
   * other. Ids already used in the organization are refused rather than replaced, so the ids the caller records still
   * name these employees.
   */
  async createTeam(orgId: string, definitions: EmployeeDefinition[]): Promise<EmployeeView[]> {
    const org = this.organization(orgId)
    if (!Array.isArray(definitions) || !definitions.length) return []
    const checked = definitions.map((d) => this.checked(d))
    const { entries, folders } = await this.load(orgId)
    const taken = new Set([...entries.map((e) => e.id), ...folders, ...this.records().filter((r) => r.orgId === orgId).map((r) => r.id)])
    const ids = new Set<string>()
    const names: { id: string; name: string }[] = entries.flatMap((e) => (e.definition ? [{ id: e.id, name: e.definition.name }] : []))
    for (const d of checked) {
      if (taken.has(d.id) || ids.has(d.id)) throw new Error(`${d.id} is already used in ${org.name}.`)
      const problem = employeeNameProblem(d.name, names)
      if (problem) throw new Error(problem === 'taken' ? `There is already an employee named ${d.name.trim()} in ${org.name}.` : 'Give every employee a name.')
      ids.add(d.id)
      names.push({ id: d.id, name: d.name })
    }
    for (const d of checked) {
      const unknown = d.access.delegate_to.filter((id) => !ids.has(id) && !entries.some((e) => e.id === id))
      if (unknown.length) throw new Error(`${d.name} can only hand tasks to employees of ${org.name}: ${unknown.join(', ')} isn’t one.`)
    }
    const changes = checked.flatMap((d) => [
      ...definitionWrites(d),
      ...Object.entries(seedMemoryFiles(d)).map(([file, text]) => ({ kind: 'write' as const, path: file, text, expectedBlob: null }))
    ])
    const subject = checked.length === 1 ? `Add AI employee ${checked[0].name} (${employeePath(checked[0].id)})` : `Add the team: ${checked.map((d) => d.name).join(', ')}`
    const result = await this.host.memory.commitAsPerson(orgId, changes, { subject })
    if (!result.ok) throw new Error(`${result.path} is already in ${org.name}’s memory repository.`)
    for (const d of checked) this.setRecord(orgId, d.id, { state: 'draft' })
    this.host.changed()
    const out: EmployeeView[] = []
    for (const d of checked) {
      const { file } = await this.entry(orgId, d.id)
      out.push(await this.view(orgId, file))
    }
    return out
  }

  /**
   * Make several in one commit, as createTeam does, then approve each as it is (§15, §16): the program manager and the
   * templates New organization picked, or the one template Add employee picked. An approval that fails leaves that
   * employee and the ones after it as drafts, approved on their pages, and says why; nothing made is taken back.
   */
  async createApproved(orgId: string, definitions: EmployeeDefinition[]): Promise<{ employees: EmployeeView[]; approveError?: string }> {
    const made = await this.createTeam(orgId, definitions)
    const employees: EmployeeView[] = []
    for (const [i, e] of made.entries()) {
      try {
        employees.push(await this.approve(orgId, e.id))
      } catch (err) {
        return { employees: [...employees, ...made.slice(i)], approveError: message(err) }
      }
    }
    return { employees }
  }

  /**
   * Add employee's Pick a job (§5.3, §16): one template employee, made and approved at once with the template's own
   * access on the organization's repositories (its memory repository left out) and the person's loadouts. Its name,
   * hat and id are decided here from the roster as it is now; the window previews the same with templateDefinitions on
   * the roster it has (PickJob.tsx).
   */
  async addTemplate(orgId: string, templateId: string): Promise<{ employee: EmployeeView; approveError?: string }> {
    const org = this.organization(orgId)
    if (!isEmployeeTemplateId(templateId)) throw new Error('There is no such job to add.')
    const { entries, folders } = await this.load(orgId)
    const repos = reposInSpace(this.state.repos, this.state.organizations ?? [], org.id)
      .filter((r) => r.id !== org.memoryRepoId)
      .map((r) => r.name)
    const [definition] = templateDefinitions({
      templates: [templateId],
      repos,
      loadouts: this.state.settings.loadouts,
      taken: [...entries.map((e) => e.id), ...folders, ...this.records().filter((r) => r.orgId === orgId).map((r) => r.id)],
      takenNames: entries.flatMap((e) => (e.definition ? [e.definition.name] : [])),
      worn: entries.flatMap((e) => (e.definition && this.record(orgId, e.id)?.state !== 'retired' ? [e.definition.look.colour] : []))
    })
    const { employees, approveError } = await this.createApproved(orgId, [definition])
    return { employee: employees[0], ...(approveError ? { approveError } : {}) }
  }

  /**
   * New organization's program manager (§15) and the templates the person picked in the same dialog, on the repositories
   * it has (its memory repository left out): made in one commit and approved, the way addTemplate makes one. Her
   * definition is fixed and the same in every organization, and the dialog names each one Create approves, so an
   * approval that fails throws. Returns her id.
   */
  async addProgramManager(orgId: string, templates: readonly EmployeeTemplateId[] = []): Promise<string> {
    const org = this.organization(orgId)
    const repos = reposInSpace(this.state.repos, this.state.organizations ?? [], org.id)
      .filter((r) => r.id !== org.memoryRepoId)
      .map((r) => r.name)
    const members = await this.members(orgId)
    const loadouts = this.state.settings.loadouts
    const taken = members.map((m) => m.summary.id)
    const takenNames = members.map((m) => m.summary.name)
    const definition = programManagerDefinition({ repos, loadouts, taken, takenNames })
    const picked = templateDefinitions({ templates, repos, loadouts, taken: [...taken, definition.id], takenNames: [...takenNames, definition.name] })
    const { approveError } = await this.createApproved(orgId, [definition, ...picked])
    if (approveError) throw new Error(approveError)
    return definition.id
  }

  /**
   * Save an edit against the files as they were read (`expectedBlob` for the definition, `expectedPromptBlob` for its
   * own prompt, null while it had none; left out, it isn't checked); a file changed since is a conflict, with how it is
   * now. The id can't change,
   * and a retired employee isn't edited. If the fingerprint moved, an approved employee is "changed since approval"
   * until it is approved again.
   */
  async update(orgId: string, id: string, definition: EmployeeDefinition, expectedBlob: string, expectedPromptBlob?: string | null): Promise<EmployeeUpdateResult> {
    this.organization(orgId)
    if (!isEmployeeId(id) || typeof expectedBlob !== 'string' || !expectedBlob || (expectedPromptBlob !== undefined && expectedPromptBlob !== null && (typeof expectedPromptBlob !== 'string' || !expectedPromptBlob))) throw new Error('Invalid employee')
    const d = this.checked(definition)
    if (d.id !== id) throw new Error('An employee’s id never changes.')
    if (this.record(orgId, id)?.state === 'retired') throw new Error(`${d.name} is retired.`)
    const { entries } = await this.load(orgId)
    const read = entries.find((e) => e.id === id)
    if (!read) throw new Error('Employee not found')
    this.checkName(d, entries, id)
    const unknown = d.access.delegate_to.filter((other) => !entries.some((e) => e.id === other))
    if (unknown.length) throw new Error(`${d.name} can only hand tasks to employees of this organization: ${unknown.join(', ')} isn’t one.`)
    const path = employeePath(id)
    const result = await this.host.memory.commitAsPerson(orgId, definitionWrites(d, { blob: expectedBlob, promptBlob: expectedPromptBlob === undefined ? read.promptBlob : expectedPromptBlob }), { subject: `Edit AI employee ${d.name} (${path})` })
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
    this.setRecord(orgId, id, { state: record?.state === 'paused' ? 'paused' : 'active', approvedFingerprint: file.fingerprint, approvedBlob: file.blob, approvedPromptBlob: file.promptBlob ?? undefined, approvedAt: now })
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
    if (!this.host.draft) throw new Error('No agent here can draft an employee. Press Use my words.')
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('The model didn’t answer in time. Try again, or press Use my words.')), DRAFT_TIMEOUT_MS)
    })
    try {
      const answer = await Promise.race([this.host.draft({ system: EMPLOYEE_DRAFT_SYSTEM_PROMPT, prompt }), timeout])
      if (!answer) throw new Error('No agent here can draft an employee: sign in to one in Settings → Agents, or press Use my words.')
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
    if (!parsed.ok) throw new Error(`The draft didn’t come back as expected: ${parsed.problem} Try again, or press Use my words.`)
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
