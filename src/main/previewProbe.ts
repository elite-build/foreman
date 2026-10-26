// The Run panel's "is the preview responding?" check (W-2). One short request,
// only to localhost, no redirects followed, and the body is never read.
import http from 'node:http'
import https from 'node:https'
import { isLocalPreviewUrl, type PreviewProbe } from '../shared/previewProbe'

export const PROBE_TIMEOUT_MS = 1500

export function probePreview(url: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<PreviewProbe> {
  const at = () => new Date().toISOString()
  if (!isLocalPreviewUrl(url)) return Promise.resolve({ url, state: 'skipped', reason: 'Only localhost addresses are checked', at: at() })
  return new Promise((resolve) => {
    let settled = false
    const done = (probe: Omit<PreviewProbe, 'url' | 'at'>) => {
      if (settled) return
      settled = true
      resolve({ url, at: at(), ...probe })
    }
    const request = (url.startsWith('https:') ? https : http).get(url, { timeout: timeoutMs, agent: false, headers: { Accept: '*/*', 'User-Agent': 'Foreman-preview-check' }, rejectUnauthorized: false } as https.RequestOptions, (res) => {
      // Any HTTP answer means a server is there; what it says is not looked at.
      done({ state: 'responding', status: res.statusCode })
      res.destroy()
    })
    request.on('timeout', () => {
      done({ state: 'not-responding', reason: 'No answer within a few seconds' })
      request.destroy()
    })
    request.on('error', (err: NodeJS.ErrnoException) => done({ state: 'not-responding', reason: err.code === 'ECONNREFUSED' ? 'Nothing is listening' : err.code ?? err.message }))
  })
}
