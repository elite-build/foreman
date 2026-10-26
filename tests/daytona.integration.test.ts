// Remote workspaces on a real Daytona account, through Foreman's own provider (src/main/cloud/daytonaProvider.ts):
// the provider contract (tests/providerConformance.ts) end to end, the agent host and its attach bridge included
// when out/main has them (`npm run build`). Skipped unless FOREMAN_DAYTONA_API_KEY is set (FOREMAN_DAYTONA_API_URL
// and FOREMAN_DAYTONA_TARGET optional). It makes 1 vCPU sandboxes named foreman-conf-<run>-…, labelled app=foreman
// role=conformance, and always deletes them and the base's snapshot. The first run in an organization and region
// also builds the Foreman snapshot for 1 vCPU (minutes; its log goes to the console) and leaves it for later runs.
// Each case names the part of the contract it checks; where that rests on an SDK or daemon behaviour this provider
// assumes, the extra cases below say which.
import { describe, expect, it } from 'vitest'
import { createDaytonaProvider, verifyDaytona } from '../src/main/cloud/daytonaProvider'
import { CLOUD_SANDBOX_ROOT } from '../src/shared/cloud'
import { DAYTONA_API_URL } from '../src/shared/integrations'
import { describeProviderConformance } from './providerConformance'

const apiKey = process.env.FOREMAN_DAYTONA_API_KEY
const apiUrl = process.env.FOREMAN_DAYTONA_API_URL || DAYTONA_API_URL
const target = process.env.FOREMAN_DAYTONA_TARGET || undefined
const skip = apiKey ? false : 'set FOREMAN_DAYTONA_API_KEY (and optionally FOREMAN_DAYTONA_API_URL, FOREMAN_DAYTONA_TARGET)'
const make = () => createDaytonaProvider({ apiKey: apiKey!, apiUrl, target }, undefined)

describeProviderConformance('Daytona (opt-in, real account)', make, {
  skip,
  id: 'daytona',
  // The smallest size; the region from the connection's target, else the provider's first.
  vcpus: 1,
  ...(target ? { region: target } : {}),
  // A first run builds the 1 vCPU snapshot inside create().
  timeoutMs: 20 * 60_000,
  settleMs: 3 * 60_000
})

describe.skipIf(Boolean(skip))('Daytona specifics (opt-in, real account)', () => {
  it('verifyDaytona accepts the key and names its organization (GET /sandbox, /api-keys/current, /organizations/{id})', async () => {
    const r = await verifyDaytona(apiKey!, { apiUrl, target })
    expect(r.daytona.apiUrl, 'the API URL is kept without a trailing slash').toBe(apiUrl.replace(/\/+$/, ''))
    expect(r.daytona.limits?.maxVcpus, 'limits from the organization’s usage, or the defaults').toBeGreaterThan(0)
    // Not required (a self-hosted Daytona may not answer), but on Daytona's cloud the key's organization is known.
    if (apiUrl === DAYTONA_API_URL) expect(r.identity.orgId, 'GET /api-keys/current gives the key’s organizationId').toBeTruthy()
    await expect(verifyDaytona('dtn_not-a-key', { apiUrl })).rejects.toMatchObject({ auth: true })
  })

  it('keeps the daemon behaviours the provider relies on: exact bytes, env off disk, stdin closed by the marker', async () => {
    const provider = make()
    const name = `foreman-conf-${Date.now().toString(36)}-sdk`
    const sb = await provider.create({ name, vcpus: 1, region: target ?? provider.capabilities().regions[0], timeoutMs: 60_000, tags: { app: 'foreman', role: 'conformance' } })
    try {
      // process.executeCommand merges stdout and stderr; execScript must get both back apart, byte for byte.
      const exact = await sb.exec('node', ['-e', 'process.stdout.write("a\\u0000b");process.stderr.write("c")'])
      expect(exact, 'executeCommand runs the wrapper with the daemon’s shell and returns its output whole').toEqual({ stdout: 'a\u0000b', stderr: 'c', code: 0 })
      // A session command's text is written to cmd.sh in the sandbox: the env must not be in it.
      const streamed: string[] = []
      const env = await sb.exec('bash', ['-c', 'echo "$FOREMAN_SECRET"; grep -rl --include=cmd.sh --exclude-dir=proc --exclude-dir=sys "$FOREMAN_SECRET" / 2>/dev/null | head -1'], { env: { FOREMAN_SECRET: 'foreman-secret-value' }, onOutput: (c) => streamed.push(c) })
      expect(env.stdout.split('\n')[0], 'sendSessionCommandInput delivers the env line to the session command’s stdin').toBe('foreman-secret-value')
      expect(env.stdout.split('\n')[1] ?? '', 'no cmd.sh holds the secret (suppressInputEcho keeps it out of the log too)').toBe('')
      // Session commands keep stdin open forever; closeStdin must end it through the filter's marker.
      const cmd = await sb.spawn('node', ['-e', 'let n=0;process.stdin.on("data",(d)=>n+=d.length).on("end",()=>{console.log("bytes:"+n);process.exit(0)})'], { stdin: true, cwd: CLOUD_SANDBOX_ROOT })
      await cmd.write('12345\n')
      await cmd.closeStdin()
      expect(await cmd.wait(), 'the command sees EOF after the marker line and exits').toEqual({ code: 0 })
      let out = ''
      for await (const line of cmd.logs()) out += line.data
      expect(out, 'suppressInputEcho: input is not echoed into the log').toBe('bytes:6\n')
    } finally {
      const handle = await provider.get(name).catch(() => null)
      await handle?.delete({ snapshots: true }).catch((err: unknown) => console.warn(`[daytona] couldn't delete ${name}; delete it by hand.`, err))
    }
  }, 20 * 60_000)
})
