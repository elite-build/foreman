import { stubGh, takeGhCalls } from './ghHarness'
import { describe, expect, it, vi } from 'vitest'
import { accountToken, accountTokenAsync, detectAccount, forgetAccountTokens, ghActiveAccount, ghActiveAccountAsync, ghActiveAccountReady, gh, githubAccounts, githubEnv, githubEnvAsync, githubSlug, isSshRemote, refreshGhActiveAccount, remoteGitEnv, warmGithub } from '../src/main/github'
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
    expect(await ghActiveAccountAsync()).toBe('work')
    expect(ghActiveAccount()).toBe('work')
    expect((await githubEnvAsync(ghActiveAccount())).GH_TOKEN).toBe('tok-work')
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
    expect(await accountTokenAsync('alice')).toBe('tok-alice')
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

  it('without an account, leaves git and gh to their defaults', async () => {
    expect(githubEnv()).toEqual({})
    expect(await remoteGitEnv(undefined)).toEqual({})
  })

  it('says how to fix a signed-out account and prevents fetches from using another account', async () => {
    await fakeGh()
    await expect(githubEnvAsync('gone')).rejects.toThrow(/gone isn’t signed in to gh/)
    expect(() => githubEnv('gone')).toThrow(/gone isn’t signed in to gh/)
    await expect(gh(process.cwd(), ['api', 'user'], 5000, 'gone')).rejects.toThrow(/Settings → Account/)
    expect(await remoteGitEnv('gone')).toMatchObject({ GH_TOKEN: '', GITHUB_TOKEN: '', GIT_CONFIG_VALUE_0: '' })
  })
})

// gh can take over a second to answer: the main process must never wait for it (no execFileSync),
// ask it once for many readers, and keep its answers a while (gh's active account for a minute, tokens for minutes).
describe('asking gh without blocking the main process', () => {
  type Fake = { active: string; version: number; statusFails?: boolean; reject?: boolean; signedOut?: string[] }
  function countingGh(fake: Fake): void {
    forgetAccountTokens()
    stubGh((args) => {
      if (args[0] === 'auth' && args[1] === 'status') {
        return fake.statusFails ? { code: 1, stderr: 'gh: timed out' } : { stdout: JSON.stringify({ hosts: { 'github.com': [{ login: fake.active, active: true, state: 'success' }] } }) }
      }
      if (args[0] === 'auth' && args[1] === 'token') {
        const user = args[args.indexOf('--user') + 1]
        return fake.signedOut?.includes(user) ? { code: 1, stderr: `no account found for ${user}` } : { stdout: `tok-${user}-${fake.version}\n` }
      }
      return fake.reject ? { code: 1, stderr: 'HTTP 401: Bad credentials (https://api.github.com/user)' } : { stdout: 'ok' }
    })
    takeGhCalls()
  }
  const asked = (calls: { args: string[] }[], what: 'status' | 'token') => calls.filter((c) => c.args[0] === 'auth' && c.args[1] === what).length

  function clock(): { advance: (ms: number) => void; restore: () => void } {
    let t = Date.now()
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => t)
    return { advance: (ms) => void (t += ms), restore: () => spy.mockRestore() }
  }

  it('answers readers that can’t wait from the cache, and asks gh once for many readers', async () => {
    countingGh({ active: 'work', version: 1 })
    // Not known yet: nobody (so no credentials), never another account.
    expect(ghActiveAccount()).toBeUndefined()
    expect(() => accountToken('carol')).toThrow(/still loading/)
    await Promise.all([ghActiveAccountAsync(), ghActiveAccountAsync(), ghActiveAccountReady(), accountTokenAsync('carol'), accountTokenAsync('carol')])
    for (let i = 0; i < 50; i++) {
      expect(ghActiveAccount()).toBe('work')
      expect(githubEnv('carol').GH_TOKEN).toBe('tok-carol-1')
    }
    for (let i = 0; i < 3; i++) await gh(process.cwd(), ['api', 'user'], 5000, 'carol')
    expect(await ghActiveAccountAsync()).toBe('work')
    const calls = takeGhCalls()
    expect(asked(calls, 'status')).toBe(1)
    expect(asked(calls, 'token')).toBe(1)
    expect(calls.some((c) => c.sync)).toBe(false)
  })

  it('keeps answers a while, then serves the old one while gh is asked again in the background', async () => {
    const fake: Fake = { active: 'work', version: 1 }
    countingGh(fake)
    const time = clock()
    try {
      expect(await ghActiveAccountAsync()).toBe('work')
      expect(await accountTokenAsync('dana')).toBe('tok-dana-1')
      fake.active = 'me'
      fake.version = 2
      time.advance(40_000)
      expect(ghActiveAccount()).toBe('work')
      expect(asked(takeGhCalls(), 'status')).toBe(1)
      // gh's active account is kept for a minute (gh auth switch happens outside Foreman), then asked again.
      time.advance(30_000)
      expect(ghActiveAccount()).toBe('work')
      await vi.waitUntil(() => ghActiveAccount() === 'me')
      fake.active = 'work'
      expect(await ghActiveAccountAsync(true)).toBe('work')
      expect(ghActiveAccount()).toBe('work')
      time.advance(10 * 60_000)
      expect(accountToken('dana')).toBe('tok-dana-1')
      expect(await accountTokenAsync('dana')).toBe('tok-dana-1')
      await vi.waitUntil(() => accountToken('dana') === 'tok-dana-2')
      const calls = takeGhCalls()
      expect(asked(calls, 'status')).toBe(2)
      expect(asked(calls, 'token')).toBe(1)
      expect(calls.some((c) => c.sync)).toBe(false)
    } finally {
      time.restore()
    }
  })

  it('asks gh again when a window gains focus, at most once in a while, without waiting for it', async () => {
    const fake: Fake = { active: 'work', version: 1 }
    countingGh(fake)
    const time = clock()
    try {
      expect(await ghActiveAccountAsync()).toBe('work')
      takeGhCalls()
      // gh auth switch in another terminal, then back to Foreman.
      fake.active = 'me'
      refreshGhActiveAccount(5000)
      expect(asked(takeGhCalls(), 'status')).toBe(0)
      time.advance(6000)
      refreshGhActiveAccount(5000)
      refreshGhActiveAccount(5000)
      // The old answer until gh's comes back: never nobody, never a third account.
      expect(ghActiveAccount()).toBe('work')
      await vi.waitUntil(() => ghActiveAccount() === 'me')
      const calls = takeGhCalls()
      expect(asked(calls, 'status')).toBe(1)
      expect(calls.some((c) => c.sync)).toBe(false)
    } finally {
      time.restore()
    }
  })

  it('asks again after a sign-in or sign-out, without lending the old active account meanwhile', async () => {
    const fake: Fake = { active: 'work', version: 1 }
    countingGh(fake)
    expect(await ghActiveAccountAsync()).toBe('work')
    expect(await accountTokenAsync('erin')).toBe('tok-erin-1')
    fake.active = 'me'
    fake.version = 2
    forgetAccountTokens()
    expect(ghActiveAccount()).toBeUndefined()
    // The same account's last token is still its own while it reloads; callers that can wait get the new one.
    expect(accountToken('erin')).toBe('tok-erin-1')
    expect(await accountTokenAsync('erin')).toBe('tok-erin-2')
    expect(await ghActiveAccountAsync()).toBe('me')
    // Listing the accounts tells gh's active one too.
    fake.active = 'work'
    forgetAccountTokens()
    takeGhCalls()
    await githubAccounts()
    expect(ghActiveAccount()).toBe('work')
    expect(asked(takeGhCalls(), 'status')).toBe(1)
  })

  it('asks again after gh or GitHub refuses the credentials', async () => {
    const fake: Fake = { active: 'work', version: 1 }
    countingGh(fake)
    expect(await ghActiveAccountAsync()).toBe('work')
    expect(await accountTokenAsync('fay')).toBe('tok-fay-1')
    fake.reject = true
    fake.version = 2
    await expect(gh(process.cwd(), ['api', 'user'], 5000, 'fay')).rejects.toThrow(/401/)
    await expect(gh(process.cwd(), ['api', 'user'], 5000)).rejects.toThrow(/401/)
    takeGhCalls()
    expect(await accountTokenAsync('fay')).toBe('tok-fay-2')
    expect(await ghActiveAccountAsync()).toBe('work')
    const calls = takeGhCalls()
    expect(asked(calls, 'token')).toBe(1)
    expect(asked(calls, 'status')).toBe(1)
  })

  it('treats a failed or signed-out answer as no account, briefly, and never throws for it', async () => {
    const fake: Fake = { active: 'work', version: 1, statusFails: true, signedOut: ['gabe'] }
    countingGh(fake)
    const time = clock()
    try {
      expect(await ghActiveAccountAsync()).toBeUndefined()
      await expect(accountTokenAsync('gabe')).rejects.toThrow(/gabe isn’t signed in to gh/)
      for (let i = 0; i < 10; i++) {
        expect(ghActiveAccount()).toBeUndefined()
        expect(() => accountToken('gabe')).toThrow(/gabe isn’t signed in to gh/)
      }
      await expect(gh(process.cwd(), ['api', 'user'], 5000, 'gabe')).rejects.toThrow(/Settings → Account/)
      expect(await remoteGitEnv('gabe')).toMatchObject({ GH_TOKEN: '', GITHUB_TOKEN: '' })
      let calls = takeGhCalls()
      expect(asked(calls, 'status')).toBe(1)
      expect(asked(calls, 'token')).toBe(1)
      // Then gh is asked again.
      fake.statusFails = false
      time.advance(31_000)
      expect(await ghActiveAccountAsync()).toBe('work')
      calls = takeGhCalls()
      expect(asked(calls, 'status')).toBe(1)
      expect(calls.some((c) => c.sync)).toBe(false)
    } finally {
      time.restore()
    }
  })

  it('warms the active account and linked accounts’ tokens for readers that can’t wait', async () => {
    countingGh({ active: 'hal', version: 1 })
    await warmGithub(['ivy', 'ivy'], true)
    expect(ghActiveAccount()).toBe('hal')
    expect(accountToken('hal')).toBe('tok-hal-1')
    expect(accountToken('ivy')).toBe('tok-ivy-1')
    const calls = takeGhCalls()
    expect(asked(calls, 'status')).toBe(1)
    expect(asked(calls, 'token')).toBe(2)
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
