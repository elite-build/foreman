// Credential probing portions: Copyright 2026 Untrivial, Apache-2.0.
// Adapted for Foreman's read-only credential reporting; see NOTICE and docs/licenses/acp-integration.txt.
// G1: sign-in checks for catalog agents whose CLI has no status command, using credential locations from
// agent docs and external integration references. A probe only ever says "credentials found" (with the file
// or command it read) or nothing: a file that's there doesn't prove the sign-in still works, and a missing one
// doesn't prove there's none (a keychain, another folder), so anything unclear stays Unknown. Probes read files and
// run read-only commands; they never sign in, refresh or change anything. Everything comes in through ProbeDeps so
// tests don't touch the real home folder.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface ProbeDeps {
  home: string
  platform: NodeJS.Platform
  // The agent's environment (its scoped variables) over Foreman's own.
  env: Record<string, string | undefined>
  read(file: string): string | null
  // Runs a read-only command; never rejects.
  run(file: string, args: string[]): Promise<{ ok: boolean; output: string }>
}

/** What a probe found: credentials, where, and the account when the file names one. */
export interface ProbeResult {
  signedIn: true
  account?: string
  // The file or command it came from, as the UI shows it (~ for the home folder).
  source: string
}

type Probe = (deps: ProbeDeps) => Promise<ProbeResult | null>

const PROBE_TIMEOUT_MS = 5000

export function realProbeDeps(env: Record<string, string | undefined>): ProbeDeps {
  return {
    home: os.homedir(),
    platform: process.platform,
    env: { ...process.env, ...env },
    read: (file) => {
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    run: (file, args) =>
      new Promise((resolve) => {
        execFile(file, args, { env: { ...process.env, ...env } as NodeJS.ProcessEnv, timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 256 * 1024 }, (err, stdout, stderr) =>
          resolve({ ok: !err, output: `${stdout ?? ''}${stderr ?? ''}` })
        )
      })
  }
}

// ---- small readers ----

function json(deps: ProbeDeps, file: string): Record<string, unknown> | null {
  const text = deps.read(file)
  if (!text) return null
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function filled(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const v = value.trim()
  return v !== '' && !/^(null|none|undefined)$/i.test(v)
}

/** "~/.gemini/oauth_creds.json" for the UI. */
function shown(deps: ProbeDeps, file: string): string {
  const p = deps.platform === 'win32' ? path.win32 : path.posix
  const rel = p.relative(deps.home, file)
  return rel && !rel.startsWith('..') && !p.isAbsolute(rel) ? `~${p.sep}${rel}` : file
}

function join(deps: ProbeDeps, ...parts: string[]): string {
  return (deps.platform === 'win32' ? path.win32 : path.posix).join(...parts)
}

/** A folder from an env var (with ~ expanded), else the default under home. */
function dirFrom(deps: ProbeDeps, envVar: string, ...fallback: string[]): string {
  const set = deps.env[envVar]?.trim()
  if (set) return set === '~' ? deps.home : set.startsWith('~/') || set.startsWith('~\\') ? join(deps, deps.home, set.slice(2)) : set
  return join(deps, deps.home, ...fallback)
}

/** Whether any key (at any depth) matching `name` holds a filled string. */
function deepFilled(value: unknown, name: RegExp, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 6) return false
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (name.test(k) && filled(v)) return true
    if (typeof v === 'object' && deepFilled(v, name, depth + 1)) return true
  }
  return false
}

/** `name = "value"` / `name: value` lines (TOML, YAML, .env) with a filled value, comments skipped. */
function lineFilled(text: string | null, name: RegExp): boolean {
  if (!text) return false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^([A-Za-z0-9_.\-"']+)\s*[:=]\s*(.*)$/.exec(line)
    if (!m || !name.test(m[1].replace(/["']/g, ''))) continue
    const value = m[2].replace(/\s+#.*$/, '').trim().replace(/^["']|["']$/g, '')
    if (filled(value) && !value.startsWith('$')) return true
  }
  return false
}

/** The email in a JWT's payload (not verified: only to name the account). */
export function tokenEmail(token: unknown): string | undefined {
  if (typeof token !== 'string') return undefined
  const part = token.split('.')[1]
  if (!part) return undefined
  try {
    const payload = JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as { email?: unknown }
    return typeof payload.email === 'string' ? payload.email : undefined
  } catch {
    return undefined
  }
}

function found(deps: ProbeDeps, file: string, account?: string): ProbeResult {
  return { signedIn: true, source: shown(deps, file), ...(account ? { account } : {}) }
}

// ---- per agent ----

/** The Google account Gemini CLI and Antigravity record after a sign-in (`active` in google_accounts.json). */
function googleAccount(deps: ProbeDeps, home: string): string | undefined {
  const active = json(deps, join(deps, home, 'google_accounts.json'))?.active
  return filled(active) ? active : undefined
}

const gemini: Probe = async (deps) => {
  // Gemini CLI keeps its Google sign-in in ~/.gemini/oauth_creds.json (GEMINI_CLI_HOME moves the folder in newer builds).
  const home = deps.env.GEMINI_CLI_HOME?.trim() ? join(deps, deps.env.GEMINI_CLI_HOME.trim(), '.gemini') : join(deps, deps.home, '.gemini')
  const file = join(deps, home, 'oauth_creds.json')
  const creds = json(deps, file)
  if (creds && (filled(creds.refresh_token) || filled(creds.access_token))) return found(deps, file, googleAccount(deps, home))
  return null
}

const antigravity: Probe = async (deps) => {
  // Antigravity records the Google account it signed in with under GEMINI_HOME (default ~/.gemini).
  const home = deps.env.GEMINI_HOME?.trim() || join(deps, deps.home, '.gemini')
  const account = googleAccount(deps, home)
  return account ? found(deps, join(deps, home, 'google_accounts.json'), account) : null
}

const qwen: Probe = async (deps) => {
  const home = dirFrom(deps, 'QWEN_HOME', '.qwen')
  const oauth = join(deps, home, 'oauth_creds.json')
  const creds = json(deps, oauth)
  if (creds && (filled(creds.refresh_token) || filled(creds.access_token))) return found(deps, oauth)
  const settingsFile = join(deps, home, 'settings.json')
  const settings = json(deps, settingsFile)
  if (settings && deepFilled(settings, /^api_?key$/i)) return found(deps, settingsFile)
  return null
}

const copilot: Probe = async (deps) => {
  const home = dirFrom(deps, 'COPILOT_HOME', '.copilot')
  const file = join(deps, home, 'config.json')
  const config = json(deps, file)
  if (config) {
    if (filled(config.authToken) || filled(config.accessToken) || filled(config.token)) return found(deps, file)
    const users = config.loggedInUsers
    const login = Array.isArray(users) ? users.find((u) => u && typeof u === 'object') : undefined
    if (login) return found(deps, file, filled((login as { login?: unknown }).login) ? (login as { login: string }).login : undefined)
    if (users && typeof users === 'object' && Object.values(users).some((v) => v)) return found(deps, file)
  }
  // Copilot CLI can use the GitHub CLI's sign-in: `gh auth status` names the account. Not signed in to gh says nothing about Copilot.
  const gh = await deps.run('gh', ['auth', 'status', '--hostname', 'github.com'])
  const account = /Logged in to github\.com (?:account|as) ([\w-]+)/i.exec(gh.output)?.[1]
  if (gh.ok && account) return { signedIn: true, account, source: 'gh auth status' }
  return null
}

const amp: Probe = async (deps) => {
  const file = join(deps, deps.home, '.local', 'share', 'amp', 'secrets.json')
  const secrets = json(deps, file)
  if (secrets && Object.entries(secrets).some(([k, v]) => /token|secret|key/i.test(k) && filled(v))) return found(deps, file)
  const settingsFile = deps.env.AMP_SETTINGS_FILE?.trim() || join(deps, deps.home, '.config', 'amp', 'settings.json')
  const settings = json(deps, settingsFile)
  if (settings && ['amp.apiKey', 'amp.api_key', 'apiKey', 'api_key'].some((k) => filled(settings[k]))) return found(deps, settingsFile)
  return null
}

const droid: Probe = async (deps) => {
  // Custom models with their own key in ~/.factory/settings.json (bring your own key). Droid's /login keeps no file Foreman knows.
  const file = join(deps, deps.home, '.factory', 'settings.json')
  const models = json(deps, file)?.customModels
  if (!Array.isArray(models)) return null
  const usable = models.some((m) => {
    const r = m as { model?: unknown; baseUrl?: unknown; apiKey?: unknown }
    if (!filled(r.model) || !filled(r.baseUrl) || !filled(r.apiKey)) return false
    const key = r.apiKey.trim()
    const ref = /^\$\{(\w+)\}$/.exec(key)?.[1]
    return ref ? filled(deps.env[ref]) : !key.startsWith('$')
  })
  return usable ? found(deps, file) : null
}

const kimi: Probe = async (deps) => {
  for (const home of [dirFrom(deps, 'KIMI_SHARE_DIR', '.kimi'), dirFrom(deps, 'KIMI_CODE_HOME', '.kimi-code')]) {
    const creds = join(deps, home, 'credentials', 'kimi-code.json')
    const c = json(deps, creds)
    if (c && (filled(c.access_token) || filled(c.refresh_token))) return found(deps, creds)
    const configJson = join(deps, home, 'config.json')
    if (deepFilled(json(deps, configJson), /^api_key$/i)) return found(deps, configJson)
    const configToml = join(deps, home, 'config.toml')
    if (lineFilled(deps.read(configToml), /^api_key$/i)) return found(deps, configToml)
  }
  return null
}

const goose: Probe = async (deps) => {
  const dirs =
    deps.platform === 'win32'
      ? [join(deps, deps.env.APPDATA?.trim() || join(deps, deps.home, 'AppData', 'Roaming'), 'Block', 'goose', 'config')]
      : [deps.env.XDG_CONFIG_HOME?.trim() ? join(deps, deps.env.XDG_CONFIG_HOME.trim(), 'goose') : '', join(deps, deps.home, '.config', 'goose')].filter(Boolean)
  for (const dir of dirs) {
    for (const name of ['config.yaml', 'secrets.yaml']) {
      const file = join(deps, dir, name)
      if (lineFilled(deps.read(file), /api_?key|token/i)) return found(deps, file)
    }
  }
  return null
}

/** Pi's auth.json: an OAuth entry with a token, or a key (a `!command` is never run; `$VAR` must be set). */
function piAuth(deps: ProbeDeps, file: string): ProbeResult | null {
  const auth = json(deps, file)
  if (!auth) return null
  for (const entry of Object.values(auth)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as { type?: unknown; access?: unknown; key?: unknown }
    if (e.type === 'oauth' && filled(e.access)) return found(deps, file)
    if (filled(e.key)) {
      const key = e.key.trim()
      if (key.startsWith('!')) continue
      const refs = [...key.matchAll(/\$\{?(\w+)\}?/g)].map((m) => m[1])
      if (refs.every((r) => filled(deps.env[r]))) return found(deps, file)
    }
  }
  return null
}

const pi: Probe = async (deps) => piAuth(deps, join(deps, dirFrom(deps, 'PI_CODING_AGENT_DIR', '.pi', 'agent'), 'auth.json'))

const omp: Probe = async (deps) => {
  const file = join(deps, dirFrom(deps, 'PI_CODING_AGENT_DIR', '.omp', 'agent'), 'auth.json')
  const auth = json(deps, file)
  return auth && Object.values(auth).some((e) => e && typeof e === 'object' && filled((e as { key?: unknown }).key)) ? found(deps, file) : null
}

const cline: Probe = async (deps) => {
  const file = join(deps, deps.home, '.cline', 'data', 'settings', 'providers.json')
  const data = json(deps, file)
  const providers = data?.providers
  if (!providers || typeof providers !== 'object') return null
  const all = providers as Record<string, { settings?: { apiKey?: unknown; auth?: { accessToken?: unknown; refreshToken?: unknown; expiresAt?: unknown } } }>
  const last = typeof data.lastUsedProvider === 'string' ? all[data.lastUsedProvider] : undefined
  for (const p of last ? [last] : Object.values(all)) {
    const s = p?.settings
    if (!s) continue
    if (filled(s.apiKey)) return found(deps, file)
    const auth = s.auth
    const fresh = typeof auth?.expiresAt !== 'number' || auth.expiresAt === 0 || auth.expiresAt > Date.now()
    if (auth && (filled(auth.refreshToken) || (filled(auth.accessToken) && fresh))) return found(deps, file, tokenEmail(auth.accessToken))
  }
  return null
}

const kilocode: Probe = async (deps) => {
  const dir = deps.env.KILO_DATA_DIR?.trim() || (deps.env.XDG_DATA_HOME?.trim() ? join(deps, deps.env.XDG_DATA_HOME.trim(), 'kilo') : join(deps, deps.home, '.local', 'share', 'kilo'))
  const file = join(deps, dir, 'auth.json')
  const auth = json(deps, file)
  const keys = ['key', 'apiKey', 'api_key', 'access_token', 'token']
  return auth && Object.values(auth).some((e) => e && typeof e === 'object' && keys.some((k) => filled((e as Record<string, unknown>)[k]))) ? found(deps, file) : null
}

const auggie: Probe = async (deps) => {
  const file = join(deps, deps.home, '.augment', 'session.json')
  return deepFilled(json(deps, file), /^(token|accessToken|access_token)$/i) ? found(deps, file) : null
}

const grok: Probe = async (deps) => {
  const home = dirFrom(deps, 'GROK_HOME', '.grok')
  const authFile = join(deps, home, 'auth.json')
  const auth = json(deps, authFile)
  if (auth) {
    for (const entry of Object.values(auth)) {
      const e = entry as { access_token?: unknown; refresh_token?: unknown; email?: unknown } | null
      if (e && typeof e === 'object' && (filled(e.access_token) || filled(e.refresh_token))) return found(deps, authFile, filled(e.email) ? e.email : undefined)
    }
  }
  const config = join(deps, home, 'config.toml')
  return lineFilled(deps.read(config), /^api_key$/i) ? found(deps, config) : null
}

const vibe: Probe = async (deps) => {
  const file = join(deps, dirFrom(deps, 'VIBE_HOME', '.vibe'), '.env')
  return lineFilled(deps.read(file), /^(MISTRAL_API_KEY|VIBE_CODE_API_KEY)$/) ? found(deps, file) : null
}

/**
 * Agents with a credentials probe. Kiro, Devin and Command Code answer through their own status commands
 * (CatalogAgent.auth.login.statusArgs) instead; every other agent stays Unknown.
 */
export const SIGN_IN_PROBES: Record<string, Probe> = { gemini, antigravity, qwen, copilot, amp, droid, kimi, goose, pi, omp, cline, kilocode, auggie, grok, vibe }

export function hasSignInProbe(id: string): boolean {
  return id in SIGN_IN_PROBES
}

/** Runs the agent's probe; null when it has none, or found nothing it can vouch for. */
export async function probeSignIn(id: string, deps: ProbeDeps): Promise<ProbeResult | null> {
  const probe = SIGN_IN_PROBES[id]
  if (!probe) return null
  try {
    return await probe(deps)
  } catch {
    return null
  }
}
