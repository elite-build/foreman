// The development replay switch and the demo (docs/agents.md, 9.5): while the setting is on, Claude Code and Codex run
// through their own adapters over recorded traffic, picked by a word in the prompt, and say so in the chat.
import { afterEach, describe, expect, it } from 'vitest'
import { claudeDriver } from '../../src/main/agents/claude'
import { codexDriver } from '../../src/main/agents/codex'
import { configureReplay, replayAware, scenarioFor } from '../../src/main/agents/fixtures/replayDriver'
import { driverFor, registerDriver } from '../../src/main/agents/registry'
import { transportOverride } from '../../src/main/agents/transport'
import { registerDemoAgents } from '../../src/main/demoRun'
import { callbacks, request } from './harness'

afterEach(() => {
  configureReplay(undefined)
  registerDriver(replayAware(claudeDriver))
  registerDriver(replayAware(codexDriver))
})

function replayOn(initial = true) {
  const state = { on: initial }
  configureReplay({ enabled: () => state.on, root: process.cwd(), speed: 0, notice: () => 'Replaying a recording' })
  return state
}

async function chat(agent: 'claude' | 'codex', prompt: string) {
  const { cb, played } = callbacks()
  await driverFor(agent).createTurn(await request({ prompt }), cb).run()
  return played
}

describe('the replay switch', () => {
  it('picks a recording by a word in the prompt, plain otherwise', () => {
    expect(scenarioFor('Reply with a word')).toBe('plain')
    expect(scenarioFor('please ask for approval first')).toBe('approval')
    expect(scenarioFor('I have a Question')).toBe('question')
    expect(scenarioFor('make a plan')).toBe('plan')
    expect(scenarioFor('hit the limit')).toBe('limit')
    expect(scenarioFor('then crash')).toBe('crash')
    // Whole words only.
    expect(scenarioFor('explain planetary approvals')).toBe('plain')
  })

  it.each(['claude', 'codex'] as const)('plays %s from its recording, and says so on the turn', async (agent) => {
    replayOn()
    const played = await chat(agent, 'Say hello')
    expect(played.find('notice').map((n) => n.text)).toEqual(['Replaying a recording'])
    expect(played.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(played.results).toEqual([{ ok: true }])
  })

  it('plays what the word picks', async () => {
    replayOn()
    const approval = await chat('claude', 'do the approval one')
    expect(approval.approvals).toHaveLength(1)
    const question = await chat('claude', 'a question please')
    expect(question.questions).toHaveLength(1)
    const limit = await chat('claude', 'hit the limit')
    expect(limit.results[0]).toMatchObject({ ok: false, limit: { resetAt: expect.any(String) } })
    const crash = await chat('codex', 'now crash')
    expect(crash.results[0]).toMatchObject({ ok: false })
  })

  it('does nothing while it is off: no notice, and the seam hands the adapter no replay', async () => {
    const state = replayOn(false)
    const req = await request()
    expect(transportOverride('claude')?.(req)).toBeUndefined()
    expect(transportOverride('codex')?.(req)).toBeUndefined()
    const { cb, played } = callbacks()
    // Off, the driver is the real one: nothing before its own first item (it is not started here).
    const turn = driverFor('claude').createTurn(req, cb)
    expect(played.items).toEqual([])
    void turn.stop()
    state.on = true
    expect(transportOverride('claude')?.(req)).toBeDefined()
  })

  it('is not configured at all until main configures it: no override, no notice', async () => {
    expect(transportOverride('claude')).toBeUndefined()
    expect(transportOverride('codex')).toBeUndefined()
  })
})

describe('the demo', () => {
  it('plays a chat of the person\'s from a recording, and keeps the flow run\'s steps scripted', async () => {
    registerDemoAgents({ replayRoot: process.cwd() })
    configureReplay({ enabled: () => true, root: process.cwd(), speed: 0, notice: () => 'Replaying a recording' })
    const chatted = await chat('claude', 'Can you fix the login redirect?')
    expect(chatted.find('assistant').map((a) => a.text)).toEqual(['ok'])
    expect(chatted.find('notice')).toHaveLength(1)
    // The task the flow run starts with is a beat of the script, not a recording.
    const { cb, played } = callbacks()
    const turn = driverFor('claude').createTurn(await request({ prompt: 'Add a retry with backoff to the API client: retry a failed request up to 3 times, waiting 200 ms, then 400 ms, then 800 ms.' }), cb)
    const done = turn.run()
    await turn.stop()
    await done
    expect(played.find('assistant').map((a) => a.text).join('')).not.toBe('ok')
  })
})
