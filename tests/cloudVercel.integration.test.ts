// Remote workspaces on a real Vercel Sandbox, through Foreman's own provider: the
// provider contract (tests/providerConformance.ts) end to end, the agent host and its attach bridge included when
// out/main has them (`npm run build`). Skipped unless FOREMAN_VERCEL_TOKEN, FOREMAN_VERCEL_TEAM_ID and
// FOREMAN_VERCEL_PROJECT_ID are set; run it with `npm run cloud:smoke`. It makes 1 vCPU sandboxes named
// foreman-smoke-<run>-…, tagged app=foreman role=conformance, and always deletes them (and their snapshots).
import { VercelProvider } from '../src/main/cloud/vercelProvider'
import { planLimits } from '../src/shared/cloud'
import { describeProviderConformance } from './providerConformance'

const token = process.env.FOREMAN_VERCEL_TOKEN
const teamId = process.env.FOREMAN_VERCEL_TEAM_ID
const projectId = process.env.FOREMAN_VERCEL_PROJECT_ID
const configured = Boolean(token && teamId && projectId)

describeProviderConformance('Vercel Sandbox (opt-in, real account)', () => new VercelProvider({ token: token!, teamId: teamId!, projectId: projectId! }, planLimits('hobby')), {
  skip: configured ? false : 'set FOREMAN_VERCEL_TOKEN, FOREMAN_VERCEL_TEAM_ID and FOREMAN_VERCEL_PROJECT_ID',
  id: 'vercel',
  prefix: 'foreman-smoke',
  // The smallest size, as the smoke test always asked for.
  vcpus: 1,
  timeoutMs: 5 * 60_000,
  settleMs: 2 * 60_000
})
