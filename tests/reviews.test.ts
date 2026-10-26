import { describe, expect, it, vi } from 'vitest'
import { fetchReviewSummaries, fetchReviewThreads, reviewThreadsMarkdown } from '../src/main/reviews'

const pr = { number: 12, url: 'https://git.example.com/acme/app/pull/12', title: 'Fix login' }
const comment = (id: string) => ({
  id,
  author: { login: 'reviewer' },
  body: `Feedback ${id}`,
  url: `${pr.url}#${id}`,
  createdAt: '2026-10-01',
  updatedAt: '2026-10-02',
  diffHunk: '@@ -1 +1 @@\n-old\n+new'
})
const page = <T>(nodes: T[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } })
const thread = (id: string) => ({
  id,
  path: 'src/login.ts',
  line: 7,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: page([comment(`${id}-root`)])
})

describe('GitHub review threads', () => {
  it('paginates threads and replies and uses the PR host', async () => {
    const first = { ...thread('first'), comments: page([comment('root')], 'replies-2') }
    const request = vi
      .fn()
      .mockResolvedValueOnce(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([first], 'threads-2') } } } }))
      .mockResolvedValueOnce(JSON.stringify({ data: { node: { comments: page([{ ...comment('reply'), author: null }]) } } }))
      .mockResolvedValueOnce(
        JSON.stringify({
          data: {
            repository: { pullRequest: { reviewThreads: page([{ ...thread('second'), isResolved: true, isOutdated: true, line: null }]) } }
          }
        })
      )
    const result = await fetchReviewThreads('/workspace', pr, request)
    expect(result).toHaveLength(2)
    expect(result[0].comments.map((c) => c.id)).toEqual(['root', 'reply'])
    expect(result[0].comments[1].author).toBe('Deleted user')
    expect(result[1]).toMatchObject({ isResolved: true, isOutdated: true, line: null })
    expect(request.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['--hostname', 'git.example.com', 'owner=acme', 'name=app', 'number=12'])
    )
    expect(request.mock.calls[1][1]).toContain('cursor=replies-2')
    expect(request.mock.calls[2][1]).toContain('cursor=threads-2')
  })

  it('surfaces GraphQL permission errors instead of reporting no feedback', async () => {
    await expect(
      fetchReviewThreads('/workspace', pr, vi.fn().mockResolvedValue(JSON.stringify({ errors: [{ message: 'Resource not accessible' }] })))
    ).rejects.toThrow('Resource not accessible')
  })

  it('does not treat an unavailable PR as an empty review', async () => {
    await expect(
      fetchReviewThreads('/workspace', pr, vi.fn().mockResolvedValue(JSON.stringify({ data: { repository: null } })))
    ).rejects.toThrow('did not return review threads')
  })

  it('includes file, side, original diff, URLs and nested replies in agent context', async () => {
    const raw = { ...thread('thread'), diffSide: 'LEFT', isOutdated: true, comments: page([comment('root'), comment('reply')]) }
    const request = vi.fn().mockResolvedValue(JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: page([raw]) } } } }))
    const markdown = reviewThreadsMarkdown(pr, await fetchReviewThreads('/workspace', pr, request))
    expect(markdown).toContain('src/login.ts:7 (deleted/base side) — outdated')
    expect(markdown).toContain(comment('root').diffHunk)
    expect(markdown).toContain(`### Reply from @reviewer\n\n${pr.url}#reply`)
    expect(markdown).toContain('Feedback reply')
  })
})

describe('review summaries', () => {
  it('reads review ids, states and text without pending drafts', async () => {
    const nodes = [
      { id: 'r1', state: 'APPROVED', body: '', author: { login: 'bob' } },
      { id: 'r2', state: 'PENDING', body: 'draft', author: { login: 'me' } },
      { id: 'r3', state: 'COMMENTED', body: 'hm', author: null }
    ]
    const request = vi.fn().mockResolvedValue(JSON.stringify({ data: { repository: { pullRequest: { reviews: { nodes } } } } }))
    expect(await fetchReviewSummaries('/repo', pr, request)).toEqual([
      { id: 'r1', state: 'APPROVED', body: '', author: 'bob' },
      { id: 'r3', state: 'COMMENTED', body: 'hm', author: 'Deleted user' }
    ])
    expect(request.mock.calls[0][1]).toContain('--hostname')
  })
})
