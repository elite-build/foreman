// The commands about the app itself: app-info, doctor, cli-status and cli-install. They answer for the
// running app, so `foreman doctor` can say what is wrong with the setup without opening the window.
import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { catalogAgent, enabledAgentIds, FULL_AGENT_IDS } from '../../shared/agentCatalog'
import type { AgentKind } from '../../shared/agents'
import type { AppInfoResult, DoctorItem, DoctorParams, DoctorResult } from '../../cli/protocol'
import { CLI_PROTOCOL_VERSION, socketPath } from '../../cli/protocol'
import type { CliHost } from './host'
import type { CliMethod } from './methods'

/** `git --version`, or null when git isn't there. */
export function gitVersionLine(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile('git', ['--version'], { windowsHide: true, timeout: 10_000 }, (err, stdout) => resolve(err ? null : stdout.trim()))
  })
}

export interface DoctorDeps {
  gitVersion?: () => Promise<string | null>
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

/** A check that failed to run is a gap in the report, not a reason to fail it: undefined (and a throw before the promise counts too). */
async function attempt<T>(check: () => Promise<T>): Promise<T | undefined> {
  try {
    return await check()
  } catch {
    return undefined
  }
}

/** Can the app write in its data folder? A file made and removed says so better than a permission bit does. */
async function writable(dir: string): Promise<string | null> {
  const probe = path.join(dir, `.doctor-${process.pid}`)
  try {
    await writeFile(probe, '')
    await rm(probe, { force: true })
    return null
  } catch (err) {
    return message(err)
  }
}

/** One line per thing that has to work for Foreman to run agents: the app, the command, git, gh, each enabled agent and the data folder. */
export async function doctor(host: CliHost, params: DoctorParams | undefined, deps: DoctorDeps = {}): Promise<DoctorResult> {
  const items: DoctorItem[] = []
  const info = host.appInfo()
  items.push({ name: 'app', status: 'ok', detail: `Foreman ${info.version}, protocol ${CLI_PROTOCOL_VERSION}, ${info.packaged ? 'packaged' : 'running from source'}` })

  const cli = await attempt(() => host.api.cliStatus())
  const cliVersion = params?.cliVersion
  const cliLabel = cliVersion ? `foreman ${cliVersion}` : 'foreman'
  if (!cli) items.push({ name: 'command', status: 'note', detail: `${cliLabel}; could not tell whether it is installed` })
  else if (cli.installed) items.push({ name: 'command', status: cliVersion && cliVersion !== info.version ? 'note' : 'ok', detail: `${cliLabel}, installed${cli.path ? ` at ${cli.path}` : ''}${cliVersion && cliVersion !== info.version ? `; the app is ${info.version}` : ''}` })
  else items.push({ name: 'command', status: 'note', detail: `${cliLabel}, not installed on your PATH`, fix: 'Run `foreman cli install`, or use Settings → Advanced → foreman command → Install' })

  const gitLine = await (deps.gitVersion ?? gitVersionLine)()
  if (!gitLine) items.push({ name: 'git', status: 'problem', detail: 'not found', fix: 'Install git and make sure it is on your PATH' })
  else {
    items.push({ name: 'git', status: 'ok', detail: gitLine })
    const watch = await attempt(() => host.api.baseWatchSupport())
    if (watch && !watch.ok) items.push({ name: 'git merge-tree', status: 'note', detail: `${watch.version ? `git ${watch.version}` : 'this git'} is too old to watch base branches for conflicts` })
  }

  const gh = await attempt(() => host.api.whichBinary('gh'))
  items.push(gh ? { name: 'gh', status: 'ok', detail: gh } : { name: 'gh', status: 'note', detail: 'not found on your PATH' })

  const prefs = host.state().settings.agentPrefs
  const catalog = await attempt(() => host.api.agentCatalog(false))
  const agents = await Promise.all(
    enabledAgentIds(prefs).map(async (id): Promise<DoctorItem> => {
      const label = catalogAgent(id)?.name ?? id
      const docs = catalogAgent(id)?.docsUrl
      try {
        if ((FULL_AGENT_IDS as readonly string[]).includes(id)) {
          const status = await host.api.agentStatus(id as AgentKind)
          const version = [status.version, status.method].filter(Boolean).join(', ')
          if (!status.installed) return { name: id, status: 'problem', detail: `${label} is enabled but not installed`, fix: docs ? `Install it: ${docs}` : 'Install it, or turn it off in Settings → Agents' }
          if (!status.ready) return { name: id, status: 'problem', detail: `${label} is installed but not signed in${status.detail ? ` (${status.detail})` : ''}`, fix: 'Sign in from Settings → Agents' }
          return { name: id, status: 'ok', detail: `${label} installed and signed in${version ? ` (${version})` : ''}` }
        }
        const found = catalog?.detections[id]
        if (!found) return { name: id, status: 'note', detail: `${label} is enabled; not checked yet` }
        return found.installed ? { name: id, status: 'ok', detail: `${label} installed${found.version ? ` (${found.version})` : ''}` } : { name: id, status: 'problem', detail: `${label} is enabled but not installed`, fix: docs ? `Install it: ${docs}` : 'Install it, or turn it off in Settings → Agents' }
      } catch (err) {
        return { name: id, status: 'problem', detail: `${label}: ${message(err)}` }
      }
    })
  )
  items.push(...agents)

  const failure = await writable(info.dataDir)
  items.push(failure ? { name: 'data folder', status: 'problem', detail: `${info.dataDir} is not writable (${failure})`, fix: 'Check its permissions; Foreman keeps its settings and chats there' } : { name: 'data folder', status: 'ok', detail: `${info.dataDir} is writable` })
  return { items }
}

/** The methods this file adds to the registry (methods.ts spreads them in). */
export const appMethods: Record<string, CliMethod> = {
  'app-info': {
    tier: 'read',
    handle: async (host): Promise<AppInfoResult> => {
      const info = host.appInfo()
      const result: AppInfoResult = { ...info, protocol: CLI_PROTOCOL_VERSION, socket: socketPath(info.dataDir, host.platform) }
      // Whether the command is on the PATH is nice to know, never a reason to fail.
      try {
        const cli = await host.api.cliStatus()
        result.cliInstalled = cli.installed
        result.cliPath = cli.path
      } catch {
        // Leave both out.
      }
      return result
    }
  },
  doctor: { tier: 'read', handle: async (host, params) => doctor(host, params as DoctorParams | undefined) },
  'cli-status': { tier: 'read', handle: async (host) => host.api.cliStatus() },
  // Installing changes the user's PATH (and may ask for an administrator password on macOS), so it is the user's to do.
  'cli-install': { tier: 'admin', handle: async (host) => host.api.installCli() }
}
