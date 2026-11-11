// docs/agent-access.md, sections 3 and 4: the levels, the ceiling order, the cap per agent and the protected paths.
import { describe, expect, it } from 'vitest'
import {
  AGENT_ACCESS_LEVELS,
  capIsLower,
  capPolicy,
  CEILING_PROTECTED_PATHS,
  ceilingRefusal,
  CEILINGS_ENFORCED,
  DEFAULT_AGENT_ACCESS_LEVEL,
  holdsCeiling,
  isCeilingProtected,
  LEVEL_CEILINGS,
  LEVEL_SCOPES,
  lowerCap,
  lowerPolicy,
  POLICY_ORDER,
  protectedPathDecision,
  type TurnCap
} from '../src/shared/agentAccess'
import { chatAgentKinds, type AgentKind } from '../src/shared/agents'
import type { ApprovalPolicy } from '../src/shared/permissions'

const cap = (ceiling: ApprovalPolicy, grantId = 'g1', name = 'Claude Code'): TurnCap => ({ ceiling, grantId, name })

describe('access levels', () => {
  it('are two separate things: what a client may call, and the most a turn it causes may do', () => {
    expect(AGENT_ACCESS_LEVELS).toEqual(['read', 'ask', 'ask-except-edits', 'auto', 'never-ask'])
    expect(DEFAULT_AGENT_ACCESS_LEVEL).toBe('ask')
    expect(LEVEL_SCOPES).toEqual({ read: ['read'], ask: ['read', 'operate'], 'ask-except-edits': ['read', 'operate'], auto: ['read', 'operate'], 'never-ask': ['read', 'operate'] })
    expect(LEVEL_CEILINGS).toEqual({ read: null, ask: 'ask', 'ask-except-edits': 'ask-except-edits', auto: 'auto', 'never-ask': 'never-ask' })
    // No level holds admin or window.
    for (const level of AGENT_ACCESS_LEVELS) expect(LEVEL_SCOPES[level].every((s) => s === 'read' || s === 'operate')).toBe(true)
  })

  it('orders the policies ask < ask except edits < auto < never ask, and the lower one wins', () => {
    expect(POLICY_ORDER).toEqual(['ask', 'ask-except-edits', 'auto', 'never-ask'])
    for (const [i, a] of POLICY_ORDER.entries()) for (const [j, b] of POLICY_ORDER.entries()) expect(lowerPolicy(a, b)).toBe(POLICY_ORDER[Math.min(i, j)])
  })
})

describe('the cap per agent', () => {
  const holdsAll: AgentKind[] = ['claude', 'codex']

  it('holds Claude and Codex to every ceiling, and Cursor, OpenCode and every ACP agent only to Never ask', () => {
    for (const agent of chatAgentKinds()) {
      expect(CEILINGS_ENFORCED[agent]).toEqual(holdsAll.includes(agent) ? POLICY_ORDER : ['never-ask'])
    }
    expect(chatAgentKinds()).toEqual(expect.arrayContaining(['claude', 'codex', 'cursor', 'opencode']))
    // A chat agent from the catalogue is in the table, and one this build doesn't know isn't held below Never ask.
    expect(chatAgentKinds().length).toBeGreaterThan(4)
    expect(holdsCeiling('someday-agent' as AgentKind, 'ask')).toBe(false)
    expect(holdsCeiling('someday-agent' as AgentKind, 'never-ask')).toBe(true)
  })

  it('caps every policy of every agent at every ceiling: the lower of the two where it can be held, refused where not', () => {
    for (const agent of chatAgentKinds()) {
      for (const policy of POLICY_ORDER) {
        for (const ceiling of POLICY_ORDER) {
          const expected = holdsAll.includes(agent) || ceiling === 'never-ask' ? POLICY_ORDER[Math.min(POLICY_ORDER.indexOf(policy), POLICY_ORDER.indexOf(ceiling))] : null
          expect(capPolicy(policy, ceiling, agent), `${agent} ${policy} under ${ceiling}`).toBe(expected)
        }
      }
    }
  })

  it('never raises a chat above the user’s own settings', () => {
    expect(capPolicy('ask', 'never-ask', 'claude')).toBe('ask')
    expect(capPolicy('ask-except-edits', 'auto', 'codex')).toBe('ask-except-edits')
    expect(capPolicy('never-ask', 'auto', 'codex')).toBe('auto')
  })

  it('refuses an agent that can’t be held, naming it and the client', () => {
    expect(ceilingRefusal('claude', cap('ask'))).toBeNull()
    expect(ceilingRefusal('cursor', undefined)).toBeNull()
    expect(ceilingRefusal('cursor', cap('never-ask'))).toBeNull()
    const refusal = ceilingRefusal('cursor', cap('auto'))
    expect(refusal).toContain('Cursor')
    expect(refusal).toContain('Claude Code')
    expect(refusal).toContain('“Auto”')
    expect(ceilingRefusal('opencode', cap('ask'))).toContain('OpenCode')
  })
})

describe('caps down the tree', () => {
  it('keeps the lower of two caps, the first on a tie, and either when the other is absent', () => {
    expect(lowerCap(undefined, undefined)).toBeUndefined()
    expect(lowerCap(cap('auto'), undefined)).toEqual(cap('auto'))
    expect(lowerCap(undefined, cap('ask'))).toEqual(cap('ask'))
    expect(lowerCap(cap('auto', 'root'), cap('ask', 'other'))).toEqual(cap('ask', 'other'))
    expect(lowerCap(cap('ask', 'root'), cap('auto', 'other'))).toEqual(cap('ask', 'root'))
    expect(lowerCap(cap('ask', 'root'), cap('ask', 'other'))).toEqual(cap('ask', 'root'))
  })

  it('says when one cap holds a turn lower than another (no cap holds nothing)', () => {
    expect(capIsLower(undefined, cap('ask'))).toBe(false)
    expect(capIsLower(cap('never-ask'), undefined)).toBe(true)
    expect(capIsLower(cap('ask'), cap('auto'))).toBe(true)
    expect(capIsLower(cap('auto'), cap('auto'))).toBe(false)
    expect(capIsLower(cap('never-ask'), cap('auto'))).toBe(false)
  })
})

describe('protected paths under a ceiling', () => {
  const ROOT = '/work/repo'
  const GIT = '/repos/app/.git'

  it('lists the files that configure agents and git', () => {
    expect(CEILING_PROTECTED_PATHS).toEqual(['.claude/', '.codex/', '.cursor/', '.foreman/', '.switchyard/', '.mcp.json', '.git/'])
  })

  it('protects them at any depth, the worktree’s .git pointer, the git common directory and agents’ home folders', () => {
    for (const p of ['.claude/settings.json', '/work/repo/.codex/config.toml', '.cursor/rules/a.mdc', '.foreman/settings.toml', '.switchyard/settings.toml', '.mcp.json', 'packages/web/.mcp.json', '.git', '.git/hooks/pre-commit', 'packages/lib/.claude/settings.local.json', `${GIT}/hooks/pre-push`, GIT, '/home/me/.claude/settings.json', '../other/.git/config']) {
      expect(isCeilingProtected(p, ROOT, GIT), p).toBe(true)
    }
    for (const p of ['src/index.ts', '/work/repo/README.md', 'docs/claude.md', '.github/workflows/ci.yml', '/repos/app/.github/x', `${GIT}x/hooks`, '']) {
      expect(isCeilingProtected(p, ROOT, GIT), p).toBe(false)
    }
    // A workspace kept under a dot-folder isn't protected as a whole: only what is below its root counts.
    expect(isCeilingProtected('/home/me/.foreman/ws/src/a.ts', '/home/me/.foreman/ws')).toBe(false)
  })

  it('compares Windows paths without case', () => {
    expect(isCeilingProtected('C:\\Work\\Repo\\.Claude\\settings.json', 'c:\\work\\repo')).toBe(true)
    expect(isCeilingProtected('c:\\repos\\app\\.GIT\\hooks\\x', 'C:\\work\\repo', 'C:\\Repos\\App\\.git')).toBe(true)
    expect(isCeilingProtected('C:\\Work\\Repo\\src\\a.ts', 'c:\\work\\repo', 'C:\\Repos\\App\\.git')).toBe(false)
  })

  it('makes file tools on them ask, and decides nothing else', () => {
    expect(protectedPathDecision('Write', { file_path: '.claude/settings.json' }, ROOT, GIT)).toMatchObject({ ask: true, reason: expect.stringContaining('asks first') })
    expect(protectedPathDecision('Edit', { file_path: `${GIT}/config` }, ROOT, GIT)).toMatchObject({ ask: true })
    expect(protectedPathDecision('NotebookEdit', { notebook_path: '.foreman/n.ipynb' }, ROOT)).toMatchObject({ ask: true })
    expect(protectedPathDecision('MultiEdit', { file_path: 'src/a.ts' }, ROOT, GIT)).toBeNull()
    expect(protectedPathDecision('Read', { file_path: '.claude/settings.json' }, ROOT, GIT)).toBeNull()
    expect(protectedPathDecision('Bash', { command: 'echo > .mcp.json' }, ROOT, GIT)).toBeNull()
    expect(protectedPathDecision('Write', {}, ROOT, GIT)).toBeNull()
  })
})
