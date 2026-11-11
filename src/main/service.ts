// Foreman as a background service (docs/server.md, "As a service"): `foreman service install` registers this Foreman to
// start with no window when the user logs in, so schedules, flows, phones and paired computers keep working without
// anyone opening the app. A launchd agent on macOS, a systemd user unit on Linux, a Task Scheduler task on Windows. The
// files are made by pure functions, tested; ServiceManager writes and removes them through injected file and process
// calls; src/main/index.ts gives it the facts and hands it to the command line.
//
// Installing never starts or stops anything: the Foreman that runs the command is already running, and the service
// starts it at the next login. Removing it leaves the running Foreman alone too, as stopping the service would stop the
// process answering the command.
import { execFile } from 'node:child_process'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

/** Foreman's own flag for a start by the service: headless, and it may restart itself to install an update. */
export const SERVICE_FLAG = '--service'
const DATA_DIR_FLAG = '--data-dir='

export const LAUNCHD_LABEL = 'dev.foreman.app.service'
export const SYSTEMD_UNIT = 'foreman.service'
export const TASK_NAME = 'Foreman'

export type ServiceKind = 'launchd' | 'systemd' | 'task-scheduler'

export interface ServiceFacts {
  platform: NodeJS.Platform
  home: string
  // process.execPath: Foreman's binary when packaged, Electron's in development.
  execPath: string
  // app.getAppPath(): what Electron runs in development.
  appPath: string
  packaged: boolean
  // $APPIMAGE on Linux: execPath is inside the AppImage's mount, which is gone once it exits.
  appImage?: string
  // A data folder other than the default (--data-dir= or FOREMAN_DATA_DIR): the service starts the same Foreman.
  dataDir?: string
  // $XDG_CONFIG_HOME, where systemd looks for user units before ~/.config.
  configHome?: string
  // Linux: the display this Foreman has, so the service's has one too; xvfb-run when there is none.
  display?: Partial<Record<'DISPLAY' | 'WAYLAND_DISPLAY' | 'XAUTHORITY', string>>
  xvfbRun?: string | null
  // Windows: DOMAIN\user, whose logon starts the task.
  user?: string
  // Windows: where the task's definition is written for schtasks to read.
  tempDir?: string
}

export interface ServiceLaunch {
  command: string
  args: string[]
}

/** The data folder a --data-dir= on the command line names, if any. Only the one-word form, so it is never read as a folder to open. */
export function parseDataDir(argv: readonly string[]): string | undefined {
  const arg = argv.slice(1).find((a) => a.startsWith(DATA_DIR_FLAG))
  const dir = arg?.slice(DATA_DIR_FLAG.length)
  return dir || undefined
}

export function parseService(argv: readonly string[]): boolean {
  return argv.slice(1).includes(SERVICE_FLAG)
}

export function serviceKind(platform: NodeJS.Platform): ServiceKind | null {
  if (platform === 'darwin') return 'launchd'
  if (platform === 'win32') return 'task-scheduler'
  if (platform === 'linux') return 'systemd'
  return null
}

/**
 * Foreman's arguments for a start of this copy: the app path first in a development build, then the flags, then its data
 * folder when it isn't the default. The service's own start, `foreman service restart` and a start after a failed
 * update try (serviceUpdate.ts) are all made here.
 */
export function launchArgs(f: Pick<ServiceFacts, 'packaged' | 'appPath' | 'dataDir'>, flags: string[]): string[] {
  return [...(f.packaged ? [] : [f.appPath]), ...flags, ...(f.dataDir ? [`${DATA_DIR_FLAG}${f.dataDir}`] : [])]
}

/** What the service starts: this Foreman, headless, marked as the service's, with its data folder when it isn't the default. */
export function serviceLaunch(f: ServiceFacts): ServiceLaunch {
  const command = f.platform === 'linux' && f.appImage ? f.appImage : f.execPath
  return { command, args: launchArgs(f, ['--headless', SERVICE_FLAG]) }
}

/**
 * `foreman service restart`: the service's start again, with a window when one is open now. Restarting stops this
 * Foreman, so it is refused unless the service is installed and starts this copy (another copy would come back in its
 * place), and while something Quit would ask about is running unless forced. Null when it may go ahead.
 */
export function restartProblem(f: { installed: boolean; current: boolean; busy: boolean; force: boolean }): { code: 'not-found' | 'refused' | 'busy'; message: string; hint: string } | null {
  if (!f.installed) return { code: 'not-found', message: 'The background service isn’t installed, so there is nothing to restart.', hint: 'Run `foreman service install` first.' }
  if (!f.current) return { code: 'refused', message: 'The service starts another copy of Foreman (or an older install), not this one, so restarting this one would bring that one back instead.', hint: 'Run `foreman service install` from this Foreman, then restart it.' }
  if (f.busy && !f.force) return { code: 'busy', message: 'Agent turns, check runs or run scripts are going, and restarting would stop them.', hint: 'Wait for them to finish, or add --force to stop them (they are listed for review after the restart, as with Quit).' }
  return null
}

/** The restarted Foreman's arguments: the service's, without --headless when a window should open. */
export function restartArgs(launch: ServiceLaunch, window: boolean): string[] {
  return window ? launch.args.filter((a) => a !== '--headless') : launch.args
}

/** Why this Foreman can't be installed as a service, or null. */
export function serviceProblem(f: ServiceFacts): string | null {
  if (!serviceKind(f.platform)) return `Foreman can’t install a service on ${f.platform}.`
  // macOS runs an app opened from a disk image or the Downloads folder from a random read-only copy (App Translocation).
  if (f.platform === 'darwin' && (f.execPath.startsWith('/Volumes/') || f.execPath.includes('/AppTranslocation/'))) {
    return 'Move Foreman to the Applications folder and open it from there first: macOS is running it from a temporary copy that won’t be there at the next login.'
  }
  return null
}

/** Where the service is registered: the launchd agent or systemd unit file, or the task's name. */
export function serviceLocation(f: ServiceFacts): string {
  const kind = serviceKind(f.platform)
  const join = (...parts: string[]) => parts.join('/')
  if (kind === 'launchd') return join(f.home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
  if (kind === 'systemd') return join(f.configHome || join(f.home, '.config'), 'systemd', 'user', SYSTEMD_UNIT)
  return TASK_NAME
}

const xml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const unxml = (s: string): string => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

/**
 * A launchd agent in the user's GUI session: started at login, and again after a crash (KeepAlive with SuccessfulExit
 * false), but not after Quit, which exits cleanly. ThrottleInterval keeps a crash at startup from looping fast.
 */
export function launchdPlist(launch: ServiceLaunch): string {
  const args = [launch.command, ...launch.args].map((a) => `    <string>${xml(a)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<!-- Written by \`foreman service install\`; \`foreman service uninstall\` removes it. -->
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>ProcessType</key>
  <string>Interactive</string>
</dict>
</plist>
`
}

/** One ExecStart word: quoted, with systemd's escapes, and % doubled so it isn't read as a specifier. */
const systemdWord = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`

/**
 * A systemd user unit, enabled for the user's session: restarted after a crash, not after Quit. Electron needs a display,
 * so the unit carries the one this Foreman has, or runs under xvfb-run when there is none and it is installed.
 */
export function systemdUnit(launch: ServiceLaunch, f: Pick<ServiceFacts, 'display' | 'xvfbRun'>): string {
  const display = Object.entries(f.display ?? {}).filter(([, v]) => v)
  const words = display.length === 0 && f.xvfbRun ? [f.xvfbRun, '-a', launch.command, ...launch.args] : [launch.command, ...launch.args]
  const env = display.map(([k, v]) => `Environment=${systemdWord(`${k}=${v}`)}\n`).join('')
  return `# Written by \`foreman service install\`; \`foreman service uninstall\` removes it.
[Unit]
Description=Foreman in the background: schedules, flows, phones and paired computers

[Service]
Type=simple
ExecStart=${words.map(systemdWord).join(' ')}
${env}Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`
}

/** A Windows command-line word: quoted when it has a space, as CreateProcess splits it. Paths can't hold a quote. */
export const windowsWord = (s: string): string => (s === '' || /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s)

/**
 * A Task Scheduler task that starts at the user's logon, in their session (DPAPI and the tray need it), without
 * administrator rights. No time limit (the default stops a task after three days), not stopped on battery, normal
 * priority (a task's default is below normal, which agents would inherit), and one instance.
 */
export function taskXml(launch: ServiceLaunch, user: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Foreman in the background: schedules, flows, phones and paired computers. Written by \`foreman service install\`; \`foreman service uninstall\` removes it.</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
    <Priority>5</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(launch.command)}</Command>
      <Arguments>${xml(launch.args.map(windowsWord).join(' '))}</Arguments>
    </Exec>
  </Actions>
</Task>
`
}

/** The command and arguments of a task as `schtasks /Query /XML` prints it. */
export function taskAction(queried: string): { command: string; args: string } | null {
  const command = /<Command>([\s\S]*?)<\/Command>/.exec(queried)?.[1]
  if (command === undefined) return null
  const args = /<Arguments>([\s\S]*?)<\/Arguments>/.exec(queried)?.[1] ?? ''
  return { command: unxml(command.trim()), args: unxml(args.trim()) }
}

export interface ServiceState {
  kind: ServiceKind
  installed: boolean
  // Installed, and it starts this Foreman as install would write it now. False: another copy of Foreman, an older
  // install, or one edited by hand; installing again replaces it.
  current: boolean
  where: string
  launch: ServiceLaunch
}

export interface ServiceDeps {
  facts: ServiceFacts
  // The file's text, or null when there is none.
  readFile(file: string): Promise<string | null>
  // Writes the file, making its folder.
  writeFile(file: string, data: string | Buffer): Promise<void>
  // Removes the file; nothing when it isn't there.
  removeFile(file: string): Promise<void>
  run(file: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }>
}

/** The file and process calls on this computer. */
export function systemServiceDeps(): Omit<ServiceDeps, 'facts'> {
  return {
    readFile: (file) => readFile(file, 'utf8').catch(() => null),
    writeFile: async (file, data) => {
      await mkdir(path.dirname(file), { recursive: true })
      await writeFile(file, data)
    },
    removeFile: (file) => rm(file, { force: true }),
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => resolve({ ok: !err, stdout: String(stdout), stderr: String(stderr || (err?.message ?? '')) }))
      })
  }
}

/** What to say after installing beyond that it worked: what is different about this copy or this computer. */
export function installNotes(f: ServiceFacts): string[] {
  const notes: string[] = []
  if (!f.packaged) notes.push(`This is a development build: the service runs it from ${f.appPath}, which must stay built (npm run build). Install from an installed Foreman for everyday use.`)
  if (f.dataDir) notes.push(`The service uses this Foreman’s data folder, ${f.dataDir}.`)
  if (f.platform === 'linux') {
    const display = Object.values(f.display ?? {}).some(Boolean)
    if (!display && !f.xvfbRun) notes.push('No display was found and xvfb-run isn’t installed, and Foreman needs a display, as Electron does. Install Xvfb (it provides xvfb-run) and run `foreman service install` again.')
    else if (!display) notes.push('No display was found, so the service runs Foreman under xvfb-run.')
    notes.push('systemd starts it when you log in. To start it at boot with nobody logged in, run `loginctl enable-linger` once.')
  }
  return notes
}

export class ServiceManager {
  constructor(private readonly deps: ServiceDeps) {}

  private get facts(): ServiceFacts {
    return this.deps.facts
  }

  private kind(): ServiceKind {
    const kind = serviceKind(this.facts.platform)
    if (!kind) throw new Error(`Foreman can’t install a service on ${this.facts.platform}.`)
    return kind
  }

  /** The file install writes for launchd or systemd. */
  private fileText(launch: ServiceLaunch): string {
    return this.kind() === 'launchd' ? launchdPlist(launch) : systemdUnit(launch, this.facts)
  }

  private async must(file: string, args: string[], what: string): Promise<string> {
    const result = await this.deps.run(file, args)
    if (!result.ok) throw new Error(`${what}: ${result.stderr.trim() || result.stdout.trim() || `${file} failed`}`)
    return result.stdout
  }

  async status(): Promise<ServiceState> {
    const kind = this.kind()
    const launch = serviceLaunch(this.facts)
    const where = serviceLocation(this.facts)
    if (kind === 'task-scheduler') {
      const queried = await this.deps.run('schtasks', ['/Query', '/TN', TASK_NAME, '/XML'])
      if (!queried.ok) return { kind, installed: false, current: false, where, launch }
      const action = taskAction(queried.stdout)
      const current = action !== null && action.command === launch.command && action.args === launch.args.map(windowsWord).join(' ')
      return { kind, installed: true, current, where, launch }
    }
    const text = await this.deps.readFile(where)
    return { kind, installed: text !== null, current: text === this.fileText(launch), where, launch }
  }

  /** Register this Foreman to start headless at the next login, replacing any registration there was. */
  async install(): Promise<ServiceState> {
    const problem = serviceProblem(this.facts)
    if (problem) throw new Error(problem)
    const kind = this.kind()
    const launch = serviceLaunch(this.facts)
    const where = serviceLocation(this.facts)
    if (kind === 'task-scheduler') {
      // schtasks reads a definition from a file, in UTF-16 as its header says.
      const file = path.join(this.facts.tempDir ?? '.', `foreman-service-${process.pid}.xml`)
      await this.deps.writeFile(file, Buffer.from(`\ufeff${taskXml(launch, this.facts.user ?? '')}`, 'utf16le'))
      try {
        await this.must('schtasks', ['/Create', '/TN', TASK_NAME, '/XML', file, '/F'], 'Task Scheduler refused the task')
      } finally {
        await this.deps.removeFile(file).catch(() => undefined)
      }
    } else {
      await this.deps.writeFile(where, this.fileText(launch))
      if (kind === 'systemd') {
        await this.must('systemctl', ['--user', 'daemon-reload'], 'systemd didn’t read the unit')
        await this.must('systemctl', ['--user', 'enable', SYSTEMD_UNIT], 'systemd didn’t enable the unit')
      }
      // launchd reads ~/Library/LaunchAgents at login. Loading it now would start a second Foreman, which hands over to
      // this one and exits; and unloading it later stops whatever launchd started, which may be the Foreman asking.
    }
    return this.status()
  }

  /** Stop starting Foreman at login. The Foreman running now keeps running. */
  async uninstall(): Promise<ServiceState> {
    const kind = this.kind()
    const where = serviceLocation(this.facts)
    if (kind === 'task-scheduler') {
      const before = await this.status()
      // Deleting a task leaves a process it started running.
      if (before.installed) await this.must('schtasks', ['/Delete', '/TN', TASK_NAME, '/F'], 'Task Scheduler didn’t delete the task')
    } else {
      // Disable, not stop: stopping the unit would stop this process if the service started it.
      if (kind === 'systemd' && (await this.deps.readFile(where)) !== null) await this.deps.run('systemctl', ['--user', 'disable', SYSTEMD_UNIT])
      await this.deps.removeFile(where)
      if (kind === 'systemd') await this.deps.run('systemctl', ['--user', 'daemon-reload'])
    }
    return this.status()
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Updating itself. A Foreman the service started installs a downloaded update on its own once nobody is using it, then
// comes back the way it was. The installers start Foreman again with no arguments (NSIS's --force-run, Squirrel's
// relaunch), so it leaves a note in its data folder that the new version reads once at startup. The new version is on
// trial until it serves, with the data copied aside first (serviceUpdate.ts).

/** Whether the service's Foreman should restart now to install a downloaded update. */
export function serviceUpdateDue(f: {
  // Started by the service (or brought back by this note after an update).
  service: boolean
  // The downloaded update's version; absent with none, or one that was skipped.
  readyVersion?: string
  // Open windows: someone at the computer decides with the update card instead.
  windows: number
  // Turns, checks or scripts running: what Quit would ask about.
  busy: boolean
  // A version whose update was rolled back here (serviceUpdate.ts): not installed by itself again. Someone at the
  // computer can still choose it from the update card.
  failedVersion?: string
}): boolean {
  return f.service && Boolean(f.readyVersion) && f.readyVersion !== f.failedVersion && f.windows === 0 && !f.busy
}

export const RELAUNCH_FILE = 'service-relaunch.json'
// An update installs in a minute or two; a note older than this is from an install that never finished.
const RELAUNCH_MAX_MS = 30 * 60_000

export interface RelaunchNote {
  // The version being installed: an older Foreman starting means the install failed, and the note is ignored.
  version: string
  // A window was open: it opens again.
  window: boolean
  at: number
}

/** The note's text, written just before the installer runs. */
export function relaunchNote(version: string, window: boolean, now = Date.now()): string {
  return JSON.stringify({ version, window, at: now } satisfies RelaunchNote)
}

/** Read at startup: the note, when it is for this version and recent. The caller removes the file either way. */
export function readRelaunchNote(text: string | null, version: string, now = Date.now()): RelaunchNote | null {
  if (!text) return null
  try {
    const note = JSON.parse(text) as Partial<RelaunchNote>
    if (note.version !== version || typeof note.at !== 'number' || now - note.at > RELAUNCH_MAX_MS || note.at > now + 60_000) return null
    return { version: note.version, window: note.window === true, at: note.at }
  } catch {
    return null
  }
}
