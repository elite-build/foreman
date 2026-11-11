// The background service (src/main/service.ts; docs/server.md, "As a service"): the files each platform gets, installing
// and removing them through fakes, the update rule and the relaunch note, and `foreman service` (src/main/cli/service.ts).
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { CliError } from '../src/cli/client'
import type { Context } from '../src/cli/command'
import { appRunners, waitForRestart } from '../src/cli/commands/app'
import { renderCommandHelp } from '../src/cli/help'
import { CliCodedError, type ServiceHost } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { SERVICE_METHODS } from '../src/main/cli/service'
import { METHODS, tierCheck } from '../src/main/cliServer'
import {
  installNotes,
  launchArgs,
  launchdPlist,
  parseDataDir,
  parseService,
  readRelaunchNote,
  relaunchNote,
  restartArgs,
  restartProblem,
  serviceLaunch,
  serviceLocation,
  ServiceManager,
  serviceProblem,
  serviceUpdateDue,
  systemdUnit,
  taskAction,
  taskXml,
  windowsWord,
  type ServiceDeps,
  type ServiceFacts,
  type ServiceState
} from '../src/main/service'
import type { ServiceRestartResult, ServiceStatusResult, ServiceUninstallResult } from '../src/shared/cli/service'
import { COMMANDS, commandName, findCommand } from '../src/shared/cliCommands'
import { defaultSettings } from '../src/main/store'
import { stubHost } from './cliHost'

const mac: ServiceFacts = { platform: 'darwin', home: '/Users/ada', execPath: '/Applications/Foreman.app/Contents/MacOS/Foreman', appPath: '/Applications/Foreman.app/Contents/Resources/app.asar', packaged: true }
const linux: ServiceFacts = { platform: 'linux', home: '/home/ada', execPath: '/tmp/.mount_ForemaXYZ/foreman', appPath: '/tmp/.mount_ForemaXYZ/resources/app.asar', packaged: true, appImage: '/home/ada/Apps/Foreman.AppImage', display: { DISPLAY: ':0' } }
const windows: ServiceFacts = { platform: 'win32', home: 'C:\\Users\\ada', execPath: 'C:\\Users\\ada\\AppData\\Local\\Programs\\Foreman\\Foreman.exe', appPath: 'C:\\Users\\ada\\AppData\\Local\\Programs\\Foreman\\resources\\app.asar', packaged: true, user: 'PC\\ada', tempDir: 'C:\\Temp' }

describe('the flags', () => {
  it('finds --service after the executable', () => {
    expect(parseService(['Foreman.exe', '--headless', '--service'])).toBe(true)
    expect(parseService(['electron', '.', '--service'])).toBe(true)
    expect(parseService(['--service'])).toBe(false)
    expect(parseService(['Foreman.exe', '--service=no'])).toBe(false)
  })

  it('reads --data-dir= only in its one-word form, so a folder is never read as one to open', () => {
    expect(parseDataDir(['Foreman.exe', '--data-dir=C:\\Foreman data'])).toBe('C:\\Foreman data')
    expect(parseDataDir(['Foreman.exe', '--data-dir='])).toBeUndefined()
    expect(parseDataDir(['Foreman.exe', '--data-dir', '/tmp/x'])).toBeUndefined()
    expect(parseDataDir(['--data-dir=/x'])).toBeUndefined()
  })
})

describe('what the service starts', () => {
  it('starts an installed Foreman by its binary, headless and marked as the service’s', () => {
    expect(serviceLaunch(mac)).toEqual({ command: mac.execPath, args: ['--headless', '--service'] })
    expect(serviceLaunch(windows)).toEqual({ command: windows.execPath, args: ['--headless', '--service'] })
  })

  it('starts the AppImage on Linux, not the mount it runs from', () => {
    expect(serviceLaunch(linux).command).toBe('/home/ada/Apps/Foreman.AppImage')
    expect(serviceLaunch({ ...linux, appImage: undefined }).command).toBe(linux.execPath)
  })

  it('starts a development build through Electron with its app path, and keeps a data folder other than the default', () => {
    const dev = { ...windows, packaged: false, execPath: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe', appPath: 'C:\\repo', dataDir: 'C:\\Foreman test' }
    expect(serviceLaunch(dev)).toEqual({ command: dev.execPath, args: ['C:\\repo', '--headless', '--service', '--data-dir=C:\\Foreman test'] })
  })

  it('makes every start of this copy the same way: app path first in development, flags, then its data folder', () => {
    expect(launchArgs(windows, ['--service', '--update-retry'])).toEqual(['--service', '--update-retry'])
    expect(launchArgs({ packaged: false, appPath: 'C:\\repo', dataDir: 'D:\\data' }, ['--headless'])).toEqual(['C:\\repo', '--headless', '--data-dir=D:\\data'])
  })

  it('restarts as the service starts it, without --headless when a window is open', () => {
    const launch = serviceLaunch({ ...windows, dataDir: 'D:\\data' })
    expect(restartArgs(launch, false)).toEqual(['--headless', '--service', '--data-dir=D:\\data'])
    expect(restartArgs(launch, true)).toEqual(['--service', '--data-dir=D:\\data'])
  })

  it('restarts only an installed service that starts this copy, and with work running only when forced', () => {
    const ok = { installed: true, current: true, busy: false, force: false }
    expect(restartProblem(ok)).toBeNull()
    expect(restartProblem({ ...ok, busy: true, force: true })).toBeNull()
    expect(restartProblem({ ...ok, installed: false, current: false })).toMatchObject({ code: 'not-found', hint: expect.stringContaining('foreman service install') })
    expect(restartProblem({ ...ok, current: false })).toMatchObject({ code: 'refused', message: expect.stringContaining('another copy') })
    expect(restartProblem({ ...ok, busy: true })).toMatchObject({ code: 'busy', hint: expect.stringContaining('--force') })
  })

  it('refuses a macOS app run from a disk image or a translocated copy', () => {
    expect(serviceProblem(mac)).toBeNull()
    expect(serviceProblem({ ...mac, execPath: '/Volumes/Foreman/Foreman.app/Contents/MacOS/Foreman' })).toMatch(/Applications folder/)
    expect(serviceProblem({ ...mac, execPath: '/private/var/folders/x/AppTranslocation/1/d/Foreman.app/Contents/MacOS/Foreman' })).toMatch(/Applications folder/)
    expect(serviceProblem({ ...linux, platform: 'freebsd' })).toMatch(/freebsd/)
  })

  it('is registered where each system looks', () => {
    expect(serviceLocation(mac)).toBe('/Users/ada/Library/LaunchAgents/dev.foreman.app.service.plist')
    expect(serviceLocation(linux)).toBe('/home/ada/.config/systemd/user/foreman.service')
    expect(serviceLocation({ ...linux, configHome: '/home/ada/.cfg' })).toBe('/home/ada/.cfg/systemd/user/foreman.service')
    expect(serviceLocation(windows)).toBe('Foreman')
  })
})

describe('the files', () => {
  it('launchd: at login in the GUI session, again after a crash but not after Quit, with each word escaped', () => {
    const plist = launchdPlist({ command: '/Apps/A&B <Foreman>.app/Contents/MacOS/Foreman', args: ['--headless', '--service'] })
    expect(plist).toContain('<string>dev.foreman.app.service</string>')
    expect(plist).toContain('<string>/Apps/A&amp;B &lt;Foreman&gt;.app/Contents/MacOS/Foreman</string>\n    <string>--headless</string>\n    <string>--service</string>')
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/)
    expect(plist).toMatch(/<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/)
    expect(plist).toMatch(/<key>LimitLoadToSessionType<\/key>\s*<string>Aqua<\/string>/)
  })

  it('systemd: quoted words with % doubled, the display carried, restarted only after a failure', () => {
    const unit = systemdUnit({ command: '/home/ada/My Apps/Foreman.AppImage', args: ['--headless', '--service', '--data-dir=/home/ada/100%'] }, { display: { DISPLAY: ':0', WAYLAND_DISPLAY: undefined } })
    expect(unit).toContain('ExecStart="/home/ada/My Apps/Foreman.AppImage" "--headless" "--service" "--data-dir=/home/ada/100%%"')
    expect(unit).toContain('Environment="DISPLAY=:0"')
    expect(unit).not.toContain('WAYLAND_DISPLAY')
    expect(unit).toContain('Restart=on-failure')
    expect(unit).toContain('WantedBy=default.target')
  })

  it('systemd: with no display, runs Foreman under xvfb-run when it is installed', () => {
    const launch = { command: '/opt/Foreman.AppImage', args: ['--headless', '--service'] }
    expect(systemdUnit(launch, { display: {}, xvfbRun: '/usr/bin/xvfb-run' })).toContain('ExecStart="/usr/bin/xvfb-run" "-a" "/opt/Foreman.AppImage" "--headless" "--service"')
    expect(systemdUnit(launch, { display: { DISPLAY: ':1' }, xvfbRun: '/usr/bin/xvfb-run' })).toContain('ExecStart="/opt/Foreman.AppImage"')
    expect(systemdUnit(launch, { display: {}, xvfbRun: null })).toContain('ExecStart="/opt/Foreman.AppImage"')
  })

  it('Task Scheduler: at this user’s logon in their session, no time limit, not stopped on battery, normal priority', () => {
    const task = taskXml({ command: 'C:\\Program Files\\Foreman\\Foreman.exe', args: ['--headless', '--service', '--data-dir=C:\\A & B'] }, 'PC\\ada')
    expect(task).toMatch(/<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>PC\\ada<\/UserId>/)
    expect(task).toContain('<LogonType>InteractiveToken</LogonType>')
    expect(task).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(task).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(task).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>')
    expect(task).toContain('<Priority>5</Priority>')
    expect(task).toContain('<Arguments>--headless --service &quot;--data-dir=C:\\A &amp; B&quot;</Arguments>')
    // What `schtasks /Query /XML` prints back reads as the same command.
    expect(taskAction(task)).toEqual({ command: 'C:\\Program Files\\Foreman\\Foreman.exe', args: '--headless --service "--data-dir=C:\\A & B"' })
    expect(taskAction('<Task></Task>')).toBeNull()
  })

  it('quotes a Windows word only when it needs it', () => {
    expect(windowsWord('--headless')).toBe('--headless')
    expect(windowsWord('C:\\Program Files\\x')).toBe('"C:\\Program Files\\x"')
    expect(windowsWord('')).toBe('""')
  })
})

/** File and process fakes: a folder of files and the commands run, each answering ok unless told otherwise. */
function fakeDeps(facts: ServiceFacts, answers: Record<string, { ok: boolean; stdout?: string; stderr?: string }> = {}) {
  const files = new Map<string, string>()
  const runs: string[] = []
  const deps: ServiceDeps = {
    facts,
    readFile: async (file) => files.get(file) ?? null,
    writeFile: async (file, data) => void files.set(file, typeof data === 'string' ? data : data.toString('utf16le')),
    removeFile: async (file) => void files.delete(file),
    run: async (file, args) => {
      const line = [file, ...args].join(' ')
      runs.push(line)
      const answer = Object.entries(answers).find(([prefix]) => line.startsWith(prefix))?.[1] ?? { ok: true }
      return { ok: answer.ok, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
    }
  }
  return { deps, files, runs }
}

describe('ServiceManager', () => {
  it('macOS: writes the agent without loading it, says it is current, and removes it', async () => {
    const { deps, files, runs } = fakeDeps(mac)
    const manager = new ServiceManager(deps)
    expect(await manager.status()).toMatchObject({ kind: 'launchd', installed: false, current: false })
    expect(await manager.install()).toMatchObject({ installed: true, current: true, where: serviceLocation(mac) })
    expect(files.get(serviceLocation(mac))).toBe(launchdPlist(serviceLaunch(mac)))
    // Loading it now would start a second Foreman; unloading later would stop the one asking.
    expect(runs).toEqual([])
    // Another copy's agent is installed but not current.
    files.set(serviceLocation(mac), launchdPlist({ command: '/Users/ada/Downloads/Foreman.app/Contents/MacOS/Foreman', args: ['--headless'] }))
    expect(await manager.status()).toMatchObject({ installed: true, current: false })
    expect(await manager.uninstall()).toMatchObject({ installed: false })
    expect(files.size).toBe(0)
    expect(runs).toEqual([])
  })

  it('macOS: refuses a translocated app before writing anything', async () => {
    const { deps, files } = fakeDeps({ ...mac, execPath: '/Volumes/Foreman/Foreman.app/Contents/MacOS/Foreman' })
    await expect(new ServiceManager(deps).install()).rejects.toThrow(/Applications folder/)
    expect(files.size).toBe(0)
  })

  it('Linux: writes the unit, reloads and enables it, and on removal disables it without stopping it', async () => {
    const { deps, files, runs } = fakeDeps(linux)
    const manager = new ServiceManager(deps)
    expect(await manager.install()).toMatchObject({ kind: 'systemd', installed: true, current: true })
    expect(files.get(serviceLocation(linux))).toContain('ExecStart="/home/ada/Apps/Foreman.AppImage" "--headless" "--service"')
    expect(runs).toEqual(['systemctl --user daemon-reload', 'systemctl --user enable foreman.service'])
    runs.length = 0
    expect(await manager.uninstall()).toMatchObject({ installed: false })
    expect(runs).toEqual(['systemctl --user disable foreman.service', 'systemctl --user daemon-reload'])
    expect(runs.some((r) => r.includes('stop'))).toBe(false)
  })

  it('Linux: says what systemd answered when it refuses', async () => {
    const { deps } = fakeDeps(linux, { 'systemctl --user enable': { ok: false, stderr: 'Failed to connect to bus: No medium found' } })
    await expect(new ServiceManager(deps).install()).rejects.toThrow('systemd didn’t enable the unit: Failed to connect to bus: No medium found')
  })

  it('Windows: creates the task from a UTF-16 file it then deletes, reads it back, and deletes the task', async () => {
    const launch = serviceLaunch(windows)
    const queried = taskXml(launch, 'PC\\ada')
    let installed = false
    const { deps, files, runs } = fakeDeps(windows)
    const written: Buffer[] = []
    deps.writeFile = async (file, data) => {
      written.push(Buffer.isBuffer(data) ? data : Buffer.from(data))
      files.set(file, 'x')
    }
    const run = deps.run
    deps.run = async (file, args) => {
      const answer = await run(file, args)
      if (args[0] === '/Create') installed = true
      if (args[0] === '/Delete') installed = false
      if (args[0] === '/Query') return installed ? { ok: true, stdout: queried, stderr: '' } : { ok: false, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' }
      return answer
    }
    const manager = new ServiceManager(deps)
    expect(await manager.status()).toMatchObject({ kind: 'task-scheduler', installed: false, where: 'Foreman' })
    expect(await manager.install()).toMatchObject({ installed: true, current: true })
    expect(runs[1]).toMatch(/^schtasks \/Create \/TN Foreman \/XML C:\\Temp[\\/]foreman-service-\d+\.xml \/F$/)
    // The file schtasks reads is UTF-16 with a byte-order mark, and it is gone afterwards.
    expect([...written[0].subarray(0, 2)]).toEqual([0xff, 0xfe])
    expect(written[0].subarray(2).toString('utf16le')).toBe(queried)
    expect(files.size).toBe(0)
    expect(await manager.uninstall()).toMatchObject({ installed: false })
    expect(runs).toContain('schtasks /Delete /TN Foreman /F')
  })

  it('Windows: a task that starts another copy is installed but not current, and removing nothing runs nothing', async () => {
    const other = taskXml({ command: 'D:\\Old\\Foreman.exe', args: ['--headless'] }, 'PC\\ada')
    const { deps, runs } = fakeDeps(windows, { 'schtasks /Query': { ok: true, stdout: other } })
    expect(await new ServiceManager(deps).status()).toMatchObject({ installed: true, current: false })
    const none = fakeDeps(windows, { 'schtasks /Query': { ok: false } })
    await new ServiceManager(none.deps).uninstall()
    expect(none.runs.filter((r) => r.includes('/Delete'))).toEqual([])
    expect(runs.length).toBe(1)
  })

  it('Windows: says what Task Scheduler answered when it refuses, and still deletes the file', async () => {
    const { deps, files } = fakeDeps(windows, { 'schtasks /Create': { ok: false, stderr: 'ERROR: Access is denied.' } })
    await expect(new ServiceManager(deps).install()).rejects.toThrow('Task Scheduler refused the task: ERROR: Access is denied.')
    expect(files.size).toBe(0)
  })
})

describe('installNotes', () => {
  it('says nothing for an installed build on macOS or Windows', () => {
    expect(installNotes(mac)).toEqual([])
    expect(installNotes(windows)).toEqual([])
  })

  it('names a development build and a data folder of its own', () => {
    const notes = installNotes({ ...windows, packaged: false, appPath: 'C:\\repo', dataDir: 'C:\\data' })
    expect(notes[0]).toMatch(/development build.*C:\\repo/)
    expect(notes[1]).toMatch(/C:\\data/)
  })

  it('on Linux, says how it gets a display and how to start it at boot', () => {
    expect(installNotes(linux).join('\n')).toMatch(/loginctl enable-linger/)
    expect(installNotes({ ...linux, display: {}, xvfbRun: '/usr/bin/xvfb-run' }).join('\n')).toMatch(/under xvfb-run/)
    expect(installNotes({ ...linux, display: {}, xvfbRun: null }).join('\n')).toMatch(/Install Xvfb/)
  })
})

describe('updating itself', () => {
  const due = { service: true, readyVersion: '1.0.22', windows: 0, busy: false }

  it('restarts the service’s Foreman for a downloaded update once nobody is using it', () => {
    expect(serviceUpdateDue(due)).toBe(true)
  })

  it('leaves it to the window, to running work, and to a Foreman the service didn’t start', () => {
    expect(serviceUpdateDue({ ...due, service: false })).toBe(false)
    expect(serviceUpdateDue({ ...due, readyVersion: undefined })).toBe(false)
    expect(serviceUpdateDue({ ...due, windows: 1 })).toBe(false)
    expect(serviceUpdateDue({ ...due, busy: true })).toBe(false)
  })

  it('doesn’t install by itself a version whose update was rolled back here, but does a newer one', () => {
    expect(serviceUpdateDue({ ...due, failedVersion: '1.0.22' })).toBe(false)
    expect(serviceUpdateDue({ ...due, readyVersion: '1.0.23', failedVersion: '1.0.22' })).toBe(true)
  })

  it('reads the relaunch note back only for the version it named, and only while it is recent', () => {
    const now = 1_762_790_400_000
    const text = relaunchNote('1.0.22', false, now)
    expect(readRelaunchNote(text, '1.0.22', now + 90_000)).toEqual({ version: '1.0.22', window: false, at: now })
    expect(readRelaunchNote(relaunchNote('1.0.22', true, now), '1.0.22', now)).toMatchObject({ window: true })
    // The install failed and the old version started: not the service's restart.
    expect(readRelaunchNote(text, '1.0.21', now)).toBeNull()
    expect(readRelaunchNote(text, '1.0.22', now + 31 * 60_000)).toBeNull()
    expect(readRelaunchNote(text, '1.0.22', now - 5 * 60_000)).toBeNull()
    expect(readRelaunchNote(null, '1.0.22', now)).toBeNull()
    expect(readRelaunchNote('{not json', '1.0.22', now)).toBeNull()
    expect(readRelaunchNote('{"version":"1.0.22"}', '1.0.22', now)).toBeNull()
  })
})

describe('index.ts and the service', () => {
  // index.ts can't be loaded outside Electron, so its wiring is read instead.
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

  it('hands --service to the running Foreman with the single-instance request, which then becomes the service’s', () => {
    expect(source).toMatch(/requestSingleInstanceLock\(\{ headless: parseHeadless\(process\.argv\), service: parseService\(process\.argv\) \}\)/)
    expect(source).toMatch(/asked\?\.service === true/)
  })

  it('writes the relaunch note only on the way to the installer, and reads it once after the single-instance lock', () => {
    expect(source).toMatch(/if \(!installUpdate \|\| !updateInstaller\) return app\.quit\(\)\r?\n\s*if \(updating\) writeRelaunchNote\(updating, windowOpen\)/)
    expect(source.indexOf('takeRelaunchNote()')).toBeGreaterThan(source.indexOf('requestSingleInstanceLock('))
  })

  it('settles an update’s trial after the lock and the relaunch note, before anything opens the data', () => {
    const at = source.indexOf('startTrial(app.getPath(')
    expect(at).toBeGreaterThan(source.indexOf('takeRelaunchNote()'))
    expect(at).toBeLessThan(source.indexOf('new Store(app.getPath('))
    // A human start is neither the service's nor a retry; one that can't put the data back doesn't open it.
    expect(source).toMatch(/human: !service && !parseRetry\(process\.argv\)/)
    expect(source).toMatch(/Foreman won’t open it:', err\)\r?\n\s*return app\.exit\(1\)/)
  })

  it('keeps the update once the command line serves, before schedules and flows start writing', () => {
    const commit = source.indexOf('commitTrial(app.getPath(')
    expect(commit).toBeGreaterThan(source.indexOf('cliServer = await startCliServer('))
    expect(commit).toBeLessThan(source.indexOf('core.schedules.start()'))
  })

  it('copies the data aside before restarting to install, and fails a try that throws by starting again with the retry flag', () => {
    expect(source.indexOf('takeSnapshot(dataDir')).toBeLessThan(source.indexOf('started.api.restartToUpdate(false)'))
    expect(source).toMatch(/if \(trialRun\) return failTry\(err\)/)
    expect(source).toMatch(/RETRY_FLAG\]\r?\n\s*app\.relaunch\(/)
  })
})

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

/** A ServiceHost over a ServiceState that install and uninstall change. */
function serviceHost(start: Partial<ServiceState> = {}, extra: Partial<ServiceHost> = {}) {
  const launch = serviceLaunch(windows)
  let state: ServiceState = { kind: 'task-scheduler', installed: false, current: false, where: 'Foreman', launch, ...start }
  const calls: string[] = []
  const service: ServiceHost = {
    status: async () => state,
    install: async () => {
      calls.push('install')
      return (state = { ...state, installed: true, current: true })
    },
    uninstall: async () => {
      calls.push('uninstall')
      return (state = { ...state, installed: false, current: false })
    },
    startedByService: false,
    canUpdate: () => true,
    notes: () => [],
    pid: 4242,
    busy: () => false,
    windowOpen: () => false,
    restart: (window) => void calls.push(`restart ${window ? 'window' : 'headless'}`),
    lastUpdate: () => null,
    ...extra
  }
  return { service, calls }
}

function hostWith(service: ServiceHost | undefined, settings: Partial<ReturnType<typeof defaultSettings>> = {}) {
  return stubHost({ service, state: () => ({ repos: [], workspaces: [], sessions: [], settings: { ...defaultSettings(), ...settings } }) })
}

const call = <T>(host: ReturnType<typeof hostWith>, method: string, params?: unknown) => SERVICE_METHODS[method].handle(host, params, ctx) as Promise<T>

describe('the service methods', () => {
  it('reads in read and installs or removes only in admin, the same as the command table says', () => {
    const tiers = { 'service-status': 'read', 'service-install': 'admin', 'service-uninstall': 'admin', 'service-restart': 'admin' }
    expect(Object.fromEntries(Object.entries(SERVICE_METHODS).map(([m, d]) => [m, d.tier]))).toEqual(tiers)
    const specs = COMMANDS.filter((c) => c.path[0] === 'service')
    expect(Object.fromEntries(specs.map((c) => [commandName(c), c.tier]))).toEqual({ service: 'read', 'service status': 'read', 'service install': 'admin', 'service uninstall': 'admin', 'service restart': 'admin' })
    for (const [m, tier] of Object.entries(tiers)) expect(METHODS[m]?.tier, m).toBe(tier)
  })

  it('refuses installing and removing from inside an agent turn, and serves status there', () => {
    const host = stubHost()
    const caller = { sessionId: 's', turnId: 't', token: 'turn-token' }
    for (const [method, def] of Object.entries(SERVICE_METHODS)) {
      const refusal = tierCheck(method, def.tier, { v: 2, method, params: {}, caller, token: 'test-token' }, host)
      if (def.tier === 'admin') expect(refusal, method).toMatchObject({ code: 'refused', error: expect.stringContaining('inside an agent turn') })
      else expect(refusal, method).toBeNull()
    }
  })

  it('says a Foreman without the service (tests, the demo) can’t install one', async () => {
    await expect(call(hostWith(undefined), 'service-status')).rejects.toMatchObject({ code: 'not-supported' })
    await expect(call(hostWith(undefined), 'service-install')).rejects.toBeInstanceOf(CliCodedError)
  })

  it('status: not installed says how to install it', async () => {
    const result = await call<ServiceStatusResult>(hostWith(serviceHost().service), 'service-status')
    expect(result).toMatchObject({ kind: 'task-scheduler', installed: false, startedByService: false, pid: 4242, updates: 'automatic', command: [windows.execPath, '--headless', '--service'] })
    expect(result).not.toHaveProperty('lastUpdate')
    expect(result.text).toMatch(/^Background service: not installed\.\nRun `foreman service install`/)
  })

  it('status: installed shows what it starts, whether this Foreman is it, and what it does with updates', async () => {
    const { service } = serviceHost({ installed: true, current: true }, { startedByService: true })
    const result = await call<ServiceStatusResult>(hostWith(service), 'service-status')
    expect(result.text.split('\n')).toEqual([
      'Background service: installed, as the Task Scheduler task “Foreman”.',
      'It starts: C:\\Users\\ada\\AppData\\Local\\Programs\\Foreman\\Foreman.exe --headless --service',
      'This Foreman was started by the service.',
      'Updates: it installs a downloaded update by itself once nothing is running and no window is open, then starts again.'
    ])
  })

  it('status: says when the service starts another copy, and each update setting', async () => {
    const { service } = serviceHost({ installed: true, current: false })
    expect((await call<ServiceStatusResult>(hostWith(service), 'service-status')).text).toMatch(/another copy.*`foreman service install` replaces it/)
    expect(await call<ServiceStatusResult>(hostWith(service, { updateMode: 'notify' }), 'service-status')).toMatchObject({ updates: 'notify', text: expect.stringContaining('general.update-mode download') })
    expect(await call<ServiceStatusResult>(hostWith(service, { checkForUpdates: false }), 'service-status')).toMatchObject({ updates: 'off' })
    const cant = serviceHost({ installed: true, current: true }, { canUpdate: () => false }).service
    expect(await call<ServiceStatusResult>(hostWith(cant), 'service-status')).toMatchObject({ updates: 'unavailable' })
  })

  it('status: says how the last update went, kept or put back and why', async () => {
    const at = Date.UTC(2026, 10, 10, 15, 4)
    const kept = serviceHost({ installed: true, current: true }, { lastUpdate: () => ({ from: '1.0.22', to: '1.0.23', at, outcome: 'kept', tries: 1 }) }).service
    const keptResult = await call<ServiceStatusResult>(hostWith(kept), 'service-status')
    expect(keptResult.lastUpdate).toEqual({ from: '1.0.22', to: '1.0.23', at: '2026-11-10T15:04:00.000Z', outcome: 'kept', tries: 1 })
    expect(keptResult.text.split('\n').at(-1)).toBe('Last update: 1.0.22 → 1.0.23 on 2026-11-10 15:04 UTC, kept.')
    const back = serviceHost({ installed: true, current: true }, { lastUpdate: () => ({ from: '1.0.22', to: '1.0.23', at, outcome: 'rolled-back', tries: 3, error: 'no such column: x' }) }).service
    expect((await call<ServiceStatusResult>(hostWith(back), 'service-status')).text.split('\n').at(-1)).toBe(
      'Last update: 1.0.23 didn’t start after 3 tries on 2026-11-10 15:04 UTC (no such column: x), so Foreman put the data back as 1.0.22 left it. The service won’t install 1.0.23 by itself again; a newer release, or the update card, will.'
    )
  })

  it('restart stops this Foreman and starts the service’s, with a window when one is open, once the checks pass', async () => {
    const headless = serviceHost({ installed: true, current: true })
    const result = await call<ServiceRestartResult>(hostWith(headless.service), 'service-restart')
    expect(headless.calls).toEqual(['restart headless'])
    expect(result).toMatchObject({ window: false, pid: 4242, text: 'Restarting Foreman as the Task Scheduler task “Foreman” starts it, with no window.' })
    const windowed = serviceHost({ installed: true, current: true }, { windowOpen: () => true })
    expect(await call<ServiceRestartResult>(hostWith(windowed.service), 'service-restart')).toMatchObject({ window: true })
    expect(windowed.calls).toEqual(['restart window'])
  })

  it('restart refuses with the service missing or another copy’s, and with work running unless forced', async () => {
    for (const [start, code] of [[{}, 'not-found'], [{ installed: true, current: false }, 'refused']] as const) {
      const { service, calls } = serviceHost(start)
      await expect(call(hostWith(service), 'service-restart', { force: true })).rejects.toMatchObject({ code })
      expect(calls).toEqual([])
    }
    const busy = serviceHost({ installed: true, current: true }, { busy: () => true })
    await expect(call(hostWith(busy.service), 'service-restart')).rejects.toMatchObject({ code: 'busy', hint: expect.stringContaining('--force') })
    await expect(call(hostWith(busy.service), 'service-restart', { force: 'yes' })).rejects.toMatchObject({ code: 'busy' })
    expect(busy.calls).toEqual([])
    await call(hostWith(busy.service), 'service-restart', { force: true })
    expect(busy.calls).toEqual(['restart headless'])
  })

  it('install registers it and says what changes now and at the next login, with this copy’s notes', async () => {
    const { service, calls } = serviceHost({}, { notes: () => ['This is a development build.'] })
    const result = await call<ServiceStatusResult>(hostWith(service), 'service-install')
    expect(calls).toEqual(['install'])
    expect(result).toMatchObject({ installed: true, current: true })
    expect(result.text).toMatch(/^Installed: Foreman now starts with no window when you log in, as the Task Scheduler task “Foreman”\./)
    expect(result.text).toContain('This Foreman keeps running now; the service starts it from the next login.')
    expect(result.text.split('\n').at(-1)).toBe('This is a development build.')
  })

  it('install passes on what the system refused as a failure', async () => {
    const { service } = serviceHost({}, { install: async () => Promise.reject(new Error('Task Scheduler refused the task: ERROR: Access is denied.')) })
    await expect(call(hostWith(service), 'service-install')).rejects.toMatchObject({ code: 'failed', message: 'Task Scheduler refused the task: ERROR: Access is denied.' })
  })

  it('uninstall removes it and leaves this Foreman running, and says when there was nothing to remove', async () => {
    const installed = serviceHost({ installed: true, current: true })
    const removed = await call<ServiceUninstallResult>(hostWith(installed.service), 'service-uninstall')
    expect(installed.calls).toEqual(['uninstall'])
    expect(removed).toMatchObject({ removed: true, installed: false })
    expect(removed.text).toBe('Removed the Task Scheduler task “Foreman”: Foreman no longer starts when you log in.\nThis Foreman keeps running; quit it from the tray when you’re done.')
    const none = serviceHost()
    expect(await call<ServiceUninstallResult>(hostWith(none.service), 'service-uninstall')).toMatchObject({ removed: false, text: 'Nothing to remove: the background service isn’t installed.' })
    expect(none.calls).toEqual([])
  })
})

describe('the service commands', () => {
  function fakeContext(args: string[]) {
    const sent: string[] = []
    const context = {
      args,
      opts: {},
      json: false,
      quiet: false,
      yes: false,
      cwd: '/work',
      send: (async (method: string) => {
        sent.push(method)
        return { text: `${method} ok` }
      }) as Context['send'],
      print: () => undefined,
      confirm: async () => true,
      note: () => undefined,
      progress: () => undefined
    } as Context
    return { context, sent }
  }

  afterEach(() => void (process.exitCode = undefined))

  it('sends each command’s method, and refuses words they don’t take', async () => {
    for (const [name, args, method] of [
      ['service', [], 'service-status'],
      ['service', ['status'], 'service-status'],
      ['service status', [], 'service-status'],
      ['service install', [], 'service-install'],
      ['service uninstall', [], 'service-uninstall']
    ] as const) {
      const { context, sent } = fakeContext([...args])
      await appRunners[name](context)
      expect(sent, name).toEqual([method])
    }
    for (const [name, args] of [
      ['service', ['start']],
      ['service install', ['now']],
      ['service uninstall', ['x']]
    ] as const) {
      const { context, sent } = fakeContext([...args])
      await expect(appRunners[name](context), name).rejects.toThrow()
      expect(sent).toEqual([])
    }
  })

  it('restart sends --force, then waits for another Foreman to answer, through the moment none does', async () => {
    const sent: [string, unknown][] = []
    const replies: (() => unknown)[] = [
      () => ({ pid: 1, window: false, text: 'Restarting…' }),
      () => ({ pid: 1 }),
      () => {
        throw new CliError('Foreman isn’t running.', 5, 'not-running')
      },
      () => ({ pid: 2, text: 'status' })
    ]
    const printed: unknown[] = []
    const context = {
      ...fakeContext([]).context,
      opts: { force: true },
      send: (async (method: string, params?: unknown) => {
        sent.push([method, params])
        return replies.shift()!()
      }) as Context['send'],
      print: (value: unknown) => void printed.push(value)
    } as Context
    await appRunners['service restart'](context)
    expect(sent).toEqual([['service-restart', { force: true }], ['service-status', undefined], ['service-status', undefined], ['service-status', undefined]])
    expect(printed).toEqual([{ pid: 1, window: false, text: 'Restarting…', back: { pid: 2, text: 'status' } }])
  }, 10_000)

  it('restart gives up when Foreman doesn’t come back, and passes on any other failure', async () => {
    const failing = (err: CliError) => ({ ...fakeContext([]).context, send: (async () => Promise.reject(err)) as Context['send'] }) as Context
    await expect(waitForRestart(failing(new CliError('Foreman isn’t running.', 5, 'not-running')), 1, { tries: 3, delayMs: 0 })).rejects.toMatchObject({ code: 'failed', message: expect.stringContaining('hasn’t come back') })
    const same = { ...fakeContext([]).context, send: (async () => ({ pid: 1 })) as Context['send'] } as Context
    await expect(waitForRestart(same, 1, { tries: 2, delayMs: 0 })).rejects.toMatchObject({ code: 'failed' })
    await expect(waitForRestart(failing(new CliError('Refused.', 7, 'refused')), 1, { tries: 3, delayMs: 0 })).rejects.toMatchObject({ code: 'refused' })
    const { context, sent } = fakeContext(['now'])
    await expect(appRunners['service restart'](context)).rejects.toThrow('takes no more words')
    expect(sent).toEqual([])
  })

  it('has a help page and resolving examples for every command', () => {
    for (const spec of COMMANDS.filter((c) => c.path[0] === 'service')) {
      expect(renderCommandHelp(spec)).toContain(spec.usage)
      for (const example of spec.examples ?? []) expect(findCommand(example.replace(/^foreman /, '').split(' ')), example).toMatchObject({ spec: { path: spec.path } })
    }
  })
})
