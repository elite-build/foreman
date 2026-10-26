// `foreman ask` (accessibility plan H3): one assistant turn from the terminal. The main method is driven with a fake
// assistant behind the Api (the Api the Ask Foreman overlay uses); the runner is driven with a fake Context.
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '../src/cli/command'
import { workRunners } from '../src/cli/commands/work'
import { renderCommandHelp } from '../src/cli/help'
import { parseCommandArgs, plan } from '../src/cli/registry'
import { ASK_METHODS, type AskResult } from '../src/main/cli/ask'
import type { CliContext } from '../src/main/cli/methods'
import { CliCodedError, METHODS, tierCheck, type CliHost } from '../src/main/cliServer'
import { defaultSettings } from '../src/main/store'
import { foremanRunItem } from '../src/shared/assistant'
import type { AssistantGate } from '../src/shared/assistant'
import { COMMANDS, commandName } from '../src/shared/cliCommands'
import type { Api, ChatItem, MainEvent, Workspace } from '../src/shared/types'
import { fakeApi, stubHost } from './cliHost'

const ws = { id: 'ws1', repoId: 'r1', name: 'lisbon', branch: 'fix-login', baseBranch: 'main', state: 'ready', path: '/x', createdAt: 'x' } as Workspace

const turnEnd = (outcome: 'completed' | 'error' | 'cancelled' = 'completed', error?: string): ChatItem => ({ kind: 'turn-end', id: 'turn-end:t', turnId: 't', outcome, ...(error ? { error } : {}) })
const said = (text: string, id = 'a1'): ChatItem => ({ kind: 'assistant', id, turnId: 't', text })
const proposal = (runId: string, args: string[], summary: string, state: 'pending' | 'cancelled' = 'pending'): ChatItem =>
  foremanRunItem('t', { runId, command: `foreman ${args.join(' ')}`, summary, state })

interface Rig {
  host: CliHost
  calls: [string, ...unknown[]][]
  call: (params: Record<string, unknown>, signal?: AbortSignal) => Promise<AskResult>
  emit: (event: MainEvent) => void
}

/**
 * A host whose assistant is ready (or the given gate) and whose thread holds `items`. When `ends` is set, the turn
 * ends right after assistantSend answers (`early`: before it answers, to cover an end that beats the reply).
 */
function rig(options: { gate?: AssistantGate; items?: ChatItem[]; ends?: boolean; early?: boolean; api?: Partial<Api> } = {}): Rig {
  const calls: [string, ...unknown[]][] = []
  const listeners = new Set<(event: MainEvent) => void>()
  const emit = (event: MainEvent) => {
    for (const listener of listeners) listener(event)
  }
  const endEvent: MainEvent = { type: 'assistant-item', threadId: 'thread1', item: turnEnd() }
  const api = fakeApi({
    assistantState: async () => ({ gate: options.gate ?? ({ state: 'ready', agent: 'claude', model: 'm' } as AssistantGate), threads: [] }),
    assistantSend: async (...args) => {
      calls.push(['assistantSend', ...args])
      if (options.ends && options.early) emit(endEvent)
      if (options.ends && !options.early) setTimeout(() => emit(endEvent), 0)
      return { threadId: 'thread1' }
    },
    assistantItems: async () => options.items ?? [],
    assistantCancelRun: async (...args) => void calls.push(['assistantCancelRun', ...args]),
    assistantDeleteThread: async (...args) => void calls.push(['assistantDeleteThread', ...args]),
    ...options.api
  })
  const host = stubHost({
    api,
    state: () => ({ repos: [], workspaces: [ws], sessions: [], settings: defaultSettings() }),
    onEvent: (listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
  })
  const ctx = (signal?: AbortSignal): CliContext => ({ request: { method: 'ask' } as CliContext['request'], caller: undefined, signal, progress: () => undefined })
  return { host, calls, emit, call: async (params, signal) => (await ASK_METHODS.ask.handle(host, params, ctx(signal))) as AskResult }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  try {
    await promise
  } catch (err) {
    expect(err).toBeInstanceOf(CliCodedError)
    return err as CliCodedError
  }
  throw new Error('expected a failure')
}

const items: ChatItem[] = [
  said('Two things need you. Lisbon has a question about the mobile menu.', 'a1'),
  proposal('run1', ['approve', '3f9a1c2'], 'Answer one approval request', 'pending'),
  said('I can approve it if you like.', 'a2'),
  turnEnd()
]

describe('ask: the main method', () => {
  it('is an admin method and is the one registered under ask', () => {
    expect(METHODS.ask).toBe(ASK_METHODS.ask)
    expect(METHODS.ask.tier).toBe('admin')
  })

  it('asks the question in a fresh thread, returns the answer and the proposed command, then cancels it and deletes the thread', async () => {
    const { call, calls } = rig({ ends: true, items })
    const result = await call({ question: '  what needs me?  ' })
    expect(result).toEqual({
      answer: 'Two things need you. Lisbon has a question about the mobile menu.\n\nI can approve it if you like.',
      proposals: [{ runId: 'run1', command: 'foreman approve 3f9a1c2', summary: 'Answer one approval request' }]
    })
    // A new thread (null), the question as typed minus spaces, no alternative agent, no workspace context.
    expect(calls[0]).toEqual(['assistantSend', null, 'what needs me?', false, undefined])
    // The proposal never runs: it is cancelled (it would sit waiting for a click) and the thread goes.
    expect(calls.slice(1)).toEqual([
      ['assistantCancelRun', 'thread1', 'run1'],
      ['assistantDeleteThread', 'thread1']
    ])
  })

  it('does not return a proposal that was already cancelled or run, and has an empty list when there is none', async () => {
    const { call } = rig({ ends: true, items: [said('Nothing needs you.'), proposal('r', ['status'], 'List', 'cancelled'), turnEnd()] })
    expect(await call({ question: 'anything?' })).toEqual({ answer: 'Nothing needs you.', proposals: [] })
  })

  it('hears a turn that ends before assistantSend has answered', async () => {
    const { call } = rig({ ends: true, early: true, items })
    expect((await call({ question: 'what needs me?' })).proposals).toHaveLength(1)
  })

  it('ignores the end of another conversation', async () => {
    vi.useFakeTimers()
    try {
      const { call, emit } = rig({ items })
      const pending = call({ question: 'q', timeoutSec: 5 })
      await vi.advanceTimersByTimeAsync(1000)
      emit({ type: 'assistant-item', threadId: 'someone-elses', item: turnEnd() })
      await vi.advanceTimersByTimeAsync(5000)
      expect(await pending).toMatchObject({ timedOut: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives the workspace as the assistant’s context: a name, or "." for the one the command is in', async () => {
    const named = rig({ ends: true, items })
    await named.call({ question: 'q', workspace: 'lisbon' })
    expect(named.calls[0]).toEqual(['assistantSend', null, 'q', false, { workspaceId: 'ws1' }])
    const branch = rig({ ends: true, items })
    await branch.call({ question: 'q', workspace: 'fix-login' })
    expect(branch.calls[0][4]).toEqual({ workspaceId: 'ws1' })
    const unknown = rig({ ends: true, items })
    await expect(unknown.call({ question: 'q', workspace: 'nope' })).rejects.toThrow(/No workspace named “nope”/)
    expect(unknown.calls).toEqual([])
  })

  it('asks for a question, as text', async () => {
    const { call, calls } = rig({ ends: true, items })
    expect((await failure(call({ question: '   ' }))).code).toBe('invalid')
    expect((await failure(call({}))).code).toBe('invalid')
    expect(calls).toEqual([])
  })

  it.each([
    ['off', { state: 'off' }, 'The assistant is turned off in Settings › General.'],
    ['privacy', { state: 'privacy' }, 'Privacy mode is on, so the assistant is off.'],
    ['none', { state: 'none' }, 'The assistant needs a signed-in AI agent. Set one up in Settings › Agents.'],
    ['signed-out', { state: 'signed-out', agent: 'claude' }, 'Your default agent, Claude Code, isn’t signed in.']
  ] as const)('is held, with the gate’s reason, when the assistant is %s, and asks nothing', async (_name, gate, reason) => {
    const { call, calls } = rig({ gate: gate as AssistantGate })
    expect(await call({ question: 'what needs me?' })).toEqual({ answer: '', proposals: [], held: reason })
    expect(calls).toEqual([])
  })

  it('returns what it has, marked timedOut, when the assistant is still answering at the deadline, and stops it', async () => {
    const { call, calls } = rig({ items: [said('Lisbon first:'), proposal('run1', ['status'], 'List workspaces')] })
    const result = await call({ question: 'what needs me?', timeoutSec: 0.05 })
    expect(result).toEqual({ answer: 'Lisbon first:', proposals: [{ runId: 'run1', command: 'foreman status', summary: 'List workspaces' }], timedOut: true })
    // Deleting the thread is what stops the turn that is still going.
    expect(calls.slice(1)).toEqual([
      ['assistantCancelRun', 'thread1', 'run1'],
      ['assistantDeleteThread', 'thread1']
    ])
  })

  it('waits 120 seconds by default', async () => {
    vi.useFakeTimers()
    try {
      const { call } = rig({ items: [said('Still thinking')] })
      let done = false
      const pending = call({ question: 'q' }).then((r) => ((done = true), r))
      await vi.advanceTimersByTimeAsync(119_000)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(2_000)
      expect(await pending).toMatchObject({ timedOut: true, answer: 'Still thinking' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails with the assistant’s own reason when the turn errored or was stopped, and leaves nothing behind', async () => {
    const errored = rig({ ends: true, items: [turnEnd('error', 'The agent crashed.')] })
    expect((await failure(errored.call({ question: 'q' }))).message).toBe('The agent crashed.')
    expect(errored.calls.at(-1)).toEqual(['assistantDeleteThread', 'thread1'])
    const stopped = rig({ ends: true, items: [turnEnd('cancelled')] })
    expect((await failure(stopped.call({ question: 'q' }))).message).toMatch(/stopped/)
    expect(stopped.calls.at(-1)).toEqual(['assistantDeleteThread', 'thread1'])
  })

  it('stops waiting, and cleans up, when the command goes away', async () => {
    const gone = new AbortController()
    const { call, calls } = rig({ items: [said('Partial'), proposal('run1', ['status'], 'List')] })
    const pending = call({ question: 'q' }, gone.signal)
    setTimeout(() => gone.abort(), 10)
    expect((await failure(pending)).message).toMatch(/Stopped waiting/)
    expect(calls.slice(1)).toEqual([
      ['assistantCancelRun', 'thread1', 'run1'],
      ['assistantDeleteThread', 'thread1']
    ])
  })

  it('passes on a failure to send (a message that is too long, say), with no thread to clean up', async () => {
    const { call, calls } = rig({
      api: {
        assistantSend: async () => {
          throw new Error('Keep it under 8000 characters.')
        }
      }
    })
    await expect(call({ question: 'q' })).rejects.toThrow('Keep it under 8000 characters.')
    expect(calls).toEqual([])
  })
})

describe('ask: who may call it', () => {
  const caller = { sessionId: 's', turnId: 't', token: 'turn-token' }

  it('is refused with a turn token, and needs the launch token without one', () => {
    const host = stubHost()
    const refused = tierCheck('ask', METHODS.ask.tier, { v: 2, method: 'ask', params: { question: 'q' }, caller, token: 'test-token' }, host)
    expect(refused).toMatchObject({ code: 'refused', error: 'Settings can’t be changed from inside an agent turn.' })
    expect(tierCheck('ask', METHODS.ask.tier, { v: 2, method: 'ask', params: { question: 'q' }, caller }, host)).toMatchObject({ code: 'refused' })
    // A command with no launch token (or a version 1 caller's token-less request that carries a turn) can't reach the assistant either.
    expect(tierCheck('ask', METHODS.ask.tier, { v: 2, method: 'ask', params: { question: 'q' } }, host)).toMatchObject({ code: 'refused', hint: 'Reinstall it from Settings → Advanced.' })
    expect(tierCheck('ask', METHODS.ask.tier, { v: 2, method: 'ask', params: { question: 'q' }, token: 'test-token' }, host)).toBeNull()
  })
})

describe('ask: the command', () => {
  const spec = COMMANDS.find((c) => commandName(c) === 'ask')!

  it('is declared in the work group as admin, and the assistant may not run it', () => {
    expect(spec).toMatchObject({ group: 'work', tier: 'admin', noAssistant: 'it runs the assistant itself', summary: 'Ask Foreman about your workspaces and get a spoken-style answer' })
    expect(spec.args).toMatchObject([{ name: 'question', required: true, rest: true }])
    expect(Object.keys(spec.options)).toEqual(['workspace'])
    expect(Object.keys(spec.exitCodes ?? {})).toEqual(['0', '2', '3', '7'])
    const help = renderCommandHelp(spec)
    expect(help).toContain('Privacy mode')
    expect(help).toContain('Run it yourself')
  })

  it('takes the question as the words after it, and --workspace', () => {
    const planned = plan(['ask', 'what', 'needs', 'me?', '--workspace', '.'])
    expect(planned.kind).toBe('command')
    if (planned.kind !== 'command') return
    expect(parseCommandArgs(planned.spec, planned.args)).toMatchObject({ opts: { workspace: '.' }, positionals: ['what', 'needs', 'me?'] })
  })
})

describe('ask: what the command prints', () => {
  afterEach(() => {
    process.exitCode = undefined
    vi.restoreAllMocks()
  })

  function run(result: AskResult | Error, args: string[] = ['what', 'needs', 'me?'], options: { json?: boolean; opts?: Record<string, unknown> } = {}) {
    const out: string[] = []
    const err: string[] = []
    const sent: [string, unknown][] = []
    vi.spyOn(console, 'log').mockImplementation((text: unknown) => void out.push(String(text)))
    vi.spyOn(console, 'error').mockImplementation((text: unknown) => void err.push(String(text)))
    const ctx: Context = {
      args,
      opts: options.opts ?? {},
      json: Boolean(options.json),
      quiet: false,
      yes: false,
      cwd: '/here',
      send: async <T>(method: string, params?: unknown) => {
        sent.push([method, params])
        if (result instanceof Error) throw result
        return result as T
      },
      print: (value, text) => void out.push(options.json ? JSON.stringify(value, null, 2) : typeof text === 'function' ? text() : text),
      confirm: async () => true,
      note: (text) => void err.push(text),
      progress: (frame) => void err.push(frame.text)
    }
    return { done: workRunners.ask(ctx), out, err, sent }
  }

  it('prints the answer, then each proposal as “Proposed” and a line to run by hand', async () => {
    const { done, out, sent } = run({
      answer: 'Two things need you.',
      proposals: [
        { runId: 'r1', command: 'foreman approve 3f9a1c2', summary: 'Answer one approval request' },
        { runId: 'r2', command: 'foreman checks' }
      ]
    })
    await done
    expect(out.join('\n')).toBe(
      ['Two things need you.', '', 'Proposed: Answer one approval request', 'Run it yourself: foreman approve 3f9a1c2', '', 'Proposed: foreman checks', 'Run it yourself: foreman checks'].join('\n')
    )
    expect(sent).toEqual([['ask', { question: 'what needs me?', workspace: undefined, cwd: '/here' }]])
    expect(process.exitCode).toBeUndefined()
  })

  it('sends --workspace along', async () => {
    const { done, sent } = run({ answer: 'ok', proposals: [] }, ['q'], { opts: { workspace: '.' } })
    await done
    expect(sent[0][1]).toMatchObject({ question: 'q', workspace: '.' })
  })

  it('prints the object with --json', async () => {
    const result: AskResult = { answer: 'Fine.', proposals: [{ runId: 'r1', command: 'foreman status', summary: 'List' }] }
    const { done, out } = run(result, undefined, { json: true })
    await done
    expect(JSON.parse(out.join('\n'))).toEqual(result)
  })

  it('exits 2, with a note on stderr, when it timed out; the partial answer still prints', async () => {
    const { done, out, err } = run({ answer: 'Lisbon first.', proposals: [], timedOut: true })
    await done
    expect(out).toEqual(['Lisbon first.'])
    expect(err.join('\n')).toContain('still answering after two minutes')
    expect(process.exitCode).toBe(2)
  })

  it('exits 3 and says why on stderr when the assistant is off, in Privacy mode or signed out', async () => {
    const { done, out, err } = run({ answer: '', proposals: [], held: 'Privacy mode is on, so the assistant is off.' })
    await done
    expect(out).toEqual([])
    expect(err).toContain('foreman: Privacy mode is on, so the assistant is off.')
    expect(process.exitCode).toBe(3)
  })

  it('with --json, a held ask is an object with the reason, and exit 3', async () => {
    const { done, out, err } = run({ answer: '', proposals: [], held: 'The assistant is turned off in Settings › General.' }, undefined, { json: true })
    await done
    expect(JSON.parse(out.join('\n'))).toMatchObject({ held: 'The assistant is turned off in Settings › General.', proposals: [] })
    expect(err.join('\n')).not.toContain('foreman:')
    expect(process.exitCode).toBe(3)
  })

  it('needs a question', async () => {
    const { done, sent } = run({ answer: '', proposals: [] }, [])
    await expect(done).rejects.toMatchObject({ exitCode: 2 })
    expect(sent).toEqual([])
  })
})
