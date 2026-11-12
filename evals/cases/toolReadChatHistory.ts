import type { z } from 'zod'
import { READ_CHAT_HISTORY_TOOL } from '../../src/shared/foremanTools'
import { renderHandOff, type HandOffBuild } from '../../src/shared/chatHandOff'
import { appTools, callsTo, type ToolDefinition } from '../fakeApp'
import type { EvalCase, ToolCall } from '../types'

const AFTER: ToolDefinition = { description: READ_CHAT_HISTORY_TOOL.description, schema: READ_CHAT_HISTORY_TOOL.schema as unknown as z.ZodObject<z.ZodRawShape> }

/** What an agent switched into a chat is given: turns 4 and 5 condensed, turns 1 to 3 left out (the real renderer's text). */
const HAND_OFF = renderHandOff(
  {
    blocks: [
      { level: 'condensed', text: '### Turn 4 · Claude Code (Opus 5.5) · condensed\n**You:** Style the usage page with the new table component.\n**Claude Code (Opus 5.5):** Done: the usage page uses the shared Table, with the totals row pinned.' },
      { level: 'full', text: '### Turn 5 · Claude Code (Opus 5.5)\n**You:** Add a CSV export button to the usage page.\n**Claude Code (Opus 5.5):** Added an Export CSV button beside the date filter. It writes the visible rows only, and the filename is usage-<from>-<to>.csv.' }
    ],
    omitted: ['t-1', 't-2', 't-3'],
    omittedNumbers: [1, 2, 3]
  } as unknown as HandOffBuild,
  { reason: 'switch', canRead: true }
)

const TURN_2_TEXT = [
  '### Turn 2 · Claude Code (Opus 5.5)',
  '**You:** What schema should the usage rows have?',
  '**Claude Code (Opus 5.5):** We settled on `CREATE TABLE usage (day TEXT NOT NULL, agent TEXT NOT NULL, tokens INTEGER NOT NULL, PRIMARY KEY (day, agent))`.'
].join('\n')

/** Slice 6 of #172: the tool the hand-off text names for the turns it left out. */
export const toolReadChatHistory: EvalCase<ToolDefinition> = {
  id: 'tool-read-chat-history',
  title: 'An agent switched into a chat reads an omitted earlier turn, and only then',
  source: 'docs/agents.md 5.3 (#172 slice 6): a hand-off leaves out the oldest turns and names read_chat_history; the agent has to choose it when asked about one.',
  before: { none: 'read_chat_history is new in #172 slice 6 (171258a); before it a left-out turn could not be read at all.' },
  after: AFTER,
  build: (variant, scenario) => ({
    system: 'You are a coding agent in a Foreman chat. Foreman gave you its app tools.',
    prompt:
      HAND_OFF +
      (scenario === 'probe'
        ? 'Quote the exact SQL schema we settled on for the usage rows in turn 2.'
        : 'Which filename pattern does the CSV export use? Answer in one sentence.'),
    tools: appTools({
      overrides: { read_chat_history: variant },
      replies: { read_chat_history: () => TURN_2_TEXT }
    })
  }),
  check: (output, scenario) => {
    const calls = callsTo(output.calls, 'read_chat_history')
    if (scenario === 'control') {
      return calls.length ? { pass: false, reason: 'read the history for something already in the text it was given' } : { pass: true, reason: 'answered from the hand-off' }
    }
    if (!calls.length) return { pass: false, reason: 'answered without reading turn 2' }
    return calls.some(readsTurn2) ? { pass: true, reason: 'asked for turn 2' } : { pass: false, reason: `asked for other turns: ${JSON.stringify(calls.map((c) => c.args))}` }
  }
}

/** Whether a read_chat_history call selects turn 2: by `turns`, or by a `from`/`to` range that contains it. */
export function readsTurn2(call: ToolCall): boolean {
  const { turns, from, to } = call.args as { turns?: unknown; from?: unknown; to?: unknown }
  if (Array.isArray(turns) && turns.includes(2)) return true
  if (from === undefined && to === undefined) return false
  const lo = typeof from === 'number' ? from : 1
  const hi = typeof to === 'number' ? to : Number.POSITIVE_INFINITY
  return lo <= 2 && 2 <= hi
}
