// #130: an agent's other accounts, the pure parts: what a saved account may hold, resolving an id, where an account's
// conversations live, what moving a chat between accounts does, and launch flags.
import { describe, expect, it } from 'vitest'
import {
  accountMoveGuess,
  argsProblem,
  continuationKey,
  flagArgs,
  instanceLabel,
  instanceMove,
  joinArgs,
  parseAgentInstances,
  resolveInstance,
  splitArgs,
  type AgentInstance
} from '../src/shared/agentInstances'
import { parseAgentPrefs } from '../src/shared/agentCatalog'
import { continueBlock, modelChoiceAction } from '../src/shared/switchAgent'

const work: AgentInstance = { id: 'ai-work0001', agent: 'claude', label: 'Work', home: '/Users/me/.claude-work', auth: 'cli' }
const shared: AgentInstance = { id: 'ai-share001', agent: 'claude', label: 'Key', auth: 'apiKey' }
const cursor: AgentInstance = { id: 'ai-cursor01', agent: 'cursor', label: 'Team', auth: 'apiKey' }

describe('parseAgentInstances', () => {
  it('keeps well-formed accounts and only the fields their agent supports', () => {
    const parsed = parseAgentInstances([
      { ...work, args: ['--debug'] },
      { id: 'ai-codex001', agent: 'codex', label: 'Work', home: '/h/.codex-work', path: '/bin/codex', args: ['--debug'], auth: 'apiKey' },
      { id: 'ai-cursor01', agent: 'cursor', label: 'Team', home: '/x', path: '/y', auth: 'cli' }
    ])
    expect(parsed).toEqual([
      { ...work, args: ['--debug'] },
      // Codex takes no launch flags.
      { id: 'ai-codex001', agent: 'codex', label: 'Work', home: '/h/.codex-work', path: '/bin/codex', auth: 'apiKey' },
      // A Cursor account is a key: no folder, no binary, always API key.
      { id: 'ai-cursor01', agent: 'cursor', label: 'Team', auth: 'apiKey' }
    ])
  })

  it('drops malformed entries, unknown agents, duplicate ids and duplicate labels', () => {
    expect(
      parseAgentInstances([
        null,
        'nope',
        { id: 'default', agent: 'claude', label: 'X', auth: 'cli' },
        { id: 'ai-gemini01', agent: 'gemini', label: 'X', auth: 'cli' },
        { id: 'ai-nolabel1', agent: 'claude', label: '  ', auth: 'cli' },
        { id: 'ai-longlab1', agent: 'claude', label: 'x'.repeat(41), auth: 'cli' },
        work,
        { ...work, label: 'Other' },
        { id: 'ai-work0002', agent: 'claude', label: 'WORK', auth: 'cli' },
        // The same name on another agent is fine.
        { id: 'ai-codexwrk', agent: 'codex', label: 'Work', auth: 'cli' }
      ]).map((i) => i.id)
    ).toEqual(['ai-work0001', 'ai-codexwrk'])
    expect(parseAgentInstances(undefined)).toEqual([])
  })

  it('drops launch flags Foreman sets itself, so a saved account can’t lift approvals', () => {
    expect(parseAgentInstances([{ ...work, args: ['--dangerously-skip-permissions'] }])[0].args).toBeUndefined()
    expect(parseAgentInstances([{ ...work, args: ['--permission-mode', 'bypassPermissions'] }])[0].args).toBeUndefined()
  })
})

describe('resolving an account', () => {
  it('is the default account without an id, the account with one, and missing when gone or another agent’s', () => {
    expect(resolveInstance([work], 'claude', undefined)).toEqual({ kind: 'default' })
    expect(resolveInstance([work], 'claude', work.id)).toEqual({ kind: 'instance', instance: work })
    expect(resolveInstance([work], 'claude', 'ai-gone0001')).toEqual({ kind: 'missing', id: 'ai-gone0001' })
    expect(resolveInstance([work], 'codex', work.id)).toEqual({ kind: 'missing', id: work.id })
    expect(instanceLabel([work], 'claude', work.id)).toBe('Work')
    expect(instanceLabel([work], 'claude', undefined)).toBeNull()
  })
})

describe('continuationKey', () => {
  it('is the config folder for Claude and Codex, where their conversations live', () => {
    expect(continuationKey('claude', { kind: 'default' }, '/Users/me', 'darwin')).toBe('claude:home:/Users/me/.claude')
    expect(continuationKey('codex', { kind: 'default' }, '/Users/me', 'darwin')).toBe('codex:home:/Users/me/.codex')
    expect(continuationKey('claude', { kind: 'instance', instance: work }, '/Users/me', 'darwin')).toBe('claude:home:/Users/me/.claude-work')
    // An account without a folder shares the default one, and so its conversations.
    expect(continuationKey('claude', { kind: 'instance', instance: shared }, '/Users/me', 'darwin')).toBe(continuationKey('claude', { kind: 'default' }, '/Users/me', 'darwin'))
  })

  it('follows CLAUDE_CONFIG_DIR in the user’s environment for the default folder', () => {
    expect(continuationKey('claude', { kind: 'default' }, '/Users/me', 'darwin', { CLAUDE_CONFIG_DIR: '/elsewhere/' })).toBe('claude:home:/elsewhere')
  })

  it('compares Windows folders without case or slash differences', () => {
    const a = continuationKey('claude', { kind: 'instance', instance: { ...work, home: 'C:\\Users\\Me\\.claude-work\\' } }, 'C:\\Users\\Me', 'win32')
    const b = continuationKey('claude', { kind: 'instance', instance: { ...work, home: 'c:/users/me/.CLAUDE-work' } }, 'C:\\Users\\Me', 'win32')
    expect(a).toBe(b)
    expect(continuationKey('claude', { kind: 'default' }, 'C:\\Users\\Me', 'win32')).toBe('claude:home:c:\\users\\me\\.claude')
  })

  it('gives every Cursor account its own, and a removed account one nothing matches', () => {
    expect(continuationKey('cursor', { kind: 'instance', instance: cursor }, '/h', 'darwin')).toBe('cursor:account:ai-cursor01')
    expect(continuationKey('cursor', { kind: 'default' }, '/h', 'darwin')).toBe('cursor:account:default')
    expect(continuationKey('claude', { kind: 'missing', id: 'ai-gone0001' }, '/h', 'darwin')).toBe('claude:missing:ai-gone0001')
  })
})

describe('moving a chat between accounts', () => {
  const base = { fromKey: 'a', toKey: 'b', rule: 'never' as const, hasConversation: true }
  it('decides by the conversation and the rule', () => {
    expect(instanceMove({ ...base, from: work.id, to: work.id })).toBe('same')
    expect(instanceMove({ ...base, from: undefined, to: undefined })).toBe('same')
    // Nothing to carry yet: it just moves, whatever the rule.
    expect(instanceMove({ ...base, to: work.id, hasConversation: false })).toBe('native')
    // Both keep it in one place: the same conversation goes on.
    expect(instanceMove({ ...base, to: work.id, toKey: 'a' })).toBe('native')
    expect(instanceMove({ ...base, to: work.id })).toBe('blocked')
    expect(instanceMove({ ...base, to: work.id, rule: 'as-text' })).toBe('carry')
  })

  it('the picker guesses the same from the accounts’ folders', () => {
    const accounts = [work, shared]
    expect(accountMoveGuess(accounts, 'claude', undefined, work.id, 'never', true)).toBe('blocked')
    expect(accountMoveGuess(accounts, 'claude', undefined, work.id, 'as-text', true)).toBe('carry')
    // The key-only account shares the default folder.
    expect(accountMoveGuess(accounts, 'claude', undefined, shared.id, 'never', true)).toBe('native')
    expect(accountMoveGuess([cursor], 'cursor', undefined, cursor.id, 'never', true)).toBe('blocked')
  })

  it('keeps the rule per agent in its preferences', () => {
    expect(parseAgentPrefs({ claude: { moveChats: 'as-text' }, codex: { moveChats: 'sometimes' } })).toEqual({ claude: { moveChats: 'as-text' } })
  })

  it('asks before moving a chat with a conversation, and names the rule when it keeps the chat', () => {
    const session = { agent: 'claude' as const, agentSessionId: 'native' }
    expect(modelChoiceAction(session, true, { agent: 'claude', instance: work.id })).toBe('ask')
    expect(modelChoiceAction({ ...session, instanceId: work.id }, true, { agent: 'claude', instance: work.id })).toBe('apply')
    expect(modelChoiceAction({ agent: 'claude' }, true, { agent: 'claude', instance: work.id })).toBe('apply')
    expect(modelChoiceAction(session, false, { agent: 'claude', instance: work.id })).toBe('apply')
    expect(continueBlock({ status: 'idle' }, 'claude', true)).toBe('account')
    expect(continueBlock({ status: 'running' }, 'claude', true)).toBe('running')
    expect(continueBlock({ status: 'idle' }, 'claude')).toBeNull()
  })
})

describe('launch flags', () => {
  it('splits a line into tokens, keeping quoted parts together, and joins them back', () => {
    expect(splitArgs('--debug  --name "two words" --x=\'a b\'')).toEqual(['--debug', '--name', 'two words', '--x=a b'])
    expect(splitArgs('--empty ""')).toEqual(['--empty', ''])
    expect(splitArgs(joinArgs(['--name', 'two words', '--q', 'say "hi"']))).toEqual(['--name', 'two words', '--q', 'say "hi"'])
  })

  it('turns flags into the SDK’s name → value table', () => {
    expect(flagArgs(['--debug', '--name', 'v', '--x=1', '--last'])).toEqual({ debug: null, name: 'v', x: '1', last: null })
  })

  it('takes only --flags (each with its value) and none Foreman sets', () => {
    expect(argsProblem(['--debug', '--name', 'v', '--x=1'])).toBeNull()
    expect(argsProblem(['positional'])).toEqual({ kind: 'not-flag', arg: 'positional' })
    expect(argsProblem(['--name', 'v', 'w'])).toEqual({ kind: 'not-flag', arg: 'w' })
    expect(argsProblem(['-d'])).toEqual({ kind: 'not-flag', arg: '-d' })
    expect(argsProblem(['--model', 'opus'])).toEqual({ kind: 'reserved', arg: '--model' })
    expect(argsProblem(['--Permission-Mode=plan'])).toEqual({ kind: 'reserved', arg: '--Permission-Mode' })
    expect(argsProblem(['--mcp-config', 'x.json'])).toEqual({ kind: 'reserved', arg: '--mcp-config' })
  })
})
