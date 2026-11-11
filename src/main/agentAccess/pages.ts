// The sign-in pages the browser shows (docs/agent-access.md §6): the waiting page with the code to type into Foreman,
// and the error page for a request Foreman won't send anywhere. Text comes in the user's language from mainT; the
// script and the style are their own files, so the page's CSP allows no inline script or style.
import type { Locale, TFunction } from '../../shared/i18n'

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (c) => ENTITIES[c])

// A placeholder value that survives escaping, then becomes markup.
const slot = (name: string): string => `\u0000${name}\u0000`
function fill(sentence: string, parts: Record<string, string>): string {
  let html = escapeHtml(sentence)
  for (const [name, markup] of Object.entries(parts)) html = html.split(slot(name)).join(markup)
  return html
}

function shell(lang: Locale, title: string, body: string, script: boolean): string {
  return `<!doctype html>
<html lang="${escapeHtml(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title><link rel="stylesheet" href="/oauth/style.css"></head>
<body><main>${body}</main>${script ? '<script src="/oauth/page.js"></script>' : ''}</body></html>
`
}

/** "This sign-in calls itself Claude Code. To let it use Foreman, type 123 456 in Foreman." The page then polls `statusUrl`. */
export function waitingPage(lang: Locale, t: TFunction, sign: { name: string; code: string; statusUrl: string }): string {
  const code = `${sign.code.slice(0, 3)} ${sign.code.slice(3)}`
  const calls = fill(t('agentAccess.page.calls', { name: slot('name') }), { name: `<strong>${escapeHtml(sign.name)}</strong>` })
  const type = fill(t('agentAccess.page.type', { code: slot('code') }), { code: `<strong class="code">${escapeHtml(code)}</strong>` })
  const data = [
    `data-status="${escapeHtml(sign.statusUrl)}"`,
    `data-approved="${escapeHtml(t('agentAccess.page.approved'))}"`,
    `data-denied="${escapeHtml(t('agentAccess.page.denied'))}"`,
    `data-gone="${escapeHtml(t('agentAccess.page.gone'))}"`
  ].join(' ')
  const body = `<h1>${escapeHtml(t('agentAccess.page.title'))}</h1>
<div id="sign-in" ${data}><p>${calls}</p><p>${type}</p><p class="hint">${escapeHtml(t('agentAccess.page.where'))}</p>
<p id="status" role="status" aria-live="polite">${escapeHtml(t('agentAccess.page.waiting'))}</p></div>`
  return shell(lang, t('agentAccess.page.title'), body, true)
}

/** A request Foreman refuses without redirecting: an unknown client, a redirect it didn't register, too many waiting. */
export function errorPage(lang: Locale, t: TFunction, message: string): string {
  const body = `<h1>${escapeHtml(t('agentAccess.page.errorTitle'))}</h1><p>${escapeHtml(message)}</p>`
  return shell(lang, t('agentAccess.page.errorTitle'), body, false)
}

// Polls once a second; once Foreman approves or denies (or the sign-in expires), goes on to where the client waits.
export const PAGE_JS = `'use strict'
;(() => {
  const box = document.getElementById('sign-in')
  const status = document.getElementById('status')
  if (!box || !status) return
  const poll = async () => {
    try {
      const res = await fetch(box.dataset.status, { cache: 'no-store', credentials: 'omit' })
      const body = await res.json()
      if (body.location) {
        status.textContent = body.state === 'approved' ? box.dataset.approved : box.dataset.denied
        window.location.replace(body.location)
        return
      }
      if (body.state !== 'waiting') {
        status.textContent = box.dataset.gone
        return
      }
    } catch (_) {
      // Foreman was busy or closing for a moment: keep asking.
    }
    setTimeout(poll, 1000)
  }
  setTimeout(poll, 1000)
})()
`

// System colours, so the page follows light, dark and forced colours without a palette of its own.
export const PAGE_CSS = `:root { color-scheme: light dark; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; line-height: 1.5; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
main { max-width: 32rem; margin: 2rem; padding: 2rem; border: 1px solid GrayText; border-radius: 0.75rem; }
h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.code { font-size: 1.6rem; letter-spacing: 0.15em; font-variant-numeric: tabular-nums; white-space: nowrap; }
`
