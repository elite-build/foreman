// What every replay test uses (docs/agents.md, 9.3): a fixture played through the real driver at the transport seam,
// with a person who answers as the test says.
import type { AgentDriver, ToolApprovalRequest, TurnCallbacks, TurnRequest, TurnResult } from '../../src/main/agents/types'
import { readFixture, type Fixture } from '../../src/main/agents/fixtures/format'
import { replayTransport, type ReplayHandle } from '../../src/main/agents/fixtures/replayTransports'
import type { ApprovalResponse, ChatItem, ContextUsage, Question, SessionGoal } from '../../src/shared/types'
import { CLAUDE_PLANS } from '../../src/main/agents/claude/record'
import { CODEX_PLANS } from '../../src/main/agents/codex/record'
import type { Plan } from '../../src/main/agents/fixtures/recorder'
import { makeRepo } from '../helpers'

const PLANS: Record<string, Partial<Record<string, Plan>>> = { claude: CLAUDE_PLANS, codex: CODEX_PLANS }

export interface Person {
  /** Answers a tool approval (default: allow). */
  approve?: (request: ToolApprovalRequest) => Omit<Extract<ApprovalResponse, { kind: 'tool' }>, 'kind'>
  /** Answers a question (default: the first option of each). */
  answer?: (questions: Question[]) => Extract<ApprovalResponse, { kind: 'question' }>
  /** Answers a plan (default: approve). */
  plan?: (plan: string) => Omit<Extract<ApprovalResponse, { kind: 'plan' }>, 'kind'>
}

export interface Played {
  items: ChatItem[]
  persisted: () => ChatItem[]
  approvals: ToolApprovalRequest[]
  questions: Question[][]
  plans: string[]
  sessions: string[]
  usage: ContextUsage[]
  results: TurnResult[]
  planModes: boolean[]
  // The points the agent reported the conversation stood at (assistantMessage), in order.
  points: string[]
  // The goal as the agent reported it, in order (null: cleared).
  goals: (SessionGoal | null)[]
  // The prompt cache the turn left, when the agent said.
  caches: { ttl: '5m' | '1h'; warm: boolean }[]
  // What the agent declared about itself when the turn started (its version).
  declared: import('../../src/shared/agentCapabilities').DeclaredFacts[]
  cwd: string
  find: <K extends ChatItem['kind']>(kind: K) => Extract<ChatItem, { kind: K }>[]
}

export function callbacks(person: Person = {}): { cb: TurnCallbacks; played: Played } {
  const items: { item: ChatItem; transient: boolean }[] = []
  const played: Played = {
    items: [],
    persisted: () => {
      // The chat as persisted: the last non-transient version of each item, in first-seen order.
      const byId = new Map<string, ChatItem>()
      for (const { item, transient } of items) if (!transient) byId.set(item.id, item)
      return [...byId.values()]
    },
    approvals: [],
    questions: [],
    plans: [],
    sessions: [],
    usage: [],
    results: [],
    planModes: [],
    points: [],
    goals: [],
    caches: [],
    declared: [],
    cwd: '',
    find: (kind) => played.persisted().filter((i): i is Extract<ChatItem, { kind: typeof kind }> => i.kind === kind)
  }
  const cb: TurnCallbacks = {
    item: (item, transient) => {
      items.push({ item, transient: Boolean(transient) })
      played.items.push(item)
    },
    sessionStarted: (id) => void played.sessions.push(id),
    assistantMessage: (uuid) => void played.points.push(uuid),
    approveTool: async (req) => {
      played.approvals.push(req)
      return { kind: 'tool', ...(person.approve?.(req) ?? { allow: true }) }
    },
    reviewPlan: async (plan) => {
      played.plans.push(plan)
      return { kind: 'plan', ...(person.plan?.(plan) ?? { approve: true }) }
    },
    ask: async (questions) => {
      played.questions.push(questions)
      return person.answer?.(questions) ?? { kind: 'question', answers: Object.fromEntries(questions.map((q) => [q.question, q.options[0]?.label ?? ''])) }
    },
    planModeChanged: (on) => void played.planModes.push(on),
    autoAcceptEdits: () => {},
    usage: (u) => void played.usage.push(u),
    goal: (g) => void played.goals.push(g),
    cacheWindow: (c) => void played.caches.push(c),
    declared: (facts) => void played.declared.push(facts),
    finished: (r) => void played.results.push(r)
  }
  return { cb, played }
}

export async function request(overrides: Partial<TurnRequest> = {}): Promise<TurnRequest> {
  return {
    turnId: 'turn-1',
    prompt: 'Hello',
    cwd: await makeRepo(),
    env: {},
    model: '',
    fastMode: false,
    planMode: false,
    approvals: 'ask',
    systemPromptAppend: '',
    ...overrides
  }
}

export interface Replayed {
  played: Played
  handle: ReplayHandle
  turn: ReturnType<AgentDriver['createTurn']>
  /** Runs to the end. */
  done: Promise<void>
  fixture: Fixture
}

/**
 * Starts a turn of `driver` over the `agent`/`scenario` fixture (instant, as tests play). `start` is for a test that
 * acts mid-turn; most just `await replayed.done`. Call `handle.uninstall()` afterwards (afterEach).
 */
export async function replay(driver: AgentDriver, agent: string, scenario: string, person: Person = {}, overrides: Partial<TurnRequest> = {}): Promise<Replayed> {
  const fixture = readFixture(agent, scenario)
  const handle = replayTransport(agent, fixture, { speed: 0 })
  const { cb, played } = callbacks(person)
  // The turn the recording was made of: its prompt and its mode (Codex plans only in plan mode).
  const plan = PLANS[agent]?.[scenario]
  const req = await request({ ...(plan ? { prompt: plan.prompt, planMode: Boolean(plan.planMode), approvals: plan.approvals, ...(plan.writes ? { writeScope: plan.writes } : {}) } : {}), ...overrides })
  played.cwd = req.cwd
  const turn = driver.createTurn(req, cb)
  return { played, handle, turn, done: turn.run(), fixture }
}
