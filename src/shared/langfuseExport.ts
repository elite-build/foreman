// Sending Foreman's own traces to Langfuse (docs/telemetry.md, "Langfuse"): each turn as a trace with its model calls,
// tokens, cost and tool calls, and Foreman's stalls and errors as events. Off unless the person at this computer's
// window picks a Langfuse connection for it; nothing is built in, so no copy of Foreman sends anywhere by itself.

/** What a turn used, in buckets that don't overlap: `input` leaves out cache reads and writes; `output` includes reasoning. */
export interface TokenCounts {
  input: number
  output: number
  cacheRead?: number
  cacheWrite?: number
  // The part of `output` spent reasoning, when the agent says.
  reasoning?: number
}

/**
 * The choice, kept in state.json beside the integrations but never in Settings, so Git backup, export and import leave it
 * out. `machine` is the computer it was turned on at: a data folder copied to another computer comes with it off there.
 */
export interface LangfuseExportConfig {
  connectionId: string
  // Prompts, answers and tool inputs and outputs go too. Off: names, times, tokens and costs only.
  content: boolean
  machine: string
  enabledAt: string
}

export interface LangfuseExportStatus {
  // The Langfuse connection it sends to; null when off (or turned on at another computer).
  connectionId: string | null
  content: boolean
  // Turned on at another computer, whose data folder this is a copy of: off here until turned on again.
  otherMachine?: string
  enabledAt?: string
  // How this computer shows in Langfuse: its user, and the device id in each trace's metadata.
  device: { id: string; name: string }
  lastSentAt?: string
  lastError?: string
  // Since Foreman started.
  sentTurns: number
  sentEvents: number
  // Sending earlier turns now, from `days` ago.
  backfill?: { days: number; done: number; total: number }
}

export interface LangfuseExportChoice {
  connectionId: string | null
  content: boolean
}

export const BACKFILL_DAYS = [7, 30, 90] as const
