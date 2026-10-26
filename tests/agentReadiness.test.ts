import { describe, expect, it } from 'vitest'
import { agentReadiness } from '../src/shared/agentReadiness'
import { pickerGroups } from '../src/shared/agentPicker'
import { preferAgentLoadout, type Loadout } from '../src/shared/agents'
import { createT } from '../src/shared/i18n'
import type { AgentStatus } from '../src/shared/types'

const status = (patch: Partial<AgentStatus> & Pick<AgentStatus, 'agent'>): AgentStatus => ({ installed: true, ready: true, ...patch })

describe('agentReadiness: sign-in status worded by its evidence', () => {
  it('says "Account found" for a signed-in Claude or Codex account', () => {
    expect(agentReadiness('claude', { status: status({ agent: 'claude', method: 'Claude Max account' }) })).toEqual({ ready: true, evidenceKey: 'agentReadiness.accountFound', needsSignIn: false, attention: false })
    expect(agentReadiness('codex', { status: status({ agent: 'codex', method: 'ChatGPT login' }) }).evidenceKey).toBe('agentReadiness.accountFound')
  })

  it('says "API key saved" when the key is what made it ready', () => {
    expect(agentReadiness('claude', { status: status({ agent: 'claude', method: 'API key' }) })).toMatchObject({ ready: true, evidenceKey: 'agentReadiness.apiKeySaved' })
    expect(agentReadiness('codex', { status: status({ agent: 'codex', method: 'API key' }) })).toMatchObject({ ready: true, evidenceKey: 'agentReadiness.apiKeySaved' })
  })

  it('says "Not signed in" and asks for sign-in when Claude or Codex is installed but not ready', () => {
    const out = agentReadiness('claude', { status: status({ agent: 'claude', ready: false, detail: 'Not signed in' }) })
    expect(out).toEqual({ ready: false, evidenceKey: 'agentReadiness.notSignedIn', needsSignIn: true, attention: true })
  })

  it('does not call a missing binary "not signed in", and does not guess before the status arrives', () => {
    expect(agentReadiness('codex', { status: status({ agent: 'codex', installed: false, ready: false }) })).toMatchObject({ ready: false, evidenceKey: 'agentReadiness.notInstalled', needsSignIn: false })
    expect(agentReadiness('claude', {})).toEqual({ ready: false, evidenceKey: 'agentReadiness.checking', needsSignIn: false, attention: false })
    expect(agentReadiness('claude', { status: null }).evidenceKey).toBe('agentReadiness.checking')
  })

  it('words Cursor’s saved key as untested, never as signed in', () => {
    expect(agentReadiness('cursor', { keySaved: true })).toMatchObject({ ready: true, evidenceKey: 'agentReadiness.keySavedUntested', attention: true })
    expect(agentReadiness('cursor', { keySaved: false })).toMatchObject({ ready: false, evidenceKey: 'agentReadiness.noKey' })
  })

  it('words OpenCode as installed, from its status or the installed flag', () => {
    expect(agentReadiness('opencode', { installed: true })).toMatchObject({ ready: true, evidenceKey: 'agentReadiness.installed' })
    expect(agentReadiness('opencode', { installed: false })).toMatchObject({ ready: false, evidenceKey: 'agentReadiness.notInstalled' })
    expect(agentReadiness('opencode', { status: status({ agent: 'opencode' }), installed: false }).ready).toBe(true)
  })

  it('has a message for every evidence key it returns, in English', () => {
    const t = createT('en')
    const inputs = [
      agentReadiness('claude', { status: status({ agent: 'claude', method: 'Claude Pro account' }) }),
      agentReadiness('claude', { status: status({ agent: 'claude', method: 'API key' }) }),
      agentReadiness('claude', { status: status({ agent: 'claude', ready: false }) }),
      agentReadiness('claude', { status: status({ agent: 'claude', installed: false, ready: false }) }),
      agentReadiness('claude', {}),
      agentReadiness('cursor', { keySaved: true }),
      agentReadiness('cursor', {}),
      agentReadiness('opencode', { installed: true })
    ]
    expect(inputs.map((r) => t(r.evidenceKey))).toEqual(['Account found', 'API key saved', 'Not signed in', 'Not installed', 'Checking…', 'Key saved, not yet tested', 'No key saved', 'Installed'])
  })
})

describe('the picker keeps a signed-out agent selectable but says so', () => {
  const signedOut = status({ agent: 'claude', ready: false })
  it('leaves Claude ready (selectable) while carrying the not-signed-in evidence', () => {
    const claude = pickerGroups(undefined, { cursor: false, opencode: false, statuses: { claude: signedOut } })[0].agents.find((a) => a.id === 'claude')!
    expect(claude.ready).toBe(true)
    expect(claude.readiness).toMatchObject({ ready: false, needsSignIn: true, evidenceKey: 'agentReadiness.notSignedIn' })
  })

  it('carries evidence for the Full agents only', () => {
    const groups = pickerGroups({ gemini: { enabled: true } }, { cursor: true, opencode: true, statuses: { claude: status({ agent: 'claude' }) } })
    expect(groups.find((g) => g.level === 'full')!.agents.map((a) => [a.id, a.readiness?.evidenceKey])).toEqual([
      ['claude', 'agentReadiness.accountFound'],
      ['codex', 'agentReadiness.checking'],
      ['cursor', 'agentReadiness.keySavedUntested'],
      ['opencode', 'agentReadiness.installed']
    ])
    expect(groups.find((g) => g.level === 'chat')!.agents[0].readiness).toBeUndefined()
  })
})

describe('preferAgentLoadout: "Use for new workspaces"', () => {
  const claude: Loadout = { agent: 'claude', model: 'a', fast: false }
  const claude2: Loadout = { agent: 'claude', model: 'b', fast: false }
  const codex: Loadout = { agent: 'codex', model: 'c', fast: false }
  const codex2: Loadout = { agent: 'codex', model: 'd', fast: true }

  it('moves the agent’s first loadout to the top and keeps the rest in order', () => {
    expect(preferAgentLoadout([claude, claude2, codex, codex2], 'codex')).toEqual([codex, claude, claude2, codex2])
  })

  it('does nothing when it is already first or the agent has none', () => {
    const list = [claude, codex]
    expect(preferAgentLoadout(list, 'claude')).toBe(list)
    expect(preferAgentLoadout(list, 'cursor')).toBe(list)
    expect(preferAgentLoadout([], 'claude')).toEqual([])
  })

  it('does not change its input', () => {
    const list = [claude, codex]
    preferAgentLoadout(list, 'codex')
    expect(list).toEqual([claude, codex])
  })
})
