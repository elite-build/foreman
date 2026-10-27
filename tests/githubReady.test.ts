// A turn's environment waits for gh's first answers (gh's active account, the account's token), but never long.
import { describe, expect, it, vi } from 'vitest'

const gh = vi.hoisted(() => ({ ready: vi.fn<() => Promise<void>>(), envAsync: vi.fn<(key?: string) => Promise<Record<string, string>>>() }))
vi.mock('../src/main/github', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/github')>()),
  ghActiveAccountReady: gh.ready,
  githubEnvAsync: gh.envAsync
}))

const { Environment } = await import('../src/main/environment')

function environment(key: string | undefined) {
  const env = new Environment({} as never, () => ({}) as never, () => ({}) as never)
  env.githubKey = () => key
  return env
}

describe('Environment.githubReady', () => {
  it('waits for gh’s active account, then the repository account’s token', async () => {
    const order: string[] = []
    gh.ready.mockImplementation(async () => void order.push('active'))
    gh.envAsync.mockImplementation(async (key) => {
      order.push(`token:${key}`)
      return { GH_TOKEN: 'x' }
    })
    await environment('octocat').githubReady('repo')
    expect(order).toEqual(['active', 'token:octocat'])
  })

  it('gives up after its bound when gh hangs, and never throws', async () => {
    gh.ready.mockImplementation(() => new Promise<void>(() => undefined))
    const started = Date.now()
    await environment('octocat').githubReady('repo', 50)
    expect(Date.now() - started).toBeLessThan(2000)
    gh.ready.mockResolvedValue(undefined)
    gh.envAsync.mockRejectedValue(new Error('blocked'))
    await expect(environment('blocked:repo').githubReady('repo')).resolves.toBeUndefined()
  })
})
