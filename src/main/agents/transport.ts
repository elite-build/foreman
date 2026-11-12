// The seam where an agent's traffic can be recorded or replayed (docs/agents.md, section 9). Each adapter starts its
// agent through ONE call that reads an override from here first; with none set (always, in production) it starts the
// real thing exactly as before. The recorder sets an override that tees the real process's traffic into a fixture,
// and ReplayTransport (fixtures/replayTransports.ts) sets one that stands in for the process and plays a fixture back.
//
// An override is a function of the turn's request, so a replay can choose its fixture by the prompt. It may return
// undefined for "not this turn": the adapter then starts the real agent.
import type { fork, spawn } from 'node:child_process'
import type { AgentKind } from '../../shared/agents'
import type { AcpConnector } from './acp'
import type { AppServerFactory } from './codex/appServer'
import type { TurnRequest } from './types'

/** `child_process.spawn`'s shape: what Claude Code's launch (`trackedClaudeSpawn`) starts the CLI with. */
export type ProcessStarter = typeof spawn

/** An app-server opener that needs no `codex` binary on this computer (a replay), so the adapter doesn't look for one. */
export type CodexOpener = AppServerFactory & { standsIn?: boolean }

/** A worker starter; `standsIn` skips the check for the built Cursor worker (a replay has no worker to run). */
export type CursorForker = typeof fork & { standsIn?: boolean }

export interface TransportOverrides {
  /** Claude Code: the CLI process, below the Agent SDK (its stream-json lines and control protocol on stdio). */
  claude?: (req: TurnRequest) => ProcessStarter | undefined
  /** Codex: the `codex app-server` process (JSON-RPC lines on stdio). */
  codex?: (req: TurnRequest) => CodexOpener | undefined
  /** ACP agents (OpenCode and the catalog's chat agents): the connection to the agent. */
  acp?: (agent: AgentKind, req: TurnRequest) => AcpConnector | undefined
  /** Cursor: the worker process a turn runs in (its IPC events). */
  cursor?: (req: TurnRequest) => CursorForker | undefined
}

const overrides: TransportOverrides = {}

/** Sets (or, with undefined, clears) an agent's override. Returns a function that puts the previous one back. */
export function setTransportOverride<K extends keyof TransportOverrides>(agent: K, factory: TransportOverrides[K] | undefined): () => void {
  const previous = overrides[agent]
  if (factory) overrides[agent] = factory
  else delete overrides[agent]
  return () => {
    if (previous) overrides[agent] = previous
    else delete overrides[agent]
  }
}

/** The override an adapter should start its agent through, if any. */
export function transportOverride<K extends keyof TransportOverrides>(agent: K): TransportOverrides[K] | undefined {
  return overrides[agent]
}
