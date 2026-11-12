// The `foreman-app` tools as the model sees them, answering from canned data. Names, descriptions and schemas come from
// the app's own catalogues (src/shared), so an eval offers what a turn is offered; only the replies are made up.
import type { z } from 'zod'
import { DELEGATION_TOOLS, delegationToolNames, type DelegationToolName } from '../src/shared/foremanDelegation'
import { FOREMAN_TOOLS, READ_CHAT_HISTORY_TOOL, type ForemanToolName } from '../src/shared/foremanTools'
import type { FakeTool } from './types'

/** The name the app gives the server (src/main/foremanMcp.ts); the model sees its tools as mcp__foreman-app__<name>. */
export const APP_SERVER = 'foreman-app'

/** A tool's text as the app registers it: its description and the shape of its arguments. */
export interface ToolDefinition {
  description: string
  schema: z.ZodObject<z.ZodRawShape>
}

type Reply = FakeTool['reply']

const json = (value: unknown) => JSON.stringify(value)

/** Answers for the tools a case isn't scripting. */
const DEFAULT_REPLIES: Record<string, Reply> = {
  list_delegation_options: () =>
    json({
      loadouts: [
        { slot: 1, agent: 'claude', model: 'claude-fable-5-1', label: 'Fable 5.1' },
        { slot: 2, agent: 'claude', model: 'claude-opus-5-5', label: 'Opus 5.5' },
        { slot: 3, agent: 'codex', model: 'gpt-6-astra', label: 'Codex' }
      ],
      repos: [{ id: 'repo-1', name: 'widgets' }],
      workspaces: [{ id: 'ws-12', name: 'johnson', chats: [{ sessionId: 's-1', turns: ['t-1'] }] }],
      flows: [{ id: 'flow-build', name: 'Build a feature', inputs: ['task'] }]
    }),
  get_task_status: () => json({ workspaceId: 'ws-41', setup: 'ready', chats: [{ sessionId: 's-41', turns: [{ turnId: 't-77', state: 'running' }] }] }),
  get_flow_status: () => json({ run: { id: 'run-8f21', state: 'running', step: 'review', iteration: 2, waiting: null } }),
  get_turn_result: () => json({ turnId: 't-77', state: 'ended', outcome: 'completed', reply: 'Added the CSV export button and its test.' }),
  wait_for_turn: () => json({ turnId: 't-77', state: 'ended', outcome: 'completed' }),
  start_task: () => json({ workspaceId: 'ws-41', setup: 'running', note: 'Use get_task_status to find the first turn.' }),
  send_task: () => json({ turnId: 't-90', state: 'queued' }),
  cancel_turn: () => json({ state: 'ended', outcome: 'cancelled' }),
  start_flow: () => json({ runId: 'run-8f21', state: 'starting' }),
  get_workspace_status: () => json({ workspaceId: 'ws-12', state: 'ready', chats: [{ sessionId: 's-1', state: 'idle' }] }),
  get_check_results: () => json({ checks: [{ name: 'typecheck', state: 'passed' }], stale: false }),
  open_preview: () => json({ proposed: true }),
  run_checks: () => json({ proposed: true }),
  read_chat_history: () => 'No turns selected.'
}

/**
 * The tools of a turn that has `foreman-app` with delegation, flows and `read_chat_history` on. `overrides` replaces a
 * tool's description or schema (an earlier version of it); `replies` scripts what a tool answers in this run.
 */
export function appTools(options: { overrides?: Partial<Record<string, ToolDefinition>>; replies?: Partial<Record<string, Reply>> } = {}): FakeTool[] {
  const { overrides = {}, replies = {} } = options
  const reply = (name: string): Reply => replies[name] ?? DEFAULT_REPLIES[name] ?? (() => json({ ok: true }))
  const delegation = delegationToolNames(true).map((name: DelegationToolName): FakeTool => {
    const definition = overrides[name] ?? currentDefinition(name)
    return { name, description: definition.description, schema: definition.schema.shape, reply: reply(name) }
  })
  const app = (Object.keys(FOREMAN_TOOLS) as ForemanToolName[]).map((name): FakeTool => ({ name, description: FOREMAN_TOOLS[name].description, schema: {}, reply: reply(name) }))
  const history: FakeTool = {
    name: READ_CHAT_HISTORY_TOOL.name,
    description: READ_CHAT_HISTORY_TOOL.description,
    schema: (READ_CHAT_HISTORY_TOOL.schema as unknown as z.ZodObject<z.ZodRawShape>).shape,
    reply: reply(READ_CHAT_HISTORY_TOOL.name)
  }
  return [...delegation, ...app, history]
}

/** A delegation tool's current text. */
export function currentDefinition(name: DelegationToolName): ToolDefinition {
  return { description: DELEGATION_TOOLS[name].description, schema: DELEGATION_TOOLS[name].schema as unknown as z.ZodObject<z.ZodRawShape> }
}

/** The calls named `name` in a run. */
export function callsTo<T extends { name: string }>(calls: T[], name: string): T[] {
  return calls.filter((c) => c.name === name)
}
