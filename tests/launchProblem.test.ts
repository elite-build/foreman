// launchProblem: why an agent couldn't start, in one sentence, first match wins (docs/agents.md, 4.1). The adapters' own
// start failures (Claude, Codex, ACP, Cursor) are checked in their test files; this holds the function and its order.
import { afterEach, describe, expect, it } from 'vitest'
import { catalogAgent } from '../src/shared/agentCatalog'
import { createT } from '../src/shared/i18n'
import { launchProblem, LaunchProblemError, unknownMethodOf } from '../src/shared/launchProblem'

// A table to try the version branches on: the catalog says nothing is broken, so a test writes one and puts it back.
const original = catalogAgent('codex')!.versions
afterEach(() => {
  catalogAgent('codex')!.versions = original
})
const withTable = (table: NonNullable<typeof original>) => {
  catalogAgent('codex')!.versions = table
}

describe('launchProblem', () => {
  it('says the program is not installed, naming where it looked, and points at Settings', () => {
    expect(launchProblem('codex', { notInstalled: true, path: '/opt/codex' })).toEqual({
      kind: 'not-installed',
      text: 'Codex is not installed or could not be found at /opt/codex. Set its path in Settings → Agents → Codex.',
      action: 'open-settings'
    })
    // Where it can be got, when the catalog knows, instead of the path hint; and the adapter's own name for it.
    expect(launchProblem('opencode', { notInstalled: true, name: 'OpenCode', installHint: 'Install it from opencode.ai.' }).text).toBe('OpenCode is not installed or could not be found. Install it from opencode.ai.')
  })

  it('refuses a version the table lists as broken, with why, and offers Update where the agent has an update command', () => {
    withTable({ tested: ['0.163.0'], update: { args: ['update'] }, broken: [{ range: '>=0.150.0 <0.160.0', why: 'agentCaps.why.cost' }] })
    expect(launchProblem('codex', { version: '0.155.2' })).toEqual({
      kind: 'broken',
      text: 'Codex 0.155.2 doesn’t work with Foreman: This agent doesn’t report a price for a turn.',
      action: 'update'
    })
    // A version outside the range is not broken.
    expect(launchProblem('codex', { version: '0.163.0' }).kind).toBe('other')
  })

  it('refuses a version older than the minimum, and says nothing of one it cannot read', () => {
    withTable({ tested: [], minimum: '0.120.0' })
    expect(launchProblem('codex', { version: '0.119.9' })).toEqual({ kind: 'broken', text: 'Codex 0.119.9 is older than 0.120.0, the oldest version Foreman can run.', action: 'open-settings' })
    expect(launchProblem('codex', { version: '0.120.0' }).kind).toBe('other')
    expect(launchProblem('codex', { version: 'dev' }).kind).toBe('other')
  })

  it('says a model needs a newer CLI than the one installed, with Update', () => {
    withTable({ tested: [], update: { args: ['update'] }, models: { 'gpt-6.1-sol': '0.170.0' } })
    expect(launchProblem('codex', { version: '0.163.0', model: { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' } })).toEqual({
      kind: 'model-needs-newer',
      text: 'GPT-6.1 Sol needs a newer Codex than 0.163.0.',
      action: 'update'
    })
    // A model with no minimum, or an installed version that has it, is fine.
    expect(launchProblem('codex', { version: '0.163.0', model: { id: 'gpt-6-sol', label: 'GPT-6 Sol' } }).kind).toBe('other')
    expect(launchProblem('codex', { version: '0.170.0', model: { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' } }).kind).toBe('other')
  })

  it('says an ACP agent that answers with another protocol version speaks only that one', () => {
    expect(launchProblem('gemini', { acpProtocol: 2 })).toEqual({ kind: 'protocol', text: 'Gemini CLI speaks only ACP v2, and Foreman speaks v1.' })
    expect(launchProblem('gemini', { acpProtocol: 1 }).kind).toBe('other')
  })

  it('says a Codex that does not know a request is older than Foreman expects, with Update', () => {
    expect(launchProblem('codex', { unknownMethod: 'thread/goal/set', version: '0.140.0' })).toEqual({
      kind: 'protocol',
      text: 'Codex 0.140.0 doesn’t know the request “thread/goal/set”, so it is older than Foreman expects.',
      action: 'update'
    })
    expect(launchProblem('codex', { unknownMethod: 'thread/goal/set' }).text).toBe('Codex doesn’t know the request “thread/goal/set”, so it is older than Foreman expects.')
  })

  it('says not signed in, or no key, with the action the adapter offers', () => {
    expect(launchProblem('claude', { signedOut: true, signIn: 'sign-in' })).toEqual({ kind: 'signed-out', text: 'Claude Code isn’t signed in, or its sign-in has expired.', action: 'sign-in' })
    expect(launchProblem('codex', { signedOut: true })).toMatchObject({ kind: 'signed-out', action: 'open-settings' })
    expect(launchProblem('cursor', { keyMissing: true })).toEqual({ kind: 'signed-out', text: 'Cursor has no API key. Add one in Settings → Agents → Cursor.', action: 'open-settings' })
  })

  it('otherwise gives the agent’s own error, and no action', () => {
    expect(launchProblem('codex', { error: 'model not found ' })).toEqual({ kind: 'other', text: 'model not found' })
    expect(launchProblem('codex', {}).text).toBe('Codex failed to start.')
  })

  it('takes the first match: not installed, then a broken version, then a protocol, then signed out', () => {
    withTable({ tested: [], minimum: '9.0.0' })
    const everything = { notInstalled: true, version: '0.1.0', acpProtocol: 2, unknownMethod: 'x', signedOut: true, keyMissing: true, error: 'boom' }
    expect(launchProblem('codex', everything).kind).toBe('not-installed')
    expect(launchProblem('codex', { ...everything, notInstalled: false }).kind).toBe('broken')
    expect(launchProblem('codex', { ...everything, notInstalled: false, version: undefined }).kind).toBe('protocol')
    expect(launchProblem('codex', { ...everything, notInstalled: false, version: undefined, acpProtocol: undefined, unknownMethod: undefined }).kind).toBe('signed-out')
  })

  it('says it in the language it is given', () => {
    expect(launchProblem('codex', { signedOut: true }, createT('de')).text).toBe('Codex ist nicht angemeldet, oder die Anmeldung ist abgelaufen.')
  })

  it('can be thrown, and carries the problem', () => {
    const problem = launchProblem('codex', { notInstalled: true })
    expect(new LaunchProblemError(problem).problem).toBe(problem)
    expect(new LaunchProblemError(problem).message).toBe(problem.text)
  })
})

describe('unknownMethodOf', () => {
  it('reads the method from what the pinned Codex says (code -32600, checked against the real app-server)', () => {
    expect(unknownMethodOf('Invalid request: unknown variant `thread/nope`, expected one of `initialize`, `thread/start`')).toBe('thread/nope')
  })
  it('reads the method from a spec-following server', () => {
    expect(unknownMethodOf('Method not found: thread/goal/set')).toBe('thread/goal/set')
  })
  it('finds nothing in other errors, including an invalid parameter', () => {
    expect(unknownMethodOf('Invalid params: unknown variant `bogus`, expected `a`')).toBeUndefined()
    expect(unknownMethodOf('boom')).toBeUndefined()
    expect(unknownMethodOf(undefined)).toBeUndefined()
  })
})
