// What Foreman knows about an agent's versions (docs/agents.md, 4.1), as data in the agent's catalog file, and the pure
// functions that read it. Only facts: `tested` is what the fixtures were recorded with, `minimum` is set by hand from the
// methods the adapter calls, breakages are added as they are found. A version nobody has written down is `untested`, never
// guessed to be fine or broken. Pure: main, the renderer and the CLI share it.
import { catalogAgent } from './agentCatalog'
import type { PlainKey } from './i18n'

export interface VersionTable {
  // Versions fixtures were recorded with (tests/agentVersions.test.ts holds this equal to the fixture headers).
  tested: string[]
  // The oldest version with every method the adapter calls. Set by hand, only from evidence; absent where there is none.
  minimum?: string
  // Works, with something lost: `below` a version, or inside a `range` (">=1.2.0 <1.4.0"); `why` says what.
  degraded?: { below?: string; range?: string; why: PlainKey }[]
  // Doesn't work: a launch refuses to go on.
  broken?: { range: string; why: PlainKey }[]
  // Model id -> the oldest CLI version that has it, only where the agent reports it itself.
  models?: Record<string, string>
  // The agent's own update command (arguments after its program), read from its `--help`.
  update?: { args: string[] }
}

export type VersionStatus = 'tested' | 'untested' | 'degraded' | 'broken'

type Triple = [number, number, number]

/** "2.1.301", "v2.1.301 (Claude Code)", "codex-cli 0.163.0" → [2, 1, 301]; undefined when no x.y.z is in it. */
export function parseVersion(text: string | undefined): Triple | undefined {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined
}

/** Negative, zero or positive like a comparator; undefined when either has no x.y.z. */
export function compareVersions(a: string | undefined, b: string | undefined): number | undefined {
  const [x, y] = [parseVersion(a), parseVersion(b)]
  if (!x || !y) return undefined
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]
  return 0
}

/** Whether `version` is older than `minimum`. Unreadable versions are not "older": nothing is claimed about them. */
export function olderThan(version: string | undefined, minimum: string): boolean {
  const c = compareVersions(version, minimum)
  return c !== undefined && c < 0
}

/** `range` is comparators joined by spaces: ">=1.2.0 <1.4.0", "<2.0.0", "1.3.1" (exactly). All must hold. */
export function inRange(version: string | undefined, range: string): boolean {
  if (!parseVersion(version)) return false
  return range
    .split(/\s+/)
    .filter(Boolean)
    .every((part) => {
      const [, op, bound] = /^(>=|<=|>|<|=)?(.+)$/.exec(part) ?? []
      const c = compareVersions(version, bound)
      if (c === undefined) return false
      switch (op) {
        case '>=':
          return c >= 0
        case '<=':
          return c <= 0
        case '>':
          return c > 0
        case '<':
          return c < 0
        default:
          return c === 0
      }
    })
}

/** The first thing wrong with `version` in the table: a broken range, or a version older than `minimum`. */
export function brokenReason(table: VersionTable | undefined, version: string | undefined): { why?: PlainKey; below?: string } | undefined {
  if (!table || !parseVersion(version)) return undefined
  const range = table.broken?.find((b) => inRange(version, b.range))
  if (range) return { why: range.why }
  if (table.minimum && olderThan(version, table.minimum)) return { below: table.minimum }
  return undefined
}

export function degradedReason(table: VersionTable | undefined, version: string | undefined): PlainKey | undefined {
  if (!table || !parseVersion(version)) return undefined
  return table.degraded?.find((d) => (d.below !== undefined && olderThan(version, d.below)) || (d.range !== undefined && inRange(version, d.range)))?.why
}

/** The status of one version against a table. Broken beats degraded beats tested; anything not written down is untested. */
export function statusOf(table: VersionTable | undefined, version: string | undefined): VersionStatus {
  if (!table || !parseVersion(version)) return 'untested'
  if (brokenReason(table, version)) return 'broken'
  if (degradedReason(table, version)) return 'degraded'
  return table.tested.some((t) => compareVersions(t, version) === 0) ? 'tested' : 'untested'
}

/** `versionStatus('codex', '0.163.0')` → 'tested'. An agent with no table, or a version that can't be read, is untested. */
export function versionStatus(agent: string, version: string | undefined): VersionStatus {
  return statusOf(catalogAgent(agent)?.versions, version)
}

/** The oldest CLI version that has `model`, when the agent reported it (the table's `models`); undefined when not known. */
export function modelMinimum(agent: string, model: string): string | undefined {
  return catalogAgent(agent)?.versions?.models?.[model]
}

/** The version Foreman recorded the agent's fixtures with (the newest `tested` one), for the Capabilities evidence line. */
export function testedVersion(agent: string): string | undefined {
  const tested = catalogAgent(agent)?.versions?.tested ?? []
  return [...tested].sort((a, b) => compareVersions(b, a) ?? 0)[0]
}

/** The agent's own update command's arguments, where the table has one. */
export function updateArgs(agent: string): string[] | undefined {
  return catalogAgent(agent)?.versions?.update?.args
}
