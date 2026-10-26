// Remote workspaces on a real Docker daemon, through Foreman's own provider: the provider contract
// (tests/providerConformance.ts) end to end, the agent host and its attach bridge included when out/main has
// them (`npm run build`). Opt-in, so `npm test` never builds images or starts containers: set FOREMAN_DOCKER=1
// (PowerShell: $env:FOREMAN_DOCKER='1'; npx vitest run tests/docker.integration.test.ts). It runs against the
// CLI's current context, or FOREMAN_DOCKER_CONTEXT / FOREMAN_DOCKER_HOST (a LAN daemon), and is skipped when
// `docker version` doesn't answer there. The first run builds the sandbox image (minutes; it is kept for the
// app). Containers are 1 CPU, named foreman-conf-<run>-…, and the suite deletes them and the images committed
// from them, whatever happened.
import { execFileSync } from 'node:child_process'
import { createDockerProvider, dockerBinary } from '../src/main/cloud/dockerProvider'
import { describeProviderConformance } from './providerConformance'

const target = { context: process.env.FOREMAN_DOCKER_CONTEXT || undefined, host: process.env.FOREMAN_DOCKER_HOST || undefined }

function daemonUp(): boolean {
  const bin = dockerBinary()
  if (!bin) return false
  try {
    const args = [...(target.context ? ['--context', target.context] : []), 'version', '--format', '{{.Server.Version}}']
    execFileSync(bin, args, { stdio: 'pipe', timeout: 30_000, env: target.host ? { ...process.env, DOCKER_HOST: target.host } : process.env, windowsHide: true })
    return true
  } catch {
    return false
  }
}

const skip = process.env.FOREMAN_DOCKER !== '1' ? 'set FOREMAN_DOCKER=1 (and FOREMAN_DOCKER_CONTEXT or FOREMAN_DOCKER_HOST for another daemon)' : daemonUp() ? false : 'docker version didn’t answer: start Docker Desktop or the daemon'

describeProviderConformance('Docker', () => createDockerProvider(target, undefined), {
  skip,
  id: 'docker',
  vcpus: 1,
  // The first case builds the sandbox image when the daemon doesn't have it yet.
  timeoutMs: 30 * 60_000,
  settleMs: 2 * 60_000
})
