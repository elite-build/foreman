// ACP elicitation as the question card (docs/agents.md 3): a form's properties become questions and the person's answers go
// back as the values the schema asks for; the client advertises form elicitation only for an agent whose record offers
// questions; what Foreman can't show is declined, never left waiting.
import type * as acp from '@agentclientprotocol/sdk/unstable'
import { afterEach, describe, expect, it } from 'vitest'
import { createAcpDriver } from '../src/main/agents/acp'
import { elicitationQuestions, elicitationResponse } from '../src/main/agents/acp/elicitation'
import { acpFake, inProcessAcp } from '../src/main/agents/fixtures/fakes'
import { opencodeDriver } from '../src/main/agents/opencode'
import { replay } from './replay/harness'
import type { ReplayHandle } from '../src/main/agents/fixtures/replayTransports'
import { staticCapabilities } from '../src/shared/agentCatalog'
import type { Question } from '../src/shared/types'
import { callbacks, request } from './replay/harness'

let handle: ReplayHandle | undefined
afterEach(() => handle?.uninstall())

const form = (properties: Record<string, unknown>, extra: Record<string, unknown> = {}, message = 'Tell me') =>
  ({ sessionId: 's', mode: 'form', message, requestedSchema: { type: 'object', properties, ...extra } }) as unknown as acp.CreateElicitationRequest

describe('the form as questions', () => {
  it('maps a titled choice, a multi-select, a boolean and typed values to one question each', () => {
    const e = elicitationQuestions(
      form(
        {
          runner: { type: 'string', title: 'Runner', description: 'Which runner?', oneOf: [{ const: 'vitest', title: 'Vitest', description: 'fast' }, { const: 'jest', title: 'Jest' }] },
          suites: { type: 'array', title: 'Suites', items: { anyOf: [{ const: 'u', title: 'Unit' }, { const: 'e', title: 'End to end' }] } },
          watch: { type: 'boolean', title: 'Watch' },
          name: { type: 'string', title: 'Name' },
          workers: { type: 'integer', title: 'Workers' }
        },
        { required: ['runner'] }
      )
    )!
    expect(e.questions).toEqual([
      { question: 'Tell me\nWhich runner?', header: 'Runner', options: [{ label: 'Vitest', description: 'fast' }, { label: 'Jest' }] },
      { question: 'Suites', header: 'Suites', multiSelect: true, options: [{ label: 'Unit' }, { label: 'End to end' }] },
      { question: 'Watch', header: 'Watch', options: [{ label: 'Yes' }, { label: 'No' }] },
      { question: 'Name', header: 'Name', options: [] },
      { question: 'Workers', header: 'Workers', options: [] }
    ])
  })

  it('gives every question its own text, as the card keys answers by it', () => {
    const e = elicitationQuestions(form({ a: { type: 'string', description: 'Same' }, b: { type: 'string', description: 'Same' } }))!
    expect(new Set(e.questions.map((q) => q.question)).size).toBe(2)
  })

  it('shows nothing it can’t: a URL, an unknown property or an empty form', () => {
    expect(elicitationQuestions({ sessionId: 's', mode: 'url', message: 'Sign in', elicitationId: 'e', url: 'https://example.com' } as never)).toBeUndefined()
    expect(elicitationQuestions(form({ x: { type: 'object' } }))).toBeUndefined()
    expect(elicitationQuestions(form({}))).toBeUndefined()
  })
})

describe('the answers as values', () => {
  const schema = form(
    {
      runner: { type: 'string', oneOf: [{ const: 'vitest', title: 'Vitest' }, { const: 'jest', title: 'Jest' }] },
      suites: { type: 'array', items: { anyOf: [{ const: 'u', title: 'Unit' }, { const: 'e', title: 'End, to end' }] } },
      watch: { type: 'boolean' },
      workers: { type: 'integer' },
      ratio: { type: 'number' },
      note: { type: 'string' }
    },
    { required: ['runner'] }
  )
  const answer = (given: Record<string, string>) => {
    const e = elicitationQuestions(schema)!
    const named = (q: Question) => q.question
    const byKey = Object.fromEntries([...e.fields].map(([question, f]) => [f.key, question]))
    expect(e.questions.map(named)).toEqual(Object.values(byKey))
    return elicitationResponse(e, { kind: 'question', answers: Object.fromEntries(Object.entries(given).map(([k, v]) => [byKey[k], v])) })
  }

  it('turns labels back into the agent’s constants, with the types the schema names', () => {
    expect(answer({ runner: 'Jest', suites: 'Unit, End, to end', watch: 'No', workers: '4', ratio: '0.5', note: 'hello' })).toEqual({
      action: 'accept',
      content: { runner: 'jest', suites: ['u'], watch: false, workers: 4, ratio: 0.5, note: 'hello' }
    })
  })

  it('leaves out what the person left empty, and passes a typed choice as typed', () => {
    expect(answer({ runner: 'mocha', watch: '(no answer)' })).toEqual({ action: 'accept', content: { runner: 'mocha' } })
  })

  it('declines when a required property has no answer or a number isn’t one; skipping declines', () => {
    expect(answer({ watch: 'Yes' })).toEqual({ action: 'decline' })
    expect(answer({ runner: 'Jest', workers: 'many' })).toEqual({ action: 'accept', content: { runner: 'jest' } })
    const e = elicitationQuestions(schema)!
    expect(elicitationResponse(e, { kind: 'question', skipped: true })).toEqual({ action: 'decline' })
  })

  it('a required integer that isn’t one declines', () => {
    const e = elicitationQuestions(form({ n: { type: 'integer' } }, { required: ['n'] }))!
    expect(elicitationResponse(e, { kind: 'question', answers: { [e.questions[0].question]: '2.5' } })).toEqual({ action: 'decline' })
  })
})

describe('through the adapter', () => {
  it('shows the question card for an agent whose record offers it, and answers the agent with the chosen values', async () => {
    expect(staticCapabilities('opencode')!.planning.questions.level).toBe('native')
    const r = await replay(opencodeDriver, 'opencode', 'question', { answer: (qs) => ({ kind: 'question', answers: Object.fromEntries(qs.map((q) => [q.question, q.options[1]?.label ?? 'x'])) }) })
    handle = r.handle
    await r.done
    expect(r.played.questions).toHaveLength(1)
    expect(r.played.questions[0].map((q) => q.header)).toEqual(['Runner', 'Suites', 'Watch mode', 'Workers'])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('does not advertise elicitation for an agent whose record has no questions, so the agent never asks', async () => {
    expect(staticCapabilities('cursor')!.planning.questions.level).toBe('none')
    // The fake agent asks only if the client advertised it; Cursor's record says it doesn't show questions. (Cursor isn't an ACP
    // agent: the driver is built on its kind to read its record, as a Chat agent with a record like it would be.)
    const driver = createAcpDriver({ kind: 'cursor', label: 'Cursor', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(acpFake('question')) })
    const { cb, played } = callbacks()
    const turn = driver.createTurn(await request(), cb)
    await turn.run()
    expect(played.questions).toEqual([])
    expect(played.find('assistant').map((a) => a.text)).toEqual(['I can’t ask you, so I picked vitest.'])
  })

  it('declines a form it can’t show, and a cancelled turn cancels the question', async () => {
    const driver = createAcpDriver({ kind: 'gemini', label: 'Gemini', command: () => ({ file: 'unused', args: [] }), connect: inProcessAcp(acpFake('question')) })
    // The person never answers: stopping the turn cancels the card's wait, and the agent is told so.
    const { cb, played } = callbacks()
    cb.ask = (questions, signal) => {
      played.questions.push(questions)
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    }
    const turn = driver.createTurn(await request(), cb)
    const done = turn.run()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(played.questions).toHaveLength(1)
    await turn.stop()
    await done
    expect(played.results[0]).toMatchObject({ ok: false })
  })
})
