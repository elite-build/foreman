import { ChevronDown, CircleDot, FolderGit2, FolderOpen, FolderRoot, GitBranch, GitPullRequest, Paperclip } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent, type ReactNode } from 'react'
import { AGENTS, DEFAULT_MODEL, isSameModel, modelInfo, modelsFor, type AgentKind, type Loadout } from '../../../shared/agents'
import { catalogAgent, enabledAgentIds } from '../../../shared/agentCatalog'
import { pickerModels, type HiddenModels } from '../../../shared/modelVisibility'
import { fillIssuePlaceholders, intakeLine, type GithubLinkInfo } from '../../../shared/githubLink'
import { findScmLink } from '../../../shared/scm'
import { insertTemplate, templateAfterEdit } from '../../../shared/promptTemplates'
import { templateById } from '../../../shared/repoTemplates'
import { chooseStartLoadout } from '../../../shared/startModel'
import type { Attachment, BranchInfo, Repo, WorktreeInfo } from '../../../shared/types'
import { rankItems } from '../fuzzy'
import { adoptWorktree, api, attempt, availableAgents, bridge, createWorkspace, getState, openNewWorkspace, openSettingsPage, showToast, timeAgo, useStore } from '../store'
import { useAgentStatuses } from '../agentReadiness'
import { agentReadiness } from '../../../shared/agentReadiness'
import { openTerminalAgent } from './agents/TerminalAgents'
import { AttachmentChip, toBase64 } from './composer/Composer'
import { TemplatePicker } from './composer/TemplatePicker'
import { LinearIssuesButton, LinearLine, useHasLinear, useLinearIntake } from './LinearIntake'
import { useT, type RendererT } from '../i18n'
import { RepoIconView } from './Sidebar'
import { RunsOnField, useCloudReadiness, type RunsOnLocation } from './cloud/RunsOn'
import { providerLabel, providerRegion, repoCloud, type CloudProviderId } from '../../../shared/cloud'
import type { CloudProviderView } from '../../../shared/types'
import { blocksChoice, providerFacts } from '../cloudView'
import { Button, Checkbox, Combobox, Dialog, Field, Kbd, LinkButton, MediaThumb, MenuButton, MenuRadioItem, RadioCards, RadioList, Segmented, Select, Spinner, Status, Tag, TextArea, TextInput, type ListboxOption, type RadioCardOption } from '../ui'

// Long branch lists are cut off; typing narrows them down.
const MAX_OPTIONS = 150
const NO_HIDDEN: HiddenModels = {}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** The path with the home folder shown as ~. */
export function tildify(path: string, home: string): string {
  const root = home.replace(/[\\/]+$/, '')
  if (!root) return path
  if (path === root) return '~'
  if (path.startsWith(`${root}/`) || path.startsWith(`${root}\\`)) return `~${path.slice(root.length)}`
  return path
}

function samePath(a: string, b: string, platform: string): boolean {
  const norm = (p: string) => {
    const trimmed = p.replace(/\\/g, '/').replace(/\/+$/, '')
    return platform === 'linux' ? trimmed : trimmed.toLowerCase()
  }
  return norm(a) === norm(b)
}

// ---- data ----

interface BranchState {
  list: BranchInfo[] | null
  fetch: 'none' | 'fetching' | 'done' | 'failed'
  fetchedAt?: string
  error?: string
}

/** Local branches straight away, then again after fetching from the remote. */
function useBranches(repo: Repo | undefined): BranchState {
  const [state, setState] = useState<BranchState>({ list: null, fetch: 'none' })
  const id = repo?.id
  const hasOrigin = Boolean(repo?.hasOrigin)
  useEffect(() => {
    if (!id) return
    let live = true
    let fetched = false
    setState({ list: null, fetch: hasOrigin ? 'fetching' : 'none' })
    api
      .listBranches(id)
      .then((list) => live && !fetched && setState((s) => ({ ...s, list })))
      .catch((err) => live && !fetched && setState((s) => ({ ...s, list: s.list ?? [], error: message(err) })))
    if (hasOrigin) {
      api
        .listBranches(id, { fetch: true })
        .then((list) => {
          if (!live) return
          fetched = true
          setState({ list, fetch: 'done', fetchedAt: new Date().toISOString() })
        })
        .catch(() => live && setState((s) => ({ ...s, fetch: 'failed' })))
    }
    return () => {
      live = false
    }
  }, [id, hasOrigin])
  return state
}

// ---- branch combobox ----

function BranchTags({ branch, inUse }: { branch: BranchInfo; inUse: boolean }) {
  const t = useT()
  return (
    <>
      {branch.isDefault && <Tag tone="outline">{t('newWorkspace.tag.default')}</Tag>}
      {branch.remote && !branch.local && <Tag tone="outline">{t('newWorkspace.tag.remote')}</Tag>}
      {inUse && branch.checkedOutAt && <Tag tone="outline">{t('newWorkspace.tag.inUse')}</Tag>}
    </>
  )
}

interface BranchPickerProps {
  branches: BranchInfo[] | null
  value: string
  onChange: (name: string) => void
  home: string
  label: string
  placeholder?: string
  // Why a branch can't be chosen here, if it can't.
  unavailable?: (branch: BranchInfo) => string | undefined
  // Focus and open the list when it first appears.
  openOnMount?: boolean
}

/** A searchable branch list. The input only holds the search; the chosen branch shows as its placeholder. */
function BranchPicker({ branches, value, onChange, home, label, placeholder, unavailable, openOnMount }: BranchPickerProps) {
  const t = useT()
  const [open, setOpen] = useState(Boolean(openOnMount))
  const [query, setQuery] = useState('')
  const ranked = useMemo(() => rankItems(branches ?? [], query, (b) => b.name), [branches, query])
  const items = ranked.slice(0, MAX_OPTIONS)
  const selected = branches?.find((b) => b.name === value)

  const options: ListboxOption[] = items.map((b) => {
    const reason = unavailable?.(b)
    return {
      value: b.name,
      label: b.name,
      disabled: Boolean(reason),
      title: b.checkedOutAt,
      description: reason ?? (b.checkedOutAt ? tildify(b.checkedOutAt, home) : undefined),
      leading: <GitBranch size={13} aria-hidden />,
      trailing: <BranchTags branch={b} inUse={!reason} />
    }
  })

  return (
    <Combobox
      className="nw-combo"
      label={label}
      mono
      options={options}
      value={value}
      onChange={onChange}
      query={query}
      onQueryChange={setQuery}
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery('')
      }}
      placeholder={value || placeholder}
      autoFocus={openOnMount}
      leading={<GitBranch size={13} aria-hidden />}
      trailing={
        <>
          {!open && selected && <BranchTags branch={selected} inUse={false} />}
          <ChevronDown size={13} aria-hidden />
        </>
      }
      empty={
        branches === null ? (
          <>
            <Spinner size={12} /> {t('newWorkspace.branches.loading')}
          </>
        ) : query ? (
          t('newWorkspace.branches.noMatch')
        ) : (
          t('newWorkspace.branches.none')
        )
      }
      footer={ranked.length > items.length ? t('newWorkspace.branches.more', { count: ranked.length - items.length }) : undefined}
    />
  )
}

// ---- header: repository chip ----

function RepoChip({ repos, repo, onChange }: { repos: Repo[]; repo: Repo; onChange: (id: string) => void }) {
  const t = useT()
  const withIcons = repos.some((r) => r.icon)

  if (repos.length < 2) {
    return (
      <Tag className="nw-repo" title={repo.rootPath}>
        <RepoIconView icon={repo.icon} size={13} />
        {repo.name}
      </Tag>
    )
  }
  return (
    <MenuButton
      label={t('newWorkspace.repo.label')}
      look="chip"
      portal
      placement="bottom-start"
      className="nw-repo"
      menuClassName="nw-repo-menu"
      title={repo.rootPath}
      trigger={
        <>
          <RepoIconView icon={repo.icon} size={13} />
          {repo.name}
          <ChevronDown size={12} aria-hidden />
        </>
      }
    >
      {repos.map((r) => (
        <MenuRadioItem
          key={r.id}
          checked={r.id === repo.id}
          icon={withIcons ? <RepoIconView icon={r.icon} size={14} /> : undefined}
          onSelect={() => onChange(r.id)}
        >
          {r.name}
        </MenuRadioItem>
      ))}
    </MenuButton>
  )
}

// ---- existing worktrees ----

function treeUnavailable(tree: WorktreeInfo, t: RendererT): string | undefined {
  if (tree.workspaceId) return t('newWorkspace.tree.alreadyWorkspace')
  if (!tree.branch) return t('newWorkspace.tree.noBranch')
  return undefined
}

/** One worktree as a RadioCards choice: its path, then the branch and how many changes it holds. */
function treeOption({ path, home, meta, reason }: { path: string; home: string; meta: ReactNode; reason?: string }): RadioCardOption<string> {
  return {
    value: path,
    label: (
      <span className="nw-tree-path mono" title={path}>
        {tildify(path, home)}
      </span>
    ),
    description: <span className="nw-tree-meta">{meta}</span>,
    icon: <FolderGit2 size={15} />,
    disabled: Boolean(reason),
    reason
  }
}

function treeMeta(tree: WorktreeInfo, t: RendererT): ReactNode {
  return (
    <>
      {tree.branch ? (
        <span className="nw-tree-branch">
          <GitBranch size={11} aria-hidden /> {tree.branch}
        </span>
      ) : (
        <span>{t('newWorkspace.tree.detached')}</span>
      )}
      <span aria-hidden>·</span>
      {tree.dirty > 0 ? <span className="nw-dirty">{t('newWorkspace.tree.dirty', { count: tree.dirty })}</span> : <span>{t('newWorkspace.tree.clean')}</span>}
    </>
  )
}

// ---- first-message files ----

/** A file for the first message. Pasted data is staged first, so every file has a path; images keep a thumbnail. */
interface PendingFile {
  path: string
  name: string
  kind: Attachment['kind']
  // A data: URL (the page's CSP allows data: images, not blob:).
  preview?: string
}

// Like the chat composer: 10 at a time, 20 in all.
const MAX_ADDED = 10
const MAX_FILES = 20
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024
const IMAGE_NAME = /\.(png|jpe?g|gif|webp|bmp|svg)$/i

function fileKind(name: string, type = ''): Attachment['kind'] {
  if (type.startsWith('image/') || IMAGE_NAME.test(name)) return 'image'
  if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf'
  return 'file'
}

/** Pasted or dropped files: ones from disk are used where they are, clipboard data (a screenshot) is staged. */
async function readFiles(files: File[]): Promise<PendingFile[]> {
  const out: PendingFile[] = []
  for (const file of files.slice(0, MAX_ADDED)) {
    const name = file.name || `pasted-${Date.now()}.png`
    const kind = fileKind(name, file.type)
    const onDisk = bridge.pathForFile(file)
    const showable = kind === 'image' && file.size <= MAX_PREVIEW_BYTES
    const data = !onDisk || showable ? toBase64(await file.arrayBuffer()) : undefined
    const path = onDisk || (await attempt(() => api.stageAttachment(name, data!)))
    if (!path) continue
    out.push({ path, name, kind, ...(showable && data ? { preview: `data:${file.type || 'image/png'};base64,${data}` } : {}) })
  }
  return out
}

function FileThumb({ file, onRemove }: { file: PendingFile; onRemove: () => void }) {
  const t = useT()
  if (!file.preview) return <AttachmentChip attachment={file} onRemove={onRemove} />
  return <MediaThumb src={file.preview} name={file.name} title={file.name} onRemove={onRemove} removeLabel={t('composer.attachment.remove', { name: file.name })} />
}

// ---- dialog ----

/** G1: the "Terminal agent" choice in the Model select: `terminal:<id>`. */
const TERMINAL_PREFIX = 'terminal:'

function WorkspaceModelSelect({
  value,
  onChange,
  note,
  terminalAgent,
  onTerminalAgent,
  onSignIn
}: {
  value: Loadout
  onChange: (choice: Loadout) => void
  note?: string
  terminalAgent?: string | null
  onTerminalAgent?: (id: string) => void
  // Open Settings → Agents for an agent whose sign-in is missing.
  onSignIn?: (agent: AgentKind) => void
}) {
  const t = useT()
  const available = useStore((s) => availableAgents(s))
  // Claude and Codex stay selectable when signed out; the choice says so and offers sign-in.
  const statuses = useAgentStatuses()
  const signedOut = (agent: AgentKind) => agentReadiness(agent, { status: statuses[agent] }).needsSignIn
  const chosenSignedOut = !terminalAgent && signedOut(value.agent)
  const catalog = useStore((s) => s.snapshot!.catalog)
  const chosenOpencode = useStore((s) => s.snapshot!.settings.opencodeModels)
  const hidden = useStore((s) => s.snapshot!.settings.hiddenModels) ?? NO_HIDDEN
  const prefs = useStore((s) => s.snapshot!.settings.agentPrefs)
  // G1: the enabled Chat agents too, in catalog order after the Full ones; O8: hidden models left out (the chosen one stays).
  const groups = useMemo(
    () =>
      (Object.keys(available) as AgentKind[])
        .filter((agent) => available[agent] || agent === value.agent)
        .map((agent) => {
          const listed = agent === 'opencode' ? chosenOpencode.map((id) => modelInfo(agent, id)) : modelsFor(agent)
          const models = pickerModels(listed, hidden, value).shown
          // Keep a saved model selectable even if the agent no longer lists it.
          if (agent === value.agent && !models.some((model) => isSameModel(agent, model.id, value.model))) {
            return { agent, models: [modelInfo(agent, value.model), ...models] }
          }
          return { agent, models }
        }),
    [available, catalog, chosenOpencode, hidden, value]
  )
  const terminals = useMemo(() => (onTerminalAgent ? enabledAgentIds(prefs, 'terminal') : []), [onTerminalAgent, prefs])
  const selected = groups.find((group) => group.agent === value.agent)?.models.find((model) => isSameModel(value.agent, model.id, value.model))

  const refresh = () => {
    for (const { agent } of groups) {
      const entry = catalog.agents[agent]
      if (available[agent] && !entry?.fetchedAt && !entry?.loading && !entry?.error) void api.refreshModels(agent).catch(() => undefined)
    }
  }

  return (
    <Field
      label={t('newWorkspace.model.label')}
      description={
        <>
          {terminalAgent ? t('newWorkspace.model.terminalHint', { agent: catalogAgent(terminalAgent)?.name ?? terminalAgent }) : note}
          {chosenSignedOut && (
            <span className="nw-signin">
              <Status tone="warn" label={t('agentReadiness.notSignedIn')} /> {t('newWorkspace.model.signedOut', { agent: AGENTS[value.agent].label })}{' '}
              {onSignIn && (
                <LinkButton size="sm" underline aria-label={t('chat.notice.signIn', { agent: AGENTS[value.agent].label })} onClick={() => onSignIn(value.agent)}>
                  {t('agentReadiness.signIn')}
                </LinkButton>
              )}
            </span>
          )}
        </>
      }
    >
      {(control) => (
        <Select
          {...control}
          className="dlg-fill"
          value={terminalAgent ? `${TERMINAL_PREFIX}${terminalAgent}` : `${value.agent}:${selected?.id ?? value.model}`}
          onFocus={refresh}
          onChange={(next) => {
            if (next.startsWith(TERMINAL_PREFIX)) return onTerminalAgent?.(next.slice(TERMINAL_PREFIX.length))
            const model = groups.flatMap((group) => group.models).find((model) => `${model.agent}:${model.id}` === next)
            if (model) onChange({ agent: model.agent, model: model.id, effort: model.defaultEffort, fast: false })
          }}
          options={[
            ...groups.flatMap(({ agent, models }) => models.map((model) => ({ value: `${agent}:${model.id}`, label: model.label || t('common.default'), group: signedOut(agent) ? `${AGENTS[agent].label} · ${t('agentReadiness.notSignedIn')}` : AGENTS[agent].label }))),
            ...terminals.map((id) => ({ value: `${TERMINAL_PREFIX}${id}`, label: catalogAgent(id)?.name ?? id, group: t('newWorkspace.model.terminalGroup') }))
          ]}
        />
      )}
    </Field>
  )
}

// 'folder': work directly in the repository folder, on one of its branches.
type Mode = 'new' | 'existing' | 'folder'

export function NewWorkspaceDialog({ repoId: initialRepoId, initialPrompt, initialTemplateId }: { repoId: string; initialPrompt?: string; initialTemplateId?: string }) {
  const t = useT()
  const repos = useStore((s) => s.snapshot!.repos)
  const repoSettings = useStore((s) => s.snapshot!.repoSettings)
  const settings = useStore((s) => s.snapshot!.settings)
  const home = useStore((s) => s.snapshot!.homeDir)
  const platform = useStore((s) => s.snapshot!.platform)
  const [repoId, setRepoId] = useState(initialRepoId)
  const repo = repos.find((r) => r.id === repoId)
  const defaultMode = (id: string): Mode => (repoSettings[id]?.values.workInRepoFolder ? 'folder' : 'new')
  const [mode, setMode] = useState<Mode>(() => defaultMode(initialRepoId))
  // Cloud workspaces: where the worktree lives. Cloud is offered only when cloud workspaces are on and the repository's Cloud setting is.
  const [location, setLocation] = useState<RunsOnLocation>('local')
  const readiness = useCloudReadiness(repo)
  const inCloud = location === 'cloud' && Boolean(readiness?.offer) && !blocksChoice(readiness?.block)
  // Always the repository's base branch when the dialog opens.
  const [base, setBase] = useState(repo?.defaultBranch ?? '')
  const [branchKind, setBranchKind] = useState<'new' | 'existing'>('new')
  const [newName, setNewName] = useState('')
  const [existing, setExisting] = useState('')
  // The branch to work on in the repository folder; '' until we know what it has checked out.
  const [direct, setDirect] = useState('')
  const directTaken = useStore((s) => s.snapshot!.workspaces.find((w) => w.repoId === repoId && w.direct && w.state !== 'archived'))
  const [prompt, setPrompt] = useState(initialPrompt ?? '')
  // The template the message was written from; kept while it is edited, dropped when it is cleared.
  const [templateId, setTemplateId] = useState<string | undefined>(initialTemplateId)
  const promptInput = useRef<HTMLTextAreaElement>(null)
  const promptId = useId()
  const [templatesOpen, setTemplatesOpen] = useState(false)
  const [loadout, setLoadout] = useState<Loadout>(() => settings.loadouts[0] ?? { agent: 'claude', model: DEFAULT_MODEL.claude, fast: false })
  // Set once the user picks a model themselves; from then on it beats a template's start model.
  const [modelChosen, setModelChosen] = useState(false)
  // G1: a Terminal agent to open in the new workspace instead of a chat (it runs its own CLI in a terminal tab).
  const [terminalAgent, setTerminalAgent] = useState<string | null>(null)
  const repoTemplates = useStore((s) => s.snapshot!.repoTemplates)
  const chosenTemplate = prompt.trim() ? templateById(settings.promptTemplates, repoTemplates, templateId) : undefined
  const templateModel = modelChosen ? undefined : chooseStartLoadout(undefined, chosenTemplate).loadout
  const [runSetup, setRunSetup] = useState(false)
  const [trees, setTrees] = useState<WorktreeInfo[] | null>(null)
  const [treesError, setTreesError] = useState<string | null>(null)
  const [chosenPath, setChosenPath] = useState<string | null>(null)
  // A folder picked with Browse that isn't in the list.
  const [browsed, setBrowsed] = useState<string | null>(null)
  const [working, setWorking] = useState(false)
  const [files, setFiles] = useState<PendingFile[]>([])
  const [dragging, setDragging] = useState(false)
  const branches = useBranches(repo)
  // A GitHub issue or PR link (O2: or a GitLab MR or issue) in the first message: one line says what it is; the PR's base becomes the base branch.
  const link = useMemo(() => findScmLink(prompt), [prompt])
  const linkUrl = link?.url
  const [linkInfo, setLinkInfo] = useState<{ url: string; info?: GithubLinkInfo; error?: string } | null>(null)
  useEffect(() => {
    if (!linkUrl || !repoId) {
      setLinkInfo(null)
      return
    }
    let stale = false
    const timer = setTimeout(() => {
      api.resolveGithubLink(repoId, linkUrl).then(
        (info) => !stale && setLinkInfo({ url: linkUrl, info }),
        (err) => !stale && setLinkInfo({ url: linkUrl, error: message(err) })
      )
    }, 350)
    return () => {
      stale = true
      clearTimeout(timer)
    }
  }, [linkUrl, repoId])
  const resolved = linkInfo && linkInfo.url === linkUrl ? linkInfo.info : undefined
  // Integrations: a Linear issue in the first message (when no GitHub or GitLab link is), read with the repository's Linear connection.
  const hasLinear = useHasLinear(repo)
  const linear = useLinearIntake(repoId, prompt, hasLinear && !link)
  const checksOutPr = resolved?.kind === 'pr' && !resolved.problem && mode === 'new' && branchKind === 'new'
  useEffect(() => {
    if (checksOutPr && resolved?.baseRef) setBase(resolved.baseRef)
  }, [checksOutPr, resolved?.baseRef])
  const mac = platform === 'darwin'
  const close = () => openNewWorkspace(null)

  const loadTrees = async (id: string): Promise<WorktreeInfo[] | null> => {
    try {
      const all = await api.listWorktrees(id)
      setTrees(all)
      setTreesError(null)
      return all
    } catch (err) {
      setTreesError(message(err))
      return null
    }
  }

  useEffect(() => {
    if (mode !== 'existing' || !repo) return
    setTrees(null)
    void loadTrees(repo.id)
  }, [mode, repo?.id])

  // The repository folder's current branch, or the base branch when it's detached.
  const rootBranch = repo ? branches.list?.find((b) => b.checkedOutAt && samePath(b.checkedOutAt, repo.rootPath, platform)) : undefined
  useEffect(() => {
    if (!direct && branches.list && repo) setDirect(rootBranch?.name ?? repo.defaultBranch)
  }, [branches.list, direct, repo, rootBranch])

  // The repository was removed while the dialog was open.
  useEffect(() => {
    if (!repo) close()
  }, [repo])

  if (!repo) return null

  const hasSetup = Boolean(repoSettings[repo.id]?.values.setupScript.trim())
  const autoName = settings.autoRenameBranches && !settings.privacyMode
  const others = trees?.filter((tree) => !tree.isMain) ?? null

  const changeRepo = (id: string) => {
    const next = repos.find((r) => r.id === id)
    if (!next || id === repo.id) return
    setRepoId(id)
    setMode(defaultMode(id))
    setBase(next.defaultBranch)
    setExisting('')
    setDirect('')
    setChosenPath(null)
    setBrowsed(null)
    setRunSetup(false)
    setLocation('local')
  }

  const browse = async () => {
    const picked = await attempt(() => api.pickPath({ kind: 'directory', title: t('newWorkspace.browse.title') }))
    if (!picked) return
    const all = (await loadTrees(repo.id)) ?? trees ?? []
    const match = all.find((tree) => samePath(tree.path, picked, platform))
    if (match?.isMain) {
      showToast(t('newWorkspace.browse.mainCheckout', { repo: repo.name }))
      return
    }
    if (match) {
      const reason = treeUnavailable(match, t)
      if (match.workspaceId) return showToast(t('newWorkspace.browse.alreadyWorkspace'))
      if (reason) return showToast(t('newWorkspace.browse.noBranch'))
      setBrowsed(null)
      setChosenPath(match.path)
      return
    }
    setBrowsed(picked)
    setChosenPath(picked)
  }

  const addFiles = (added: PendingFile[]) => {
    if (added.length) setFiles((current) => [...current, ...added.filter((a) => !current.some((c) => c.path === a.path))].slice(0, MAX_FILES))
  }
  const attach = async () => {
    const paths = await attempt(() => api.pickFiles())
    if (paths?.length) addFiles(paths.slice(0, MAX_ADDED).map((path) => ({ path, name: path.split(/[\\/]/).pop() || path, kind: fileKind(path) })))
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length) return
    e.preventDefault()
    void readFiles(pasted).then(addFiles)
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDragging(false)
    if (!terminalAgent) void readFiles([...e.dataTransfer.files]).then(addFiles)
  }

  const canSubmit =
    (mode === 'new' ? Boolean(base.trim()) && (branchKind === 'new' || Boolean(existing)) : mode === 'folder' ? Boolean(direct) && !directTaken : Boolean(chosenPath)) &&
    // At the running limit a cloud workspace is refused until one is put to sleep.
    !(inCloud && readiness?.block === 'limit')

  const submit = async () => {
    if (!canSubmit || working) return
    setWorking(true)
    // G1: a Terminal agent takes no first message; it gets its terminal tab once the workspace exists.
    const text = terminalAgent ? undefined : (link ? fillIssuePlaceholders(prompt.trim(), link) : prompt.trim()) || undefined
    // The link is only sent once it has been read, so a typo'd URL doesn't block creating the workspace.
    // A cloud workspace checks the pull request out in its sandbox when it's on the repository's own GitHub remote (main says so otherwise).
    const githubUrl = resolved && !(resolved.kind === 'pr' && resolved.problem && mode === 'new') ? linkUrl : undefined
    // A Linear issue goes along once it has been read (a problem, like another workspace's issue, leaves it out).
    const linearIssue = linear?.info?.issue ? linear.ref : undefined
    const fromTemplate = text ? templateId : undefined
    const attachments = terminalAgent || !files.length ? undefined : files.map((f) => f.path)
    // The template's start model is applied by the app when no model was chosen here.
    const sendLoadout = templateModel ? undefined : loadout
    let ok: boolean
    if (mode === 'new') {
      const name = newName.trim()
      ok = await createWorkspace(repo.id, {
        baseBranch: base,
        branch: branchKind === 'existing' ? { kind: 'existing', name: existing } : name ? { kind: 'new', name } : { kind: 'new' },
        prompt: text,
        templateId: fromTemplate,
        attachments,
        loadout: sendLoadout,
        githubUrl,
        linearIssue,
        ...(inCloud ? { location: 'cloud' as const } : {})
      })
    } else if (mode === 'folder') {
      ok = await createWorkspace(repo.id, { branch: { kind: 'direct', name: direct }, runSetup: hasSetup && runSetup, prompt: text, templateId: fromTemplate, attachments, loadout: sendLoadout, githubUrl, linearIssue })
    } else {
      ok = await adoptWorktree(repo.id, chosenPath!, { runSetup: hasSetup && runSetup, prompt: text, templateId: fromTemplate, attachments, loadout: sendLoadout })
    }
    // createWorkspace and adoptWorktree select the new workspace.
    const created = getState().selectedWorkspaceId
    if (ok && terminalAgent && created) openTerminalAgent(created, terminalAgent)
    // On failure the store shows why; keep the dialog so nothing is lost.
    if (ok) close()
    else setWorking(false)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' || e.nativeEvent.isComposing || e.defaultPrevented) return
    const modDown = mac ? e.metaKey : e.ctrlKey
    const tag = (e.target as HTMLElement).tagName
    if (modDown && !e.altKey && !e.shiftKey) {
      e.preventDefault()
      void submit()
    } else if (!modDown && !e.altKey && !e.shiftKey && tag !== 'TEXTAREA' && tag !== 'BUTTON' && tag !== 'SELECT') {
      e.preventDefault()
      void submit()
    }
  }

  const remote = repo.remote || 'origin'
  let fetchHint: ReactNode
  if (branches.error && !branches.list?.length) fetchHint = t('newWorkspace.fetch.listFailed', { error: branches.error })
  else if (!repo.hasOrigin) fetchHint = t('newWorkspace.fetch.noRemote')
  else if (branches.fetch === 'fetching') {
    fetchHint = (
      <>
        <Spinner size={11} /> {t('newWorkspace.fetch.fetching', { remote })}
      </>
    )
  } else if (branches.fetch === 'failed') fetchHint = t('newWorkspace.fetch.failed', { remote })
  else fetchHint = t('newWorkspace.fetch.fetched', { remote, ago: timeAgo(branches.fetchedAt) })

  const submitLabel = mode === 'existing' ? (working ? t('newWorkspace.submit.adding') : t('newWorkspace.submit.add')) : working ? t('newWorkspace.submit.creating') : inCloud && readiness ? t('cloud.nw.submit', { provider: providerLabel(readiness.provider) }) : t('newWorkspace.submit.create')
  // Why a branch can't be the folder's: it's checked out in another worktree.
  const elsewhere = (b: BranchInfo) => (b.checkedOutAt && !samePath(b.checkedOutAt, repo.rootPath, platform) ? t('newWorkspace.branch.checkedOutIn', { path: tildify(b.checkedOutAt, home) }) : undefined)
  const setupCheck = hasSetup && (
    <Checkbox className="nw-check" checked={runSetup} onChange={(e) => setRunSetup(e.target.checked)}>
      {t('newWorkspace.runSetup')}
    </Checkbox>
  )
  // The worktrees to choose from: the list, then a folder picked with Browse that isn't in it.
  const treeOptions: RadioCardOption<string>[] = [
    ...(others ?? []).map((tree) => treeOption({ path: tree.path, home, meta: treeMeta(tree, t), reason: treeUnavailable(tree, t) })),
    ...(browsed ? [treeOption({ path: browsed, home, meta: t('newWorkspace.tree.chosen') })] : [])
  ]
  const treeList = !(treesError && !others) && others !== null && !(others.length === 0 && !browsed)

  return (
    <Dialog title={t('palette.newWorkspace')} className="nw-modal" onClose={close} headerExtra={<RepoChip repos={repos} repo={repo} onChange={changeRepo} />}>
      <div className="nw-body" onKeyDown={onKeyDown}>
        <div className="nw-settings">
          {readiness?.offer && (
            <RunsOnField
              repo={repo}
              readiness={readiness}
              value={location}
              onLeave={close}
              onChange={(next) => {
                setLocation(next)
                // A cloud workspace gets its own clone: a new branch or an existing one, never a folder here.
                if (next === 'cloud') setMode('new')
              }}
            />
          )}
          <Segmented
            plain
            className="nw-mode"
            label={t('newWorkspace.source.label')}
            value={mode}
            options={[
              { value: 'new', label: t('newWorkspace.source.new') },
              { value: 'existing', label: t('newWorkspace.source.existing'), disabled: inCloud, title: inCloud ? t('cloud.nw.notInCloud') : undefined },
              { value: 'folder', label: t('newWorkspace.source.folder'), disabled: inCloud, title: inCloud ? t('cloud.nw.notInCloud') : undefined }
            ]}
            onChange={setMode}
          />

          {mode === 'new' ? (
            <>
              <div className="dlg-group">
                <span className="dlg-label">{branchKind === 'existing' ? t('newWorkspace.base.label') : t('newWorkspace.base.startFrom')}</span>
                <BranchPicker key={`base-${repo.id}`} branches={branches.list} value={base} onChange={setBase} home={home} label={t('newWorkspace.base.startFrom')} />
                <small className="nw-hint">{fetchHint}</small>
              </div>

              <RadioList
                className="nw-branch"
                legend={t('newWorkspace.branch.label')}
                value={branchKind}
                onChange={setBranchKind}
                options={[
                  {
                    value: 'new',
                    label: t('newWorkspace.branch.new'),
                    extra: branchKind === 'new' && (
                      <Field label={t('newWorkspace.branch.nameLabel')} hideLabel description={autoName ? t('newWorkspace.branch.helpAuto') : t('newWorkspace.branch.helpGenerated')} className="nw-indent">
                        {(control) => (
                          <TextInput
                            {...control}
                            mono
                            className="dlg-fill"
                            spellCheck={false}
                            autoComplete="off"
                            value={newName}
                            onChange={(e) => setNewName(e.target.value)}
                            placeholder={autoName ? t('newWorkspace.branch.placeholderAuto') : t('newWorkspace.branch.placeholderGenerated')}
                          />
                        )}
                      </Field>
                    )
                  },
                  {
                    value: 'existing',
                    label: t('newWorkspace.branch.checkoutExisting'),
                    extra: branchKind === 'existing' && (
                      <div className="nw-indent">
                        <BranchPicker
                          key={`existing-${repo.id}`}
                          branches={branches.list}
                          value={existing}
                          onChange={setExisting}
                          home={home}
                          label={t('newWorkspace.branch.existingLabel')}
                          placeholder={t('newWorkspace.branch.choose')}
                          unavailable={(b) =>
                            b.checkedOutAt
                              ? samePath(b.checkedOutAt, repo.rootPath, platform)
                                ? t('newWorkspace.branch.inRepoFolder')
                                : t('newWorkspace.branch.checkedOutIn', { path: tildify(b.checkedOutAt, home) })
                              : undefined
                          }
                          openOnMount={!existing}
                        />
                      </div>
                    )
                  }
                ]}
              />
            </>
          ) : mode === 'folder' ? (
            <>
              <div className="dlg-group">
                <span className="dlg-label">{t('newWorkspace.branch.label')}</span>
                <BranchPicker key={`direct-${repo.id}`} branches={branches.list} value={direct} onChange={setDirect} home={home} label={t('newWorkspace.branch.label')} unavailable={elsewhere} />
                <small className="nw-hint">
                  <FolderRoot size={11} aria-hidden /> {tildify(repo.rootPath, home)}
                  {direct && rootBranch && direct !== rootBranch.name ? ` · ${t('newWorkspace.folder.switches', { from: rootBranch.name, to: direct })}` : ''}
                </small>
              </div>
              {setupCheck}
              {directTaken ? (
                <p className="nw-note error-text">{t('newWorkspace.folder.taken', { name: directTaken.name })}</p>
              ) : (
                <p className="nw-note">{t.rich('newWorkspace.folder.note', { branch: <code>{direct || t('newWorkspace.folder.theBranch')}</code> })}</p>
              )}
            </>
          ) : (
            <>
              <div className="dlg-group">
                {treeList ? (
                  <RadioCards className="nw-trees" layout="stack" legend={t('newWorkspace.tree.label')} value={chosenPath ?? undefined} onChange={setChosenPath} options={treeOptions} />
                ) : (
                  <>
                    <span className="dlg-label">{t('newWorkspace.tree.label')}</span>
                    {treesError && !others ? (
                      <div className="nw-trees-empty error-text" role="alert">
                        {t('newWorkspace.tree.listFailed', { error: treesError })}
                      </div>
                    ) : others === null ? (
                      <div className="nw-trees-empty" role="status">
                        <Spinner size={12} /> {t('newWorkspace.tree.looking')}
                      </div>
                    ) : (
                      <div className="nw-trees-empty">{t.rich('newWorkspace.tree.none', { command: <code>git worktree add</code> })}</div>
                    )}
                  </>
                )}
                <div>
                  <Button size="sm" className="nw-browse" icon={<FolderOpen size={13} />} onClick={() => void browse()}>
                    {t('newWorkspace.tree.browse')}
                  </Button>
                </div>
              </div>
              {setupCheck}
              <p className="nw-note">{t('newWorkspace.tree.note')}</p>
            </>
          )}

          <WorkspaceModelSelect
            value={templateModel ?? loadout}
            onChange={(choice) => {
              setLoadout(choice)
              setModelChosen(true)
              setTerminalAgent(null)
            }}
            terminalAgent={terminalAgent}
            onTerminalAgent={setTerminalAgent}
            onSignIn={(agent) => {
              close()
              openSettingsPage({ section: 'agents', agent })
            }}
            note={templateModel && chosenTemplate ? t('newWorkspace.model.fromTemplate', { name: chosenTemplate.name }) : undefined}
          />
        </div>

        <div className="nw-message">
          <div className="nw-prompt">
            <div className="nw-prompt-head">
              <label htmlFor={promptId}>
                {t.rich('newWorkspace.prompt.label', { optional: <span className="nw-optional">{t('newWorkspace.prompt.optional')}</span> })}
              </label>
              {hasLinear && !terminalAgent && (
                <LinearIssuesButton
                  repoId={repo.id}
                  onPick={(issue) => {
                    // An empty message gets one that names the issue; otherwise the id goes at the end.
                    setPrompt((current) => (current.trim() ? `${current.trimEnd()} ${issue.identifier}` : t('linearIntake.prompt', { id: issue.identifier })))
                    requestAnimationFrame(() => promptInput.current?.focus())
                  }}
                />
              )}
              <TemplatePicker
                open={templatesOpen}
                onOpenChange={setTemplatesOpen}

                side="bottom"
                align="end"
                manageLink={false}
                repoId={repo.id}
                onPick={(template) => {
                  const el = promptInput.current
                  const next = insertTemplate(prompt, el?.selectionStart ?? prompt.length, el?.selectionEnd ?? prompt.length, template.body)
                  setPrompt(next.text)
                  setTemplateId(template.id)
                  requestAnimationFrame(() => {
                    el?.focus()
                    el?.setSelectionRange(...next.selection)
                  })
                }}
              />
            </div>
            <div
              className={`nw-composer ${dragging ? 'dragging' : ''} ${terminalAgent ? 'disabled' : ''}`}
              onClick={(e) => e.target === e.currentTarget && promptInput.current?.focus()}
              onDragOver={(e) => {
                e.preventDefault()
                if (!terminalAgent) setDragging(true)
              }}
              onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node) && setDragging(false)}
              onDrop={onDrop}
            >
              <TextArea
                bare
                id={promptId}
                ref={promptInput}
                autoFocus
                disabled={Boolean(terminalAgent)}
                value={prompt}
                onChange={(e) => {
                  setPrompt(e.target.value)
                  setTemplateId((id) => templateAfterEdit(id, e.target.value))
                }}
                onPaste={onPaste}
                placeholder={t('newWorkspace.prompt.placeholder')}
              />
              {files.length > 0 && !terminalAgent && (
                <div className="nw-files">
                  {files.map((file) => (
                    <FileThumb key={file.path} file={file} onRemove={() => setFiles((current) => current.filter((f) => f.path !== file.path))} />
                  ))}
                </div>
              )}
              <div className="nw-composer-tools">
                <Button size="sm" variant="ghost" icon={<Paperclip size={13} />} disabled={Boolean(terminalAgent)} onClick={() => void attach()}>
                  {t('newWorkspace.attach.button')}
                </Button>
                <span className="nw-composer-hint">{t('newWorkspace.attach.hint')}</span>
              </div>
            </div>
            {linear && mode !== 'existing' && <LinearLine intake={linear} />}
            {link && mode !== 'existing' && (
              <>
                <div className="intake-line">
                  {link.kind === 'pr' ? <GitPullRequest size={12} aria-hidden /> : <CircleDot size={12} aria-hidden />}
                  <span>{resolved ? intakeLine(resolved, t) : linkInfo?.url === linkUrl && linkInfo?.error ? linkInfo.error : t(link.kind === 'pr' ? (link.gitlabHost ? 'newWorkspace.link.readingMr' : 'newWorkspace.link.readingPr') : 'newWorkspace.link.readingIssue', { number: link.number, repo: link.repo })}</span>
                </div>
                {resolved?.problem && mode === 'new' && <p className="nw-note">{t('newWorkspace.link.problem', { problem: resolved.problem })}</p>}
                {resolved?.kind === 'pr' && !resolved.problem && !checksOutPr && <p className="nw-note">{t('newWorkspace.link.headOnlyNew')}</p>}
                {resolved && <p className="nw-note">{link.kind === 'pr' ? t('newWorkspace.link.untrustedPr') : t('newWorkspace.link.untrustedIssue')}</p>}
              </>
            )}
          </div>

          <div className="nw-actions">
            {inCloud && readiness && <span className="nw-footnote">{remoteFootnote(t, readiness.provider, repoCloud(repo).region, readiness.view)}</span>}
            <Button onClick={close}>{t('common.cancel')}</Button>
            <Button variant="primary" disabled={!canSubmit || working} onClick={() => void submit()}>
              {working && <Spinner size={13} />}
              {submitLabel}
              <Kbd>{mac ? '⌘↵' : 'Ctrl+Enter'}</Kbd>
            </Button>
          </div>
        </div>
      </div>
    </Dialog>
  )
}

/** "Remote workspaces run on Vercel in iad1." (on a provider without regions, just the provider). */
function remoteFootnote(t: RendererT, provider: CloudProviderId, wanted: string, view: CloudProviderView | undefined): string {
  const region = providerRegion(wanted, providerFacts(provider, view).capabilities, provider)
  const name = providerLabel(provider)
  return region ? t('cloud.nw.footer', { provider: name, region }) : t('cloud.nw.footerNoRegion', { provider: name })
}
