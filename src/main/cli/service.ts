// `foreman service status|install|uninstall`: start Foreman with no window when the user logs in, so schedules, flows,
// phones and paired computers keep working without the app open (src/main/service.ts; docs/server.md, "As a service").
// Installing and removing are the admin tier: an agent turn can't make Foreman start at login, or stop it.
import type { ServiceInstallResult, ServiceKind, ServiceStatusResult, ServiceUninstallResult, ServiceUpdates } from '../../shared/cli/service'
import type { ServiceState } from '../service'
import { windowsWord } from '../service'
import { CliCodedError, type CliHost, type ServiceHost } from './host'
import type { MethodDef } from './kit'

const KIND_WORDS: Record<ServiceKind, string> = { launchd: 'launchd agent', systemd: 'systemd user unit', 'task-scheduler': 'Task Scheduler task' }

const UPDATE_WORDS: Record<ServiceUpdates, string> = {
  automatic: 'it installs a downloaded update by itself once nothing is running and no window is open, then starts again',
  notify: 'Settings → General → Updates only tells you about a new version; `foreman settings set general.update-mode download` lets it update itself',
  off: 'automatic checks are off (`foreman settings set general.check-for-updates true` turns them on)',
  unavailable: 'this copy of Foreman can’t install updates itself (a development build, an unsigned macOS build, or Linux)'
}

function serviceOf(host: CliHost): ServiceHost {
  if (!host.service) throw new CliCodedError('not-supported', 'This Foreman can’t install a background service.', 'Install one from an installed Foreman.')
  return host.service
}

function updatesOf(host: CliHost): ServiceUpdates {
  const settings = host.state().settings
  if (!host.service?.canUpdate()) return 'unavailable'
  if (!settings.checkForUpdates) return 'off'
  return settings.updateMode === 'notify' ? 'notify' : 'automatic'
}

/** What the service starts, as a person would type it. */
function commandText(state: ServiceState): string {
  const words = [state.launch.command, ...state.launch.args]
  return words.map((w) => (state.kind === 'task-scheduler' ? windowsWord(w) : /[\s"'\\$]/.test(w) ? `'${w.replace(/'/g, `'\\''`)}'` : w)).join(' ')
}

function where(state: ServiceState): string {
  return state.kind === 'task-scheduler' ? `${KIND_WORDS[state.kind]} “${state.where}”` : `${KIND_WORDS[state.kind]} ${state.where}`
}

function result(host: CliHost, service: ServiceHost, state: ServiceState, text: string): ServiceStatusResult {
  return {
    kind: state.kind,
    installed: state.installed,
    current: state.current,
    where: state.where,
    command: [state.launch.command, ...state.launch.args],
    startedByService: service.startedByService,
    updates: updatesOf(host),
    text
  }
}

function statusLines(host: CliHost, service: ServiceHost, state: ServiceState): string[] {
  const lines: string[] = []
  if (!state.installed) {
    lines.push('Background service: not installed.', 'Run `foreman service install` to start Foreman with no window when you log in, so schedules, flows and phones keep working without the app open.')
  } else {
    lines.push(`Background service: installed, as the ${where(state)}.`)
    if (!state.current) lines.push('It doesn’t start this Foreman as installing now would (another copy, an older install, or edited by hand); `foreman service install` replaces it.')
    lines.push(`It starts: ${commandText(state)}`)
  }
  lines.push(service.startedByService ? 'This Foreman was started by the service.' : 'This Foreman wasn’t started by the service.')
  if (state.installed || service.startedByService) lines.push(`Updates: ${UPDATE_WORDS[updatesOf(host)]}.`)
  return lines
}

const status: MethodDef = {
  tier: 'read',
  async handle(host): Promise<ServiceStatusResult> {
    const service = serviceOf(host)
    const state = await service.status()
    return result(host, service, state, statusLines(host, service, state).join('\n'))
  }
}

const install: MethodDef = {
  tier: 'admin',
  async handle(host): Promise<ServiceInstallResult> {
    const service = serviceOf(host)
    const state = await service.install().catch((err: unknown) => {
      throw new CliCodedError('failed', err instanceof Error ? err.message : String(err))
    })
    const lines = [
      `Installed: Foreman now starts with no window when you log in, as the ${where(state)}.`,
      'Schedules, flows, phones and paired computers then work without the app open; the tray icon opens the window, and Quit there stops it until the next login.',
      `It starts: ${commandText(state)}`,
      service.startedByService ? 'This Foreman was started by the service.' : 'This Foreman keeps running now; the service starts it from the next login.',
      `Updates: ${UPDATE_WORDS[updatesOf(host)]}.`,
      ...service.notes()
    ]
    return result(host, service, state, lines.join('\n'))
  }
}

const uninstall: MethodDef = {
  tier: 'admin',
  async handle(host): Promise<ServiceUninstallResult> {
    const service = serviceOf(host)
    const before = await service.status()
    if (!before.installed) return { ...result(host, service, before, 'Nothing to remove: the background service isn’t installed.'), removed: false }
    const state = await service.uninstall().catch((err: unknown) => {
      throw new CliCodedError('failed', err instanceof Error ? err.message : String(err))
    })
    const text = [`Removed the ${where(before)}: Foreman no longer starts when you log in.`, 'This Foreman keeps running; quit it from the tray when you’re done.'].join('\n')
    return { ...result(host, service, state, text), removed: true }
  }
}

export const SERVICE_METHODS: Record<string, MethodDef> = {
  'service-status': status,
  'service-install': install,
  'service-uninstall': uninstall
}
