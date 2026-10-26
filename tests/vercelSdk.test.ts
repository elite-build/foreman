// The real @vercel/sandbox SDK, offline, with the @vercel/oidc that package.json's override gives it (see the
// dependency override in docs/maintenance.md). Fetch is stubbed, so nothing reaches Vercel. The SDK must still
// find every OIDC function it imports, and Foreman's explicit access token must still be the one that is sent.
import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VercelProvider } from '../src/main/cloud/vercelProvider'
import { planLimits } from '../src/shared/cloud'

const sdkEntry = createRequire(import.meta.url).resolve('@vercel/sandbox')
const sdkDist = path.dirname(sdkEntry)

/** The names the SDK takes from @vercel/oidc, read from both its ESM and CommonJS builds. */
function oidcImports(): Set<string> {
  const names = new Set<string>()
  const files = readdirSync(sdkDist, { recursive: true, encoding: 'utf8' }).filter((f) => /\.c?js$/.test(f))
  for (const file of files) {
    const src = readFileSync(path.join(sdkDist, file), 'utf8')
    for (const [, clause] of src.matchAll(/import\s+([^;]*?)\s+from\s*["']@vercel\/oidc["']/g)) {
      const named = /^\{([^}]*)\}$/.exec(clause)
      if (!named) throw new Error(`${file}: unreadable @vercel/oidc import "${clause}"`)
      for (const part of named[1].split(',')) if (part.trim()) names.add(part.trim().split(/\s+as\s+/)[0])
    }
    for (const [, binding] of src.matchAll(/(\w+)\s*=\s*require\(["']@vercel\/oidc["']\)/g)) {
      for (const [, name] of src.matchAll(new RegExp(`\\b${binding}\\.(\\w+)`, 'g'))) names.add(name)
    }
  }
  return names
}

/** An unsigned JWT with these claims, the shape the SDK and @vercel/oidc decode. */
function jwt(claims: Record<string, unknown>): string {
  return [{ alg: 'none' }, claims, ''].map((part) => Buffer.from(typeof part === 'string' ? part : JSON.stringify(part)).toString('base64url')).join('.')
}

/** Vercel's API for a sandbox that doesn't exist, noting each request's URL and bearer token. */
function missingSandboxApi(seen: { url: string; auth: string }[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    seen.push({ url: String(input instanceof Request ? input.url : input), auth: new Headers(init.headers).get('authorization') ?? '' })
    return new Response(JSON.stringify({ error: { code: 'not_found', message: 'Sandbox not found' } }), { status: 404, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
}

describe('the Vercel SDK with its resolved @vercel/oidc', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('provides every OIDC function the SDK imports', () => {
    const imported = oidcImports()
    expect(imported).toContain('getVercelOidcToken')
    const oidc = createRequire(sdkEntry)('@vercel/oidc') as Record<string, unknown>
    for (const name of imported) expect(typeof oidc[name], `@vercel/oidc export ${name}`).toBe('function')
  })

  it('sends the explicit access token, not one from the environment', async () => {
    const seen: { url: string; auth: string }[] = []
    vi.stubGlobal('fetch', missingSandboxApi(seen))
    vi.stubEnv('VERCEL_OIDC_TOKEN', jwt({ owner_id: 'team_env', project_id: 'prj_env', exp: Math.floor(Date.now() / 1000) + 3600 }))
    const provider = new VercelProvider({ token: 'vercel_tok', teamId: 'team_1', projectId: 'prj_1' }, planLimits('hobby'))

    expect(await provider.get('foreman-ws')).toBeNull()

    expect(seen).toHaveLength(1)
    expect(seen[0].auth).toBe('Bearer vercel_tok')
    const url = new URL(seen[0].url)
    expect(url.pathname).toBe('/api/v2/sandboxes/foreman-ws')
    expect(url.searchParams.get('teamId')).toBe('team_1')
    expect(url.searchParams.get('projectId')).toBe('prj_1')
    expect(url.searchParams.get('resume')).toBe('false')
  })

  it('refreshes an OIDC token through @vercel/oidc before a request', async () => {
    const seen: { url: string; auth: string }[] = []
    vi.stubGlobal('fetch', missingSandboxApi(seen))
    vi.stubEnv('VERCEL_OIDC_TOKEN_FILE', undefined)
    const now = Math.floor(Date.now() / 1000)
    const fresh = jwt({ owner_id: 'team_1', project_id: 'prj_1', exp: now + 3600 })
    vi.stubEnv('VERCEL_OIDC_TOKEN', fresh)
    const provider = new VercelProvider({ token: jwt({ owner_id: 'team_1', project_id: 'prj_1', exp: now - 60 }), teamId: 'team_1', projectId: 'prj_1' }, planLimits('hobby'))

    expect(await provider.get('foreman-ws')).toBeNull()

    // The SDK swallows a failed refresh and keeps the old token, so a new one here proves the call went through.
    expect(seen.map((s) => s.auth)).toEqual([`Bearer ${fresh}`])
  })
})
