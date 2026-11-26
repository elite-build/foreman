// What settings search finds: the menu's entries, the settings in the registry (registry.ts) and each repository's
// pages, ranked, each with where it lives. The results page lists them by category (SearchResults.tsx).
import {
  Accessibility,
  BarChart3,
  CircleUser,
  Cloud,
  Cpu,
  Database,
  Ellipsis,
  FlaskConical,
  GitBranch,
  HardDrive,
  KeyRound,
  LayoutGrid,
  MonitorSmartphone,
  Globe,
  Palette,
  Plug,
  Network,
  Router,
  Settings2,
  SquareTerminal,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import type { AgentPrefs } from '../../../../shared/agentCatalog'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import { createT, type TFunction } from '../../../../shared/i18n'
import type { AgentKind, Repo } from '../../../../shared/types'
import { fuzzyScore } from '../../fuzzy'
import type { PersonalSection, RepoSection, SettingsPage } from '../../store'
import { firstPage, linkTo, pageNode, pathTo, settingsTree, type SettingsNode } from './pages'
import { CATEGORIES, PAGE_KEYWORDS, REPO_TAB_LABELS, SETTINGS, type SettingEntry, type SettingsCategory } from './registry'

export const PAGE_ICONS: Record<PersonalSection | 'agents', LucideIcon> = {
  quick: LayoutGrid,
  browser: Globe,
  general: Settings2,
  account: CircleUser,
  integrations: Plug,
  appearance: Palette,
  accessibility: Accessibility,
  models: Cpu,
  git: GitBranch,
  agents: Router,
  environment: KeyRound,
  experimental: FlaskConical,
  advanced: HardDrive,
  usage: BarChart3,
  data: Database,
  cloud: Cloud,
  devices: MonitorSmartphone,
  spaces: Network
}

export const REPO_TAB_ICONS: Record<RepoSection, LucideIcon> = {
  git: GitBranch,
  environment: KeyRound,
  integrations: Plug,
  scripts: SquareTerminal,
  cloud: Cloud,
  actions: Zap,
  misc: Ellipsis
}

const REPO_TABS = Object.keys(REPO_TAB_LABELS) as RepoSection[]
const AGENT_KEYWORDS: Partial<Record<string, string[]>> = { claude: ['anthropic'], codex: ['openai'] }
const MAX_RESULTS = 60
// Page names in English stay findable whatever the UI language.
const enT = createT('en')

export interface SearchItem {
  key: string
  label: string
  // Where it lives under its group: the menu's path to it ("Claude Code › Sign-in"); empty for a group's own entry.
  where: string[]
  // The category or repository it is listed under, and that group's key (a category id, or `repo:<id>`).
  group: string
  groupKey: string
  description?: string
  keywords: string
  icon: LucideIcon
  target: SettingsPage
  // A setting of the registry: its current value can be shown beside it.
  rowId?: string
  // A Full agent: whether it is signed in can be shown, and fixed.
  agent?: AgentKind
}

const words = (label: string) => label.toLowerCase().split(/\s+/)

const isAgentTabRow = (row: SettingEntry): row is SettingEntry & { page: { section: 'agents'; agent: AgentKind } } =>
  row.page.section === 'agents' && row.title === AGENTS[row.page.agent as AgentKind]?.label

/** A row's title in the UI language (see registry.ts `titleKey`). */
export const rowTitle = (row: SettingEntry, t: TFunction): string => (row.titleKey ? t(row.titleKey) : row.title)

/** A row's description in the UI language. */
export const rowDescription = (row: SettingEntry, t: TFunction): string | undefined => (row.descriptionKey ? t(row.descriptionKey) : row.description)

/** The translated description, with the English one after it when they differ, so search matches both. */
const searchDescription = (row: SettingEntry, t: TFunction): string | undefined => {
  const shown = rowDescription(row, t)
  return shown && row.description && shown !== row.description ? `${shown} ${row.description}` : shown
}

/** A label in the UI language, plus its English words when they differ. */
const bothWords = (label: string, english: string | undefined): string[] => (english === undefined || label === english ? words(label) : [...words(label), ...words(english)])

/** The icon of a category: its first page's. */
export const categoryIcon = (category: SettingsCategory): LucideIcon => PAGE_ICONS[CATEGORIES.find((c) => c.id === category)!.pages[0]]

const flatten = (nodes: SettingsNode[]): SettingsNode[] => nodes.flatMap((n) => [n, ...flatten(n.children ?? [])])

/** A Full agent's own entry in the menu ("agents/claude"), as the agent it is. */
const agentOfNode = (node: SettingsNode): AgentKind | undefined => {
  const id = node.id.startsWith('agents/') && !node.page ? node.id.slice('agents/'.length) : ''
  return (AGENT_ORDER as string[]).includes(id) ? (id as AgentKind) : undefined
}

/** Every entry of the menu, every setting and every repository page, as search finds them. */
export function buildIndex(repos: Repo[], mac: boolean, t: TFunction, platform?: string, agentPrefs?: AgentPrefs): SearchItem[] {
  const items: SearchItem[] = []
  const tree = settingsTree({ t, platform: platform ?? '', agentPrefs })
  const english = new Map(flatten(settingsTree({ t: enT, platform: platform ?? '', agentPrefs })).map((n) => [n.id, n]))
  const categoryLabel = (category: SettingsCategory) => tree.find((n) => n.category === category)!.label
  // The labels under the category down to the node: where it sits.
  const whereOf = (id: string) => pathTo(tree, id).slice(1).map((n) => n.label)

  // The menu's entries: categories, agents, pages.
  const visit = (node: SettingsNode, top: boolean) => {
    const first = firstPage(node)
    if (first) {
      const en = english.get(node.id)
      const agent = agentOfNode(node)
      // The registry's row for a whole agent (e.g. "Claude Code") is folded into the agent's entry.
      const agentRow = agent ? SETTINGS.find((r) => isAgentTabRow(r) && r.page.agent === agent) : undefined
      const category = CATEGORIES.find((c) => c.id === node.category)!
      items.push({
        key: `node:${node.id}`,
        label: top ? node.label : node.title,
        where: top ? [] : whereOf(node.id).slice(0, -1),
        group: categoryLabel(node.category),
        groupKey: node.category,
        description: agentRow && searchDescription(agentRow, t),
        keywords: [
          'settings',
          ...bothWords(node.title, en?.title),
          ...(node.label === node.title ? [] : bothWords(node.label, en?.label)),
          ...(top ? category.pages.flatMap((page) => PAGE_KEYWORDS[page]) : []),
          ...(agent ? ['harness', 'harnesses', 'provider', agent, ...(AGENT_KEYWORDS[agent] ?? []), ...(agentRow?.keywords ?? [])] : [])
        ].join(' '),
        icon: categoryIcon(node.category),
        target: linkTo(first),
        agent
      })
    }
    for (const child of node.children ?? []) visit(child, false)
  }
  for (const node of tree) visit(node, true)

  for (const repo of repos) {
    for (const tab of REPO_TABS) {
      const label = t(REPO_TAB_LABELS[tab])
      items.push({
        key: `repo:${repo.id}:${tab}`,
        label,
        where: [],
        group: repo.name,
        groupKey: `repo:${repo.id}`,
        keywords: ['settings', 'repository', repo.name, ...(label === enT(REPO_TAB_LABELS[tab]) ? [] : [enT(REPO_TAB_LABELS[tab])]), ...PAGE_KEYWORDS[tab]].join(' '),
        icon: REPO_TAB_ICONS[tab],
        target: { section: 'repo', repoId: repo.id, tab }
      })
    }
  }

  for (const row of SETTINGS) {
    // Windows-only rows (O4) need the platform; without it they're left out.
    if ((row.mac && !mac) || (row.windows && platform !== 'win32') || isAgentTabRow(row)) continue
    const label = rowTitle(row, t)
    const description = searchDescription(row, t)
    // The English title stays findable when the UI is in another language.
    const extra = [...(label === row.title ? [] : [row.title]), ...(row.keywords ?? [])]
    const page = row.page
    if (page.section === 'repo') {
      for (const repo of repos) {
        const tabLabel = t(REPO_TAB_LABELS[page.tab])
        items.push({
          key: `row:${repo.id}:${row.id}`,
          label,
          where: [tabLabel],
          group: repo.name,
          groupKey: `repo:${repo.id}`,
          description,
          keywords: [tabLabel, repo.name, ...extra].join(' '),
          icon: REPO_TAB_ICONS[page.tab],
          target: { section: 'repo', repoId: repo.id, tab: page.tab, scrollTo: row.id },
          rowId: row.id
        })
      }
      continue
    }
    const node = pageNode(tree, { ...(page as SettingsPage), scrollTo: row.id })
    if (!node) continue
    const where = whereOf(node.id)
    items.push({
      key: `row:${row.id}`,
      label,
      where,
      group: categoryLabel(node.category),
      groupKey: node.category,
      description,
      keywords: [...where, ...extra].join(' '),
      icon: categoryIcon(node.category),
      target: { ...linkTo(node), scrollTo: row.id },
      rowId: row.id
    })
  }
  return items
}

// ---- matching ----

const WORD_START = /[\s\-/·('"]/

/** Lower is better; null when the field doesn't match well enough to show. */
function fieldScore(text: string | undefined, q: string, scattered = true): number | null {
  if (!text) return null
  const t = text.toLowerCase()
  const at = t.indexOf(q)
  if (at !== -1) return at === 0 ? 0 : WORD_START.test(t[at - 1]) ? 4 : 10
  if (!scattered) return null
  const score = fuzzyScore(t, q)
  if (score === null) return null
  // fuzzyScore adds 50 for a scattered match and counts the skip before the first letter.
  const gaps = score - 50 - t.indexOf(q[0])
  return gaps <= q.length * 2 + 2 ? 20 + gaps : null
}

function itemScore(item: SearchItem, q: string): number | null {
  // The best field wins; keyword and description matches rank below title
  // matches. Descriptions are long, so they only match as written.
  const fields: [string | undefined, number, boolean][] = [
    [item.label, 0, true],
    [item.keywords, 6, true],
    [item.description, 12, false]
  ]
  let best: number | null = null
  for (const [text, weight, scattered] of fields) {
    const score = fieldScore(text, q, scattered)
    if (score !== null && (best === null || score + weight < best)) best = score + weight
  }
  if (best !== null) return best
  // Several words in any order, each found somewhere.
  const tokens = q.split(/\s+/).filter(Boolean)
  if (tokens.length < 2) return null
  const all = `${item.label} ${item.keywords} ${item.description ?? ''}`.toLowerCase()
  return tokens.every((token) => all.includes(token)) ? 45 : null
}

export function search(items: SearchItem[], query: string): SearchItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  return items
    .map((item) => ({ item, score: itemScore(item, q) }))
    .filter((x): x is { item: SearchItem; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .slice(0, MAX_RESULTS)
    .map((x) => x.item)
}

/** The label with the matched letters marked. */
export function highlight(label: string, query: string): ReactNode {
  const q = query.trim().toLowerCase()
  const t = label.toLowerCase()
  const marked = new Set<number>()
  const at = t.indexOf(q)
  if (at !== -1) {
    for (let i = at; i < at + q.length; i++) marked.add(i)
  } else {
    let from = 0
    for (const ch of q) {
      if (ch === ' ') continue
      const found = t.indexOf(ch, from)
      if (found === -1) return label
      marked.add(found)
      from = found + 1
    }
  }
  const parts: ReactNode[] = []
  let run = ''
  let runMarked = false
  const flush = () => {
    if (!run) return
    parts.push(runMarked ? <strong key={parts.length}>{run}</strong> : run)
    run = ''
  }
  for (let i = 0; i < label.length; i++) {
    const isMarked = marked.has(i)
    if (isMarked !== runMarked) {
      flush()
      runMarked = isMarked
    }
    run += label[i]
  }
  flush()
  return parts
}
