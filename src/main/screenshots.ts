// Dev-only screenshot run. Only with FOREMAN_SCREENSHOTS=1, which
// scripts/screenshots.mjs sets: the app starts on a throwaway data folder seeded with a small fixture, main loads the
// page with ?screens, asks the renderer's hook (renderer/src/screens.ts) to show each screen, captures it with
// webContents.capturePage and quits. Next to each PNG it writes <name>.ax.json, the reduced accessibility tree
// (axTree.ts), and warns about unnamed focusable elements, skipped heading levels and a wrong count of main landmarks.
// With FOREMAN_SCREENSHOTS_WALK=1 (`--walk`) it then plays the keyboard walks (walks.ts, keyboardWalk.ts): real keys through
// the DevTools protocol, the focus and live-region text recorded after each, compared with tests/fixtures/walks.
// Without the flag nothing here runs.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { nativeTheme, type BrowserWindow } from 'electron'
import type { Core } from './core'
import { axWarnings, checkAxTree, reduceAxTree, type CdpAxNode } from './axTree'
import { compareTranscript, formatDiffs, formatTranscript, keyEvents, runWalk, type ExpectedTranscript, type Reading, type StepDiff, type Transcript, type Walk, type WalkDriver } from './keyboardWalk'
import { fileName, LARGE_CONTENT_SIZE, planShots, type Shot } from './screensPlan'
import { selectWalks } from './walks'
import { git } from './git'
import { Store } from './store'
import { DEFAULT_MODEL } from '../shared/agents'
import type { ApprovalResponse, ChatItem, ColorVision, Repo, Session, Settings, Workspace } from '../shared/types'

export const SCREENSHOTS = process.env.FOREMAN_SCREENSHOTS === '1'
/** `npm run screens -- --walk`: play the keyboard walks after the screens, and fail the run when one does not match. */
const WALK = process.env.FOREMAN_SCREENSHOTS_WALK === '1'

/** The run's own folder (the script makes one; started by hand, a fresh temp folder). Data, repos and worktrees live in it. */
export function screenshotRoot(): string {
  const root = process.env.FOREMAN_SCREENSHOTS_DIR || mkdtempSync(path.join(os.tmpdir(), 'foreman-screens-data-'))
  mkdirSync(root, { recursive: true })
  return root
}

/**
 * Before ready: point every child process (git, gh, agent CLIs) and the page at a proxy that refuses, so nothing the
 * run starts reaches the network; and keep the window painting when another window covers it, or captures stall.
 */
export function screensSwitches(appendSwitch: (name: string, value?: string) => void): void {
  const nowhere = 'http://127.0.0.1:9'
  for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) process.env[name] = nowhere
  delete process.env.NO_PROXY
  delete process.env.no_proxy
  appendSwitch('proxy-server', '127.0.0.1:9')
  appendSwitch('disable-features', 'CalculateNativeWinOcclusion')
  appendSwitch('disable-backgrounding-occluded-windows')
  appendSwitch('disable-renderer-backgrounding')
}

// ---- the fixture ----

const IDENTITY = ['-c', 'user.name=Foreman Screens', '-c', 'user.email=screens@example.com', '-c', 'commit.gpgsign=false']
// Every fixture time counts back from one moment, and the page's clock is pinned just after it (`now` below), so
// "12m ago" reads the same in every shot of every run.
let seededAt = Date.now()
const minutesAgo = (minutes: number) => new Date(seededAt - minutes * 60_000).toISOString()

async function commitAll(dir: string, message: string, minutes: number): Promise<void> {
  const at = minutesAgo(minutes)
  await git(dir, ['add', '-A'])
  await git(dir, [...IDENTITY, 'commit', '-q', '-m', message], { env: { GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at } })
}

async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true })
    await writeFile(path.join(dir, name), content)
  }
}

async function makeRepo(dir: string, files: Record<string, string>): Promise<void> {
  mkdirSync(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
  await writeFiles(dir, files)
  await commitAll(dir, 'Initial commit', 3 * 24 * 60)
}

const LOGIN_TS = `export interface Credentials {
  email: string
  password: string
}

export async function login(credentials: Credentials): Promise<Response> {
  return fetch('/api/login', { method: 'POST', body: JSON.stringify(credentials) })
}
`

const SESSION_TS = `const KEY = 'atlas.session'

export function saveSession(token: string): void {
  localStorage.setItem(KEY, token)
}

export function readSession(): string | null {
  return localStorage.getItem(KEY)
}
`

/** The workspace's branch: one commit on top of main, plus uncommitted work, so Changes and Commits have content. */
async function makeWorktree(repoDir: string, worktree: string, branch: string, committed: Record<string, string>, uncommitted: Record<string, string>): Promise<void> {
  await git(repoDir, ['worktree', 'add', '-q', '-b', branch, worktree, 'main'])
  await writeFiles(worktree, committed)
  await commitAll(worktree, `Work on ${branch}`, 90)
  await writeFiles(worktree, uncommitted)
}

function session(id: string, workspaceId: string, title: string, minutes: number, extra: Partial<Session> = {}): Session {
  return {
    id,
    workspaceId,
    title,
    agent: 'claude',
    model: DEFAULT_MODEL.claude,
    effort: 'high',
    fastMode: false,
    planMode: false,
    status: 'idle',
    queue: [],
    lastTurn: { outcome: 'completed', turnId: `${id}-t2`, endedAt: minutesAgo(minutes), additions: 18, deletions: 4 },
    createdAt: minutesAgo(minutes + 40),
    lastActivityAt: minutesAgo(minutes),
    ...extra
  }
}

function chat(id: string, minutes: number, error?: string): ChatItem[] {
  const t1 = `${id}-t1`
  const t2 = `${id}-t2`
  return [
    { kind: 'user', id: `${t1}:user`, turnId: t1, at: minutesAgo(minutes + 30), text: 'After signing in, users land on the home page instead of the page they came from. Can you fix the redirect?' },
    { kind: 'assistant', id: `${t1}:a1`, turnId: t1, text: "I'll look at how the login flow handles the return address." },
    { kind: 'tool', id: `${t1}:read`, turnId: t1, name: 'Read', input: { file_path: 'src/login.ts' }, status: 'done', output: LOGIN_TS },
    { kind: 'tool', id: `${t1}:grep`, turnId: t1, name: 'Grep', input: { pattern: 'returnTo', path: 'src' }, status: 'done', output: 'No matches found' },
    {
      kind: 'tool',
      id: `${t1}:edit`,
      turnId: t1,
      name: 'Edit',
      input: { file_path: 'src/login.ts', old_string: "return fetch('/api/login'", new_string: "const response = await fetch('/api/login'" },
      status: 'done',
      output: 'The file src/login.ts has been updated.'
    },
    {
      kind: 'assistant',
      id: `${t1}:a2`,
      turnId: t1,
      text: [
        'The login form never passed the page the user came from, so the server always redirected to `/`.',
        '',
        '## What changed',
        '',
        '- `login()` now accepts a `returnTo` path and sends it with the credentials.',
        '- `redirect.ts` checks that the path is on this site before following it.',
        '',
        '```ts',
        "export function safeReturnTo(path: string | null): string {",
        "  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/'",
        '}',
        '```',
        '',
        'Run `npm test` to check the new cases.'
      ].join('\n')
    },
    { kind: 'result', id: `${t1}:result`, turnId: t1, ok: true, costUsd: 0.42, durationMs: 84_000, turns: 6 },
    { kind: 'turn-end', id: `turn-end:${t1}`, turnId: t1, outcome: 'completed', durationMs: 84_000 },
    { kind: 'user', id: `${t2}:user`, turnId: t2, at: minutesAgo(minutes + 5), text: 'Also keep the session when the token refreshes.' },
    { kind: 'tool', id: `${t2}:bash`, turnId: t2, name: 'Bash', input: { command: 'npm test -- session', description: 'Run the session tests' }, status: 'done', output: ' ✓ session.test.ts (4 tests) 12ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)' },
    { kind: 'assistant', id: `${t2}:a1`, turnId: t2, text: 'Done. `saveSession` now keeps the previous token until the refreshed one is stored, and the four session tests pass.' },
    error
      ? { kind: 'turn-end', id: `turn-end:${t2}`, turnId: t2, outcome: 'error', error, durationMs: 41_000 }
      : { kind: 'turn-end', id: `turn-end:${t2}`, turnId: t2, outcome: 'completed', durationMs: 41_000, suggestions: ['Add a test for an expired token', 'Open a pull request'] }
  ]
}

export interface ScreensFixture {
  repoId: string
  workspaceId: string
  chatId: string
  queueChatId: string
  /** The page's clock while it shows a screen (renderer/src/screens.ts): half a minute after the fixture's times. */
  now: number
}

/** Two real git repositories, three workspaces (worktrees) and their chats, written into `dataDir` before the app loads it. */
export async function seedScreens(root: string, dataDir: string): Promise<ScreensFixture> {
  seededAt = Date.now()
  const repos = path.join(root, 'repos')
  const worktrees = path.join(root, 'workspaces')
  const atlas = path.join(repos, 'atlas')
  const beacon = path.join(repos, 'beacon')
  await makeRepo(atlas, {
    'README.md': '# Atlas\n\nThe customer web app.\n',
    'package.json': '{\n  "name": "atlas",\n  "private": true,\n  "scripts": { "test": "vitest run" }\n}\n',
    'src/login.ts': LOGIN_TS,
    'src/session.ts': SESSION_TS
  })
  await makeRepo(beacon, { 'README.md': '# Beacon\n\nStatus page service.\n', 'main.go': 'package main\n\nfunc main() {}\n' })

  const lisbon = path.join(worktrees, 'atlas', 'lisbon')
  const osaka = path.join(worktrees, 'atlas', 'osaka')
  const quito = path.join(worktrees, 'beacon', 'quito')
  await makeWorktree(
    atlas,
    lisbon,
    'fix-login-redirect',
    { 'src/login.ts': LOGIN_TS.replace('credentials: Credentials)', 'credentials: Credentials, returnTo = "/")').replace('JSON.stringify(credentials)', 'JSON.stringify({ ...credentials, returnTo })') },
    {
      'src/redirect.ts': "/** Follow only paths on this site. */\nexport function safeReturnTo(path: string | null): string {\n  return path && path.startsWith('/') && !path.startsWith('//') ? path : '/'\n}\n",
      'src/session.ts': SESSION_TS.replace('localStorage.setItem(KEY, token)', 'if (token) localStorage.setItem(KEY, token)')
    }
  )
  await makeWorktree(atlas, osaka, 'add-rate-limit', { 'src/rateLimit.ts': 'export const LIMIT_PER_MINUTE = 60\n' }, {})
  await makeWorktree(beacon, quito, 'docs-update', { 'README.md': '# Beacon\n\nStatus page service. Run `go run .` to start it.\n' }, {})

  const store = new Store(dataDir)
  await store.load()
  const repo = (id: string, name: string, rootPath: string): Repo => ({ id, name, rootPath, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: minutesAgo(3 * 24 * 60) })
  // Nothing listens on these ports: the fixture has no run scripts. 50050–50059 is this workspace's reserved block.
  const workspace = (id: string, repoId: string, name: string, branch: string, wsPath: string, minutes: number, extra: Partial<Workspace>): Workspace => ({
    id, repoId, name, branch, baseBranch: 'main', path: wsPath, portBase: 50050, state: 'ready', createdAt: minutesAgo(minutes), ...extra
  })
  store.state.repos.push(repo('repo-atlas', 'atlas', atlas), repo('repo-beacon', 'beacon', beacon))
  store.state.recentRepoPaths = [atlas, beacon]
  store.state.workspaces.push(
    workspace('ws-lisbon', 'repo-atlas', 'lisbon', 'fix-login-redirect', lisbon, 120, { namesake: 'tesla', status: 'in-progress', statusAt: minutesAgo(100), diffStat: { files: 3, additions: 9, deletions: 3 } }),
    workspace('ws-osaka', 'repo-atlas', 'osaka', 'add-rate-limit', osaka, 300, { status: 'in-review', statusAt: minutesAgo(200), diffStat: { files: 1, additions: 1, deletions: 0 } }),
    workspace('ws-quito', 'repo-beacon', 'quito', 'docs-update', quito, 600, { status: 'done', statusAt: minutesAgo(400), diffStat: { files: 1, additions: 1, deletions: 1 } })
  )
  const queued = (id: string, text: string) => ({ id, text, attachments: [], revision: 1 })
  store.state.sessions.push(
    session('s-lisbon-1', 'ws-lisbon', 'Fix login redirect', 12),
    session('s-lisbon-2', 'ws-lisbon', 'Session tests', 25, {
      queue: [queued('q-1', 'Add a test for an expired token'), queued('q-2', 'Then update the README with the new returnTo parameter')],
      queueRevision: 2
    }),
    // A failed last turn, so Home has a row under Needs your attention (and no randomly chosen "All clear" line).
    session('s-osaka-1', 'ws-osaka', 'Rate limit the API', 180, { lastTurn: { outcome: 'error', turnId: 's-osaka-1-t2', endedAt: minutesAgo(180) } }),
    session('s-quito-1', 'ws-quito', 'Document how to run', 420)
  )
  for (const s of store.state.sessions) {
    const error = s.lastTurn?.outcome === 'error' ? 'The agent stopped: npm test exited with code 1.' : undefined
    for (const item of chat(s.id, 12, error)) await store.appendChat(s.id, item)
  }

  const settings: Partial<Settings> = {
    language: 'en',
    // The tour, sounds, notifications, the tray and the dock badge stay off; the theme follows nativeTheme, which the run sets.
    tourSeen: true,
    sound: 'none',
    notifications: false,
    trayIcon: false,
    dockBadge: false,
    theme: 'system',
    homeBoard: true,
    homeLayout: 'list',
    // cmd.exe has no profile to run; elsewhere the default shell.
    terminalShell: process.platform === 'win32' ? 'cmd' : 'auto',
    restoreTerminals: false,
    workspacesRoot: worktrees,
    cloneDirectory: repos
  }
  Object.assign(store.state.settings, settings)
  store.close()
  return { repoId: 'repo-atlas', workspaceId: 'ws-lisbon', chatId: 's-lisbon-1', queueChatId: 's-lisbon-2', now: seededAt + 30_000 }
}

// ---- the run ----

/** Screens the renderer hook knows (renderer/src/screens.ts), in capture order. */
export const SCREENS = [
  'home',
  'home-board',
  'workspace-chat',
  'composer-queue',
  'terminal',
  'file-diff',
  'git-panel',
  'tiles',
  'new-workspace',
  'settings-general',
  'settings-agents',
  'settings-appearance',
  'settings-cloud',
  'settings-repo',
  'settings-integrations',
  'automations',
  'assistant',
  'phone-pairing',
  // A settings row reached from the navigation, its flash held (renderer/src/screens.ts).
  'flash-loadout',
  'flash-claude-models',
  'flash-claude-agent',
  'flash-chrome-mode',
  'flash-output-style',
  // The design system's component galleries (ui/gallery/), taken a page at a time.
  'gallery-2a',
  'gallery-2b',
  'gallery-2c',
  'gallery-2d'
] as const

// The screens also taken in each colour-vision mode and at 200% (Tiles: the tightest layout at 200%).
const FOCUS: readonly string[] = ['home', 'workspace-chat', 'tiles', 'settings-agents']
const VISION: [label: string, mode: ColorVision][] = [
  ['red-green', 'protanopia-deuteranopia'],
  ['blue-yellow', 'tritanopia']
]

export interface ScreensRun {
  win: BrowserWindow
  core: Core
  fixture: ScreensFixture
  // index.html, or the dev server's URL.
  page: { file: string } | { url: string }
  out: string
  done: (failed: boolean) => void
}

/**
 * Every shot, or only the screens FOREMAN_SCREENSHOTS_ONLY names (comma-separated; `npm run screens -- --only home,assistant`).
 * FOREMAN_SCREENSHOTS_LARGE_TEXT=1 (`--large-text`) adds the `zoom200-*` and `content24-*` variants (screensPlan.ts).
 */
function plan(): Shot[] {
  const shots: Shot[] = []
  for (const theme of ['light', 'dark'] as const) for (const screen of SCREENS) shots.push({ screen, theme })
  for (const [vision] of VISION) for (const theme of ['light', 'dark'] as const) for (const screen of FOCUS) shots.push({ screen, theme, vision })
  for (const theme of ['light', 'dark'] as const) for (const screen of FOCUS) shots.push({ screen, theme, zoom: 2 })
  const only = process.env.FOREMAN_SCREENSHOTS_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
  return planShots(shots, { only, largeText: process.env.FOREMAN_SCREENSHOTS_LARGE_TEXT === '1' })
}

// The hook loads as its own chunk, so it may arrive just after the page; wait for it.
const SHOW = (screen: string, fixture: ScreensFixture) => `(async () => {
  for (let i = 0; i < 300 && !window.__foremanScreens; i++) await new Promise((r) => setTimeout(r, 50))
  if (!window.__foremanScreens) return { skipped: 'the screenshot hook never loaded' }
  return window.__foremanScreens.show(${JSON.stringify(screen)}, ${JSON.stringify(fixture)})
})()`

/** Load the page fresh with the hook on, so every screen starts from the same state. `screens` carries the pinned clock. */
async function loadPage(run: ScreensRun): Promise<void> {
  const { win, page, fixture } = run
  const loaded = new Promise<void>((resolve) => win.webContents.once('did-finish-load', () => resolve()))
  if ('url' in page) await win.loadURL(`${page.url}${page.url.includes('?') ? '&' : '?'}screens=${fixture.now}`)
  else await win.loadFile(page.file, { query: { screens: String(fixture.now) } })
  await loaded
}

/** The page's accessibility tree through the DevTools protocol. Attached on first use, detached by `close`. */
function axCapture(win: BrowserWindow) {
  const dbg = win.webContents.debugger
  let enabled = false
  dbg.on('detach', () => {
    enabled = false
  })
  return {
    async tree(): Promise<CdpAxNode[]> {
      if (!dbg.isAttached()) dbg.attach('1.3')
      if (!enabled) {
        await dbg.sendCommand('Accessibility.enable')
        enabled = true
      }
      return ((await dbg.sendCommand('Accessibility.getFullAXTree')) as { nodes: CdpAxNode[] }).nodes
    },
    close() {
      try {
        if (dbg.isAttached()) dbg.detach()
      } catch {
        // The window is going away anyway.
      }
    }
  }
}

// ---- the keyboard walks ----

/** Real keys: Input.dispatchKeyEvent through the DevTools protocol is trusted like a keyboard (Tab moves focus, Enter presses a button). */
function walkDriver(win: BrowserWindow): WalkDriver {
  const dbg = win.webContents.debugger
  return {
    async start() {
      if (!dbg.isAttached()) dbg.attach('1.3')
      win.show()
      win.webContents.focus()
    },
    async press(key) {
      for (const event of keyEvents(key, process.platform)) await dbg.sendCommand('Input.dispatchKeyEvent', event)
    },
    read: (watch) => win.webContents.executeJavaScript(`window.__foremanScreens.probe(${JSON.stringify(watch)})`) as Promise<Reading>
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function waitForSelector(win: BrowserWindow, selector: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (await win.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}) !== null`)) return true
    await sleep(100)
  }
  return false
}

/** A tool approval for the fixture chat that main really holds, as an agent's request would be: answering it resolves the promise. */
function requestApproval(core: Core, sessionId: string, signal: AbortSignal): Promise<ApprovalResponse> {
  const sessions = core.sessions as unknown as { requestApproval(sessionId: string, request: Record<string, unknown>, signal: AbortSignal): Promise<ApprovalResponse> }
  return sessions.requestApproval(sessionId, { kind: 'tool', toolName: 'Bash', input: { command: 'npm test', description: 'Run the tests' }, alternate: 'always-allow' }, signal)
}

export interface WalkResult {
  name: string
  ok: boolean
  diffs: string[]
}

/** The expected transcript for a walk, from the folder FOREMAN_SCREENSHOTS_WALK_EXPECTED names (tests/fixtures/walks). */
function expectedTranscript(name: string): ExpectedTranscript | null {
  const dir = process.env.FOREMAN_SCREENSHOTS_WALK_EXPECTED
  const file = dir && path.join(dir, `${name}.json`)
  return file && existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as ExpectedTranscript) : null
}

async function playWalk(run: ScreensRun, driver: WalkDriver, walk: Walk): Promise<WalkResult> {
  const { win, core, fixture, out } = run
  const abort = new AbortController()
  const diffs: StepDiff[] = []
  let answered: Promise<ApprovalResponse | undefined> | undefined
  try {
    await loadPage(run)
    const shown = (await win.webContents.executeJavaScript(SHOW(walk.screen, fixture))) as { skipped?: string }
    if (shown?.skipped) throw new Error(`screen ${walk.screen}: ${shown.skipped}`)
    if (walk.approval) answered = requestApproval(core, fixture.chatId, abort.signal).catch(() => undefined)
    if (walk.waitFor && !(await waitForSelector(win, walk.waitFor))) throw new Error(`${walk.waitFor} never appeared`)
    const transcript: Transcript = await runWalk(driver, walk)
    if (answered && walk.approval) {
      const response = await Promise.race([answered, sleep(1500).then(() => undefined)])
      const got = response?.kind === 'tool' ? (response.allow ? 'approved' : 'denied') : 'unanswered'
      transcript.outcome = { approval: got }
      if (got !== walk.approval.expect) diffs.push({ step: 0, key: '', field: 'approval', expected: walk.approval.expect, actual: got })
    }
    writeFileSync(path.join(out, `walk-${walk.name}.json`), JSON.stringify(transcript, null, 2))
    console.log(`[walk] ${walk.name}`)
    for (const line of formatTranscript(transcript)) console.log(`[walk] ${line}`)
    // What the walk itself asserts, then the transcript file kept next to the fixture.
    diffs.push(...compareTranscript(walk, transcript))
    const expected = expectedTranscript(walk.name)
    if (expected) diffs.push(...compareTranscript(expected, transcript))
    else if (process.env.FOREMAN_SCREENSHOTS_WALK_EXPECTED) diffs.push({ step: 0, key: '', field: 'expected transcript', expected: `tests/fixtures/walks/${walk.name}.json`, actual: 'missing' })
  } catch (err) {
    diffs.push({ step: 0, key: '', field: 'run', expected: 'the walk completes', actual: err instanceof Error ? err.message : String(err) })
  } finally {
    // A request the walk did not answer must not outlive it.
    abort.abort()
  }
  return { name: walk.name, ok: diffs.length === 0, diffs: formatDiffs(walk.name, diffs) }
}

/** Every walk in walks.ts (FOREMAN_SCREENSHOTS_WALK_ONLY=name,... for some), each on a freshly loaded page. */
async function runWalks(run: ScreensRun): Promise<WalkResult[]> {
  const { win, core } = run
  // The walks run in the default look: light, no colour-vision mode, the usual size.
  nativeTheme.themeSource = 'light'
  if (core.snapshot().settings.colorVision !== 'default') await core.api.updateSettings({ colorVision: 'default' })
  win.webContents.setZoomFactor(1)
  const driver = walkDriver(win)
  const results: WalkResult[] = []
  for (const walk of selectWalks(process.env.FOREMAN_SCREENSHOTS_WALK_ONLY)) results.push(await playWalk(run, driver, walk))
  try {
    if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
  } catch {
    // The window is going away anyway.
  }
  for (const r of results) {
    console.log(`[walk] ${r.name}: ${r.ok ? 'ok' : 'FAILED'}`)
    for (const line of r.diffs) console.error(`[walk] ${line}`)
  }
  return results
}

export async function runScreens(run: ScreensRun): Promise<void> {
  const { win, core, out } = run
  mkdirSync(out, { recursive: true })
  win.setContentSize(1320, 860)
  // The real pointer would leave hover states wherever it happens to rest over the window.
  win.setIgnoreMouseEvents(true)
  const index: { file: string; screen: string; theme: string; vision?: string; zoom: number; variant?: string }[] = []
  const skipped: { screen: string; theme: string; vision?: string; zoom: number; variant?: string; reason: string }[] = []
  let failed = false
  const ax = axCapture(win)
  // The fixture's own content text size, which the `content24` variant changes and every other shot goes back to.
  const baseContentSize = core.snapshot().settings.contentFontSize
  // Warnings per screenshot file, for the summary. Not failures yet.
  const axReport: Record<string, string[]> = {}
  for (const shot of plan()) {
    const vision = VISION.find(([label]) => label === shot.vision)?.[1] ?? 'default'
    try {
      nativeTheme.themeSource = shot.theme
      if (core.snapshot().settings.colorVision !== vision) await core.api.updateSettings({ colorVision: vision })
      const contentSize = shot.variant === 'content24' ? LARGE_CONTENT_SIZE : baseContentSize
      if (core.snapshot().settings.contentFontSize !== contentSize) await core.api.updateSettings({ contentFontSize: contentSize })
      win.webContents.setZoomFactor(shot.zoom ?? 1)
      await loadPage(run)
      win.webContents.setZoomFactor(shot.zoom ?? 1)
      win.webContents.sendInputEvent({ type: 'mouseLeave', x: 0, y: 0 })
      const result = (await win.webContents.executeJavaScript(SHOW(shot.screen, run.fixture))) as { skipped?: string; pages?: number }
      if (result?.skipped) {
        skipped.push({ screen: shot.screen, theme: shot.theme, vision: shot.vision, zoom: shot.zoom ?? 1, variant: shot.variant, reason: result.skipped })
        continue
      }
      // At most 8 pages, so a runaway gallery can't fill the disk.
      for (let page = 0; page < Math.min(result?.pages ?? 1, 8); page++) {
        if (page) await win.webContents.executeJavaScript(`window.__foremanScreens.page(${page})`)
        const image = await win.webContents.capturePage(undefined, { stayAwake: true })
        if (image.isEmpty()) throw new Error('capturePage returned an empty image')
        const file = fileName(shot, page)
        writeFileSync(path.join(out, file), image.toPNG())
        index.push({ file, screen: shot.screen, theme: shot.theme, vision: shot.vision, zoom: shot.zoom ?? 1, variant: shot.variant })
        console.log(`[screens] ${file}`)
        // A failed tree capture must not lose the screenshot.
        try {
          const tree = reduceAxTree(await ax.tree())
          writeFileSync(path.join(out, file.replace(/\.png$/, '.ax.json')), JSON.stringify(tree, null, 2))
          const warnings = axWarnings(checkAxTree(tree))
          if (warnings.length) axReport[file] = warnings
        } catch (err) {
          console.error(`[screens] ${file}: accessibility tree not captured: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    } catch (err) {
      failed = true
      const reason = err instanceof Error ? err.message : String(err)
      skipped.push({ screen: shot.screen, theme: shot.theme, vision: shot.vision, zoom: shot.zoom ?? 1, variant: shot.variant, reason })
      console.error(`[screens] ${fileName(shot)} failed: ${reason}`)
    }
  }
  ax.close()
  // Leave the window and the fixture's settings as the run found them.
  win.webContents.setZoomFactor(1)
  if (core.snapshot().settings.contentFontSize !== baseContentSize) await core.api.updateSettings({ contentFontSize: baseContentSize }).catch(() => undefined)
  // A walk that crashes the run must not lose the screenshots: the index is written either way.
  let walks: WalkResult[] | undefined
  if (WALK) {
    try {
      walks = await runWalks(run)
    } catch (err) {
      walks = [{ name: 'walks', ok: false, diffs: [`the keyboard walks did not run: ${err instanceof Error ? err.message : String(err)}`] }]
    }
    if (walks.some((w) => !w.ok)) failed = true
  }
  writeFileSync(
    path.join(out, 'index.json'),
    JSON.stringify({ createdAt: new Date().toISOString(), size: win.getContentSize(), shots: index, skipped, axWarnings: axReport, ...(walks ? { walks } : {}) }, null, 2)
  )
  console.log(`[screens] ${index.length} screenshots in ${out}`)
  for (const [file, warnings] of Object.entries(axReport)) for (const warning of warnings) console.warn(`[screens] a11y warning: ${file}: ${warning}`)
  run.done(failed)
}
