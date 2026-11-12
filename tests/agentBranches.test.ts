// The agent-branch guard (docs/agents.md, 2.4). A feature asks the capability record what an agent can do; it does not
// ask which agent it is. This counts, per file outside the adapters and the catalog, the places that still branch on an
// agent's id, and holds the counts to a ratchet: a count may fall, never rise, and a file with no baseline entry may have
// no sites. The last slice of the agents build empties the baseline, which is the issue's "no branch" check.
//
// A site is one of:
//   (a) a comparison of an agent-named expression with an agent id (`agent === 'claude'`, `s.agent !== 'codex'`), or a
//       `case '<id>':` label of a `switch` on an agent-named expression;
//   (b) an array or Set literal of two or more agent ids (`['claude', 'codex']`);
//   (c) a read of an old flag: supportsSteering, supportsPlanMode, supportsReadOnly, supportsRepoMcp, capabilities.rewind,
//       .steer or .plan, or a call to agentControls(), missingCapabilities(), declaresPlanMode() or supportsPlan().
//
// Agent-named: an identifier or member whose last name is `agent`, `agentId` or `agentKind`; and `kind` or `id` in a file
// that deals in agents (see AGENT_FILE), compared with an id that is not an everyday word (see EVERYDAY). So
// `provider === 'claude'` (an API-key provider) and `kind === 'continue'` are not sites.
//
// After removing sites, write the new counts down (the rewrite refuses any count that went up):
//   UPDATE_AGENT_BRANCH_BASELINE=1 npx vitest run tests/agentBranches.test.ts
// To list every site with its line: AGENT_BRANCH_REPORT=<file.json> npx vitest run tests/agentBranches.test.ts
// TypeScript 7 has no compiler API, so the files are parsed with @babel/parser, as the design-system guard does.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { describe, expect, it } from 'vitest'
import { AGENT_CATALOG } from '../src/shared/agentCatalog'

const BASELINE = 'tests/agentBranches.baseline.json'
const UPDATE = 'UPDATE_AGENT_BRANCH_BASELINE=1 npx vitest run tests/agentBranches.test.ts'

/** Where agent ids may be named: the adapters, the catalog and the records (and the pure helpers over them). */
const ALLOWED = ['src/main/agents/', 'src/shared/agentCatalog/', 'src/shared/agentCapabilities.ts']

const AGENT_IDS = new Set(AGENT_CATALOG.map((a) => a.id))
// Ids that are also ordinary words: with `kind` or `id` they say nothing about an agent (`kind === 'continue'`), so only
// an expression named `agent` makes them a site.
const EVERYDAY = new Set(['continue', 'pi', 'amp', 'goose', 'crush', 'cline', 'vibe', 'muse', 'devin', 'kiro', 'auto'])
const STRONG_NAMES = new Set(['agent', 'agentId', 'agentKind'])
const WEAK_NAMES = new Set(['kind', 'id'])
const AGENT_FILE = /\bAgentKind\b|\bAGENTS\b|agentCatalog|catalogAgent|\bCatalogAgent\b|['"`]claude['"`]/
const FLAG_PROPERTIES = new Set(['supportsSteering', 'supportsPlanMode', 'supportsReadOnly', 'supportsRepoMcp'])
const CAPABILITY_PROPERTIES = new Set(['rewind', 'steer', 'plan'])
const FLAG_CALLS = new Set(['agentControls', 'missingCapabilities', 'declaresPlanMode', 'supportsPlan'])

type Node = any

export interface Site {
  line: number
  kind: 'comparison' | 'case' | 'list' | 'flag'
  text: string
}

/** The name an expression ends in: `agent`, `s.agent`, `x().agent`, `agents[0].agent`. Null for anything else. */
function lastName(node: Node): string | null {
  if (!node) return null
  if (node.type === 'Identifier') return node.name
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') && !node.computed && node.property.type === 'Identifier') return node.property.name
  if (node.type === 'TSNonNullExpression' || node.type === 'TSAsExpression' || node.type === 'ParenthesizedExpression') return lastName(node.expression)
  return null
}

const stringValue = (node: Node): string | null => (node?.type === 'StringLiteral' ? node.value : node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : null)

function walk(node: Node, visit: (node: Node) => void): void {
  if (!node || typeof node.type !== 'string') return
  visit(node)
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key.endsWith('Comments') || key === 'extra') continue
    const child = node[key]
    if (Array.isArray(child)) for (const c of child) walk(c, visit)
    else if (child && typeof child === 'object') walk(child, visit)
  }
}

/** The sites in one file's source. `file` picks the parser's dialect. */
export function scanSource(file: string, source: string): Site[] {
  const plugins = file.endsWith('.tsx') ? ['jsx', 'typescript'] : file.endsWith('.js') ? [] : ['typescript']
  const ast = parse(source, { sourceType: 'unambiguous', plugins: plugins as never })
  const lines = source.split('\n')
  const agentFile = AGENT_FILE.test(source)
  const out: Site[] = []
  const add = (node: Node, kind: Site['kind']) => out.push({ line: node.loc.start.line, kind, text: (lines[node.loc.start.line - 1] ?? '').trim().slice(0, 140) })

  // Whether `name` makes the expression agent-named when it is compared with the id `id`.
  const named = (name: string | null, id: string): boolean => {
    if (!name) return false
    if (STRONG_NAMES.has(name)) return true
    return WEAK_NAMES.has(name) && agentFile && !EVERYDAY.has(id)
  }

  walk(ast.program, (node) => {
    if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator)) {
      for (const [expr, other] of [[node.left, node.right], [node.right, node.left]]) {
        const id = stringValue(other)
        if (id !== null && AGENT_IDS.has(id) && named(lastName(expr), id)) {
          add(node, 'comparison')
          break
        }
      }
    } else if (node.type === 'SwitchStatement') {
      for (const c of node.cases) {
        const id = c.test ? stringValue(c.test) : null
        if (id !== null && AGENT_IDS.has(id) && named(lastName(node.discriminant), id)) add(c, 'case')
      }
    } else if (node.type === 'ArrayExpression') {
      if (node.elements.filter((e: Node) => e && AGENT_IDS.has(stringValue(e) ?? '')).length >= 2) add(node, 'list')
    } else if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      if (node.computed || node.property.type !== 'Identifier') return
      const name = node.property.name
      if (FLAG_PROPERTIES.has(name) || (CAPABILITY_PROPERTIES.has(name) && lastName(node.object) === 'capabilities')) add(node, 'flag')
    } else if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      if (node.callee.type === 'Identifier' && FLAG_CALLS.has(node.callee.name)) add(node, 'flag')
    }
  })
  return out
}

function filesUnder(dir: string, test: (name: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out
  for (const name of readdirSync(dir)) {
    const path = join(dir, name).split('\\').join('/')
    if (statSync(path).isDirectory()) filesUnder(path, test, out)
    else if (test(name)) out.push(path)
  }
  return out
}

function scanRepository(): Record<string, Site[]> {
  const files = [...filesUnder('src', (n) => /\.tsx?$/.test(n)), ...filesUnder('resources/mobile', (n) => n.endsWith('.js'))]
  const sites: Record<string, Site[]> = {}
  for (const file of files.sort()) {
    if (ALLOWED.some((a) => file === a || (a.endsWith('/') && file.startsWith(a)))) continue
    const found = scanSource(file, readFileSync(file, 'utf8'))
    if (found.length) sites[file] = found
  }
  return sites
}

type Counts = Record<string, number>
const countsOf = (sites: Record<string, Site[]>): Counts => Object.fromEntries(Object.entries(sites).map(([file, s]) => [file, s.length]))
const total = (counts: Counts) => Object.values(counts).reduce((n, c) => n + c, 0)

/** Files whose count is above the baseline (a file with no entry may have none). */
function overBaseline(now: Counts, baseline: Counts): string[] {
  return Object.keys(now).filter((file) => now[file] > (baseline[file] ?? 0))
}

/** Baseline entries that are higher than what is there now: sites were removed, so the baseline must come down. */
function staleBaseline(now: Counts, baseline: Counts): string[] {
  return Object.keys(baseline).filter((file) => baseline[file] > (now[file] ?? 0))
}

describe('the agent-branch guard: what it counts', () => {
  const kinds = (code: string, file = 'src/x.ts') => scanSource(file, code).map((s) => s.kind)

  it('counts a comparison of an agent-named expression with an agent id, in either order', () => {
    expect(kinds("if (agent === 'claude') {}")).toEqual(['comparison'])
    expect(kinds("const x = session.agent !== 'codex'")).toEqual(['comparison'])
    expect(kinds("const x = loadout.model.agent == 'cursor'")).toEqual(['comparison'])
    expect(kinds("const x = 'opencode' === agentId")).toEqual(['comparison'])
    expect(kinds("const x = choiceFor(s, c).agent === 'claude'")).toEqual(['comparison'])
    expect(kinds("const x = agent === 'claude' || agent === 'codex'")).toEqual(['comparison', 'comparison'])
  })

  it('counts kind and id only in a file that deals in agents, and not for an everyday word', () => {
    expect(kinds("import type { AgentKind } from './agents'\nconst x = entry.id === 'claude'")).toEqual(['comparison'])
    expect(kinds("import type { AgentKind } from './agents'\nconst x = a.kind === 'gemini'")).toEqual(['comparison'])
    expect(kinds("const x = entry.id === 'gemini'")).toEqual([])
    // 'continue' is a terminal agent's id and a step kind.
    expect(kinds("import type { AgentKind } from './agents'\nconst x = step.kind === 'continue'")).toEqual([])
    expect(kinds("const x = agent === 'continue'")).toEqual(['comparison'])
  })

  it('does not count what is not an agent', () => {
    expect(kinds("const x = provider === 'claude'")).toEqual([])
    expect(kinds("const x = agent === 'something'")).toEqual([])
    expect(kinds("const x = agent === other")).toEqual([])
    expect(kinds("const x = { agent: 'claude' }")).toEqual([])
    expect(kinds("const label = AGENTS['claude'].label")).toEqual([])
  })

  it('counts the case labels of a switch on an agent-named expression', () => {
    expect(kinds("switch (agent) { case 'claude': break; case 'codex': break; default: break }")).toEqual(['case', 'case'])
    expect(kinds("switch (s.agent) { case 'claude': break }")).toEqual(['case'])
    expect(kinds("switch (type) { case 'claude': break }")).toEqual([])
  })

  it('counts an array or Set literal of two or more agent ids', () => {
    expect(kinds("const x = ['claude', 'codex']")).toEqual(['list'])
    expect(kinds("const x = new Set(['claude', 'codex', 'cursor'])")).toEqual(['list'])
    expect(kinds("const x = ['claude']")).toEqual([])
    expect(kinds("const x = ['claude', 'other']")).toEqual([])
  })

  it('counts a read of an old flag, not its definition', () => {
    expect(kinds('const x = AGENTS[a].supportsSteering')).toEqual(['flag'])
    expect(kinds('const x = AGENTS[a]?.supportsRepoMcp')).toEqual(['flag'])
    expect(kinds('const x = agent.capabilities.rewind')).toEqual(['flag'])
    expect(kinds('const x = capabilities.plan')).toEqual(['flag'])
    expect(kinds('const x = agentControls(id).restore')).toEqual(['flag'])
    expect(kinds('const x = missingCapabilities(id)')).toEqual(['flag'])
    expect(kinds('const x = supportsPlan(a, modes) || declaresPlanMode(a, modes)')).toEqual(['flag', 'flag'])
    expect(kinds('const x = { supportsSteering: true }')).toEqual([])
    expect(kinds('const x = turns.steer')).toEqual([])
  })

  it('reads the phone client’s plain JavaScript and TSX', () => {
    expect(kinds("if (s.agent === 'claude') run()", 'resources/mobile/app.js')).toEqual(['comparison'])
    expect(kinds("const el = <b>{agent === 'claude' ? 1 : 2}</b>", 'src/x.tsx')).toEqual(['comparison'])
  })

  it('holds a count to its baseline: it may fall, never rise, and a new file may have none', () => {
    expect(overBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([])
    expect(overBaseline({ 'a.ts': 1 }, { 'a.ts': 2 })).toEqual([])
    expect(overBaseline({ 'a.ts': 3 }, { 'a.ts': 2 })).toEqual(['a.ts'])
    expect(overBaseline({ 'b.ts': 1 }, { 'a.ts': 2 })).toEqual(['b.ts'])
    expect(staleBaseline({ 'a.ts': 1 }, { 'a.ts': 2 })).toEqual(['a.ts'])
    expect(staleBaseline({}, { 'a.ts': 2 })).toEqual(['a.ts'])
    expect(staleBaseline({ 'a.ts': 2 }, { 'a.ts': 2 })).toEqual([])
  })
})

describe('the agent-branch guard: src and resources/mobile', () => {
  it('no file branches on an agent more than its baseline allows', () => {
    const sites = scanRepository()
    const now = countsOf(sites)
    const baseline: Counts = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : {}
    if (process.env.AGENT_BRANCH_REPORT) writeFileSync(process.env.AGENT_BRANCH_REPORT, `${JSON.stringify(sites, null, 2)}\n`)
    const by = (kind: Site['kind']) => Object.values(sites).reduce((n, s) => n + s.filter((x) => x.kind === kind).length, 0)
    console.log(`Agent-branch guard: ${total(now)} sites in ${Object.keys(now).length} files (${by('comparison')} comparisons, ${by('case')} case labels, ${by('list')} id lists, ${by('flag')} flag reads); baseline ${total(baseline)}.`)

    if (process.env.UPDATE_AGENT_BRANCH_BASELINE === '1') {
      // Written down only when nothing went up (or when there is no baseline yet); a rise is fixed in the code, never here.
      if (existsSync(BASELINE)) expect(overBaseline(now, baseline), 'counts went up; the baseline is not rewritten upward').toEqual([])
      writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(now).sort(([a], [b]) => (a < b ? -1 : 1))), null, 2)}\n`)
      return
    }

    const over = overBaseline(now, baseline)
    const lines = (files: string[]) => files.flatMap((f) => [`${f}: ${now[f]} now, ${baseline[f] ?? 0} allowed`, ...sites[f].map((s) => `  ${f}:${s.line}  ${s.text}`)])
    expect(
      over.length ? ['A feature asks the capability record what an agent can do (capabilitiesFor, useCapabilities); it does not branch on the agent. See docs/agents.md, 2.4.', ...lines(over)].join('\n') : '',
      'sites above the baseline'
    ).toBe('')

    const stale = staleBaseline(now, baseline)
    expect(
      stale.length ? [`Sites were removed. Lower the baseline: ${UPDATE}`, ...stale.map((f) => `  ${f}: ${baseline[f]} in the baseline, ${now[f] ?? 0} now`)].join('\n') : '',
      'baseline entries above the sites'
    ).toBe('')
  })
})
