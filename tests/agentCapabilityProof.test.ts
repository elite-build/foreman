// Records are proven by fixtures (docs/agents.md, 9.4). For every agent that can hold a chat and every claim of its
// capability record that has an observable behaviour, a fixture scenario for THAT agent must exist, replay through the real
// adapter, and show the behaviour. An agent whose fixtures are simulated says so in its record, and one with recordings
// says that. A claim with no fixture is listed in UNPROVEN with the reason, and the list can only shrink: this fails when a
// listed claim turns out to be proven, and when an unlisted one isn't.
import { afterEach, describe, expect, it } from 'vitest'
import { driverFor } from '../src/main/agents/registry'
import type { TurnRequest } from '../src/main/agents/types'
import { fixtureFolder, hasFixture, readFixture, type Evidence, type Fixture } from '../src/main/agents/fixtures/format'
import type { ReplayHandle } from '../src/main/agents/fixtures/replayTransports'
import type { Ability, AgentCapabilities } from '../src/shared/agentCapabilities'
import { isFallback, offers } from '../src/shared/agentCapabilities'
import { CHAT_AGENT_IDS, FULL_AGENT_IDS, staticCapabilities } from '../src/shared/agentCatalog'
import { waitFor } from './helpers'
import { replay, type Played, type Replayed } from './replay/harness'

interface Claim {
  /** The record field, as the issue names it. */
  field: string
  /** The scenario whose fixture shows it. */
  scenario: string
  /** Whether this record claims it. */
  claimed: (record: AgentCapabilities) => boolean
  /** What the replay must show. */
  shows: (played: Played) => void
  /** Acts mid-turn, for a behaviour the person starts (a steer). */
  act?: (r: Replayed) => void
  /** What the turn the scenario was recorded as asked for besides its prompt (a thread to continue, a point to cut at); from the recording. */
  request?: (fixture: Fixture) => Partial<TurnRequest>
}

/** The thread a recorded turn resumed, and (Codex) the turn its history was cut back to: the second of the turns its listing held. */
const resumedFrom = (fixture: Fixture) => {
  const resume = fixture.frames.map((f) => f.data as { method?: string; params?: { threadId?: string } }).find((d) => d?.method === 'thread/resume')?.params?.threadId
  const turns = fixture.frames.map((f) => f.data as { result?: { data?: { id: string }[] } }).find((d) => d?.result?.data)?.result?.data
  return { resume: resume ?? 'a-session', point: turns?.[1]?.id ?? 'a-point' }
}

const native = (a: Ability) => a.level === 'native'
// A word the first of two recorded turns asked the agent to remember and the second replaced: said only by a conversation cut after the first.
const remembersFirst = (p: Played) => expect(p.find('assistant').map((a) => a.text.toLowerCase())).toEqual(['pineapple'])

const abilityClaimed = (a: Ability) => offers(a)

const CLAIMS: Claim[] = [
  {
    field: 'turns.steer',
    scenario: 'steer',
    claimed: (r) => native(r.turns.steer),
    act: ({ turn }) => expect(turn.steer('Actually, stop at 10.')).toBe(true),
    shows: (p) => expect(p.results).toEqual([{ ok: true }])
  },
  // Slice 4b: an agent that can't take a message mid-turn is interrupted and its conversation continued. The fallback is Foreman's, but it
  // rests on two things the agent does: it can be stopped (the `interrupt` fixture ends as stopped) and its session can be continued (the
  // `resume` fixture, proven by threads.resume above).
  {
    field: 'turns.steer (interrupt-restart)',
    scenario: 'interrupt',
    claimed: (r) => isFallback(r.turns.steer, 'interrupt-restart') && native(r.threads.resume),
    act: ({ turn }) => void turn.stop(),
    shows: (p) => expect(p.results).toEqual([{ ok: false, error: 'Stopped.' }])
  },
  { field: 'planning.planMode', scenario: 'plan', claimed: (r) => abilityClaimed(r.planning.planMode), shows: (p) => expect(p.plans.length).toBeGreaterThanOrEqual(1) },
  { field: 'planning.questions', scenario: 'question', claimed: (r) => abilityClaimed(r.planning.questions), shows: (p) => expect(p.questions.length).toBeGreaterThanOrEqual(1) },
  { field: 'approvals.tools', scenario: 'approval', claimed: (r) => abilityClaimed(r.approvals.tools), shows: (p) => expect(p.approvals.length).toBeGreaterThanOrEqual(1) },
  {
    field: 'threads.resume',
    scenario: 'resume',
    claimed: (r) => abilityClaimed(r.threads.resume),
    shows: (p) => {
      expect(p.sessions).toHaveLength(1)
      expect(p.results[0]).toMatchObject({ ok: true })
    }
  },
  {
    field: 'usage.cost',
    scenario: 'plain',
    claimed: (r) => r.usage.cost,
    shows: (p) => expect(p.find('result')[0]?.costUsd).toBeGreaterThan(0)
  },
  { field: 'usage.limitWindows', scenario: 'limit', claimed: (r) => r.usage.limitWindows, shows: (p) => expect(p.results[0]).toMatchObject({ ok: false }) },
  // Slice 4a: what the agent does itself for a fork, Restore, /compact and a goal. A fallback has nothing to record (it is Foreman's).
  {
    field: 'threads.fork',
    scenario: 'fork',
    claimed: (r) => native(r.threads.fork),
    request: () => ({ resume: 'a-session', resumeAt: 'a-point' }),
    shows: (p) => {
      remembersFirst(p)
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  {
    field: 'checkpointing.conversationRollback',
    scenario: 'revert',
    claimed: (r) => native(r.checkpointing.conversationRollback),
    request: (f) => ({ resume: resumedFrom(f).resume, resumeAt: resumedFrom(f).point, rewind: true }),
    shows: (p) => {
      remembersFirst(p)
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  {
    field: 'context.compact',
    scenario: 'compact',
    claimed: (r) => native(r.context.compact),
    request: () => ({ resume: 'a-session' }),
    shows: (p) => {
      expect(p.find('notice').flatMap((n) => (n.divider ? [n.divider.kind] : []))).toEqual(['compact'])
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  {
    field: 'planning.goals',
    scenario: 'goal',
    claimed: (r) => native(r.planning.goals),
    shows: (p) => {
      expect(p.goals.at(-1)?.status).toBe('complete')
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  // Slice 4b: the fallback is Foreman's (files back, a fresh session seeded with the chat: tests/restoreFreshSession.test.ts), and rests on the
  // agent starting a new conversation when none is continued: the plain turn opens one session and answers.
  {
    field: 'checkpointing.conversationRollback (checkpoint-fresh-session)',
    scenario: 'plain',
    claimed: (r) => isFallback(r.checkpointing.conversationRollback, 'checkpoint-fresh-session'),
    shows: (p) => {
      expect(p.sessions).toHaveLength(1)
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  // Slice 4b: OpenCode starts a server of its own for each turn, whatever its version (the fixture: the version declared, the server closed
  // with the turn; tests/acpServers.test.ts runs turns together).
  {
    field: 'sessions.concurrentChats (server-per-turn)',
    scenario: 'version1',
    claimed: (r) => isFallback(r.sessions.concurrentChats, 'server-per-turn'),
    shows: (p) => {
      expect(p.declared).toEqual([{ version: '1.14.3' }])
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  // Slice 4b: a Chat agent's always-allow is Foreman's, remembered for the session and named on the card.
  {
    field: 'approvals.alwaysAllow (session-always)',
    scenario: 'approval',
    claimed: (r) => isFallback(r.approvals.alwaysAllow, 'session-always'),
    shows: (p) => {
      expect(p.approvals[0]).toMatchObject({ toolName: 'Bash', alternate: 'always-allow', alwaysScope: 'npm test' })
    }
  },
  // Slice 4b: OpenCode's always-allow is answered once: the card it shows has no Always allow button.
  {
    field: 'approvals.alwaysAllow (once-always)',
    scenario: 'approval',
    claimed: (r) => isFallback(r.approvals.alwaysAllow, 'once-always'),
    shows: (p) => {
      expect(p.approvals.length).toBeGreaterThanOrEqual(1)
      expect(p.approvals.every((a) => a.alternate === undefined)).toBe(true)
    }
  },
  // Slice 4b: the commands an ACP agent asks Foreman to run, as piped processes; the replay really starts the recorded command.
  {
    field: 'tools.terminals',
    scenario: 'terminal',
    claimed: (r) => native(r.tools.terminals),
    shows: (p) => {
      expect(p.approvals).toHaveLength(1)
      expect(p.find('tool')[0]).toMatchObject({ name: 'Bash', status: 'done', output: '2\n' })
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  // Slice 5b: a flow persona's `writes`, held by the agent's own mechanism: Claude's PreToolUse hook, Codex's read-only sandbox with Foreman answering
  // each request. A write inside the globs goes through, the one outside is refused with words the agent reads, and nobody is asked.
  {
    field: 'enforcement.scopedWrites',
    scenario: 'scoped',
    claimed: (r) => native(r.enforcement.scopedWrites),
    shows: (p) => {
      expect(p.approvals).toEqual([])
      const tools = p.find('tool')
      expect(tools.filter((t) => t.name === 'Write' && t.status === 'done').length).toBeGreaterThanOrEqual(1)
      expect(tools.some((t) => t.status === 'error')).toBe(true)
      // The agent carried on from the refusal and said which of the two it could create.
      expect(p.find('assistant').at(-1)?.text).toMatch(/yes.txt/)
      expect(p.results).toEqual([{ ok: true }])
    }
  },
  { field: 'subagents.children', scenario: 'subagents', claimed: (r) => abilityClaimed(r.subagents.children), shows: (p) => expect(p.items.length).toBeGreaterThan(0) }
]

/**
 * Claims no fixture proves yet, `agent:field`, and why. Not a way round the test: each is a finding, reported with the
 * slice that builds the recording (or fixes the record).
 */
const UNPROVEN: Record<string, string> = {}

const chatAgents = [...FULL_AGENT_IDS, ...CHAT_AGENT_IDS] as string[]
let handle: ReplayHandle | undefined
afterEach(async () => {
  handle?.uninstall()
})

/** Replays the scenario through the agent's own driver and returns what the person saw. */
async function observe(agent: string, claim: Claim): Promise<Played> {
  const driver = driverFor(agent as never)
  const r = await replay(driver, fixtureFolder(agent) === 'acp' ? 'acp' : agent, claim.scenario, {}, claim.scenario === 'resume' ? { resume: 'a-session' } : claim.request && hasFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, claim.scenario) ? claim.request(readFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, claim.scenario)) : {})
  handle = r.handle
  if (claim.act) {
    await waitFor(() => expect(r.played.items.some((i) => i.kind === 'assistant')).toBe(true))
    claim.act(r)
  }
  await r.done
  expect(r.handle.warnings(), `${agent}/${claim.scenario} replayed without surprises`).toEqual([])
  return r.played
}

const fixtureOf = (agent: string, scenario: string) => readFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, scenario)

describe.each(chatAgents.map((id) => [id]))('capability record of %s is proven by its fixtures', (agent) => {
  const record = staticCapabilities(agent)!

  for (const claim of CLAIMS) {
    const key = `${agent}:${claim.field}`
    if (!claim.claimed(record)) continue
    if (UNPROVEN[key]) {
      it(`${claim.field}: claimed, and not yet proven (${UNPROVEN[key].slice(0, 60)}…)`, async () => {
        // Still unproven: its scenario has no fixture, or the replay doesn't show it.
        let proven = false
        if (hasFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, claim.scenario)) {
          try {
            claim.shows(await observe(agent, claim))
            proven = true
          } catch {
            proven = false
          }
        }
        expect(proven, `${key} is proven now: remove it from UNPROVEN`).toBe(false)
      })
      continue
    }
    it(`${claim.field}: a ${claim.scenario} fixture exists and shows it`, async () => {
      expect(hasFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, claim.scenario), `${agent} claims ${claim.field} but has no ${claim.scenario} fixture`).toBe(true)
      claim.shows(await observe(agent, claim))
    })
  }

  // A record that says no price is reported is held to it too: the plain turn carries no costUsd. (Not the ACP agents: the shared ACP fake
  // reports one, and whether a real ACP agent does is its own; their records say false for the ones not known to.)
  if (!record.usage.cost && fixtureFolder(agent) !== 'acp') {
    it('usage.cost: not claimed, and its plain fixture reports no cost', async () => {
      if (!hasFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, 'plain')) return
      const claim = CLAIMS.find((c) => c.field === 'usage.cost')!
      const played = await observe(agent, claim)
      expect(played.find('result').every((r) => r.costUsd === undefined)).toBe(true)
    })
  }

  it('says what it was tested against', () => {
    const scenarios = ['plain', 'approval', 'question', 'plan', 'steer', 'interrupt', 'limit', 'crash', 'resume', 'subagents', 'fork', 'revert', 'compact', 'goal', 'terminal']
    const evidence = new Set<Evidence>(scenarios.filter((s) => hasFixture(fixtureFolder(agent) === 'acp' ? 'acp' : agent, s)).map((s) => fixtureOf(agent, s).header.evidence))
    // Real traffic means every fixture is a recording (or the documented edit of one); anything simulated makes the record simulated.
    const real = evidence.has('recorded') && !evidence.has('simulated')
    expect(record.evidence).toBe(real ? 'recorded' : 'simulated')
  })
})

describe('the unproven list', () => {
  it('names only claims that exist', () => {
    for (const key of Object.keys(UNPROVEN)) {
      const [agent, field] = key.split(':')
      const claim = CLAIMS.find((c) => c.field === field)
      expect(claim, key).toBeDefined()
      expect(claim!.claimed(staticCapabilities(agent)!), `${key} is not claimed by the record any more`).toBe(true)
    }
  })
})
