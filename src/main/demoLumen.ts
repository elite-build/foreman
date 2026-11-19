// Dev-only demo (main/demo.ts): Lumen, a second organization beside Acme and smaller than it, for an open-source command
// line tool: its memory repository, two code repositories (lumen-cli and lumen-site), a team of four (Priya plans, Theo
// maintains the CLI, Noor writes the docs, Sami triages new issues every hour) and a release it already shipped. One of
// the person's own workspaces in it has a chat paused where an API-key account ran out of credits: Resume now, or
// Continue on another account. Its live channels are started by the demo's director (main/demoEmployees.ts).
import path from 'node:path'
import type { ForemanDb } from './db'
import { createMemoryRepository } from './organizations'
import { asFiles, DEMO_LOADOUTS, demoPerson, hire } from './demoOrganization'
import { DEFAULT_MODEL } from '../shared/agents'
import { programManagerDefinition } from '../shared/employeeTeams'
import type { Organization } from '../shared/organizations'
import type { Project } from '../shared/projects'
import type { ChatItem, Repo, Session, Workspace } from '../shared/types'
import type { OrganizationSeed } from './screensOrganization'

export const LUMEN_ID = 'org-lumen'
const LUMEN_MEMORY = 'repo-lumen-memory'
export const LUMEN_CLI_REPO = 'repo-lumen-cli'
export const LUMEN_SITE_REPO = 'repo-lumen-site'
const OSLO_TAB = 's-oslo-1'

const CONFIG_TS = `import { readFileSync } from 'node:fs'

export interface Config {
  theme: string
  pageSize: number
}

export function loadConfig(file = '.lumenrc.json'): Config {
  return JSON.parse(readFileSync(file, 'utf8')) as Config
}
`

export async function seedLumen(seed: OrganizationSeed): Promise<void> {
  const { store, minutesAgo: at } = seed
  const db = store.db as ForemanDb

  // ---- its repositories ----
  const memory = await createMemoryRepository(seed.repos, 'lumen-memory', 'Lumen')
  const cli = path.join(seed.repos, 'lumen-cli')
  const site = path.join(seed.repos, 'lumen-site')
  await seed.makeRepo(cli, {
    'README.md': '# Lumen\n\nA fast, friendly command line for reading logs. `lumen tail`, `lumen grep`, `lumen stats`.\n',
    'package.json': '{\n  "name": "lumen-cli",\n  "version": "0.8.2",\n  "bin": { "lumen": "dist/cli.js" }\n}\n',
    'CHANGELOG.md': '# Changelog\n\n## 0.8.2\n\n- `lumen tail` keeps up with rotated files.\n\n## 0.8.0\n\n- `lumen stats`: counts by level and by minute.\n',
    'src/cli.ts': "import { loadConfig } from './config'\n\nconst config = loadConfig()\nconsole.log(`lumen (${config.theme})`)\n",
    'src/config.ts': CONFIG_TS
  })
  await seed.makeRepo(site, { 'README.md': '# lumen.dev\n\nThe website and the docs.\n', 'docs/index.md': '# Lumen\n\nStart with `npm install -g lumen-cli`.\n', 'docs/config.md': '# Configuration\n\nLumen reads `.lumenrc.json` from the folder you run it in.\n' })
  const oslo = path.join(seed.worktrees, 'lumen-cli', 'oslo')
  const kigali = path.join(seed.worktrees, 'lumen-site', 'kigali')
  await seed.makeWorktree(cli, oslo, 'toml-config', { 'lumen.toml.example': 'theme = "dark"\npage_size = 200\n' }, { 'src/config.ts': CONFIG_TS.replace("file = '.lumenrc.json'", "file = 'lumen.toml'") })
  await seed.makeWorktree(site, kigali, 'dark-mode-docs', { 'docs/themes.md': '# Themes\n\n`lumen --theme dark` or set `theme` in your config.\n' }, {})

  // ---- the team: Priya, Theo, Noor and Sami ----
  const taken = (store.state.employees ?? []).map((e) => e.id)
  const priya = asFiles(programManagerDefinition({ repos: ['lumen-cli', 'lumen-site'], loadouts: DEMO_LOADOUTS, taken }))
  const theo = demoPerson('e-theo9', 'green', ['lumen-cli', 'lumen-site'], {
    name: 'Theo',
    role: 'Maintainer',
    description: 'Maintains the CLI: reviews changes, cuts releases and keeps the changelog.',
    personality: 'Calm and thorough.',
    responsibilities: ['Cut each release', 'Keep CHANGELOG.md honest'],
    ask_me_about: 'What is in a release',
    instructions: 'Every change in the changelog links its pull request. Never publish to npm: a person does.'
  })
  const noor = demoPerson('e-noor10', 'purple', ['lumen-site', 'lumen-cli'], {
    name: 'Noor',
    role: 'Docs writer',
    description: 'Writes lumen.dev’s docs and the release posts.',
    personality: 'Warm and clear.',
    responsibilities: ['Document every new flag', 'Write a post for every minor release'],
    ask_me_about: 'The docs and the blog',
    instructions: 'Show a command and its output for every feature.'
  })
  const sami = demoPerson('e-sami11', 'yellow', ['lumen-cli'], {
    name: 'Sami',
    role: 'Triage',
    description: 'Reads new issues every hour, labels them and asks for what is missing.',
    personality: 'Direct and kind.',
    responsibilities: ['Label new issues', 'Ask reporters for a way to reproduce'],
    ask_me_about: 'Open issues',
    instructions: 'Label by area. Never close an issue.',
    triggers: [{ kind: 'interval', id: 'hourly-triage', every: '1h', prompt: 'Read the new issues in lumen-cli and label them.', repo: 'lumen-cli', missed: 'skip', overlap: 'skip', enabled: true }]
  })
  const RELEASE = 'release-lumen-0-8'
  await seed.writeFiles(memory, {
    'memory/org/PROJECT.md': '# Lumen\n\nLumen is an open-source command line for reading logs (lumen-cli), with its website and docs at lumen.dev (lumen-site).\n\n- Minor releases every six weeks; patches when needed.\n- A person publishes to npm.\n',
    'memory/org/instructions.md': '# Instructions\n\nWrite for people running Lumen in a terminal. Never publish: push to a branch and let a person decide.\n',
    [`memory/org/projects/${RELEASE}/plan.md`]: '# Release Lumen 0.8\n\n1. Changelog (Theo)\n2. Release post (Noor)\n',
    [`memory/org/projects/${RELEASE}/changelog.md`]: '# 0.8.0\n\n- `lumen stats`: counts by level and by minute.\n- `lumen tail --since 10m`.\n',
    [`memory/org/projects/${RELEASE}/post.md`]: '# Lumen 0.8: stats\n\n`lumen stats` counts your logs by level and by minute.\n'
  })
  const records = await hire(seed, LUMEN_ID, memory, [priya, theo, noor, sami], 'Add Priya, Theo, Noor and Sami', 20 * 24 * 60)

  // ---- state.json: the organization, its repositories, its workspaces ----
  const repo = (id: string, name: string, rootPath: string): Repo => ({ id, name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: at(20 * 24 * 60), spaceId: LUMEN_ID })
  store.state.repos.push(repo(LUMEN_MEMORY, 'lumen-memory', memory), repo(LUMEN_CLI_REPO, 'lumen-cli', cli), repo(LUMEN_SITE_REPO, 'lumen-site', site))
  const organization: Organization = { id: LUMEN_ID, name: 'Lumen', memoryRepoId: LUMEN_MEMORY, leadEmployeeId: theo.definition.id, programManagerId: priya.definition.id, icon: { kind: 'lucide', name: 'sun' }, createdAt: at(20 * 24 * 60) }
  store.state.organizations = [...(store.state.organizations ?? []), organization]
  store.state.employees = [...(store.state.employees ?? []), ...records]
  const workspace = (id: string, repoId: string, name: string, branch: string, wsPath: string, minutes: number, extra: Partial<Workspace>): Workspace => ({
    id, repoId, name, branch, baseBranch: 'main', path: wsPath, portBase: 50050, state: 'ready', createdAt: at(minutes), ...extra
  })
  store.state.workspaces.push(
    workspace('ws-oslo', LUMEN_CLI_REPO, 'oslo', 'toml-config', oslo, 60, { status: 'in-progress', statusAt: at(55), diffStat: { files: 2, additions: 3, deletions: 1 } }),
    workspace('ws-kigali', LUMEN_SITE_REPO, 'kigali', 'dark-mode-docs', kigali, 26 * 60, { status: 'done', statusAt: at(24 * 60), diffStat: { files: 1, additions: 3, deletions: 0 } })
  )

  // ---- the chat that ran out of credits: an API-key account, paused, with Resume now and Continue on another account ----
  const t1 = `${OSLO_TAB}-t1`
  const session: Session = {
    id: OSLO_TAB, workspaceId: 'ws-oslo', title: 'Read the config from lumen.toml', agent: 'claude', model: DEFAULT_MODEL.claude, effort: 'high', fastMode: false, planMode: false,
    status: 'idle', queue: [], instanceId: 'ai-client01', lastTurn: { outcome: 'limit', turnId: t1, endedAt: at(18) }, createdAt: at(58), lastActivityAt: at(18)
  }
  store.state.sessions.push(session)
  const chat: ChatItem[] = [
    { kind: 'user', id: `${t1}:user`, turnId: t1, at: at(24), text: 'Read the config from lumen.toml instead of .lumenrc.json, and keep reading .lumenrc.json for a release so nobody’s setup breaks.' },
    { kind: 'assistant', id: `${t1}:a1`, turnId: t1, text: 'I’ll switch the loader to TOML and keep the JSON file as a fallback for one release.' },
    { kind: 'tool', id: `${t1}:read`, turnId: t1, name: 'Read', input: { file_path: 'src/config.ts' }, status: 'done', output: CONFIG_TS },
    { kind: 'tool', id: `${t1}:grep`, turnId: t1, name: 'Grep', input: { pattern: 'lumenrc', path: '.' }, status: 'done', output: 'src/config.ts:8\nREADME.md:12' },
    { kind: 'tool', id: `${t1}:edit`, turnId: t1, name: 'Edit', input: { file_path: 'src/config.ts', old_string: "file = '.lumenrc.json'", new_string: "file = 'lumen.toml'" }, status: 'done', output: 'The file src/config.ts has been updated.' },
    { kind: 'turn-end', id: `turn-end:${t1}`, turnId: t1, outcome: 'error', error: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.', limit: { source: 'Credit balance is too low' }, durationMs: 6 * 60_000 }
  ]
  for (const item of chat) await store.appendChat(OSLO_TAB, item)

  // ---- the release it already shipped (Channels, Closed) ----
  const done: Project = {
    id: 'proj-lumen-0-8', orgId: LUMEN_ID, slug: RELEASE, title: 'Release Lumen 0.8', requirement: 'Release Lumen 0.8 with lumen stats.', repoId: LUMEN_CLI_REPO, pmId: priya.definition.id,
    phase: 'closed', outcome: 'done', plans: [], parts: {}, replans: 0, steps: [], waits: [], decisions: [], notes: [], createdAt: at(14 * 24 * 60), updatedAt: at(12 * 24 * 60), closedAt: at(12 * 24 * 60),
    artifacts: Object.fromEntries(['plan.md', 'changelog.md', 'post.md'].map((file, i) => [file, { file, path: `memory/org/projects/${RELEASE}/${file}`, employeeId: i === 1 ? theo.definition.id : i === 2 ? noor.definition.id : priya.definition.id, taskId: `task-lumen-0-8-${i}`, version: 1, at: at(13 * 24 * 60 - i * 60) }]))
  }
  db.putProject(done)
}
