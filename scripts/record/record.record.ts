// The vitest entry of `npm run record:agent` (see scripts/record-agent.mjs and vitest.record.config.ts). Not a test: it
// is only loaded by the record config, which is the one place a real agent is started.
import { test, vi } from 'vitest'
import { recordMain } from '../../src/main/agents/fixtures/recordMain'

// The simulated Cursor recording runs the adapter against a fake of its SDK (fixtures/fakes.ts). Real agents don't touch it.
vi.mock('@cursor/sdk', async () => (await import('../../src/main/agents/fixtures/cursorSdkFake')).fakeCursorSdk())

test('record', async () => {
  const [agent, scenario] = [process.env.RECORD_AGENT, process.env.RECORD_SCENARIO]
  if (!agent) throw new Error('RECORD_AGENT and RECORD_SCENARIO are set by npm run record:agent')
  await recordMain(agent, scenario ?? '')
}, 600_000)
