// G1: sign-in checks for more catalog agents, from where each one's docs say it keeps its sign-in. A probe reads
// files (and Copilot's `gh auth status`) through injected deps, so no real home folder or CLI is touched. It only
// ever says "credentials found" with its source; everything else stays Unknown.
import { describe, expect, it } from 'vitest'
import { canCheckSignIn, catalogAgent, CREDENTIAL_PROBES, signInState } from '../src/shared/agentCatalog'
import { probeSignIn, SIGN_IN_PROBES, tokenEmail, type ProbeDeps } from '../src/main/agents/signInProbes'

function deps(files: Record<string, string>, over: Partial<ProbeDeps> = {}): ProbeDeps {
  return {
    home: '/home/me',
    platform: 'darwin',
    env: {},
    read: (file) => files[file] ?? null,
    run: async () => ({ ok: false, output: 'not found' }),
    ...over
  }
}

function jwt(payload: object): string {
  return `x.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.y`
}

describe('G1 · credentials probes', () => {
  it('has a probe for exactly the agents the catalog says can be checked this way', () => {
    expect(Object.keys(SIGN_IN_PROBES).sort()).toEqual([...CREDENTIAL_PROBES].sort())
    for (const id of CREDENTIAL_PROBES) expect(catalogAgent(id)?.auth.confirmed, id).toBe(true)
    expect(canCheckSignIn(catalogAgent('gemini')!)).toBe(true)
    expect(canCheckSignIn(catalogAgent('kiro')!)).toBe(true)
    expect(canCheckSignIn(catalogAgent('continue')!)).toBe(false)
    expect(canCheckSignIn(catalogAgent('kimchi')!)).toBe(false)
    expect(canCheckSignIn(catalogAgent('claude')!)).toBe(false)
  })

  it('stays Unknown (null) when nothing is found', async () => {
    for (const id of CREDENTIAL_PROBES) expect(await probeSignIn(id, deps({})), id).toBeNull()
    expect(await probeSignIn('aider', deps({}))).toBeNull()
  })

  it('Gemini CLI: its OAuth file, with the Google account it recorded', async () => {
    const files = {
      '/home/me/.gemini/oauth_creds.json': JSON.stringify({ refresh_token: 'r' }),
      '/home/me/.gemini/google_accounts.json': JSON.stringify({ active: 'me@example.com' })
    }
    expect(await probeSignIn('gemini', deps(files))).toEqual({ signedIn: true, account: 'me@example.com', source: '~/.gemini/oauth_creds.json' })
    expect(await probeSignIn('gemini', deps({ '/home/me/.gemini/oauth_creds.json': JSON.stringify({ refresh_token: '' }) }))).toBeNull()
  })

  it('Antigravity: the Google account under GEMINI_HOME', async () => {
    const files = { '/g/google_accounts.json': JSON.stringify({ active: 'a@b.c' }) }
    expect(await probeSignIn('antigravity', deps(files, { env: { GEMINI_HOME: '/g' } }))).toMatchObject({ account: 'a@b.c', source: '/g/google_accounts.json' })
  })

  it('Copilot: its config, else the GitHub CLI’s account; gh not signed in says nothing', async () => {
    expect(await probeSignIn('copilot', deps({ '/home/me/.copilot/config.json': JSON.stringify({ loggedInUsers: [{ host: 'https://github.com', login: 'octo' }] }) }))).toMatchObject({ account: 'octo' })
    const gh = deps({}, { run: async (file, args) => ({ ok: file === 'gh' && args.join(' ') === 'auth status --hostname github.com', output: 'github.com\n  ✓ Logged in to github.com account octocat (keyring)\n' }) })
    expect(await probeSignIn('copilot', gh)).toEqual({ signedIn: true, account: 'octocat', source: 'gh auth status' })
    const out = deps({}, { run: async () => ({ ok: false, output: 'You are not logged into any GitHub hosts.' }) })
    expect(await probeSignIn('copilot', out)).toBeNull()
  })

  it('Pi: an OAuth entry or a key, never running a !command and needing every $VAR', async () => {
    const file = '/home/me/.pi/agent/auth.json'
    expect(await probeSignIn('pi', deps({ [file]: JSON.stringify({ anthropic: { type: 'oauth', access: 'tok' } }) }))).toMatchObject({ source: '~/.pi/agent/auth.json' })
    expect(await probeSignIn('pi', deps({ [file]: JSON.stringify({ openai: { key: '!security find-generic-password' } }) }))).toBeNull()
    expect(await probeSignIn('pi', deps({ [file]: JSON.stringify({ openai: { key: '$OPENAI_KEY' } }) }))).toBeNull()
    expect(await probeSignIn('pi', deps({ [file]: JSON.stringify({ openai: { key: '$OPENAI_KEY' } }) }, { env: { OPENAI_KEY: 'sk' } }))).not.toBeNull()
    expect(await probeSignIn('pi', deps({ '/p/auth.json': JSON.stringify({ x: { key: 'k' } }) }, { env: { PI_CODING_AGENT_DIR: '/p' } }))).not.toBeNull()
  })

  it('Cline: names the account from its token; an expired token alone isn’t a sign-in', async () => {
    const file = '/home/me/.cline/data/settings/providers.json'
    const live = { lastUsedProvider: 'cline', providers: { cline: { settings: { auth: { accessToken: jwt({ email: 'c@d.e' }), expiresAt: Date.now() + 60_000 } } } } }
    expect(await probeSignIn('cline', deps({ [file]: JSON.stringify(live) }))).toMatchObject({ account: 'c@d.e' })
    const expired = { providers: { cline: { settings: { auth: { accessToken: 'a.b.c', expiresAt: 1 } } } } }
    expect(await probeSignIn('cline', deps({ [file]: JSON.stringify(expired) }))).toBeNull()
    expect(tokenEmail('garbage')).toBeUndefined()
  })

  it('Droid: a custom model with its own key; an unset ${VAR} doesn’t count', async () => {
    const file = '/home/me/.factory/settings.json'
    const settings = (apiKey: string) => JSON.stringify({ customModels: [{ model: 'm', baseUrl: 'https://x', apiKey }] })
    expect(await probeSignIn('droid', deps({ [file]: settings('sk-1') }))).not.toBeNull()
    expect(await probeSignIn('droid', deps({ [file]: settings('${MY_KEY}') }))).toBeNull()
    expect(await probeSignIn('droid', deps({ [file]: settings('${MY_KEY}') }, { env: { MY_KEY: 'v' } }))).not.toBeNull()
  })

  it('Goose: its config on Windows lives under %APPDATA%', async () => {
    const win = deps({ 'C:\\Users\\me\\AppData\\Roaming\\Block\\goose\\config\\secrets.yaml': 'OPENAI_API_KEY: sk-123\n' }, { home: 'C:\\Users\\me', platform: 'win32', env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' } })
    expect(await probeSignIn('goose', win)).toMatchObject({ source: '~\\AppData\\Roaming\\Block\\goose\\config\\secrets.yaml' })
    expect(await probeSignIn('goose', deps({ '/home/me/.config/goose/config.yaml': 'GOOSE_PROVIDER: openai\n# OPENAI_API_KEY: sk\n' }))).toBeNull()
  })

  it('reads TOML and .env keys for Kimi, Grok and Vibe', async () => {
    expect(await probeSignIn('kimi', deps({ '/home/me/.kimi/config.toml': '[providers.moonshot]\napi_key = "sk-1"\n' }))).not.toBeNull()
    expect(await probeSignIn('grok', deps({ '/home/me/.grok/auth.json': JSON.stringify({ x: { access_token: 't', email: 'g@x.ai' } }) }))).toMatchObject({ account: 'g@x.ai' })
    expect(await probeSignIn('grok', deps({ '/home/me/.grok/config.toml': 'api_key = "$XAI"\n' }))).toBeNull()
    expect(await probeSignIn('vibe', deps({ '/home/me/.vibe/.env': 'MISTRAL_API_KEY=abc\n' }))).not.toBeNull()
  })

  it('shows a found credential as found, with its source, and Unknown otherwise', () => {
    const gemini = catalogAgent('gemini')!
    expect(signInState(gemini, { mode: 'cli', providerKeys: 0, reported: { signedIn: true, account: 'a', source: '~/.gemini/oauth_creds.json' } })).toEqual({ kind: 'signed-in', account: 'a', source: '~/.gemini/oauth_creds.json' })
    expect(signInState(gemini, { mode: 'cli', providerKeys: 0 })).toEqual({ kind: 'unknown' })
  })
})
