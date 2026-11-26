// What the demo and a screenshot run start with (src/shared/scenarios.ts): a scenario resolves to its parts, and names
// only screens the screenshot run can take.
import { describe, expect, it, vi } from 'vitest'
import { DATA_PARTS, DEMO_PARTS, PART_ABOUT, resolveScenario, scenarioFromEnv, SCENARIOS, SCENARIO_NAMES } from '../src/shared/scenarios'
import { CHANNEL_SCREENS, SCREENS } from '../src/main/screenshots'
import { knowsScenario } from '../scripts/pr-screens.mjs'
import { scenarioNames, scenariosText } from '../scripts/scenarios.mjs'
import { tempDir } from './helpers'

// screenshots.ts reads nativeTheme only while it captures.
vi.mock('electron', () => ({ nativeTheme: {} }))

describe('demo scenarios', () => {
  it('starts the demo on everything unless a scenario is named, and a screenshot run on the fixture alone', () => {
    expect(resolveScenario({}, 'full')).toMatchObject({ name: 'full', parts: [...DEMO_PARTS] })
    expect(resolveScenario({})).toEqual({ name: undefined, parts: [], open: undefined, screens: [] })
    expect(scenarioFromEnv({ FOREMAN_SCENARIO: 'channels' })).toMatchObject({ name: 'channels', parts: ['team', 'lumen', 'channels'], open: 'channels' })
  })

  it('adds and leaves out parts, in the list’s own order', () => {
    expect(resolveScenario({ name: 'full', without: 'lumen, flows' })).toMatchObject({ parts: ['team', 'usage', 'channels'] })
    expect(resolveScenario({ name: 'hire-employee', with: 'usage,team' })).toMatchObject({ parts: ['team', 'usage'], open: 'new-employee' })
    // Leaving a part out wins over a scenario that has it.
    expect(resolveScenario({ name: 'channels', with: 'usage', without: 'lumen' })).toMatchObject({ parts: ['team', 'usage', 'channels'] })
  })

  it('gives the channels a team to move them, and refuses them with neither', () => {
    expect(resolveScenario({ with: 'channels' })).toMatchObject({ parts: ['team', 'channels'] })
    expect(resolveScenario({ with: 'channels,lumen' })).toMatchObject({ parts: ['lumen', 'channels'] })
    expect(resolveScenario({ with: 'channels', without: 'team' })).toEqual({ problems: [expect.stringContaining('keep "team" or "lumen"')] })
  })

  it('names what it doesn’t know, with what there is', () => {
    expect(resolveScenario({ name: 'chanels' })).toEqual({ problems: [expect.stringMatching(/No scenario called "chanels".*channels/)] })
    expect(resolveScenario({ name: 'full', with: 'teem', without: 'lumen' })).toEqual({ problems: [expect.stringMatching(/No part called "teem".*team/)] })
    // A name from Object's own prototype is not a scenario.
    expect(resolveScenario({ name: 'toString' })).toHaveProperty('problems')
  })

  it('lists only parts and screens there are', () => {
    expect(Object.keys(PART_ABOUT)).toEqual([...DEMO_PARTS])
    for (const part of DATA_PARTS) expect(DEMO_PARTS).toContain(part)
    const screens: readonly string[] = [...SCREENS, ...CHANNEL_SCREENS]
    for (const name of SCENARIO_NAMES) {
      const scenario = SCENARIOS[name]
      for (const part of scenario.parts) expect(DEMO_PARTS, `${name}'s part ${part}`).toContain(part)
      for (const screen of [...scenario.screens, ...(scenario.open ? [scenario.open] : [])]) expect(screens, `${name}'s screen ${screen}`).toContain(screen)
      // A screen of a channel at a stage is taken only by a run that plays the channels.
      if (scenario.screens.some((s) => (CHANNEL_SCREENS as readonly string[]).includes(s))) expect(scenario.parts, name).toContain('channels')
    }
  })

  it('reads the same list from the scripts, and none from a checkout without it', async () => {
    expect(scenarioNames()).toEqual(SCENARIO_NAMES)
    expect(scenariosText()).toContain('hire-employee')
    expect(knowsScenario(process.cwd(), 'channels')).toBe(true)
    expect(knowsScenario(process.cwd(), 'nothing')).toBe(false)
    // A merge base from before there were scenarios: `pr:screens capture --scenario` takes "after" alone.
    expect(knowsScenario(await tempDir('foreman-no-scenarios-'), 'channels')).toBe(false)
  })
})
