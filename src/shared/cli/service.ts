// Results of the `foreman service` methods (src/main/cli/service.ts): the background service that starts Foreman with no
// window at login (src/main/service.ts). Each result has a `text` the command prints unless --json is given.

export type ServiceKind = 'launchd' | 'systemd' | 'task-scheduler'

// What the service's Foreman does with a newer release: installs it by itself once nothing is running; only says so
// (Settings → General → Updates is "Tell me"); nothing (automatic checks are off); or it can't install one itself (a
// development build, an unsigned macOS build, Linux).
export type ServiceUpdates = 'automatic' | 'notify' | 'off' | 'unavailable'

// How the last update the service's Foreman installed went (src/main/serviceUpdate.ts). Kept: the new version opened
// the data and served. Rolled back: it didn't, and the data is as the version before it left it.
export interface ServiceLastUpdate {
  from: string
  to: string
  // ISO time.
  at: string
  outcome: 'kept' | 'rolled-back'
  tries: number
  error?: string
}

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
  // The process answering: `foreman service restart` waits for another one to answer.
  pid: number
  updates: ServiceUpdates
  lastUpdate?: ServiceLastUpdate
  text: string
}

export type ServiceInstallResult = ServiceStatusResult

export interface ServiceUninstallResult extends ServiceStatusResult {
  // There was a service to remove.
  removed: boolean
}

export interface ServiceRestartParams {
  // Restart even with turns, check runs or run scripts going; they stop, as with Quit now.
  force?: boolean
}

export interface ServiceRestartResult extends ServiceStatusResult {
  // The restarted Foreman opens a window, as one is open now.
  window: boolean
}
