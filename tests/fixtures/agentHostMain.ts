// O10 tests: the background agent host as its own process, with the fake agent (see tests/agentHostFake.ts).
// Run with jiti: node jiti-cli.mjs agentHostMain.ts <dir> <idleMs>
import { HostServer } from '../../src/main/agentHost/server'
import { fakeDriver } from '../agentHostFake'

const [dir, idle] = process.argv.slice(2)
const server = new HostServer({ dir, driver: () => fakeDriver, idleMs: Number(idle) || 500, exit: () => process.exit(0) })
void server.listen().then((ok) => {
  if (!ok) process.exit(3)
})
