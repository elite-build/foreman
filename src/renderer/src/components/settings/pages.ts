// Settings you can browse: every settings page is split into short parts, one per menu entry, in the order the page
// reads. This file is the menu's tree (category → page or agent → part), which part a link opens (`pageNode`), and
// the order Previous / Next walk. A page's component marks its parts with `<Section part>` or `<Part>` (controls.tsx).
import { AGENT_CATALOG, catalogAgent, isAgentEnabled, type AgentPrefs, type FullAgentId } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import { takesInstances } from '../../../../shared/agentInstances'
import type { PlainKey, TFunction } from '../../../../shared/i18n'
import type { PersonalSection, SettingsPage } from '../../store'
import { CATEGORIES, PAGE_LABELS, SETTINGS, type SettingsCategory } from './registry'

export type PageSection = PersonalSection | 'agents'

/** One part of a page: `key` is the `part` its Section or Part carries in the page's component. */
interface PartDef {
  key: string
  label: PlainKey
  // Only on Windows.
  windows?: boolean
}

/** Each page's parts in page order. A page with none (Environment, Experimental, Spaces) opens whole. */
export const PAGE_PARTS: Partial<Record<PersonalSection, PartDef[]>> = {
  general: [
    { key: 'language', label: 'settings.general.section.language' },
    { key: 'chat', label: 'settings.general.section.chat' },
    { key: 'assistant', label: 'assistant.title' },
    { key: 'notifications', label: 'settings.general.section.notifications' },
    { key: 'system', label: 'settings.general.section.system' },
    { key: 'updates', label: 'settings.general.section.updates' },
    { key: 'open-in', label: 'settings.openIn.section' },
    { key: 'terminal', label: 'settings.general.section.terminal', windows: true }
  ],
  appearance: [
    { key: 'interface', label: 'settings.appearance.section.interface' },
    { key: 'home', label: 'settings.home.title' },
    { key: 'layout', label: 'settings.appearance.section.layout' },
    { key: 'code', label: 'settings.appearance.section.code' },
    { key: 'terminal', label: 'settings.appearance.section.terminal' }
  ],
  accessibility: [
    { key: 'vision', label: 'settings.accessibility.section.vision' },
    { key: 'screen-reader', label: 'settings.accessibility.section.screenReader' },
    { key: 'announcements', label: 'settings.accessibility.section.announcements' },
    { key: 'voice', label: 'settings.accessibility.section.voice' },
    { key: 'stt', label: 'settings.accessibility.section.stt' }
  ],
  models: [
    { key: 'loadout', label: 'settings.row.loadout' },
    { key: 'defaults', label: 'settings.pages.newChats' },
    { key: 'switching', label: 'modelsPage.switching.section' }
  ],
  cloud: [
    { key: 'setup', label: 'settings.pages.cloudSetup' },
    { key: 'claude', label: 'cloud.claude.title' },
    { key: 'codex', label: 'cloud.codex.title' },
    { key: 'house', label: 'cloud.house.title' }
  ],
  account: [
    { key: 'github', label: 'settings.pages.github' },
    { key: 'privacy', label: 'settings.account.privacy' }
  ],
  integrations: [
    { key: 'connections', label: 'integrations.connections.title' },
    { key: 'rules', label: 'integrations.rules.title' },
    { key: 'people', label: 'integrations.people.title' }
  ],
  git: [
    { key: 'accounts', label: 'gitlab.accounts.title' },
    { key: 'branches', label: 'settings.git.section.branches' },
    { key: 'pull-requests', label: 'settings.git.section.pullRequests' },
    { key: 'archiving', label: 'settings.git.section.archiving' }
  ],
  data: [
    { key: 'storage', label: 'settings.advanced.section.storage' },
    { key: 'backups', label: 'settings.data.backups' },
    { key: 'git-backup', label: 'settings.gitBackup.title' }
  ],
  usage: [
    { key: 'limits', label: 'limits.section.title' },
    { key: 'cost', label: 'settings.usage.section.cost' }
  ],
  advanced: [
    { key: 'storage', label: 'settings.advanced.section.storage' },
    { key: 'terminal', label: 'settings.general.section.terminal' },
    { key: 'keep-running', label: 'keepRunning.settings.section' },
    { key: 'cli', label: 'settings.advanced.section.commandLine' }
  ],
  devices: [
    { key: 'computers', label: 'settings.pages.computers' },
    { key: 'agents', label: 'settings.data.agentAccess.section' }
  ]
}

/** A Full agent's parts, in its page's order. */
const AGENT_PARTS = ['signin', 'accounts', 'models', 'capabilities', 'mcp'] as const
export type AgentPart = (typeof AGENT_PARTS)[number]

const AGENT_PART_LABELS: Record<AgentPart, PlainKey> = {
  signin: 'agentCatalog.signin.title',
  accounts: 'agentAccounts.title',
  models: 'settings.pages.models',
  capabilities: 'agentCaps.title',
  mcp: 'repoMcp.agent.label'
}

// The heading of an agent's part names the agent: "Claude Code accounts".
const AGENT_PART_TITLES: Record<AgentPart, 'settings.pages.agent.signin' | 'settings.pages.agent.accounts' | 'settings.pages.agent.models' | 'settings.pages.agent.capabilities' | 'settings.pages.agent.mcp'> = {
  signin: 'settings.pages.agent.signin',
  accounts: 'settings.pages.agent.accounts',
  models: 'settings.pages.agent.models',
  capabilities: 'settings.pages.agent.capabilities',
  mcp: 'settings.pages.agent.mcp'
}

/** The parts a Full agent's page has: accounts only where the agent takes them, models where it has no chooser of its own. */
export function agentParts(agent: FullAgentId): AgentPart[] {
  return AGENT_PARTS.filter((part) => (part === 'accounts' ? takesInstances(agent) : part === 'models' ? !catalogAgent(agent)?.settings?.models : true))
}

/** Where a page's component is told to draw: the page, and which of its parts (none: all of it). */
export interface PageRef {
  section: PageSection
  agent?: string
  part?: string
}

export interface SettingsNode {
  // Unique in the tree: the menu row's key.
  id: string
  // The menu's words.
  label: string
  // The page's heading: the label, or more when the label leans on its group ("Claude Code accounts").
  title: string
  category: SettingsCategory
  // The page this entry opens. A group (a category, an agent) has none: it opens its first page.
  page?: PageRef
  children?: SettingsNode[]
}

export interface TreeContext {
  t: TFunction
  platform: string
  agentPrefs?: AgentPrefs
  // A catalog agent whose page is open, listed even when it isn't turned on.
  openAgent?: string
}

const leaf = (category: SettingsCategory, label: string, page: PageRef, title = label): SettingsNode => ({
  id: [page.section, page.agent, page.part].filter(Boolean).join('/'),
  label,
  title,
  category,
  page
})

/** A page's entries: one per part, or the page itself. */
function pageLeaves(category: SettingsCategory, section: PersonalSection, ctx: TreeContext): SettingsNode[] {
  const parts = (PAGE_PARTS[section] ?? []).filter((p) => !p.windows || ctx.platform === 'win32')
  if (!parts.length) return [leaf(category, ctx.t(PAGE_LABELS[section]), { section })]
  return parts.map((p) => leaf(category, ctx.t(p.label), { section, part: p.key }))
}

function agentEntries(ctx: TreeContext): SettingsNode[] {
  const { t } = ctx
  const out: SettingsNode[] = [
    leaf('agents', t('agentCatalog.page.title'), { section: 'agents', agent: 'catalog' }),
    leaf('agents', t('agentCatalog.signin.title'), { section: 'agents', agent: 'signin' }),
    leaf('agents', t('agentCatalog.keys.title'), { section: 'agents', agent: 'keys' })
  ]
  for (const agent of AGENT_ORDER as FullAgentId[]) {
    const name = AGENTS[agent].label
    out.push({
      id: `agents/${agent}`,
      label: name,
      title: name,
      category: 'agents',
      children: agentParts(agent).map((part) => leaf('agents', t(AGENT_PART_LABELS[part]), { section: 'agents', agent, part }, t(AGENT_PART_TITLES[part], { agent: name })))
    })
  }
  // Every other agent that is turned on, and the one being looked at.
  for (const agent of AGENT_CATALOG) {
    if (agent.level === 'full' || !(isAgentEnabled(agent.id, ctx.agentPrefs) || agent.id === ctx.openAgent)) continue
    out.push(leaf('agents', agent.name, { section: 'agents', agent: agent.id }))
  }
  out.push({ id: 'models', label: t('settings.page.models'), title: t('settings.page.models'), category: 'agents', children: pageLeaves('agents', 'models', ctx) })
  return out
}

/** The whole menu: each category with its pages, in menu order. */
export function settingsTree(ctx: TreeContext): SettingsNode[] {
  return CATEGORIES.map((category) => {
    const label = ctx.t(category.label)
    const children = category.id === 'agents' ? agentEntries(ctx) : category.pages.flatMap((section) => pageLeaves(category.id, section as PersonalSection, ctx))
    // A category of one page is that page.
    if (children.length === 1 && children[0].page) return { ...children[0], label, title: children[0].title === label ? label : children[0].title }
    return { id: `category:${category.id}`, label, title: label, category: category.id, children }
  })
}

/** Every page in the tree, top to bottom: the order Previous and Next walk. */
export function pageNodes(tree: SettingsNode[]): SettingsNode[] {
  return tree.flatMap((node) => (node.children ? pageNodes(node.children) : node.page ? [node] : []))
}

/** The first page under a node (itself, when it is one). */
export function firstPage(node: SettingsNode): SettingsNode | undefined {
  return node.page ? node : node.children?.map(firstPage).find(Boolean)
}

/** The nodes from the top of the tree down to `id`, both ends included; empty when it isn't there. */
export function pathTo(tree: SettingsNode[], id: string): SettingsNode[] {
  for (const node of tree) {
    if (node.id === id) return [node]
    const below = node.children ? pathTo(node.children, id) : []
    if (below.length) return [node, ...below]
  }
  return []
}

// Rows that aren't searchable settings but are linked to by id (scrollTo), and the part each sits in.
const LINKED_ROWS: Record<string, PageRef> = {
  'editor-command': { section: 'general', part: 'open-in' },
  'open-in-list': { section: 'general', part: 'open-in' },
  'new-terminal-menu': { section: 'general', part: 'terminal' },
  'terminal-shell-custom': { section: 'general', part: 'terminal' },
  'stt-model': { section: 'accessibility', part: 'stt' },
  'stt-openai-key': { section: 'accessibility', part: 'stt' },
  'usage-limits-title': { section: 'usage', part: 'limits' },
  'replay-traffic': { section: 'experimental' }
}

/** The page and part a row lives in, from the registry (or the few linked rows outside it). */
export function rowPage(rowId: string): PageRef | undefined {
  const row = SETTINGS.find((r) => r.id === rowId)
  if (!row) return LINKED_ROWS[rowId]
  if (row.page.section === 'repo') return undefined
  return { section: row.page.section, agent: row.page.section === 'agents' ? row.page.agent : undefined, part: row.part }
}

/**
 * The page a link opens. A link names a page (`section`, an agent) and maybe a part or a row to scroll to: the part
 * given, else the part that row sits in (wherever the link thought it was), else the page's first part.
 */
export function pageNode(tree: SettingsNode[], page: SettingsPage): SettingsNode | undefined {
  if (page.section === 'repo') return undefined
  const all = pageNodes(tree)
  const find = (ref: PageRef) =>
    all.find((n) => n.page!.section === ref.section && (ref.agent === undefined || n.page!.agent === ref.agent) && (ref.part === undefined || n.page!.part === ref.part))
  const agent = page.section === 'agents' ? page.agent || 'catalog' : undefined
  const named = page.part ? find({ section: page.section, agent, part: page.part }) : undefined
  if (named) return named
  const row = page.scrollTo ? rowPage(page.scrollTo) : undefined
  const holding = row && find(row)
  if (holding) return holding
  return find({ section: page.section, agent }) ?? all[0]
}

/** The link that opens a page node, as openSettingsPage takes it. */
export function linkTo(node: SettingsNode): SettingsPage {
  const ref = node.page!
  if (ref.section === 'agents') return { section: 'agents', agent: ref.agent, ...(ref.part && { part: ref.part }) }
  return { section: ref.section, ...(ref.part && { part: ref.part }) } as SettingsPage
}
