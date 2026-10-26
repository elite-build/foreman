import { describe, expect, it } from 'vitest'
import { chooseStartLoadout, newChatHint, startModelLoadout } from '../src/shared/startModel'
import type { Loadout } from '../src/shared/types'

const opus = { agent: 'claude' as const, model: 'claude-opus-5-5[1m]', effort: 'high' as const }
const explicit: Loadout = { agent: 'codex', model: 'gpt-6.1-sol', effort: 'low', fast: true }

describe('template start model precedence', () => {
  it('an explicit model beats the template, which beats the default', () => {
    expect(chooseStartLoadout(explicit, { startModel: opus })).toEqual({ loadout: explicit, source: 'explicit' })
    expect(chooseStartLoadout(undefined, { startModel: opus })).toEqual({ loadout: startModelLoadout(opus), source: 'template' })
    expect(chooseStartLoadout(undefined, {})).toEqual({ loadout: undefined, source: 'default' })
    expect(chooseStartLoadout(undefined, undefined).source).toBe('default')
  })

  it('never starts in fast mode', () => {
    expect(startModelLoadout(opus).fast).toBe(false)
  })
})

describe('the new-chat hint', () => {
  it('offers a chat on the template’s model only when this chat is on another one', () => {
    expect(newChatHint({ startModel: opus }, { agent: 'codex', model: 'gpt-6.1-sol' })).toMatch(/^Start in a new chat with .*Opus/)
    expect(newChatHint({ startModel: opus }, { agent: 'claude', model: 'claude-opus-5-5[1m]' })).toBeNull()
    expect(newChatHint({}, { agent: 'codex', model: 'x' })).toBeNull()
    expect(newChatHint(undefined, { agent: 'codex', model: 'x' })).toBeNull()
  })
})
