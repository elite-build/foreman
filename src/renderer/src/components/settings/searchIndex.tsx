// What the settings nav's search box finds: pages and rows (see registry.ts), ranked,
// with the matched letters marked.
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
  Palette,
  Plug,
  Router,
  Settings2,
  SquareTerminal,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { ReactNode } from 'react'
import { AGENT_ORDER, AGENTS } from '../../../../shared/agents'
import { createT, type TFunction } from '../../../../shared/i18n'
import type { AgentKind, Repo } from '../../../../shared/types'
import { fuzzyScore } from '../../fuzzy'
import type { PersonalSection, RepoSection, SettingsPage } from '../../store'
import { PAGE_KEYWORDS, PAGE_LABELS, REPO_TAB_LABELS, SETTINGS, type SettingEntry } from './registry'

export const PAGE_ICONS: Record<PersonalSection | 'agents', LucideIcon> = {
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
  cloud: Cloud
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

const PERSONAL_PAGES = Object.keys(PAGE_LABELS) as (PersonalSection | 'agents')[]
const REPO_TABS = Object.keys(REPO_TAB_LABELS) as RepoSection[]
const AGENT_KEYWORDS: Partial<Record<string, string[]>> = { claude: ['anthropic'], codex: ['openai'] }
const MAX_RESULTS = 30
// Page names in English stay findable whatever the UI language.
const enT = createT('en')

export interface SearchItem {
  key: string
  label: string
  // Muted line under the label: the page a row lives on.
  sub?: string
  description?: string
  keywords: string
  icon: LucideIcon
  target: SettingsPage
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
const bothWords = (label: string, english: string): string[] => (label === english ? words(label) : [...words(label), ...words(english)])

export function buildIndex(repos: Repo[], mac: boolean, t: TFunction, platform?: string): SearchItem[] {
  const items: SearchItem[] = []

  for (const section of PERSONAL_PAGES) {
    const label = t(PAGE_LABELS[section])
    items.push({
      key: `page:${section}`,
      label,
      keywords: ['settings', ...bothWords(label, enT(PAGE_LABELS[section])), ...PAGE_KEYWORDS[section]].join(' '),
      icon: PAGE_ICONS[section],
      target: { section }
    })
  }
  for (const agent of AGENT_ORDER) {
    const label = AGENTS[agent].label
    // The registry's row for the whole tab (e.g. "Claude Code") is folded into the tab's entry.
    const row = SETTINGS.find((r) => isAgentTabRow(r) && r.page.agent === agent)
    items.push({
      key: `agent:${agent}`,
      label,
      sub: t(PAGE_LABELS.agents),
      description: row && searchDescription(row, t),
      keywords: ['harness', 'harnesses', 'provider', agent, ...(AGENT_KEYWORDS[agent] ?? []), ...(row?.keywords ?? [])].join(' '),
      icon: PAGE_ICONS.agents,
      target: { section: 'agents', agent }
    })
  }
  for (const repo of repos) {
    for (const tab of REPO_TABS) {
      const label = t(REPO_TAB_LABELS[tab])
      items.push({
        key: `repo:${repo.id}:${tab}`,
        label,
        sub: repo.name,
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
          sub: `${repo.name} · ${tabLabel}`,
          description,
          keywords: [tabLabel, repo.name, ...extra].join(' '),
          icon: REPO_TAB_ICONS[page.tab],
          target: { section: 'repo', repoId: repo.id, tab: page.tab, scrollTo: row.id }
        })
      }
    } else if (page.section === 'agents') {
      const agentsLabel = t(PAGE_LABELS.agents)
      items.push({
        key: `row:${row.id}`,
        label,
        // #22: rows on the catalog, Sign-in and Provider keys pages have no agent to name.
        sub: AGENTS[page.agent as AgentKind] ? `${agentsLabel} · ${AGENTS[page.agent as AgentKind].label}` : agentsLabel,
        description,
        keywords: [agentsLabel, ...extra].join(' '),
        icon: PAGE_ICONS.agents,
        target: { section: 'agents', agent: page.agent, scrollTo: row.id }
      })
    } else {
      const pageLabel = t(PAGE_LABELS[page.section])
      items.push({
        key: `row:${row.id}`,
        label,
        sub: pageLabel,
        description,
        keywords: [pageLabel, ...extra].join(' '),
        icon: PAGE_ICONS[page.section],
        target: { section: page.section, scrollTo: row.id }
      })
    }
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
    parts.push(runMarked ? <mark key={parts.length}>{run}</mark> : run)
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
