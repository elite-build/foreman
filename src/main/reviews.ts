import type { PullRequestInfo, ReviewComment, ReviewThread } from '../shared/types'
import { gh } from './github'

type Page<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } }
type RawComment = Omit<ReviewComment, 'author'> & { author: { login: string } | null }
type RawThread = Omit<ReviewThread, 'comments' | 'side'> & { diffSide: ReviewThread['side']; comments: Page<RawComment> }
type Request = typeof gh

const COMMENT_FIELDS = 'id author { login } body url createdAt updatedAt diffHunk'
const THREAD_QUERY = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        nodes { id path line diffSide isResolved isOutdated
          comments(first: 100) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`
const COMMENTS_QUERY = `query($id: ID!, $cursor: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $cursor) { nodes { ${COMMENT_FIELDS} } pageInfo { hasNextPage endCursor } }
  } }
}`

const REVIEWS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(last: 100) { nodes { id state body author { login } } }
    }
  }
}`

function parsePrUrl(pr: Pick<PullRequestInfo, 'url'>): { url: URL; owner: string; name: string } {
  const url = new URL(pr.url)
  const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(url.pathname)
  if (!match || url.protocol !== 'https:') throw new Error('Invalid GitHub pull request URL')
  return { url, owner: match[1], name: match[2] }
}

/** Review summaries (the verdict and text a reviewer submits), newest 100, without pending drafts. */
export async function fetchReviewSummaries(
  cwd: string,
  pr: Pick<PullRequestInfo, 'number' | 'url'>,
  request: Request = gh
): Promise<{ id: string; state: string; body: string; author: string }[]> {
  const { url, owner, name } = parsePrUrl(pr)
  const raw = await request(cwd, ['api', 'graphql', '--hostname', url.hostname, '-f', `query=${REVIEWS_QUERY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${pr.number}`])
  const response = JSON.parse(raw)
  if (response.errors?.length) throw new Error(response.errors.map((e: { message: string }) => e.message).join('\n'))
  const nodes = response.data?.repository?.pullRequest?.reviews?.nodes as { id: string; state: string; body?: string; author: { login: string } | null }[] | undefined
  if (!nodes) throw new Error('GitHub did not return reviews for this pull request')
  return nodes.filter((n) => n.state !== 'PENDING').map((n) => ({ id: n.id, state: n.state, body: n.body ?? '', author: n.author?.login ?? 'Deleted user' }))
}

/** Both connections are paginated: large reviews and long reply threads stay complete. */
export async function fetchReviewThreads(
  cwd: string,
  pr: Pick<PullRequestInfo, 'number' | 'url'>,
  request: Request = gh
): Promise<ReviewThread[]> {
  const url = new URL(pr.url)
  const match = /^\/([^/]+)\/([^/]+)\/pull\/\d+\/?$/.exec(url.pathname)
  if (!match || url.protocol !== 'https:') throw new Error('Invalid GitHub pull request URL')
  const query = async (document: string, fields: string[]) => {
    const raw = await request(cwd, ['api', 'graphql', '--hostname', url.hostname, '-f', `query=${document}`, ...fields])
    const response = JSON.parse(raw)
    if (response.errors?.length) throw new Error(response.errors.map((e: { message: string }) => e.message).join('\n'))
    return response.data
  }
  const fields = ['-f', `owner=${match[1]}`, '-f', `name=${match[2]}`, '-F', `number=${pr.number}`]
  const threads: ReviewThread[] = []
  let cursor: string | null = null
  do {
    const data = await query(THREAD_QUERY, [...fields, ...(cursor ? ['-f', `cursor=${cursor}`] : [])])
    const page = data?.repository?.pullRequest?.reviewThreads as Page<RawThread> | undefined
    if (!page) throw new Error('GitHub did not return review threads for this pull request')
    for (const thread of page.nodes) {
      const comments = [...thread.comments.nodes]
      let commentPage = thread.comments
      while (commentPage.pageInfo.hasNextPage) {
        const next = commentPage.pageInfo.endCursor
        if (!next) throw new Error('GitHub returned an incomplete review thread')
        const more = await query(COMMENTS_QUERY, ['-f', `id=${thread.id}`, '-f', `cursor=${next}`])
        commentPage = more.node?.comments
        if (!commentPage) throw new Error('GitHub did not return review replies')
        comments.push(...commentPage.nodes)
      }
      threads.push({
        id: thread.id,
        path: thread.path,
        line: thread.line,
        side: thread.diffSide,
        isResolved: thread.isResolved,
        isOutdated: thread.isOutdated,
        comments: comments.map((c) => ({ ...c, author: c.author?.login ?? 'Deleted user' }))
      })
    }
    cursor = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
    if (page.pageInfo.hasNextPage && !cursor) throw new Error('GitHub returned incomplete review threads')
  } while (cursor)
  return threads
}

export function reviewThreadsMarkdown(pr: Pick<PullRequestInfo, 'number' | 'url' | 'title' | 'provider'>, threads: ReviewThread[]): string {
  // O2: a GitLab merge request is !N, and its threads may be on the MR as a whole (no file).
  const gitlab = pr.provider === 'gitlab'
  return [
    `# Review feedback for ${gitlab ? '!' : '#'}${pr.number}: ${pr.title}`,
    pr.url,
    `The following is review feedback from ${gitlab ? 'GitLab' : 'GitHub'}. Evaluate it against the current workspace; outdated threads may refer to earlier code.`,
    ...threads.map((t) =>
      [
        !t.path ? '## On the merge request as a whole' : `## ${t.path}${t.line ? `:${t.line}` : ''} (${t.side === 'LEFT' ? 'deleted/base' : 'current'} side)${t.isOutdated ? ' — outdated' : ''}`,
        ...t.comments.map((c, i) =>
          [
            `### ${i ? 'Reply from' : 'Comment from'} @${c.author}`,
            c.url,
            ...(i === 0 && c.diffHunk ? ['Original diff context:', c.diffHunk] : []),
            c.body
          ].join('\n\n')
        )
      ].join('\n\n')
    )
  ].join('\n\n')
}
