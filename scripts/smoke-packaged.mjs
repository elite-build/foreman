// Smoke test of a packaged Foreman, run by the Installers workflow after each installer is built (see "Installers" in
// docs/maintenance.md):
//
//   node scripts/smoke-packaged.mjs <folder with the installer> [--version <x.y.z>]
//
// It installs or unpacks what users download (macOS: copies Foreman.app out of the DMG; Windows: installs the NSIS
// installer silently, for this user, into a temporary folder), starts it with --headless and a fresh, empty
// FOREMAN_DATA_DIR, and checks that it:
//
//   1. starts and keeps running,
//   2. creates foreman.db (a SQLite file) and cli.token in that folder,
//   3. answers `app-info` on its command-line socket (named pipe on Windows) as the packaged build of this version,
//      using that folder,
//   4. refuses an admin-tier request that carries no token, or a wrong one, and lets the same request past the
//      token check with the right one (it then fails for its empty parameters, changing nothing).
//
// Then it stops the app and uninstalls it. --headless opens no window, but Electron still needs the desktop session
// that GitHub's macOS and Windows runners have; it is not run on Linux, which has no installer here.
// Only Node built-ins, so it runs before or without an install.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const DB_FILE = 'foreman.db'
export const TOKEN_FILE = 'cli.token'
const SQLITE_HEADER = 'SQLite format 3\0'

/**
 * Where a Foreman using `dataDir` listens: the same rule as socketPath in src/cli/protocol.ts (tests/smokePackaged.test.ts
 * holds the two together). A named pipe on Windows; elsewhere cli.sock in the folder, or in `tmp` when that is too long.
 */
export function socketPathFor(dataDir, platform = process.platform, tmp = os.tmpdir()) {
  const id = createHash('sha256').update(path.resolve(dataDir)).digest('hex').slice(0, 12)
  if (platform === 'win32') return `\\\\.\\pipe\\foreman-${id}`
  const inData = path.join(dataDir, 'cli.sock')
  return Buffer.byteLength(inData) < 100 ? inData : path.join(tmp, `foreman-${id}.sock`)
}

/** The one installer for `platform` among `files` (names in the dist folder), or an error saying what was there. */
export function findInstaller(files, platform) {
  const pattern = platform === 'darwin' ? /\.dmg$/i : platform === 'win32' ? /Setup.*\.exe$/i : null
  if (!pattern) throw new Error(`No packaged smoke test for ${platform}`)
  const found = files.filter((f) => pattern.test(f))
  if (found.length !== 1) throw new Error(`Expected one ${platform === 'darwin' ? 'DMG' : 'Windows installer'}, found ${found.length ? found.join(', ') : 'none'}`)
  return found[0]
}

/**
 * The commands that install `installer` into `root` and remove it again, and the executable to start. Each command is
 * [file, args]. NSIS reads /D= raw and last, so a Windows `root` must have no spaces (and the args go verbatim).
 */
export function installPlan(platform, installer, root) {
  if (platform === 'darwin') {
    const mount = path.join(root, 'mnt')
    const app = path.join(root, 'Foreman.app')
    return {
      install: [
        ['hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount, installer]],
        ['ditto', [path.join(mount, 'Foreman.app'), app]],
        ['hdiutil', ['detach', mount]]
      ],
      executable: path.join(app, 'Contents', 'MacOS', 'Foreman'),
      uninstall: []
    }
  }
  if (platform === 'win32') {
    if (/\s/.test(root)) throw new Error(`The install folder must have no spaces for NSIS's /D=: ${root}`)
    const dir = path.join(root, 'app')
    return {
      install: [[installer, ['/S', '/currentuser', `/D=${dir}`]]],
      executable: path.join(dir, 'Foreman.exe'),
      uninstall: [[path.join(dir, 'Uninstall Foreman.exe'), ['/S', '/currentuser']]]
    }
  }
  throw new Error(`No packaged smoke test for ${platform}`)
}

/** Whether `bytes` start like a SQLite database file. */
export function isSqlite(bytes) {
  return bytes.length >= 16 && bytes.subarray(0, 16).toString('latin1') === SQLITE_HEADER
}

const samePath = (a, b, platform) => {
  const [x, y] = [path.resolve(a), path.resolve(b)]
  return platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y
}

/** What is wrong with the app's answer to `app-info`, or nothing. */
export function healthProblems(reply, expected) {
  if (!reply || reply.ok !== true || typeof reply.result !== 'object' || !reply.result) return [`app-info failed: ${JSON.stringify(reply)}`]
  const r = reply.result
  const problems = []
  if (r.packaged !== true) problems.push('app-info says this is not a packaged build')
  if (expected.version && r.version !== expected.version) problems.push(`app-info reports version ${r.version}, expected ${expected.version}`)
  if (typeof r.dataDir !== 'string' || !samePath(r.dataDir, expected.dataDir, expected.platform)) problems.push(`app-info reports the data folder ${r.dataDir}, expected ${expected.dataDir}`)
  if (expected.socket && r.socket !== expected.socket) problems.push(`app-info reports the socket ${r.socket}, expected ${expected.socket}`)
  return problems
}

/** What is wrong with the answer to an admin request that should have been refused for its token, or nothing. */
export function refusalProblems(reply, label) {
  return reply?.ok === false && reply.code === 'refused' ? [] : [`${label} was not refused: ${JSON.stringify(reply)}`]
}

/** What is wrong with the answer to the same request with the right token: it must get past the token check. */
export function acceptedProblems(reply) {
  if (reply?.ok === false && reply.code === 'refused') return [`the request with the right token was refused: ${reply.error}`]
  if (!reply || typeof reply.ok !== 'boolean') return [`the request with the right token got no reply: ${JSON.stringify(reply)}`]
  return []
}

// The admin request the token checks use. settings-set is admin tier; with no pairs it fails as invalid, changing nothing.
export const ADMIN_PROBE = { v: 2, method: 'settings-set', params: {} }

/** Send one request line to the socket and resolve with the last JSON line of the answer. */
export function request(socket, body, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const conn = net.connect(socket)
    let text = ''
    const timer = setTimeout(() => conn.destroy(new Error(`No answer from ${socket} within ${timeoutMs} ms`)), timeoutMs)
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(`${JSON.stringify(body)}\n`))
    conn.on('data', (chunk) => (text += chunk))
    conn.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    conn.on('end', () => {
      clearTimeout(timer)
      const last = text.split('\n').filter((line) => line.trim()).pop()
      try {
        resolve(last === undefined ? null : JSON.parse(last))
      } catch {
        reject(new Error(`Not a JSON answer: ${last}`))
      }
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function run([file, args]) {
  console.log(`> ${path.basename(file)} ${args.join(' ')}`)
  // NSIS takes /D= unquoted, so the install's arguments go as they are (none has a space); everything else is quoted as usual.
  const verbatim = process.platform === 'win32' && args.some((a) => a.startsWith('/D='))
  execFileSync(file, args, { stdio: 'inherit', timeout: 300_000, windowsVerbatimArguments: verbatim })
}

function tail(file, lines = 60) {
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return '(no log)'
  }
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise((resolve) => child.once('exit', resolve))
  // Electron's GPU and utility processes are children of the app; take the whole tree down.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  else child.kill('SIGTERM')
  if (await Promise.race([exited.then(() => true), sleep(15_000).then(() => false)])) return
  child.kill('SIGKILL')
  await Promise.race([exited, sleep(5_000)])
}

/** Install, start and probe the packaged app in `dist`; resolves with the problems found (empty when it passed). */
export async function smoke(dist, { version, platform = process.platform, startupMs = 180_000 } = {}) {
  const installer = path.join(dist, findInstaller(readdirSync(dist), platform))
  const root = mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'foreman-smoke-'))
  const dataDir = path.join(root, 'data')
  mkdirSync(dataDir)
  const log = path.join(root, 'foreman.log')
  const plan = installPlan(platform, installer, root)
  const problems = []
  let child = null
  try {
    // hdiutil mounts the DMG on a folder that exists.
    if (platform === 'darwin') mkdirSync(path.join(root, 'mnt'))
    for (const step of plan.install) run(step)
    // The NSIS installer can return a moment before its last file lands.
    for (let i = 0; i < 20 && !existsSync(plan.executable); i++) await sleep(500)
    if (!existsSync(plan.executable)) return [`Installing left no ${plan.executable}`]
    if (readdirSync(dataDir).length) return [`The data folder ${dataDir} is not empty before the start`]

    const env = { ...process.env, FOREMAN_DATA_DIR: dataDir, ELECTRON_ENABLE_LOGGING: '1' }
    // Either would make this something other than the app as a user starts it.
    for (const name of ['ELECTRON_RUN_AS_NODE', 'SWITCHYARD_DATA_DIR']) delete env[name]
    const out = openSync(log, 'a')
    console.log(`Starting ${plan.executable} --headless with FOREMAN_DATA_DIR=${dataDir}`)
    child = spawn(plan.executable, ['--headless'], { env, stdio: ['ignore', out, out] })
    closeSync(out)
    let exit = null
    child.once('exit', (code, signal) => (exit = { code, signal }))

    const socket = socketPathFor(dataDir, platform)
    const deadline = Date.now() + startupMs
    let info = null
    let lastError = 'nothing yet'
    while (Date.now() < deadline && !exit) {
      if (existsSync(path.join(dataDir, TOKEN_FILE))) {
        try {
          info = await request(socket, { v: 2, method: 'app-info' })
          if (info?.ok) break
          lastError = JSON.stringify(info)
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }
      await sleep(1_000)
    }
    if (exit) return [`Foreman exited during start-up (${JSON.stringify(exit)}). Its log ends:\n${tail(log)}`]
    if (!info?.ok) return [`Foreman did not answer app-info on ${socket} within ${startupMs / 1000} s (last: ${lastError}). Its log ends:\n${tail(log)}`]
    console.log(`app-info: ${JSON.stringify(info.result)}`)
    problems.push(...healthProblems(info, { version, dataDir, socket, platform }))

    const db = path.join(dataDir, DB_FILE)
    if (!existsSync(db)) problems.push(`No ${DB_FILE} in ${dataDir}`)
    else if (!isSqlite(readFileSync(db).subarray(0, 16))) problems.push(`${DB_FILE} is not a SQLite database`)
    const token = readFileSync(path.join(dataDir, TOKEN_FILE), 'utf8').trim()
    if (!/^[0-9a-f]{64}$/.test(token)) problems.push(`${TOKEN_FILE} does not hold a token`)

    problems.push(...refusalProblems(await request(socket, ADMIN_PROBE), 'An admin request without a token'))
    problems.push(...refusalProblems(await request(socket, { ...ADMIN_PROBE, token: '0'.repeat(64) }), 'An admin request with a wrong token'))
    problems.push(...acceptedProblems(await request(socket, { ...ADMIN_PROBE, token })))

    await sleep(2_000)
    if (exit) problems.push(`Foreman exited after answering (${JSON.stringify(exit)})`)
    return problems
  } finally {
    if (child) await stop(child)
    for (const step of plan.uninstall) {
      try {
        run(step)
      } catch (err) {
        console.warn(`Uninstalling failed: ${err instanceof Error ? err.message : err}`)
      }
    }
    if (problems.length) console.log(`Foreman's log ends:\n${tail(log)}`)
    // Windows may hold a file for a moment after the process tree is gone.
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 })
  }
}

// import.meta.url is the real path; argv[1] may reach it through a symlink, junction or subst drive.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const args = process.argv.slice(2)
  const at = args.indexOf('--version')
  const version = at >= 0 ? args.splice(at, 2)[1] : JSON.parse(readFileSync('package.json', 'utf8')).version
  const [dist] = args
  try {
    if (!dist || args.length !== 1) throw new Error('Usage: node scripts/smoke-packaged.mjs <folder with the installer> [--version <x.y.z>]')
    const problems = await smoke(path.resolve(dist), { version })
    if (problems.length) {
      for (const p of problems) console.error(process.env.GITHUB_ACTIONS ? `::error::${p.split('\n')[0]}\n${p}` : p)
      process.exitCode = 1
    } else console.log(`The packaged Foreman ${version} started, made its database, answered on its socket and refused requests without its token.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
