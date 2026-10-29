// Langfuse's key check and the read-only tools agents get through the integration bridge, against a
// stand-in for Langfuse's public API: what is asked for, how replies are cut down, and what fails.
import { describe, expect, it } from 'vitest'
import { clip, LANGFUSE_TOOLS, langfuseCall, LangfuseError, langfuseProject } from '../src/main/langfuse'
import { normalizeLangfuseHost } from '../src/shared/integrations'

const keys = { host: 'https://cloud.langfuse.com', publicKey: 'pk-lf-1', secretKey: 'sk-lf-1' }
const NOW = Date.parse('2026-10-29T12:00:00Z')

interface Seen {
  url: URL
  auth: string | null
  redirect?: RequestRedirect
}

function stub(answer: (url: URL) => Response | Promise<Response>) {
  const seen: Seen[] = []
  const doFetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    seen.push({ url, auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect })
    return answer(url)
  }) as unknown as typeof fetch
  return { seen, doFetch }
}

const filterOf = (s: Seen) => JSON.parse(s.url.searchParams.get('filter') ?? '[]') as Record<string, unknown>[]
const textOf = (r: Record<string, unknown>) => (r.content as { text: string }[])[0].text
const jsonOf = (r: Record<string, unknown>) => JSON.parse(textOf(r)) as Record<string, unknown>

describe('Langfuse hosts', () => {
  it('takes a cloud default, bare hosts, trailing slashes and the API path', () => {
    expect(normalizeLangfuseHost('')).toEqual({ host: 'https://cloud.langfuse.com' })
    expect(normalizeLangfuseHost(' us.cloud.langfuse.com/ ')).toEqual({ host: 'https://us.cloud.langfuse.com' })
    expect(normalizeLangfuseHost('https://lf.acme.dev/langfuse/api/public/')).toEqual({ host: 'https://lf.acme.dev/langfuse' })
    expect(normalizeLangfuseHost('http://localhost:3000')).toEqual({ host: 'http://localhost:3000' })
  })

  it('refuses plain http to another computer, and logins or queries in the address', () => {
    expect(normalizeLangfuseHost('http://langfuse.acme.dev')).toHaveProperty('error')
    expect(normalizeLangfuseHost('https://user:pw@langfuse.acme.dev')).toHaveProperty('error')
    expect(normalizeLangfuseHost('https://langfuse.acme.dev/?x=1')).toHaveProperty('error')
  })
})

describe('checking a Langfuse key pair', () => {
  it('asks for the project with basic auth, never following a redirect', async () => {
    const { seen, doFetch } = stub(() => Response.json({ data: [{ id: 'p1', name: 'Kite', organization: { id: 'o1', name: 'Appsmith' } }] }))
    const identity = await langfuseProject(keys, doFetch)
    expect(identity).toMatchObject({ user: 'Appsmith', org: 'Kite', orgId: 'p1', url: 'https://cloud.langfuse.com/project/p1' })
    expect(seen[0].url.href).toBe('https://cloud.langfuse.com/api/public/projects')
    expect(seen[0].auth).toBe(`Basic ${Buffer.from('pk-lf-1:sk-lf-1').toString('base64')}`)
    expect(seen[0].redirect).toBe('error')
  })

  it('says when the keys are swapped, before sending anything', async () => {
    const { seen, doFetch } = stub(() => Response.json({}))
    await expect(langfuseProject({ ...keys, publicKey: 'sk-lf-1', secretKey: 'pk-lf-1' }, doFetch)).rejects.toThrow(/That’s the secret key/)
    expect(seen).toEqual([])
  })

  it('a refusal is an auth error; being unreachable is not', async () => {
    const refused = await langfuseProject(keys, stub(() => new Response('', { status: 401 })).doFetch).catch((e: unknown) => e)
    expect(refused).toBeInstanceOf(LangfuseError)
    expect((refused as LangfuseError).auth).toBe(true)
    const offline = await langfuseProject(keys, (async () => {
      throw new Error('ENOTFOUND')
    }) as unknown as typeof fetch).catch((e: unknown) => e)
    expect((offline as LangfuseError).auth).toBe(false)
    expect(String(offline)).toMatch(/Couldn’t reach Langfuse/)
  })
})

describe('Langfuse tools for agents', () => {
  it('are all read-only', () => {
    expect(LANGFUSE_TOOLS.map((t) => t.name)).toEqual(['search_observations', 'get_trace', 'get_observation'])
    expect(LANGFUSE_TOOLS.every((t) => t.annotations.readOnlyHint)).toBe(true)
  })

  it('search turns its arguments into Langfuse filters, bounded to the last day by default', async () => {
    const { seen, doFetch } = stub(() => Response.json({ data: [{ id: 'o1', traceId: 't1', level: 'ERROR' }], meta: { cursor: 'next' } }))
    const reply = jsonOf(await langfuseCall(keys, 'search_observations', { level: 'ERROR', traceName: 'chat', rootsOnly: true, filter: [{ type: 'number', column: 'latency', operator: '>=', value: 5 }] }, doFetch, NOW))
    expect(seen[0].url.pathname).toBe('/api/public/v2/observations')
    expect(seen[0].url.searchParams.get('limit')).toBe('25')
    expect(seen[0].url.searchParams.get('fields')).toBe('basic,trace_context,metrics,usage')
    expect(filterOf(seen[0])).toEqual([
      { type: 'string', column: 'traceName', operator: '=', value: 'chat' },
      { type: 'string', column: 'level', operator: '=', value: 'ERROR' },
      { type: 'boolean', column: 'isRootObservation', operator: '=', value: true },
      { type: 'datetime', column: 'startTime', operator: '>=', value: '2026-10-28T12:00:00.000Z' },
      { type: 'number', column: 'latency', operator: '>=', value: 5 }
    ])
    expect(reply).toMatchObject({ count: 1, nextCursor: 'next', observations: [{ id: 'o1' }] })
  })

  it('search within a trace or session is not cut to the last day, and passes the cursor on', async () => {
    const { seen, doFetch } = stub(() => Response.json({ data: [] }))
    await langfuseCall(keys, 'search_observations', { sessionId: 's1', cursor: 'abc', limit: 500, fields: ['io'] }, doFetch, NOW)
    expect(filterOf(seen[0])).toEqual([{ type: 'string', column: 'sessionId', operator: '=', value: 's1' }])
    expect(seen[0].url.searchParams.get('cursor')).toBe('abc')
    expect(seen[0].url.searchParams.get('limit')).toBe('100')
    expect(seen[0].url.searchParams.get('fields')).toBe('basic,io')
  })

  it('a bad argument is the tool’s error, for the agent to fix, and asks Langfuse nothing', async () => {
    const { seen, doFetch } = stub(() => Response.json({ data: [] }))
    for (const args of [{ level: 'FATAL' }, { from: 'yesterday' }, { fields: ['secrets'] }, { filter: [{ column: 'x' }] }]) {
      const r = await langfuseCall(keys, 'search_observations', args, doFetch, NOW)
      expect(r.isError, JSON.stringify(args)).toBe(true)
    }
    expect((await langfuseCall(keys, 'get_trace', {}, doFetch)).isError).toBe(true)
    expect((await langfuseCall(keys, 'delete_trace', { traceId: 't' }, doFetch)).isError).toBe(true)
    expect(seen).toEqual([])
  })

  it('get_trace reads every page of a trace, in start order, with its errors and cost summed', async () => {
    const pages: Record<string, unknown> = {
      '': { data: [{ id: 'b', traceId: 't1', startTime: '2026-10-29T10:00:02Z', parentObservationId: 'a', level: 'ERROR', statusMessage: 'timeout', totalCost: 0.25, input: '{"q":"hi"}' }], meta: { cursor: 'p2' } },
      p2: { data: [{ id: 'a', traceId: 't1', projectId: 'p1', startTime: '2026-10-29T10:00:00Z', parentObservationId: null, isRootObservation: true, traceName: 'chat', sessionId: 's1', totalCost: 0.5 }], meta: {} }
    }
    const { seen, doFetch } = stub((url) => Response.json(pages[url.searchParams.get('cursor') ?? '']))
    const reply = jsonOf(await langfuseCall(keys, 'get_trace', { traceId: 't1' }, doFetch))
    expect(seen).toHaveLength(2)
    expect(filterOf(seen[0])).toEqual([{ type: 'string', column: 'traceId', operator: '=', value: 't1' }])
    expect(seen[0].url.searchParams.get('fields')).toContain('io')
    expect(reply).toMatchObject({
      traceId: 't1',
      traceName: 'chat',
      sessionId: 's1',
      url: 'https://cloud.langfuse.com/project/p1/traces/t1',
      observationCount: 2,
      totalCost: 0.75,
      errorsAndWarnings: [{ id: 'b', level: 'ERROR', statusMessage: 'timeout' }]
    })
    // Inputs that are JSON come back as JSON, not a string of it.
    expect((reply.observations as Record<string, unknown>[]).map((o) => o.id)).toEqual(['a', 'b'])
    expect((reply.observations as Record<string, unknown>[])[1].input).toEqual({ q: 'hi' })
  })

  it('cuts long fields so one trace can’t flood the agent', async () => {
    const big = 'x'.repeat(10_000)
    const { doFetch } = stub(() => Response.json({ data: [{ id: 'o1', output: big }] }))
    const reply = jsonOf(await langfuseCall(keys, 'get_observation', { id: 'o1', maxFieldChars: 500 }, doFetch))
    expect(reply.output).toBe(`${'x'.repeat(500)}… [9500 more characters]`)
    expect(clip({ a: ['short', big] }, 10)).toEqual({ a: ['short', `${'x'.repeat(10)}… [9990 more characters]`] })
  })

  it('says when a self-hosted Langfuse has no Observations API v2', async () => {
    const { doFetch } = stub(() => new Response('', { status: 404 }))
    await expect(langfuseCall(keys, 'get_observation', { id: 'o1' }, doFetch)).rejects.toThrow(/doesn’t have Langfuse’s Observations API v2/)
  })
})
