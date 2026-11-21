// OpenCode's recorded fixtures (src/main/agents/opencode/fixtures), real traffic of `opencode serve` on one of its free models,
// played through the real adapter at its seam (docs/agents.md, 9.4): the HTTP answers and the server's events, in order.
import { afterEach, describe, expect, it } from 'vitest'
import { opencodeDriver } from '../../src/main/agents/opencode'
import { OPENCODE_PLANS } from '../../src/main/agents/opencode/record'
import { hasFixture, readFixture, type Fixture } from '../../src/main/agents/fixtures/format'
import type { TurnRequest } from '../../src/main/agents/types'
import { waitFor } from '../helpers'
import { replay, type Person, type Replayed } from './harness'

let current: Replayed | undefined
afterEach(() => {
  current?.handle.uninstall()
})

/** What the recorded turn asked for: its prompt and mode, from the plan it was recorded with. */
function asRecorded(scenario: string, overrides: Partial<TurnRequest> = {}): Partial<TurnRequest> {
  const plan = OPENCODE_PLANS[scenario as keyof typeof OPENCODE_PLANS]!
  return { prompt: plan.prompt, planMode: Boolean(plan.planMode), approvals: plan.approvals, model: 'opencode/big-pickle', ...overrides }
}

async function play(scenario: string, person: Person = {}, overrides: Partial<TurnRequest> = {}): Promise<Replayed> {
  current = await replay(opencodeDriver, 'opencode', scenario, person, asRecorded(scenario, overrides))
  await current.done
  return current
}

/** The sends of a fixture, as `METHOD /path`. */
const sends = (fixture: Fixture) => fixture.frames.filter((f) => f.dir === 'send').map((f) => (f.data as { http?: string }).http ?? '')

/** The session a recording continued, and the message it was cut after (the one before the fork point or the first deletion). */
function cutPoint(fixture: Fixture): { resume: string; resumeAt: string } {
  const data = fixture.frames.filter((f) => f.dir === 'send').map((f) => f.data as { http?: string; body?: { messageID?: string } })
  const resume = data.map((d) => /^GET \/session\/([^/]+)$/.exec(d.http ?? '')?.[1]).find(Boolean)!
  const listed = fixture.frames.map((f) => (f.data as { body?: unknown }).body).find((b): b is { info: { id: string } }[] => Array.isArray(b) && Boolean(b[0]?.info))!
  const after = data.find((d) => d.http?.endsWith('/fork'))?.body?.messageID ?? data.filter((d) => d.http?.startsWith('DELETE ')).at(-1)!.http!.split('/').pop()
  return { resume, resumeAt: listed[listed.findIndex((m) => m.info.id === after) - 1].info.id }
}

describe('OpenCode fixtures', () => {
  it('are recordings of a real OpenCode, one per scenario it offers', () => {
    for (const scenario of Object.keys(OPENCODE_PLANS)) {
      expect(hasFixture('opencode', scenario), scenario).toBe(true)
      const { header } = readFixture('opencode', scenario)
      expect(header).toMatchObject({ agent: 'opencode', evidence: 'recorded', version: '1.19.6', model: 'opencode/big-pickle' })
    }
  })

  it('plain: the answer, the version, the usage and a session of its own; the server closes with the turn', async () => {
    const r = await play('plain')
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.played.declared).toEqual([{ version: '1.19.6' }])
    expect(r.played.sessions).toHaveLength(1)
    expect(r.played.find('assistant').map((a) => a.text.trim().toLowerCase())).toEqual(['ok'])
    expect(r.played.find('result')[0]).toMatchObject({ ok: true, costUsd: 0 })
    expect(r.played.usage.at(-1)).toMatchObject({ limit: 200_000 })
    expect(r.played.points).toHaveLength(1)
    // The events stream was open before the prompt went, and the server was closed when the turn ended.
    const order = sends(r.fixture)
    expect(order.indexOf('GET /event')).toBeLessThan(order.findIndex((s) => s.endsWith('/prompt_async')))
    expect(r.fixture.frames.at(-1)).toMatchObject({ dir: 'exit' })
    expect(r.handle.warnings()).toEqual([])
  })

  it('approval: OpenCode asks before a write and a command; the cards say what an allow covers', async () => {
    const r = await play('approval')
    expect(r.played.approvals.map((a) => a.toolName)).toEqual(['Write', 'Bash'])
    expect(r.played.approvals[0]).toMatchObject({ alternate: 'edits-for-session' })
    expect(r.played.approvals[1]).toMatchObject({ alternate: 'always-allow', alwaysRules: ['git status *'] })
    const tools = r.played.find('tool')
    expect(tools.find((t) => t.name === 'Write')).toMatchObject({ status: 'done' })
    expect(tools.find((t) => t.name === 'Bash')).toMatchObject({ status: 'done', exitCode: 0, input: { command: 'git status --short' } })
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('approval: a refusal is a reply of the same kind, so the recording still plays', async () => {
    const r = await play('approval', { approve: () => ({ allow: false, message: 'Not now' }) })
    expect(r.played.approvals).toHaveLength(2)
    expect(r.handle.engines[0].sent.filter((s) => (s as { http?: string }).http?.includes('/permission/')).map((s) => (s as { body?: unknown }).body)).toEqual([
      { reply: 'reject', message: 'Not now' },
      { reply: 'reject', message: 'Not now' }
    ])
  })

  it('approval: Always allow is a rule on the session (which a later turn reads) and an "always" reply', async () => {
    const r = await play('approval', { approve: (req) => ({ allow: true, ...(req.alternate === 'always-allow' ? { alternate: true } : {}) }) })
    const sent = r.handle.engines[0].sent as { http?: string; body?: Record<string, unknown> }[]
    expect(sent.find((s) => s.http?.startsWith('PATCH /session/'))?.body).toEqual({ permission: [{ permission: 'bash', pattern: 'git status *', action: 'allow' }] })
    expect(sent.filter((s) => s.http?.includes('/permission/')).map((s) => s.body?.reply)).toEqual(['once', 'always'])
  })

  it('question: OpenCode’s question tool is the question card, and the answer goes back as its option', async () => {
    const r = await play('question')
    expect(r.played.questions).toHaveLength(1)
    expect(r.played.questions[0][0]).toMatchObject({ question: expect.stringMatching(/tabs or spaces/i), options: [{ label: expect.any(String) }, { label: expect.any(String) }] })
    const reply = (r.handle.engines[0].sent as { http?: string; body?: { answers?: string[][] } }[]).find((s) => s.http?.endsWith('/reply') && s.http.includes('/question/'))
    expect(reply?.body?.answers).toEqual([[r.played.questions[0][0].options[0].label]])
    // The question tool's own row stays out of the chat: the card is the question.
    expect(r.played.find('tool').some((t) => t.name === 'question')).toBe(false)
    expect(r.played.results).toEqual([{ ok: true }])
  })

  it('plan: the plan agent plans, the person approves, and the build agent is told to implement it', async () => {
    const r = await play('plan', { answer: () => ({ kind: 'question', skipped: true }) })
    expect(r.played.plans).toHaveLength(1)
    expect(r.played.planModes).toEqual([false])
    const prompts = (r.handle.engines[0].sent as { http?: string; body?: { agent?: string; parts?: { text: string }[] } }[]).filter((s) => s.http?.endsWith('/prompt_async'))
    expect(prompts.map((p) => p.body?.agent)).toEqual(['plan', 'build'])
    expect(prompts[1].body?.parts?.[0].text).toBe('Implement the plan.')
    expect(r.played.results).toEqual([{ ok: true }])
  })

  it('steer: a message sent while it works goes into the same run', async () => {
    current = await replay(opencodeDriver, 'opencode', 'steer', {}, asRecorded('steer'))
    const r = current
    await waitFor(() => expect(r.played.items.some((i) => i.kind === 'thinking' || i.kind === 'tool' || i.kind === 'assistant')).toBe(true))
    expect(r.turn.steer('Actually, stop at 5.')).toBe(true)
    await r.done
    expect(r.played.find('assistant').at(-1)?.text.trim().split(/\s+/)).toEqual(['1', '2', '3', '4', '5'])
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('interrupt: Stop aborts the session and the turn ends as stopped', async () => {
    current = await replay(opencodeDriver, 'opencode', 'interrupt', {}, asRecorded('interrupt'))
    const r = current
    await waitFor(() => expect(r.played.items.some((i) => i.kind === 'tool')).toBe(true))
    await r.turn.stop()
    await r.done
    expect((r.handle.engines[0].sent as { http?: string }[]).some((s) => s.http?.endsWith('/abort'))).toBe(true)
    expect(r.played.results).toEqual([{ ok: false, error: 'Stopped.' }])
    expect(r.played.find('tool').find((t) => t.name === 'Bash')).toMatchObject({ status: 'error' })
  })

  it('crash: a server that goes away mid-turn fails the turn', async () => {
    const r = await play('crash')
    expect(r.played.results).toEqual([{ ok: false, error: 'The agent exited unexpectedly.' }])
    expect(r.played.find('notice').at(-1)).toMatchObject({ level: 'error', text: expect.stringContaining('exited unexpectedly') })
    // Nothing is left running in the chat.
    expect(r.played.find('tool').filter((t) => t.status === 'running')).toEqual([])
  })

  it('resume: a later turn’s server continues the session', async () => {
    const fixture = readFixture('opencode', 'resume')
    const resume = sends(fixture).map((s) => /^GET \/session\/([^/]+)$/.exec(s)?.[1]).find(Boolean)!
    const r = await play('resume', {}, { resume })
    expect(r.played.sessions).toEqual([resume])
    expect(r.played.find('assistant').at(-1)?.text.toLowerCase()).toContain('pineapple')
    expect(r.played.results).toEqual([{ ok: true }])
    expect(r.handle.warnings()).toEqual([])
  })

  it('fork: a new session holding the conversation up to the point, which remembers the first word', async () => {
    const fixture = readFixture('opencode', 'fork')
    const r = await play('fork', {}, cutPoint(fixture))
    expect(r.played.sessions).toHaveLength(1)
    expect(r.played.sessions[0]).not.toBe(cutPoint(fixture).resume)
    expect(r.played.find('assistant').at(-1)?.text.toLowerCase()).toContain('pineapple')
    expect(r.handle.warnings()).toEqual([])
  })

  it('revert: the same session with the later messages deleted, which remembers the first word', async () => {
    const fixture = readFixture('opencode', 'revert')
    const point = cutPoint(fixture)
    const r = await play('revert', {}, { ...point, rewind: true })
    expect(r.played.sessions).toEqual([point.resume])
    expect(sends(fixture).filter((s) => s.startsWith('DELETE ')).length).toBeGreaterThanOrEqual(2)
    expect(r.played.find('assistant').at(-1)?.text.toLowerCase()).toContain('pineapple')
    expect(r.handle.warnings()).toEqual([])
  })

  it('compact: /compact summarizes the session, shows the divider and no answer', async () => {
    const fixture = readFixture('opencode', 'compact')
    const resume = sends(fixture).map((s) => /^GET \/session\/([^/]+)$/.exec(s)?.[1]).find(Boolean)!
    const r = await play('compact', {}, { resume })
    expect(r.played.find('notice').flatMap((n) => (n.divider ? [n.divider.kind] : []))).toEqual(['compact'])
    // The summary is OpenCode's note to itself, not an answer.
    expect(r.played.find('assistant')).toEqual([])
    expect(r.played.results).toEqual([{ ok: true }])
  })

  it('subagents: the task tool is a Task row, and the child session’s calls sit under it', async () => {
    const r = await play('subagents')
    const task = r.played.find('tool').find((t) => t.name === 'Task')!
    expect(task).toMatchObject({ status: 'done', childId: expect.stringMatching(/^ses_/), task: { status: 'completed' } })
    const children = r.played.persisted().filter((i) => 'parentToolUseId' in i && i.parentToolUseId === task.id)
    expect(children.length).toBeGreaterThan(0)
    expect(children.some((c) => c.kind === 'thinking')).toBe(false)
    expect(r.played.results).toEqual([{ ok: true }])
  })
})
