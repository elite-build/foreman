// What the settings, repository settings and environment handlers share: the method shape, parameter checks and
// text columns. Nothing here knows about a particular setting.
import type { CliHost } from './host'
import { CliCodedError } from './host'
import type { CliContext } from './methods'
import type { Tier } from './policy'

/** One registry row: the tier and the handler (the same shape as methods.ts's). */
export interface MethodDef {
  tier: Tier
  handle(host: CliHost, params: unknown, ctx: CliContext): Promise<unknown>
}

/** Whether the request came from inside an agent turn (it carries a turn token). */
export const fromAgentTurn = (ctx: Pick<CliContext, 'caller'>): boolean => Boolean(ctx.caller?.token)

export const invalid = (message: string, hint?: string): CliCodedError => new CliCodedError('invalid', message, hint)

/** The parameters as an object (a method with none gets `undefined`). */
export function paramsObject(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) throw invalid('The request’s parameters must be an object.')
  return params as Record<string, unknown>
}

export function textParam(p: Record<string, unknown>, name: string, options: { optional: true }): string | undefined
export function textParam(p: Record<string, unknown>, name: string): string
export function textParam(p: Record<string, unknown>, name: string, options?: { optional: true }): string | undefined {
  const v = p[name]
  if (v === undefined || v === null) {
    if (options?.optional) return undefined
    throw invalid(`Missing ${name}.`)
  }
  if (typeof v !== 'string') throw invalid(`${name} must be text.`)
  return v
}

export function textList(p: Record<string, unknown>, name: string, options: { optional: true }): string[] | undefined
export function textList(p: Record<string, unknown>, name: string): string[]
export function textList(p: Record<string, unknown>, name: string, options?: { optional: true }): string[] | undefined {
  const v = p[name]
  if (v === undefined || v === null) {
    if (options?.optional) return undefined
    throw invalid(`Missing ${name}.`)
  }
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw invalid(`${name} must be a list of text.`)
  return v as string[]
}

export function flagParam(p: Record<string, unknown>, name: string): boolean {
  const v = p[name]
  if (v === undefined || v === null) return false
  if (typeof v !== 'boolean') throw invalid(`${name} must be true or false.`)
  return v
}

/** A whole number parameter, when given. */
export function numberParam(p: Record<string, unknown>, name: string): number | undefined {
  const v = p[name]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${name} must be a number.`)
  return v
}

/** Name/value pairs: `[["a", "b"], …]`. */
export function pairList(p: Record<string, unknown>, name: string): [string, string][] {
  const v = p[name]
  if (!Array.isArray(v) || v.some((x) => !Array.isArray(x) || x.length !== 2 || typeof x[0] !== 'string' || typeof x[1] !== 'string')) throw invalid(`${name} must be a list of [key, value] pairs.`)
  return v as [string, string][]
}

/** Lines of `cells`, each column padded to its widest cell (the last column is left as it is). */
export function columns(rows: string[][], gap = 2): string[] {
  const widths: number[] = []
  // A missing cell is an empty one, never a crash in the middle of a listing.
  const text = (cell: string | undefined) => cell ?? ''
  for (const row of rows) row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, text(cell).length)))
  return rows.map((row) => row.map((cell, i) => (i < row.length - 1 ? text(cell).padEnd(widths[i] + gap) : text(cell))).join('').trimEnd())
}

/** The last four characters of a secret, only when it is long enough that they don't give much away. */
export function hintOf(secret: string): string {
  return secret.length >= 12 ? secret.slice(-4) : ''
}

/** ` (…abcd)` for a secret that has a hint, else nothing. */
export function hintText(secret: string): string {
  const hint = hintOf(secret)
  return hint ? ` (…${hint})` : ''
}

/** Stored values are plain JSON, so this is how two of them are compared. */
export const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
