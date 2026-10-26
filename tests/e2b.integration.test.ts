// Remote workspaces on a real E2B account, through Foreman's own provider (src/main/cloud/e2bProvider.ts): the
// provider contract (tests/providerConformance.ts) end to end, the agent host included when out/main has it
// (`npm run build`). Skipped unless FOREMAN_E2B_API_KEY is set (FOREMAN_E2B_DOMAIN for a self-hosted E2B). It makes
// 2 vCPU sandboxes named foreman-e2b-<run>-…, tagged app=foreman role=conformance, and always kills them.
//
// The first run on a team builds the foreman-sandbox template (minutes, once): beforeAll does it, with its log, so
// no case's timeout pays for it. Each check below leans on an SDK behaviour the provider assumes; when one fails,
// the assumption named here is the first suspect:
//  - create/get/list: Sandbox.create keeps `metadata`, and Sandbox.list({ query: { metadata } }) filters on it,
//    running and paused alike.
//  - layout and tools: the template's Dockerfile (e2bTemplate.ts) built, `user` has HOME=/vercel, /vercel/* is
//    theirs, and PATH from /etc/profile.d reaches `bash -l -c` (commands.run).
//  - exec: commands.run with `envs` and `cwd`; CommandExitError carries the exit code; handle.kill() ends a
//    background command and its wait() settles.
//  - spawn: `stdin: true` with commands.sendStdin/closeStdin (envd ≥ 0.3), `timeoutMs: 0` keeps it running.
//  - files: files.write makes parents and takes ArrayBuffers; a missing file throws FileNotFoundError.
//  - PTY: pty.create runs `bash -i -l`, which runs PROMPT_COMMAND before its first prompt; pty.resize reaches the tty;
//    the handle's wait() throws CommandExitError with the shell's code.
//  - session/extend: getInfo().endAt is the session's end; setTimeout sets the time left from now.
//  - stop/wake: Sandbox.pause keeps the filesystem; getInfo reports `paused` and never resumes; a request to a paused
//    sandbox fails with the SDK's SandboxNotRunningError (autoResume off); Sandbox.connect resumes it.
//  - delete: Sandbox.kill removes a sandbox, paused or not, from Sandbox.list.
import { createE2bProvider, type E2bProvider } from '../src/main/cloud/e2bProvider'
import { describeProviderConformance } from './providerConformance'

const apiKey = process.env.FOREMAN_E2B_API_KEY
const domain = process.env.FOREMAN_E2B_DOMAIN || undefined

describeProviderConformance(
  'E2B (opt-in, real account)',
  async () => {
    const provider = createE2bProvider({ apiKey: apiKey!, domain }, undefined)
    // The smallest size's template, built now if the team has none (a one-time, minutes-long step).
    await (provider as E2bProvider).ensureTemplate(provider.capabilities().vcpuOptions[0], (line) => process.stdout.write(`[e2b template] ${line}`))
    return provider
  },
  {
    skip: apiKey ? false : 'set FOREMAN_E2B_API_KEY (and FOREMAN_E2B_DOMAIN for a self-hosted E2B)',
    id: 'e2b',
    prefix: 'foreman-e2b',
    // Each case, and beforeAll's template build.
    timeoutMs: 20 * 60_000,
    // A pause takes about 4 s per GiB of memory.
    settleMs: 2 * 60_000
  }
)
