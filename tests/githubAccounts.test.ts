import { stubGh } from './ghHarness'
import { describe, expect, it } from 'vitest'
import { accountToken, detectAccount, forgetAccountTokens, ghActiveAccount, gh, githubAccounts, githubEnv, githubSlug, isSshRemote, remoteGitEnv } from '../src/main/github'
import { PrCache } from '../src/main/prCache'
import type { PrResult } from '../src/main/github'
import type { Workspace } from '../src/shared/types'

// A fake gh: `auth token --user X` prints tok-X (fails for "gone"), `auth status` lists two accounts,
// and anything else prints the GH_TOKEN it ran with.
async function fakeGh(): Promise<void> {
  forgetAccountTokens()
  stubGh((args, env) => {
    if (args[0] === 'auth' && args[1] === 'token') {
      const user = args[args.indexOf('--user') + 1]
      return user === 'gone' ? { code: 1, stderr: 'no account found for gone' } : { stdout: `tok-${user}\n` }
    }
    if (args[0] === 'auth' && args[1] === 'status') return { stdout: JSON.stringify({ hosts: { 'github.com': [
      { login: 'work', active: true, state: 'success' }, { login: 'me', active: false, state: 'success' }, { login: 'old', active: false, state: 'error' }
    ] } }) }
    return { stdout: `token=${env.GH_TOKEN}\n` }
  })
}

describe('GitHub remotes', () => {
  it('reads owner/name from https, ssh and scp-style URLs', () => {
    expect(githubSlug('https://github.com/acme/web.git')).toBe('acme/web')
    expect(githubSlug('https://user@github.com/acme/web')).toBe('acme/web')
    expect(githubSlug('git@github.com:acme/web.git')).toBe('acme/web')
    expect(githubSlug('ssh://git@github.com/acme/my.repo.git')).toBe('acme/my.repo')
    expect(githubSlug('https://gitlab.com/acme/web.git')).toBeNull()
  })

  it('knows SSH remotes from HTTPS ones', () => {
    expect(isSshRemote('git@github.com:acme/web.git')).toBe(true)
    expect(isSshRemote('ssh://git@github.com/acme/web.git')).toBe(true)
    expect(isSshRemote('https://github.com/acme/web.git')).toBe(false)
  })
})

describe('detecting the account for a repo', () => {
  const canPushAs = (who: string[]) => async (_slug: string, account: string) => who.includes(account)

  it('picks the only account that can push', async () => {
    expect(await detectAccount('acme/web', ['me', 'work'], canPushAs(['work']))).toEqual({ account: 'work', pushers: ['work'] })
  })

  it('leaves a tie or nobody unset, unless an account is the owner', async () => {
    expect(await detectAccount('acme/web', ['me', 'work'], canPushAs(['me', 'work']))).toEqual({ account: null, pushers: ['me', 'work'] })
    expect(await detectAccount('acme/web', ['me', 'work'], canPushAs([]))).toEqual({ account: null, pushers: [] })
    expect(await detectAccount('Me/dotfiles', ['me', 'work'], canPushAs(['me', 'work']))).toEqual({ account: 'me', pushers: ['me', 'work'] })
  })

  it('treats a failed check as no access', async () => {
    const canPush = async (_slug: string, account: string) => {
      if (account === 'me') throw new Error('HTTP 404')
      return true
    }
    expect(await detectAccount('acme/web', ['me', 'work'], canPush)).toEqual({ account: 'work', pushers: ['work'] })
  })
})

describe('acting as a linked account', () => {
  it('resolves the active keyring identity independently of inherited tokens', async () => {
    await fakeGh()
    forgetAccountTokens()
    expect(ghActiveAccount()).toBe('work')
    expect(githubEnv(ghActiveAccount()).GH_TOKEN).toBe('tok-work')
  })
  it('lists the signed-in accounts', async () => {
    await fakeGh()
    expect(await githubAccounts()).toEqual([
      { login: 'work', active: true },
      { login: 'me', active: false }
    ])
  })

  it('gives gh and git that account’s token and gh’s credential helper', async () => {
    await fakeGh()
    expect(accountToken('alice')).toBe('tok-alice')
    const env = githubEnv('alice')
    expect(env).toMatchObject({
      GH_TOKEN: 'tok-alice',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_0: '',
      GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
      GIT_CONFIG_VALUE_1: '!gh auth git-credential'
    })
    expect((await gh(process.cwd(), ['api', 'user'], 5000, 'alice')).trim()).toBe('token=tok-alice')
  })

  it('without an account, leaves git and gh to their defaults', () => {
    expect(githubEnv()).toEqual({})
    expect(remoteGitEnv(undefined)).toEqual({})
  })

  it('says how to fix a signed-out account and prevents fetches from using another account', async () => {
    await fakeGh()
    expect(() => githubEnv('gone')).toThrow(/gone isn’t signed in to gh/)
    await expect(gh(process.cwd(), ['api', 'user'], 5000, 'gone')).rejects.toThrow(/Settings → Account/)
    expect(remoteGitEnv('gone')).toMatchObject({ GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_VALUE_0: '' })
  })
})

describe('PR lookups per account', () => {
  it('an auth failure pauses only lookups made as the same account', async () => {
    const ws = (id: string, repoId: string) => ({ id, repoId, branch: 'feat', path: '/tmp' }) as Workspace
    const accounts: Record<string, string> = { personal: 'me', work: 'work' }
    let calls = 0
    const cache = new PrCache({
      identity: (w) => accounts[w.repoId],
      fetch: async (w): Promise<PrResult> => {
        calls++
        return w.repoId === 'work' ? { kind: 'auth-error', message: 'HTTP 401' } : { kind: 'no-pr' }
      }
    })
    expect(await cache.get(ws('a', 'work'))).toMatchObject({ kind: 'auth-error' })
    // Paused for work...
    expect(await cache.get(ws('b', 'work'), { fresh: true })).toMatchObject({ kind: 'auth-error' })
    expect(calls).toBe(1)
    // ...but not for the personal repo.
    expect(await cache.get(ws('c', 'personal'))).toEqual({ kind: 'no-pr' })
    expect(calls).toBe(2)
  })
})
