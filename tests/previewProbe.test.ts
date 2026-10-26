import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { probePreview } from '../src/main/previewProbe'
import { fromToml } from '../src/main/repoSettings'
import { agoText, isLocalPreviewUrl, probeText } from '../src/shared/previewProbe'

const servers: http.Server[] = []
afterEach(() => {
  for (const s of servers.splice(0)) s.closeAllConnections?.(), s.close()
})

async function serve(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler)
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('preview probe', () => {
  it('is responding when something answers, whatever it says', async () => {
    const ok = await serve((_req, res) => res.end('hi'))
    expect(await probePreview(`http://localhost:${ok}/`)).toMatchObject({ state: 'responding', status: 200 })
    const broken = await serve((_req, res) => ((res.statusCode = 500), res.end('boom')))
    expect(await probePreview(`http://127.0.0.1:${broken}`)).toMatchObject({ state: 'responding', status: 500 })
  })

  it('does not follow a redirect to somewhere else', async () => {
    let hit = false
    const target = await serve((_req, res) => ((hit = true), res.end()))
    const port = await serve((_req, res) => (res.writeHead(302, { Location: `http://127.0.0.1:${target}/` }), res.end()))
    expect(await probePreview(`http://127.0.0.1:${port}`)).toMatchObject({ state: 'responding', status: 302 })
    expect(hit).toBe(false)
  })

  it('is not responding when nothing listens, or nothing answers in time', async () => {
    const port = await serve((_req, res) => res.end())
    servers.pop()!.close()
    expect(await probePreview(`http://127.0.0.1:${port}`)).toMatchObject({ state: 'not-responding', reason: 'Nothing is listening' })
    const silent = await serve(() => undefined)
    const started = Date.now()
    expect(await probePreview(`http://127.0.0.1:${silent}`, 150)).toMatchObject({ state: 'not-responding' })
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('only ever asks localhost', async () => {
    for (const url of ['http://example.com/', 'http://127.0.0.1.evil.test:3000', 'http://10.0.0.5:3000', 'ftp://localhost/', 'file:///etc/passwd', 'not a url', 'http://user@evil.test@localhost.evil.test']) {
      expect(isLocalPreviewUrl(url)).toBe(false)
      expect(await probePreview(url)).toMatchObject({ state: 'skipped', reason: 'Only localhost addresses are checked' })
    }
    for (const url of ['http://localhost:3000', 'https://127.0.0.1:8443/app', 'http://[::1]:5173']) expect(isLocalPreviewUrl(url)).toBe(true)
  })
})

describe('preview probe wording', () => {
  const at = '2026-01-01T00:00:00Z'
  const now = new Date(at).getTime() + 12_000

  it('says nothing before the first probe and timestamps the rest', () => {
    expect(probeText(undefined, now)).toBeNull()
    expect(probeText({ url: 'u', state: 'responding', status: 200, at }, now)).toBe('responding · checked 12s ago')
    expect(probeText({ url: 'u', state: 'not-responding', at }, now)).toBe('not responding · checked 12s ago')
    expect(agoText(at, now + 120_000)).toBe('2m ago')
  })
})

describe('preview_url in settings.toml', () => {
  it('reads a run script preview URL', () => {
    const { values } = fromToml({ scripts: { run: { dev: { command: 'npm run dev', preview_url: ' http://localhost:$FOREMAN_PORT ' }, plain: { command: 'npm test' } } } })
    expect(values.runScripts).toEqual([
      { name: 'dev', command: 'npm run dev', icon: 'play', default: undefined, hidden: undefined, previewUrl: 'http://localhost:$FOREMAN_PORT' },
      { name: 'plain', command: 'npm test', icon: 'play', default: undefined, hidden: undefined }
    ])
  })
})
