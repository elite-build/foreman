// Results of the `foreman service` methods (src/main/cli/service.ts): the background service that starts Foreman with no
// window at login (src/main/service.ts). Each result has a `text` the command prints unless --json is given.

export type ServiceKind = 'launchd' | 'systemd' | 'task-scheduler'

// What the service's Foreman does with a newer release: installs it by itself once nothing is running; only says so
// (Settings → General → Updates is "Tell me"); nothing (automatic checks are off); or it can't install one itself (a
// development build, an unsigned macOS build, Linux).
export type ServiceUpdates = 'automatic' | 'notify' | 'off' | 'unavailable'

export interface ServiceStatusResult {
  kind: ServiceKind
  installed: boolean
  // Installed, and it starts this Foreman as install would now; false for another copy, an older install or a hand edit.
  current: boolean
  // The launchd agent or systemd unit file, or the Task Scheduler task's name.
  where: string
  // What it starts: the program, then its arguments.
  command: string[]
  // This Foreman was started by the service.
  startedByService: boolean
  updates: ServiceUpdates
  text: string
}

export type ServiceInstallResult = ServiceStatusResult

export interface ServiceUninstallResult extends ServiceStatusResult {
  // There was a service to remove.
  removed: boolean
}
