// What the demo and the screenshot run start with: one list for both, so a pull request's screenshots show the data a
// person clicked through.
//   npm run dev demo [scenario] [--with <part,…>] [--without <part,…>]
//   npm run screens -- --scenario <name> [--with <part,…>] [--without <part,…>]
//   npm run pr:screens -- capture --scenario <name>
// The fixture itself is always there (main/screenshots.ts: atlas and beacon with their workspaces, a finished flow run, and
// Acme with Max, Ada and Lin's draft). A part adds to it: more data, seeded once (demoOrganization.ts, demoLumen.ts), or
// something that moves (demoRun.ts, demoEmployees.ts). A scenario names the parts an area needs, the screen the demo opens
// on and the screens a pull request takes of it.
//
// The list is scenarios.json, which the scripts read too (scripts/scenarios.mjs). To cover a new area: add its screens
// (renderer/src/screens.ts, main/screenshots.ts) and a scenario there naming them.
import list from './scenarios.json' with { type: 'json' }

export const DEMO_PARTS = ['team', 'lumen', 'usage', 'flows', 'channels'] as const
export type DemoPart = (typeof DEMO_PARTS)[number]

/** One line about each part, for `npm run dev demo list`. */
export const PART_ABOUT: Record<DemoPart, string> = list.parts

/** The parts that are data, written when the demo is seeded; the others start each launch. */
export const DATA_PARTS = list.dataParts as readonly DemoPart[]

export interface Scenario {
  about: string
  parts: readonly DemoPart[]
  /** The screen the demo opens on (a name in renderer/src/screens.ts); Home without one. */
  open?: string
  /** The screens a pull request takes of this area, when `--only` names none. Empty: every screen. */
  screens: readonly string[]
}

export const SCENARIOS = list.scenarios as Record<string, Scenario>
export const SCENARIO_NAMES = Object.keys(SCENARIOS)

export interface Resolved {
  /** The scenario asked for; undefined when only parts were named. */
  name?: string
  parts: DemoPart[]
  open?: string
  screens: readonly string[]
}

const names = (text: string | undefined): string[] => (text ?? '').split(',').map((s) => s.trim()).filter(Boolean)

/**
 * A scenario with its parts adjusted. `name` is a scenario, or nothing for `fallback` (the demo: `full`; a screenshot run:
 * none, the fixture alone). The channels are Acme's team's and Lumen's, so asking for them without either adds the team.
 */
export function resolveScenario(input: { name?: string; with?: string; without?: string }, fallback?: string): Resolved | { problems: string[] } {
  const problems: string[] = []
  const asked = input.name?.trim() || fallback
  if (asked && !Object.hasOwn(SCENARIOS, asked)) problems.push(`No scenario called "${asked}". There are: ${SCENARIO_NAMES.join(', ')}.`)
  const unknown = [...names(input.with), ...names(input.without)].filter((p) => !(DEMO_PARTS as readonly string[]).includes(p))
  if (unknown.length) problems.push(`No part called ${unknown.map((p) => `"${p}"`).join(', ')}. There are: ${DEMO_PARTS.join(', ')}.`)
  if (problems.length) return { problems }
  const scenario = asked ? SCENARIOS[asked] : undefined
  const without = new Set(names(input.without))
  const wanted = new Set<string>([...(scenario?.parts ?? []), ...names(input.with)].filter((p) => !without.has(p)))
  if (wanted.has('channels') && !wanted.has('team') && !wanted.has('lumen')) {
    if (without.has('team')) return { problems: ['The channels are Acme’s team’s and Lumen’s: keep "team" or "lumen" with "channels".'] }
    wanted.add('team')
  }
  return { name: asked, parts: DEMO_PARTS.filter((p) => wanted.has(p)), open: scenario?.open, screens: scenario?.screens ?? [] }
}

/** What the scripts hand the app (scripts/dev.mjs, scripts/screenshots.mjs). */
export function scenarioFromEnv(env: Record<string, string | undefined>, fallback?: string): Resolved | { problems: string[] } {
  return resolveScenario({ name: env.FOREMAN_SCENARIO, with: env.FOREMAN_SCENARIO_WITH, without: env.FOREMAN_SCENARIO_WITHOUT }, fallback)
}
