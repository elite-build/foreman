// Foreman on a phone: every workspace is a conversation thread. Agent requests
// (permissions, plans, questions) are answered inside the thread they came from.
const root = document.getElementById('app')
const toastEl = document.getElementById('toast')
const safe = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const ago = (iso) => {
  if (!iso) return ''
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60000)
  if (m < 1) return 'now'
  if (m < 60) return m + 'm'
  if (m < 1440) return Math.floor(m / 60) + 'h'
  return Math.floor(m / 1440) + 'd'
}
const mins = (iso) => Math.max(1, Math.floor((Date.now() - new Date(iso).getTime()) / 60000))
const secs = (ms) => ms < 60000 ? Math.max(1, Math.round(ms / 1000)) + 's' : Math.round(ms / 60000) + 'm'
const agentName = (a) => a ? a.charAt(0).toUpperCase() + a.slice(1) : 'Agent'
const COLORS = ['#cc5236', '#2f68c0', '#198a4b', '#7a5bb8', '#a86d12', '#0f7c8c', '#b83f72', '#5d6b2f']
const colorFor = (key) => { let h = 0; for (const c of String(key)) h = (h * 31 + c.charCodeAt(0)) >>> 0; return COLORS[h % COLORS.length] }
const initial = (name) => safe((String(name || '?').match(/[a-z0-9]/i)?.[0] || '?').toUpperCase())
const icon = (name, cls = '') => '<svg class="i ' + cls + '" aria-hidden="true"><use href="#' + name + '"/></svg>'

const state = {
  model: null, view: 'list', wsId: null, sessionId: null, tab: 'chat',
  chat: [], chatFor: null, diff: null, checks: null, git: null, checkConsent: null,
  filter: 'all', query: '', sheet: null, newRepo: null, newPrompt: '',
  drafts: {}, notes: {}, answers: {}, others: {}, picks: {}, replying: new Set(), fullPlans: new Set(),
  openTools: new Set(), openFiles: new Set(), limit: 120,
  error: '', pairingId: sessionStorage.getItem('pairingId'), pairCode: sessionStorage.getItem('pairCode'),
  lastKey: '', busy: false, recent: null,
  // What this phone may do (GET /api/session, then each welcome), the live connection's status, and why it signed out.
  scopes: null, live: null, signedOut: '', archiving: null,
  // #127: queue or steer, per chat, when it differs from the computer's setting; the diff line being commented on and
  // its draft; the workspace's terminals and the one shown; the workspace's usage, read when its menu opens.
  sendMode: {}, commenting: null, commentDraft: '', terms: null, term: null, usage: null
}

async function request(method, path, body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  let value
  try { value = await response.json() } catch { value = {} }
  if (!response.ok) throw Object.assign(new Error(value.error || 'Foreman could not complete the request.'), { status: response.status, code: value.code })
  return value
}
let toastTimer
function toast(text) {
  toastEl.textContent = text
  toastEl.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400)
}
// A call this phone's access doesn't allow: the server's own words, as a toast rather than an error on the page.
function fail(err) {
  if (err.code === 'refused') return toast(err.message)
  state.error = err.message || String(err)
  render()
}
// A phone approved to watch sees everything and is offered nothing that would change it; operate and above, everything.
const canAct = () => !state.scopes || state.scopes.includes('operate') || state.scopes.includes('admin')
const WATCH_ONLY = '<p class="hint watch">This phone can watch. Approve it again with more access to act.</p>'

// ---------- model helpers ----------
const ws = () => state.model?.workspaces.find((w) => w.id === state.wsId)
const repoOf = (w) => state.model.repos.find((r) => r.id === w.repoId)
const sessionsOf = (w) => state.model.sessions.filter((s) => s.workspaceId === w.id)
const approvalsOf = (w) => state.model.approvals.filter((a) => state.model.sessions.some((s) => s.id === a.sessionId && s.workspaceId === w.id))
const commentsOf = (id) => (state.model.comments || []).filter((c) => c.workspaceId === id)
// What a message sent while this chat's turn runs does: this phone's choice for the chat, else the computer's setting.
const modeFor = (s) => s.canSteer ? state.sendMode[s.id] || state.model.followUpMode || 'queue' : 'queue'
const MODE_TITLE = { steer: 'Sends into the running turn. Tap to queue this message instead.', queue: 'Waits until this turn ends. Tap to steer this message instead.' }
function ring(w, approvals = approvalsOf(w)) {
  if (approvals.length) return 'need'
  if (w.stalled) return 'stall'
  if (w.bucket === 'working') return 'work'
  if (w.bucket === 'attention') return 'need'
  return ''
}
function rank(w) {
  if (approvalsOf(w).length) return 0
  return { attention: 1, working: 2, finished: 3, idle: 4 }[w.bucket] ?? 5
}
function toolArg(name, input) {
  if (!input || typeof input !== 'object') return ''
  const v = input.command ?? input.file_path ?? input.path ?? input.pattern ?? input.url ?? input.query ?? input.description
  return typeof v === 'string' ? v : ''
}
function firstLine(text) {
  return (String(text || '').split('\n').map((l) => l.replace(/^[#>*\-\s]+/, '').trim()).find(Boolean) || '')
}
function askText(a) {
  if (a.kind === 'tool') {
    const arg = toolArg(a.toolName, a.input)
    return a.toolName === 'Bash' && arg ? '<b>Wants to run</b> ' + safe(arg) : '<b>Wants to use ' + safe(a.toolName) + '</b>' + (arg ? ' ' + safe(arg) : '')
  }
  if (a.kind === 'plan') return '<b>Plan ready:</b> ' + safe(firstLine(a.plan))
  if (a.kind === 'gate') return '<b>' + safe(a.flowName) + ' waits for you:</b> ' + safe(a.ask)
  if (a.kind === 'pick') return '<b>' + safe(a.flowName) + ' asks you to pick:</b> ' + safe(a.choices.map((c) => c.step).join(', '))
  return '<b>Asks:</b> ' + safe(a.questions[0]?.question || 'A question')
}
function preview(w, approvals) {
  if (approvals.length) return askText(approvals[0])
  if (w.stalled) return '<span class="s">Quiet for ' + mins(w.stalledSince) + ' min.</span> The agent may still be working.'
  if (w.bucket === 'working') return '<span class="w">' + safe(w.label || 'Working') + '…</span> ' + safe(w.detail || '')
  const rest = w.detail || (w.facts || []).join(' · ')
  return (w.bucket === 'attention' ? '<b>' + safe(w.label) + '</b>' : safe(w.label || 'Ready')) + (rest ? ' · ' + safe(rest) : '')
}
function statusLine(w, s, approvals) {
  const r = ring(w, approvals)
  if (approvals.length) return { cls: 'need', text: approvals.length > 1 ? approvals.length + ' requests waiting on you' : 'Waiting on you' }
  if (w.stalled) return { cls: 'stall', text: 'Quiet for ' + mins(w.stalledSince) + ' min' }
  if (s?.status === 'running') return { cls: 'work', text: 'Working' }
  // Its turn waits for an agent slot (the desktop's "Maximum agents running at once").
  if (s?.waitingForSlot) return { cls: '', text: 'Queued · starts when a running agent finishes' }
  return { cls: r, text: w.label || 'Ready' }
}

// ---------- rendering ----------
// The thin line under the header while the live connection is down; hidden while it is live (or still connecting).
const LIVE_TEXT = { reconnecting: 'Reconnecting…', off: 'Phone access is off', outdated: 'Foreman was updated. Reload this page.' }
function liveLine() {
  const text = state.model ? LIVE_TEXT[state.live] || '' : ''
  return '<div id="live" class="liveline" role="status"' + (text ? '' : ' hidden') + '>' + safe(text) + '</div>'
}
function banner() { return liveLine() + (state.error ? '<div class="banner err" role="alert">' + safe(state.error) + '</div>' : '') }
function screen(view) {
  return '<div class="view">' + (view.top ? '<header class="top">' + view.top + banner() + '</header>' : banner()) +
    '<main id="scroller">' + view.body + '</main>' + (view.foot ? '<footer class="foot">' + view.foot + '</footer>' : '') + '</div>' + (view.over || '')
}
function current() {
  if (state.pairingId) return pairView()
  if (!state.model) return unpairedView()
  if (state.view === 'thread' && ws()) return threadView()
  state.view = 'list'
  return listView()
}
function render() {
  const view = current()
  const key = state.view + '|' + state.wsId + '|' + state.sessionId + '|' + state.tab
  const sc = document.getElementById('scroller')
  const top = sc ? sc.scrollTop : 0
  const atBottom = sc ? sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90 : true
  root.innerHTML = screen(view)
  placeScroll(key === state.lastKey, top, atBottom)
  state.lastKey = key
  sizeDraft()
  syncView()
}
function placeScroll(same, top, atBottom) {
  const sc = document.getElementById('scroller')
  if (!sc) return
  // A chat and a terminal follow what is added at the bottom while the reader is there.
  const follow = state.view === 'thread' && (state.tab === 'chat' || state.tab === 'terminal')
  if (follow && (!same || atBottom)) sc.scrollTop = sc.scrollHeight
  else sc.scrollTop = same ? top : 0
}
// Background refreshes must not steal focus from what the user is typing.
function paint() {
  const focus = document.activeElement
  const typing = focus?.matches?.('input, textarea')
  if (!typing) return render()
  const sc = document.getElementById('scroller')
  if (!sc || sc.contains(focus) || focus.closest('.sheet')) return
  const top = sc.scrollTop
  const atBottom = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 90
  sc.innerHTML = current().body
  placeScroll(true, top, atBottom)
  syncView()
}

// ---------- list ----------
function filtered() {
  const m = state.model
  const q = state.query.trim().toLowerCase()
  return m.workspaces
    .map((w, i) => ({ w, i, r: rank(w) }))
    .filter(({ w, r }) => state.filter === 'all' || (state.filter === 'need' ? r <= 1 : state.filter === 'working' ? w.bucket === 'working' : state.filter === 'repo:' + w.repoId))
    .filter(({ w }) => !q || [w.name, w.branch, repoOf(w)?.name].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map(({ w }) => w)
}
// The PR glyph, as the window shows it: open, draft, merged, or red while CI fails. From the PR as last read.
const PR_STATE = { open: 'open', draft: 'draft', merged: 'merged', 'ci-failing': 'CI failing' }
function prGlyph(w) {
  const g = w.pr
  if (!g) return ''
  const ref = g.provider === 'gitlab' ? 'MR !' + g.number : 'PR #' + g.number
  const label = g.state === 'ci-failing' && g.failing ? 'CI failing (' + g.failing + ')' : PR_STATE[g.state] || ''
  return '<span class="prg ' + safe(g.state) + (g.stale ? ' stale' : '') + '" title="' + safe(ref + ' · ' + label + (g.readAt ? ' · as of ' + ago(g.readAt) + ' ago' : '')) + '">' + safe(ref) + '</span>'
}
function threadRow(w) {
  const approvals = approvalsOf(w)
  const repo = repoOf(w)
  return '<button class="th" data-action="open:' + safe(w.id) + '">' +
    '<span class="av ' + ring(w, approvals) + '" style="background:' + colorFor(w.name) + '">' + initial(w.name) + '</span>' +
    '<span class="body"><span class="l1"><span class="nm">' + safe(w.name) + '</span>' + prGlyph(w) + '<span class="rp">' + safe(repo?.name || '') + '</span>' +
    '<span class="tm' + (approvals.length ? ' hot' : '') + '">' + ago(w.since) + '</span></span>' +
    '<span class="pv"><p>' + preview(w, approvals) + '</p>' + (approvals.length ? '<span class="bdg">' + approvals.length + '</span>' : '') + '</span></span></button>'
}
// Home → Recent: what happened, newest first. History only; nothing here answers or resolves anything.
function recentBody() {
  const r = state.recent
  if (!r) return '<div class="empty">Loading recent events…</div>'
  if (!r.events.length) return '<div class="empty"><b>Nothing recent</b>Turns ending, CI and answered requests show here.</div>'
  return r.events.map((e) => {
    const unseen = !r.seenAt || e.at > r.seenAt
    return '<button class="ev' + (unseen ? ' new' : '') + '" data-action="open:' + safe(e.workspaceId) + '">' +
      '<span class="ev-tm">' + ago(e.at) + '</span><span class="ev-body"><span class="nm">' + safe(e.name) + '</span>' +
      '<span class="ev-text">' + safe(e.text) + (e.count > 1 ? ' <span class="ev-rep">×' + e.count + ' since ' + ago(e.firstAt) + ' ago</span>' : '') + '</span></span></button>'
  }).join('') + '<p class="ev-foot">Kept for 30 days or 500 events</p><div class="list-end"></div>'
}
async function loadRecent() {
  try { state.recent = await request('GET', '/api/recent') } catch (err) { state.error = err.message }
}
function listBody() {
  if (state.filter === 'recent') return recentBody()
  const rows = filtered()
  if (rows.length) return rows.map(threadRow).join('') + '<div class="list-end"></div>'
  if (!state.model.workspaces.length) return '<div class="empty"><b>No workspaces yet</b>Tap New to start an agent in a fresh worktree.</div>'
  return '<div class="empty"><b>Nothing here</b>' + (state.query ? 'No workspace matches “' + safe(state.query) + '”.' : state.filter === 'need' ? 'No agent needs you right now.' : 'No agents in this filter.') + '</div>'
}
function listView() {
  const m = state.model
  const need = m.workspaces.filter((w) => rank(w) <= 1).length
  const working = m.workspaces.filter((w) => w.bucket === 'working').length
  const chip = (id, label) => '<button class="' + (state.filter === id ? 'on' : '') + '" data-action="filter:' + safe(id) + '">' + label + '</button>'
  const top = '<div class="lt"><h1>Agents</h1><button class="conn" data-action="sheet:device"><i></i>' + (location.protocol === 'https:' ? 'Connected' : 'Same Wi-Fi') + '</button></div>' +
    '<label class="search">' + icon('search', 'sm') + '<input id="search" type="search" placeholder="Search workspaces" autocomplete="off" value="' + safe(state.query) + '"></label>' +
    '<div class="filters">' + chip('all', 'All') + chip('need', 'Needs you' + (need ? ' · ' + need : '')) + chip('working', 'Working' + (working ? ' · ' + working : '')) + chip('recent', 'Recent') +
    (m.repos.length > 1 ? m.repos.map((r) => chip('repo:' + r.id, safe(r.name))).join('') : '') + '</div>'
  return { top, body: listBody(), over: (canAct() ? '<button class="fab" data-action="sheet:new">' + icon('plus') + 'New</button>' : '') + sheetHtml() }
}

// ---------- thread ----------
function md(text) {
  const parts = String(text || '').split(/```[^\n]*\n?/)
  return parts.map((p, i) => i % 2 ? '<pre><code>' + safe(p.replace(/\n$/, '')) + '</code></pre>' :
    safe(p).replace(/^#{1,6} +(.+)$/gm, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')).join('')
}
function toolGroup(tools) {
  const id = tools[0].id
  const open = state.openTools.has(id)
  const running = tools.find((t) => t.status === 'running')
  const failed = tools.some((t) => t.status === 'error')
  const last = tools[tools.length - 1]
  const label = running ? 'Running ' + safe(running.name) + '…' : tools.length === 1 ? safe(last.name) + (toolArg(last.name, last.input) ? ' · <span class="mono">' + safe(toolArg(last.name, last.input).split('\n')[0].slice(0, 60)) + '</span>' : '') : tools.length + ' tool calls · ' + safe([...new Set(tools.map((t) => t.name))].slice(0, 3).join(', '))
  return '<div class="tools' + (open ? ' open' : '') + '"><button data-action="tools:' + safe(id) + '"><span class="tic ' + (running ? 'run' : failed ? 'err' : '') + '">' + icon(running ? 'clock' : failed ? 'x' : 'check', 'sm') + '</span>' + label + icon('chev', 'sm chev') + '</button>' +
    (open ? '<ul>' + tools.map((t) => '<li><span class="nm">' + safe(t.name) + '</span><span class="arg">' + safe(toolArg(t.name, t.input).split('\n')[0]) + '</span>' + (t.status === 'error' ? '<span class="d">failed</span>' : '') + '</li>').join('') + '</ul>' : '') + '</div>'
}
// G4 #11: a usage-limit failure's "Resume at …", as the window's card offers it (the same rules apply in Foreman).
function hhmm(ms) { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }) }
function limitPart(i, s) {
  if (!i.limit || !s) return ''
  const armed = s.limitResume && s.limitResume.turnId === i.turnId ? s.limitResume : null
  // #127: Resume now or Dismiss, as the window's card offers them.
  if (armed && armed.missed) return '<div class="sys err">' + (armed.failed ? 'The resume at ' + hhmm(Date.parse(armed.resetAt)) + ' failed: ' + safe(armed.failed) : 'Missed ' + hhmm(Date.parse(armed.resetAt))) + '.' +
    (canAct() ? ' <button class="linkish" data-action="resume-now">Resume now</button> · <button class="linkish" data-action="unresume:' + safe(i.turnId) + '">Dismiss</button>' : '') + '</div>'
  if (armed) return '<div class="sys">Resumes at ' + hhmm(Date.parse(armed.at)) + ' · sends “' + safe(armed.text) + '” once' + (canAct() ? ' <button class="linkish" data-action="unresume:' + safe(i.turnId) + '">Cancel</button>' : '') + '</div>'
  const at = i.limit.resetAt ? Date.parse(i.limit.resetAt) : NaN
  if (s.agent !== 'claude' || !i.limit.source || !(at > Date.now())) return '<div class="sys">Reset time unknown</div>'
  const latest = canAct() && s.lastTurn && s.lastTurn.turnId === i.turnId && s.status !== 'running' && !s.queued
  const from = i.limit.from === 'event' ? 'from Claude’s rate-limit event' : 'from Claude: “…' + safe(i.limit.source) + '”'
  return '<div class="sys">' + (latest ? '<button class="linkish" data-action="resume-at:' + safe(i.turnId) + '">Resume at ' + hhmm(at) + '</button>' : 'Resets ' + hhmm(at)) + ' · ' + from + '</div>'
}
function turnEnd(i, s) {
  const delta = i.delta && (i.delta.additions || i.delta.deletions) ? ' · <span class="a">+' + i.delta.additions + '</span> <span class="d">−' + i.delta.deletions + '</span>' : ''
  if (i.outcome === 'completed') return '<div class="sys">Done' + (i.durationMs ? ' in ' + secs(i.durationMs) : '') + delta + '</div>'
  if (i.outcome === 'cancelled') return '<div class="sys">Stopped' + delta + '</div>'
  if (i.outcome === 'interrupted') return '<div class="sys err">Interrupted' + (i.error ? ': ' + safe(i.error) : '') + '</div>'
  return '<div class="sys err">Turn failed' + (i.error ? ': ' + safe(i.error) : '') + '</div>' + limitPart(i, s)
}
function chatHtml(s) {
  if (state.chatFor !== state.sessionId) return '<div class="empty">Loading chat…</div>'
  const items = state.chat.filter((i) => ['user', 'assistant', 'tool', 'notice', 'turn-end'].includes(i.kind))
  const shown = items.slice(-state.limit)
  let out = items.length > shown.length ? '<button class="more-older" data-action="older">Show earlier messages</button>' : ''
  let tools = []
  const flush = () => { if (tools.length) out += toolGroup(tools); tools = [] }
  for (const i of shown) {
    if (i.kind === 'tool') { tools.push(i); continue }
    flush()
    if (i.kind === 'user') out += '<div class="me">' + safe(i.text) + '</div>'
    else if (i.kind === 'assistant') { if (i.text.trim()) out += '<div class="ag">' + md(i.text) + '</div>' }
    else if (i.kind === 'notice') out += '<div class="sys' + (i.level === 'error' ? ' err' : '') + '">' + safe(i.text) + '</div>'
    else if (i.kind === 'turn-end') out += turnEnd(i, s) + '<div class="gap"></div>'
  }
  flush()
  const approvals = state.model.approvals.filter((a) => a.sessionId === s.id)
  if (s.status === 'running' && !approvals.length) out += '<div class="typing" aria-label="Agent is working"><i></i><i></i><i></i></div>'
  out += approvals.map(requestHtml).join('')
  if (!items.length && !approvals.length && s.status !== 'running') out = '<div class="empty"><b>New chat</b>' + (canAct() ? 'Send a message to start ' + safe(agentName(s.agent)) + '.' : 'Nothing has been said here yet.') + '</div>'
  return '<div class="msgs">' + out + '</div>'
}
// Watching: the request as it stands, without its answers (the action row is each card's last part).
function requestHtml(a) {
  const html = requestCard(a)
  return canAct() ? html : html.slice(0, html.indexOf('<div class="acts">')) + '</div>'
}
function requestCard(a) {
  const id = safe(a.id)
  const replying = state.replying.has(a.id)
  const note = '<textarea class="note" data-note="' + id + '" placeholder="' + (a.kind === 'plan' ? 'What should change in the plan?' : 'Tell the agent what to do instead…') + '">' + safe(state.notes[a.id] || '') + '</textarea>'
  if (a.kind === 'tool') {
    const arg = toolArg(a.toolName, a.input)
    const detail = a.toolName === 'Bash' && arg ? arg : JSON.stringify(a.input, null, 2)
    return '<div class="req"><div class="rh">' + icon('lock', 'sm') + 'Permission needed · ' + safe(a.toolName) + '</div><div class="rb">' +
      (a.reason ? '<p class="why">' + safe(a.reason) + '</p>' : '') + '<pre class="cmd">' + safe(detail) + '</pre>' + (replying ? note : '') + '</div>' +
      '<div class="acts">' + (replying ? '<button class="alt" data-action="reply:' + id + '">Cancel</button><button class="no" data-action="deny:' + id + '">Deny &amp; send</button>' :
        '<button class="no" data-action="deny:' + id + '">Deny</button><button class="alt" data-action="reply:' + id + '">Reply</button><button class="yes" data-action="allow:' + id + '">Allow</button>') + '</div></div>'
  }
  if (a.kind === 'plan') {
    const full = state.fullPlans.has(a.id)
    const long = a.plan.length > 600 || a.plan.split('\n').length > 12
    return '<div class="req"><div class="rh">' + icon('file', 'sm') + 'Plan ready for review</div><div class="rb">' +
      '<div class="plan-body' + (full || !long ? ' full' : ' clip') + '">' + md(a.plan) + '</div>' + (long ? '<button class="linkish" data-action="plan:' + id + '">' + (full ? 'Show less' : 'Show full plan') + '</button>' : '') + (replying ? note : '') + '</div>' +
      '<div class="acts">' + (replying ? '<button class="alt" data-action="reply:' + id + '">Cancel</button><button class="no" data-action="reject:' + id + '">Send feedback</button>' :
        '<button class="no" data-action="reject:' + id + '">Reject</button><button class="alt" data-action="reply:' + id + '">Reply</button><button class="yes" data-action="approve:' + id + '">Approve</button>') + '</div></div>'
  }
  if (a.kind === 'gate') {
    // A flow's gate: what it shows, a note for Send back, and Stop · Send back · Continue.
    const gateNote = '<textarea class="note" data-note="' + id + '" placeholder="Send back with a note…">' + safe(state.notes[a.id] || '') + '</textarea>'
    return '<div class="req"><div class="rh">' + icon('chat', 'sm') + safe(a.flowName) + ' · ' + safe(a.step) + '</div><div class="rb">' +
      '<p class="why">' + safe(a.ask) + '</p>' + a.show.map((x) => x.kind === 'file' ? '<p class="why"><b>' + safe(x.path || '') + '</b></p><pre class="file">' + safe(x.summary) + '</pre>' : '<p class="why">' + safe(x.summary) + '</p>').join('') + (canAct() ? gateNote : '') + '</div>' +
      '<div class="acts"><button class="no" data-action="gstop:' + id + '">Stop</button><button class="alt" data-action="gback:' + id + '">Send back</button><button class="yes" data-action="gcont:' + id + '">Continue</button></div></div>'
  }
  if (a.kind === 'pick') {
    // A flow's pick: each result with how it stands; choose one, then Go on (or Stop with none chosen).
    const chosen = state.picks[a.id]
    return '<div class="req"><div class="rh">' + icon('chat', 'sm') + safe(a.flowName) + ' · ' + safe(a.step) + '</div><div class="rb">' +
      '<p class="why">' + safe(a.ask) + '</p><div class="opts">' +
      a.choices.map((c, ci) => '<button class="opt' + (chosen === c.step ? ' on' : '') + '" data-action="pchoose:' + id + '|' + ci + '"><span class="mk"></span><span><b>' + safe(c.step) + '</b><small>' + safe(c.summary) + '</small></span></button>').join('') +
      '</div></div><div class="acts"><button class="no" data-action="pstop:' + id + '">Stop</button><button class="yes" data-action="pgo:' + id + '"' + (chosen ? '' : ' disabled') + '>' + (chosen ? 'Go on with ' + safe(chosen) : 'Pick one first') + '</button></div></div>'
  }
  const picked = state.answers[a.id] || {}
  return '<div class="req"><div class="rh">' + icon('chat', 'sm') + (a.questions.length > 1 ? a.questions.length + ' questions' : 'Question') + '</div><div class="rb">' +
    a.questions.map((q, qi) => '<div class="q"><h4>' + (q.header ? '<span>' + safe(q.header) + ' · </span>' : '') + safe(q.question) + '</h4><div class="opts">' +
      q.options.map((o, oi) => '<button class="opt' + (q.multiSelect ? ' multi' : '') + ((picked[qi] || []).includes(o.label) ? ' on' : '') + '" data-action="pick:' + id + '|' + qi + '|' + oi + '"><span class="mk"></span><span><b>' + safe(o.label) + '</b>' + (o.description ? '<small>' + safe(o.description) + '</small>' : '') + '</span></button>').join('') +
      '</div><input data-other="' + id + '|' + qi + '" placeholder="Other answer…" value="' + safe(state.others[a.id + '|' + qi] || '') + '"></div>').join('') +
    '</div><div class="acts"><button class="alt" data-action="skip:' + id + '">Skip</button><button class="yes" data-action="answer:' + id + '">Send answer</button></div></div>'
}
function diffHtml() {
  const d = state.diff
  if (!d) return '<div class="empty">Loading changes…</div>'
  if (!d.files.length) return '<div class="empty"><b>No changes yet</b>Nothing differs from ' + safe(d.baseRef || 'the base branch') + '.</div>'
  const add = d.files.reduce((n, f) => n + f.additions, 0), del = d.files.reduce((n, f) => n + f.deletions, 0)
  const comments = commentsOf(state.wsId)
  const file = (f) => {
    const open = state.openFiles.has(f.path)
    const slash = f.path.lastIndexOf('/')
    const mine = comments.filter((c) => c.file === f.path)
    let body = ''
    if (open) {
      if (f.binary) body = '<div class="cut">Binary file</div>'
      else {
        let budget = 400
        const placed = new Set()
        const line = (l) => {
          const no = l.type === 'del' ? null : l.newNo
          const here = no == null ? [] : mine.filter((c) => c.side !== 'old' && c.line === no)
          here.forEach((c) => placed.add(c.id))
          const cells = '<span class="no">' + (l.type === 'add' ? '' : l.oldNo ?? '') + '</span><span class="no">' + (no ?? '') + '</span><span class="tx">' + (l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ') + safe(l.text) + '</span>'
          // #127: a line of the new side takes a comment, as a line in the window's diff does.
          const row = no != null && canAct() ? '<button class="ln ' + l.type + '" data-action="cmt:' + safe(f.path) + '|' + no + '" aria-label="Comment on line ' + no + '">' + cells + '</button>' : '<div class="ln ' + l.type + '">' + cells + '</div>'
          const writing = state.commenting && state.commenting.file === f.path && state.commenting.line === no
          return row + here.map(commentHtml).join('') + (writing ? commentBox(no) : '')
        }
        body = '<div class="hunks">' + f.hunks.map((h) => {
          if (budget <= 0) return ''
          const lines = h.lines.slice(0, budget)
          budget -= lines.length
          return '<div class="hh">' + safe(h.header) + '</div>' + lines.map(line).join('')
        }).join('') + (budget <= 0 ? '<div class="cut">Diff shortened. Open it on your computer for the rest.</div>' : '') + '</div>'
        // Comments on lines this diff doesn't show (a removed line, or one past the cut), under the file.
        const rest = mine.filter((c) => !placed.has(c.id))
        if (rest.length) body += '<div class="cmts-rest"><div class="hh">Other comments</div>' + rest.map(commentHtml).join('') + '</div>'
      }
    }
    const count = mine.length ? '<span class="cn">' + icon('chat', 'sm') + mine.length + '<span class="vh"> comment' + (mine.length === 1 ? '' : 's') + '</span></span>' : ''
    return '<div class="file' + (open ? ' open' : '') + '"><button data-action="file:' + safe(f.path) + '">' + icon('chev', 'sm chev') + '<span class="p"><bdi>' + safe(f.path.slice(0, slash + 1)) + '<b>' + safe(f.path.slice(slash + 1)) + '</b></bdi></span>' + count + '<span class="n"><span class="a">+' + f.additions + '</span> <span class="d">−' + f.deletions + '</span></span></button>' + body + '</div>'
  }
  const pending = comments.filter((c) => c.author === 'user').length
  return '<div class="pad"><div class="sum"><span>' + d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ' vs ' + safe(d.baseRef) + '</span><span class="mono"><span class="a">+' + add + '</span> <span class="d">−' + del + '</span></span></div>' +
    (d.truncated ? '<div class="banner info" style="margin:0 0 8px">This diff was too large to send in full.</div>' : '') +
    (canAct() && d.files.length ? '<p class="hint">' + (pending ? pending + ' comment' + (pending === 1 ? '' : 's') + ' will go with your next message.' : 'Tap a line to comment. Comments go with your next message.') + '</p>' : '') +
    d.files.map(file).join('') + '</div>'
}
// A diff comment: yours, waiting for your next message (Delete), or the agent's, open (Resolve).
function commentHtml(c) {
  const mine = c.author === 'user'
  const where = c.side === 'old' ? 'removed line ' + c.line : 'line ' + c.line
  const act = !canAct() ? '' : mine ? '<button class="linkish" data-action="cdel:' + safe(c.id) + '">Delete</button>' : '<button class="linkish" data-action="cres:' + safe(c.id) + '">Resolve</button>'
  return '<div class="cmt' + (mine ? ' mine' : '') + '"><div class="ch"><b>' + (mine ? 'You' : safe(c.authorLabel || 'Agent')) + '</b> · ' + where + (mine ? ' · goes with your next message' : '') + '</div>' +
    '<p>' + safe(c.body) + '</p>' + act + '</div>'
}
function commentBox(line) {
  return '<div class="cmt new"><textarea data-comment placeholder="Comment on line ' + line + '…" aria-label="Comment on line ' + line + '">' + safe(state.commentDraft) + '</textarea>' +
    '<div class="row"><button class="btn" data-action="cmt-cancel">Cancel</button><button class="btn pri" data-action="cmt-save">Add comment</button></div></div>'
}
function checksHtml() {
  const c = state.checks
  if (!c) return '<div class="empty">Loading checks…</div>'
  if (!c.configured && !c.rows.length) return '<div class="empty"><b>No checks configured</b>Add checks for this repository in Foreman on your computer.</div>'
  const mark = (r) => r.result?.status === 'running' || (c.running && !r.result) ? ['run', 'clock'] : r.result?.status === 'passed' ? ['ok', 'check'] : r.result ? ['bad', 'x'] : ['', 'minus']
  const run = !canAct() ? (c.running ? '<p class="hint">Checks are running…</p>' : '') : '<button class="btn dark" data-action="run-checks"' + (c.running ? ' disabled' : '') + '>' + (c.running ? 'Checks are running…' : 'Run checks') + '</button>'
  return '<div class="pad">' + (state.checkConsent && canAct() ? '<div class="consent"><p>Approve these check commands?</p><pre class="cmd">' + safe(state.checkConsent.map((x) => x.name + ': ' + x.command).join('\n')) + '</pre><button class="btn pri" data-action="approve-checks">Approve and run</button></div>' : '') +
    '<div class="card">' + c.rows.map((r) => { const [cls, ic] = mark(r); return '<div class="ck"><span class="st ' + cls + '">' + icon(ic, 'sm') + '</span><span class="nm"><b>' + safe(r.name) + '</b><small>' + safe(r.command) + '</small></span><span class="tm">' + (r.result?.durationMs ? secs(r.result.durationMs) : r.stale && r.result ? 'stale' : r.result ? '' : 'not run') + '</span></div>' }).join('') + '</div>' +
    run + '</div>'
}
function prHtml() {
  const g = state.git
  if (!g) return '<div class="empty">Loading pull request…</div>'
  const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'
  const branch = '<div class="card pr">' + kv('Branch', '<span class="mono">' + safe(g.branch) + '</span>') + kv('Base', '<span class="mono">' + safe(g.baseRef) + '</span>') + kv('Commits ahead', g.aheadBase + (g.behindBase ? ' · ' + g.behindBase + ' behind' : '')) + kv('Uncommitted files', g.uncommitted) + '</div>'
  const pr = g.pr
  if (!pr) return '<div class="pad"><div class="empty" style="padding:28px 10px"><b>No pull request</b>' + safe(g.prProblem?.message || (g.onBase ? 'This workspace works directly on its base branch.' : 'Ask the agent to open one when the work is ready.')) + '</div>' + branch + '</div>'
  const failing = pr.checks.filter((c) => c.state === 'failure').length
  const pending = pr.checks.filter((c) => c.state === 'pending').length
  const stateChip = pr.state === 'MERGED' ? '<span class="chip acc">Merged</span>' : pr.state === 'CLOSED' ? '<span class="chip r">Closed</span>' : pr.isDraft ? '<span class="chip">Draft</span>' : '<span class="chip g">Open</span>'
  const ci = !pr.checks.length ? '' : failing ? '<span class="chip r">' + failing + ' failing</span>' : pending ? '<span class="chip am">CI running</span>' : '<span class="chip g">CI passed</span>'
  const review = pr.reviewDecision === 'APPROVED' ? '<span class="chip g">Approved</span>' : pr.reviewDecision === 'CHANGES_REQUESTED' ? '<span class="chip r">Changes requested</span>' : ''
  const conflict = pr.mergeable === 'CONFLICTING' ? '<span class="chip r">Conflicts</span>' : ''
  const link = typeof pr.url === 'string' && pr.url.startsWith('https://github.com/') ? '<a class="btn" href="' + safe(pr.url) + '" target="_blank" rel="noreferrer">Open on GitHub</a>' : ''
  return '<div class="pad"><div class="card pr"><div class="n">#' + safe(pr.number) + ' → ' + safe(pr.baseRefName) + '</div><h3>' + safe(pr.title || 'Pull request') + '</h3><div class="chips">' + stateChip + ci + review + conflict + '</div>' + link + '</div>' + branch + '</div>'
}
function threadView() {
  const w = ws()
  const sessions = sessionsOf(w)
  const approvals = approvalsOf(w)
  if (!sessions.some((s) => s.id === state.sessionId)) state.sessionId = approvals[0]?.sessionId || w.sessionId || sessions[0]?.id || null
  const s = sessions.find((x) => x.id === state.sessionId)
  const st = statusLine(w, s, approvals)
  const sub = st.text + (sessions.length > 1 && s ? ' · ' + (s.title || agentName(s.agent)) : s ? ' · ' + agentName(s.agent) : '')
  const checks = w.checks?.results || []
  const checkMark = w.checks?.running ? '' : checks.some((r) => r.status !== 'passed') ? '<span class="bad">✕</span>' : checks.length ? '<span class="ok">✓</span>' : ''
  const tab = (id, label) => '<button class="' + (state.tab === id ? 'on' : '') + '" data-action="tab:' + id + '">' + label + '</button>'
  const top = '<div class="thead"><button class="icon-btn back" data-action="back" aria-label="Back">' + icon('back') + '</button>' +
    '<span class="av md ' + ring(w, approvals) + '" style="background:' + colorFor(w.name) + '">' + initial(w.name) + '</span>' +
    '<span class="tt"><b>' + safe(w.name) + '</b><small class="' + st.cls + '">' + safe(sub) + '</small></span>' +
    '<button class="icon-btn" data-action="sheet:menu" aria-label="Workspace actions">' + icon('more') + '</button></div>' +
    '<div class="subtabs">' + tab('chat', 'Chat') + tab('changes', 'Changes' + (state.diff?.files.length ? ' <span class="n">' + state.diff.files.length + '</span>' : '')) + tab('checks', 'Checks ' + checkMark) + tab('pr', 'PR' + (state.git?.pr ? ' <span class="n">#' + safe(state.git.pr.number) + '</span>' : '')) +
    // Terminal output goes only to a phone that may operate (docs/server.md), so a watching phone has no tab for it.
    (canAct() ? tab('terminal', 'Terminal' + (state.terms?.length ? ' <span class="n">' + state.terms.length + '</span>' : '')) : '') + '</div>'
  const elsewhere = approvals.find((a) => a.sessionId !== state.sessionId)
  let body = elsewhere ? '<div style="padding:8px 12px 0"><button class="other-req" data-action="session:' + safe(elsewhere.sessionId) + '">' + icon('lock', 'sm') + 'Another chat in this workspace needs you' + icon('chev', 'sm') + '</button></div>' : ''
  let foot = ''
  if (state.tab === 'chat') {
    if (s) {
      const draft = state.drafts[s.id] || ''
      const running = s.status === 'running'
      body += chatHtml(s)
      const pending = commentsOf(w.id).filter((c) => c.author === 'user').length
      const mode = modeFor(s)
      foot = queueHtml(s, running) + (!canAct() ? WATCH_ONLY :
        (pending ? '<p class="hint">' + pending + ' diff comment' + (pending === 1 ? '' : 's') + ' will go with this message</p>' : '') +
        '<div class="cmp">' +
        // #127: while a turn runs, whether this message steers it or waits for it to end (an agent that can't steer always waits).
        (s.canSteer ? '<button class="mode' + (mode === 'steer' ? ' on' : '') + '" data-action="mode" aria-pressed="' + (mode === 'steer') + '" title="' + MODE_TITLE[mode] + '"' + (running ? '' : ' hidden') + '>' + (mode === 'steer' ? 'Steer' : 'Queue') + '</button>' : '') +
        '<textarea id="draft" rows="1" placeholder="' + (running ? (mode === 'steer' ? 'Steer the agent…' : 'Queue a follow-up…') : 'Message ' + safe(agentName(s.agent))) + '" enterkeyhint="send">' + safe(draft) + '</textarea>' +
        '<button class="round send" data-action="send" aria-label="Send"' + (running && !draft.trim() ? ' hidden' : '') + '>' + icon('up') + '</button>' +
        '<button class="round stop" data-action="stop" aria-label="Stop the agent"' + (running && !draft.trim() ? '' : ' hidden') + '><i></i></button></div>')
    } else body += '<div class="empty"><b>No chat yet</b>' + (canAct() ? '<button class="btn pri" style="margin-top:14px" data-action="new-chat">Start a chat</button>' : '') + '</div>'
  } else body += state.tab === 'changes' ? diffHtml() : state.tab === 'checks' ? checksHtml() : state.tab === 'terminal' ? termHtml() : prHtml()
  return { top, body, foot, over: sheetHtml() }
}
// #127: what waits for the turn to end, each sent into it now (an agent that can steer, while it runs) or deleted.
function queueHtml(s, running) {
  const queue = s.queue || []
  if (!queue.length) return ''
  const shown = queue.slice(0, 3)
  const row = (q) => '<div class="qrow"><span class="qt">' + safe(firstLine(q.text) || q.text) + '</span>' +
    (canAct() ? (s.canSteer && running ? '<button class="linkish" data-action="qsteer:' + safe(q.id) + '">Send now</button>' : '') + '<button class="linkish" data-action="qremove:' + safe(q.id) + '">Delete</button>' : '') + '</div>'
  return '<div class="queue" role="group" aria-label="Queued messages"><p class="hint">Queued · sent when the agent finishes</p>' + shown.map(row).join('') +
    (queue.length > shown.length ? '<p class="hint">and ' + (queue.length - shown.length) + ' more</p>' : '') + '</div>'
}
// #127: a workspace's terminals, read-only: the end of each one's output, as plain text, following it while it prints.
function termName(t, list) {
  if (t.kind === 'shell') return 'Terminal ' + (list.filter((x) => x.kind === 'shell').indexOf(t) + 1)
  const line = firstLine(t.command) || (t.kind === 'snippet' ? 'Snippet' : 'Run')
  return line.length > 32 ? line.slice(0, 31) + '…' : line
}
function termHtml() {
  const list = state.terms
  if (!list) return '<div class="empty">Loading terminals…</div>'
  if (!list.length) return '<div class="empty"><b>No terminals open</b>Terminals opened in Foreman on your computer show here.</div>'
  const t = list.find((x) => x.id === state.term) || list[list.length - 1]
  state.term = t.id
  const chips = list.length > 1 ? '<div class="filters terms">' + list.map((x) => '<button class="' + (x.id === t.id ? 'on' : '') + '" data-action="term:' + safe(x.id) + '" aria-pressed="' + (x.id === t.id) + '">' + safe(termName(x, list)) + (x.code !== undefined ? ' · ended' : '') + '</button>').join('') + '</div>' : ''
  const status = t.code === undefined ? '<span class="chip g">Running</span>' : '<span class="chip' + (t.code ? ' r' : '') + '">Ended' + (t.code ? ' · exit ' + safe(t.code) : '') + '</span>'
  return chips + '<div class="pad"><div class="sum"><span>' + safe(termName(t, list)) + '</span>' + status + '</div>' +
    (t.text ? '<pre class="term">' + safe(t.text) + '</pre>' : '<div class="empty" style="padding:28px 10px">No output yet.</div>') +
    '<p class="hint">Read-only here. Type in it in Foreman on your computer.</p></div>'
}

// ---------- sheets ----------
function sheetHtml() {
  if (!state.sheet || (state.sheet === 'new' && !canAct())) return ''
  let inner = ''
  if (state.sheet === 'new') {
    const repos = state.model.repos
    if (!repos.some((r) => r.id === state.newRepo)) state.newRepo = (ws() && repos.some((r) => r.id === ws().repoId) ? ws().repoId : repos[0]?.id) || null
    const tpls = state.model.templates || []
    inner = '<h3>New workspace <button data-action="close">Cancel</button></h3><p class="sub">Starts an agent in a fresh worktree.</p>' +
      (repos.length ? '<div class="lbl">Repository</div><div class="repos">' + repos.map((r) => '<button class="' + (r.id === state.newRepo ? 'on' : '') + '" data-action="repo:' + safe(r.id) + '"><span class="tile" style="background:' + colorFor(r.id) + '">' + initial(r.name) + '</span>' + safe(r.name) + '</button>').join('') + '</div>' +
        '<div class="lbl">What should the agent do?</div><textarea id="prompt" class="prompt" placeholder="Describe the task…">' + safe(state.newPrompt) + '</textarea>' +
        (tpls.length ? '<div class="tpls">' + tpls.slice(0, 8).map((t) => '<button data-action="tpl:' + safe(t.id) + '">' + safe(t.name) + '</button>').join('') + '</div>' : '') +
        '<button class="btn pri" data-action="create"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Starting…' : 'Start agent') + '</button>'
        : '<p class="sub">Add a repository in Foreman on your computer first.</p>')
  } else if (state.sheet === 'menu') {
    const w = ws()
    const sessions = w ? sessionsOf(w) : []
    const waiting = new Set(state.model.approvals.map((a) => a.sessionId))
    inner = '<h3>' + safe(w?.name || 'Workspace') + ' <button data-action="close">Done</button></h3><p class="sub mono">' + safe(w?.branch || '') + '</p><div class="menu">' +
      (sessions.length > 1 ? '<div class="grp">Chats</div>' + sessions.map((s) => '<button data-action="session:' + safe(s.id) + '">' + icon('chat') + '<span>' + safe(s.title || agentName(s.agent) + ' · ' + s.model) + '</span><span class="meta">' + (waiting.has(s.id) ? 'needs you' : s.status === 'running' ? 'working' : s.waitingForSlot ? 'queued' : '') + '</span>' + (s.id === state.sessionId ? icon('check', 'on') : '') + '</button>').join('') + '<div class="grp">Actions</div>' : '') +
      (canAct() ? '<button data-action="new-chat">' + icon('plus') + 'New chat</button>' : '') + '<button data-action="refresh">' + icon('refresh') + 'Refresh</button>' +
      (canAct() ? '<button class="danger" data-action="archive">' + icon('archive') + 'Archive workspace</button>' : '') + '</div>' + usageHtml(w)
  } else if (state.sheet === 'device') {
    const https = location.protocol === 'https:'
    inner = '<h3>This phone <button data-action="close">Done</button></h3><div class="menu">' +
      '<div class="kv" style="border:0"><span>Connection</span><b>' + (https ? 'Private HTTPS' : 'Same Wi-Fi') + '</b></div>' +
      (state.scopes ? '<div class="kv" style="border:0"><span>Access</span><b>' + (state.scopes.includes('admin') ? 'Full control' : canAct() ? 'Operate' : 'Watch') + '</b></div>' : '') +
      (https ? '<button data-action="enable-push">' + icon('bell') + 'Enable phone alerts</button>' : '<p class="sub">Same-Wi-Fi access works only while you are nearby, and cannot send alerts. Pair through the private HTTPS address for alerts and access away from home.</p>') +
      '<p class="sub" style="margin-top:12px">To unpair, revoke this phone from the phone button in Foreman on your computer.</p></div>'
  }
  return '<div class="dim" data-action="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + inner + '</div>'
}

// #127: how full the open chat's context is, and what the chat and the workspace used (turns, agent time, cost).
const tokens = (n) => n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
function took(ms) {
  const m = Math.round(ms / 60000)
  return m < 1 ? secs(ms) : m < 60 ? m + ' min' : Math.floor(m / 60) + ' h ' + (m % 60) + ' min'
}
function spent(u) {
  const cost = typeof u.costUsd === 'number' ? '$' + u.costUsd.toFixed(2) : u.costNote ? safe(u.costNote) : ''
  return u.turns + ' turn' + (u.turns === 1 ? '' : 's') + ' · ' + took(u.agentMs) + (cost ? ' · ' + cost : '')
}
function usageHtml(w) {
  const s = w && state.model.sessions.find((x) => x.id === state.sessionId)
  const u = state.usage && state.usage.workspaceId === w?.id ? state.usage.value : null
  const kv = (k, v) => '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'
  let rows = ''
  if (s?.context && s.context.limit) rows += kv('Context', Math.round(s.context.used / s.context.limit * 100) + '% · ' + tokens(s.context.used) + ' of ' + tokens(s.context.limit))
  const tab = u && s ? u.tabs[s.id] : null
  if (tab && tab.turns) rows += kv('This chat', spent(tab))
  if (u && u.total.turns) rows += kv('Workspace', spent(u.total) + (u.total.partial && typeof u.total.costUsd === 'number' ? ' (some chats have no cost)' : ''))
  if (!rows) rows = state.usage ? '<p class="sub">Nothing used yet.</p>' : '<p class="sub">Loading usage…</p>'
  return '<div class="menu usage"><div class="grp">Usage</div>' + rows + '</div>'
}

// ---------- pairing ----------
function pairView() {
  return { body: '<div class="pair"><div class="logo">F</div><h1>Confirm on your computer</h1><p>Check that Foreman shows the same code, then approve this phone.</p>' +
    '<div class="code-card"><div class="code">' + safe(state.pairCode || '··· ···') + '</div></div>' +
    '<div class="wait"><span class="typing"><i></i><i></i><i></i></span>Waiting for approval · expires in 2 minutes</div></div>' }
}
function unpairedView() {
  return { body: '<div class="pair"><div class="logo">F</div><h1>Pair this phone</h1>' +
    (state.signedOut ? '<p class="banner info" role="status">' + safe(state.signedOut) + '</p>' : '<p>Control your Foreman agents from here.</p>') +
    '<div class="steps"><div><b>1</b>Open Foreman on your computer.</div><div><b>2</b>Click the phone button at the top of the sidebar.</div><div><b>3</b>Scan the QR code with this phone’s camera.</div></div>' +
    '<button class="btn dark" data-action="retry">I’ve paired, try again</button></div>' }
}

// ---------- data ----------
async function refresh() {
  try {
    state.model = await request('GET', '/api/state')
    state.error = ''
  } catch (err) {
    if (err.status === 401 || err.message.includes('not paired')) {
      // Revoked while the socket was down, or the cookie expired: nothing live is left to keep.
      stopLive()
      state.model = null
      state.scopes = null
    }
    state.error = err.message
  }
}
// What this phone may do. The welcome says it again on every connection; this covers the first render.
async function loadSession() {
  try { state.scopes = (await request('GET', '/api/session')).scopes } catch {}
}
// Paired (just now, or on an earlier visit): the model, the access, then the live connection.
async function signedIn() {
  await refresh()
  if (!state.model) return
  state.signedOut = ''
  await loadSession()
  startLive()
}
async function loadTab() {
  if (state.view !== 'thread' || !state.wsId) return
  const wsPath = '/api/workspace/' + encodeURIComponent(state.wsId)
  try {
    if (state.tab === 'chat' && state.sessionId) {
      const id = state.sessionId
      // `live`: with the reply still being written, so chat-append has the streaming item to continue.
      const chat = await request('GET', '/api/chat/' + encodeURIComponent(id) + '?live=1')
      if (id === state.sessionId) { state.chat = chat; state.chatFor = id }
    }
    if (state.tab === 'changes') state.diff = await request('GET', wsPath + '/diff')
    if (state.tab === 'checks') state.checks = await request('GET', wsPath + '/checks')
    if (state.tab === 'pr') state.git = await request('GET', wsPath + '/git')
    if (state.tab === 'terminal') {
      const id = state.wsId
      const terms = await request('GET', wsPath + '/terminals')
      if (id === state.wsId) state.terms = terms
    }
  } catch (err) { state.error = err.message }
}
// The menu's usage: read when it opens, kept with the workspace it is for.
async function loadUsage() {
  const id = state.wsId
  try {
    const value = await request('GET', '/api/workspace/' + encodeURIComponent(id) + '/usage')
    if (id === state.wsId) state.usage = { workspaceId: id, value }
  } catch (err) { state.error = err.message }
}
function openThread(id, sessionId = null, push = true) {
  if (push && state.view !== 'thread') history.pushState({ thread: id }, '')
  Object.assign(state, { view: 'thread', wsId: id, sessionId, tab: 'chat', chat: [], chatFor: null, diff: null, checks: null, git: null, checkConsent: null, sheet: null, limit: 120, error: '', commenting: null, commentDraft: '', terms: null, term: null, usage: null })
  state.openFiles.clear()
  render()
  void loadTab().then(render)
}
function backToList() {
  Object.assign(state, { view: 'list', wsId: null, sessionId: null, sheet: null, error: '' })
  render()
}
// A link to the full app (/app?pair=…) comes here to pair, as a browser, and goes back once approved. Only /app.
function pairThen() {
  return new URLSearchParams(location.search).get('then') === '/app' ? '/app' : null
}
async function startPairing(secret) {
  try {
    const then = pairThen()
    const name = then ? browserName() : /iPhone|iPad|Android/i.exec(navigator.userAgent)?.[0] || 'Phone'
    const p = await request('POST', '/api/pair/start', then ? { token: secret, name, kind: 'browser' } : { token: secret, name })
    state.pairingId = p.id
    state.pairCode = p.code
    sessionStorage.setItem('pairingId', p.id)
    sessionStorage.setItem('pairCode', p.code)
    if (then) sessionStorage.setItem('pairThen', then)
    else sessionStorage.removeItem('pairThen')
    history.replaceState(null, '', '/')
    render()
    pollPair()
  } catch (err) { history.replaceState(null, '', '/'); fail(err) }
}
function clearPairing() {
  state.pairingId = null
  state.pairCode = null
  sessionStorage.removeItem('pairingId')
  sessionStorage.removeItem('pairCode')
  sessionStorage.removeItem('pairThen')
}
// "Chrome on Mac": what the person approving sees a browser as (src/renderer/src/socketBridge.ts says it the same way).
function browserName() {
  const ua = navigator.userAgent
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : ''
  const os = /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : ''
  return browser && os ? browser + ' on ' + os : browser || 'Browser'
}
async function pollPair() {
  if (!state.pairingId) return
  try {
    const p = await request('GET', '/api/pair/status?id=' + encodeURIComponent(state.pairingId))
    if (p.state === 'approved') {
      // The cookie is set: a browser goes on to the full app it asked for.
      const then = sessionStorage.getItem('pairThen') === '/app' ? '/app' : null
      clearPairing()
      if (then) return location.replace(then)
      await signedIn(); render(); return
    }
    if (p.state === 'denied') throw new Error('Pairing was denied on the computer.')
    setTimeout(pollPair, 1800)
  } catch (err) { clearPairing(); fail(err) }
}
async function enablePush() {
  if (location.protocol !== 'https:') throw new Error('Phone alerts need private HTTPS access.')
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) throw new Error('Add Foreman to your Home Screen to enable alerts.')
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Notification permission was not granted.')
  const registration = await navigator.serviceWorker.register('/sw.js')
  const key = (await request('GET', '/api/push-key')).key
  const padded = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=')
  const bytes = Uint8Array.from(atob(padded), (c) => c.charCodeAt(0))
  const sub = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: bytes })
  await request('POST', '/api/push', sub.toJSON())
  state.sheet = null
  toast('Phone alerts enabled')
  render()
}
async function respond(id, answer, done) {
  await request('POST', '/api/approval/' + encodeURIComponent(id), answer)
  state.replying.delete(id)
  delete state.notes[id]; delete state.answers[id]
  for (const k of Object.keys(state.others)) if (k.startsWith(id + '|')) delete state.others[k]
  toast(done)
  await refresh()
  await loadTab()
  render()
}
function sizeDraft() {
  const d = document.getElementById('draft')
  if (!d) return
  d.style.height = 'auto'
  d.style.height = Math.min(d.scrollHeight + 2, 140) + 'px'
}
function syncComposer() {
  const s = state.model?.sessions.find((x) => x.id === state.sessionId)
  const empty = !(state.drafts[state.sessionId] || '').trim()
  const stop = s?.status === 'running' && empty
  root.querySelector('.round.send')?.toggleAttribute('hidden', stop)
  root.querySelector('.round.stop')?.toggleAttribute('hidden', !stop)
  root.querySelector('.cmp .mode')?.toggleAttribute('hidden', s?.status !== 'running')
}
// Queue ↔ steer for this chat's next message, changed in place so the draft keeps its focus and keyboard.
function flipMode(button) {
  const s = state.model.sessions.find((x) => x.id === state.sessionId)
  if (!s?.canSteer) return
  const mode = modeFor(s) === 'steer' ? 'queue' : 'steer'
  state.sendMode[s.id] = mode
  button.textContent = mode === 'steer' ? 'Steer' : 'Queue'
  button.title = MODE_TITLE[mode]
  button.classList.toggle('on', mode === 'steer')
  button.setAttribute('aria-pressed', String(mode === 'steer'))
  const draft = document.getElementById('draft')
  if (draft) draft.placeholder = mode === 'steer' ? 'Steer the agent…' : 'Queue a follow-up…'
}
async function send() {
  const id = state.sessionId
  const text = (state.drafts[id] || '').trim()
  if (!text || state.busy) return
  const s = state.model.sessions.find((x) => x.id === id)
  state.busy = true
  try {
    // Steering applies only to a running turn; otherwise the message starts one (or waits, the server decides).
    const result = await request('POST', '/api/chat/' + encodeURIComponent(id) + '/send', { text, mode: s ? modeFor(s) : 'queue' })
    state.drafts[id] = ''
    if (result.disposition === 'queued') toast('Queued for the next turn')
    else if (result.disposition === 'steered') toast('Sent to the running agent')
    await refresh()
    await loadTab()
    render()
  } finally { state.busy = false }
}

// ---------- live ----------
// Foreman's events replace the old 4-second poll. A poll every 30 seconds stands in only while the socket is down.
let live = null, viewed, fallback = null, roundTimer = null, roundRunning = false, termTimer = null
const due = { refresh: false, tab: false, paint: false }
const tabWanted = () => state.view === 'thread' && (state.tab === 'chat' || state.tab === 'terminal' || (state.tab === 'checks' && state.checks?.running))
// A busy terminal prints many times a second; what it printed is read again at most once a second.
const TERM_EVERY_MS = 1000
const ARCHIVE_STEP = { stop: 'stopping agents', checkpoint: 'saving changes', diff: 'saving the diff', script: 'running the archive script', docker: 'removing containers', remove: 'removing the folder', sandbox: 'stopping the sandbox' }

function startLive() {
  if (live || !state.model || !window.ForemanLive) return
  viewed = undefined
  live = window.ForemanLive.connect({
    url: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/api/ws',
    client: { kind: 'phone', name: /iPhone|iPad|Android/i.exec(navigator.userAgent)?.[0] || 'Phone' },
    onStatus: liveStatus,
    // Whatever happened while the socket was down is in a fresh state and chat.
    onWelcome: (welcome) => { state.scopes = welcome.session.scopes; soon({ refresh: true, tab: true }) },
    onEvent: liveEvent
  })
  syncView()
}
function stopLive() {
  if (live) live.close()
  live = null
  state.live = null
  clearInterval(fallback)
  fallback = null
}
function liveStatus(status) {
  state.live = status
  if (status === 'revoked') {
    stopLive()
    Object.assign(state, { model: null, scopes: null, view: 'list', wsId: null, sessionId: null, sheet: null, error: '', signedOut: 'This phone was signed out. Pair it again to use Foreman here.' })
    return render()
  }
  if (status === 'live') { clearInterval(fallback); fallback = null }
  else if (!fallback) fallback = setInterval(poll, 30000)
  // In place, so a status change never takes focus from the composer.
  const line = document.getElementById('live')
  const text = LIVE_TEXT[status] || ''
  if (line) { line.textContent = text; line.hidden = !text }
}
async function poll() {
  if (state.pairingId || !state.model || document.hidden) return
  await refresh()
  if (state.view === 'list' && state.filter === 'recent') await loadRecent()
  if (tabWanted()) await loadTab()
  paint()
}
// One round of reloads per 150 ms however many events ask for one; one asked for while a round runs follows it.
function soon(what) {
  for (const k of Object.keys(what)) if (what[k]) due[k] = true
  if (!roundTimer && !roundRunning) roundTimer = setTimeout(round, 150)
}
async function round() {
  roundTimer = null
  roundRunning = true
  const again = due.refresh, tab = due.tab
  due.refresh = due.tab = due.paint = false
  try {
    if (again) {
      await refresh()
      if (state.view === 'list' && state.filter === 'recent') await loadRecent()
    }
    if ((tab || again) && tabWanted()) await loadTab()
    paint()
  } finally {
    roundRunning = false
    if (due.refresh || due.tab || due.paint) roundTimer = setTimeout(round, 150)
  }
}
function liveEvent(event) {
  const t = event.type
  if (t === 'state' || t === 'approval' || t === 'approval-resolved' || t === 'notify' || t === 'attention-history') return soon({ refresh: true })
  if (t === 'archive-progress') return archiveStep(event)
  // #127: the shown workspace's terminals printed, ended or slept: read them again, no more than once a second.
  if (t === 'pty-data' || t === 'pty-exit' || t === 'pty-state') {
    if (event.workspaceId !== state.wsId || state.view !== 'thread' || state.tab !== 'terminal' || termTimer) return
    termTimer = setTimeout(() => { termTimer = null; soon({ tab: true }) }, TERM_EVERY_MS)
    return
  }
  // The rest belong to the open chat; before its first load there is nothing to put them in (the load brings them).
  if (event.sessionId !== state.sessionId || state.view !== 'thread' || state.tab !== 'chat' || state.chatFor !== state.sessionId) return
  // Whole items go in as they are, so the transcript follows without fetching the chat again.
  if (t === 'chat-reset') { state.chat = event.items; soon({ paint: true }) }
  else if (t === 'chat-item') { putItem(event.item); soon({ paint: true }) }
  else if (t === 'chat-append' && appendTo(event)) soon({ paint: true })
}
function putItem(item) {
  for (let i = state.chat.length - 1; i >= 0; i--) if (state.chat[i].id === item.id) { state.chat[i] = item; return }
  state.chat.push(item)
}
// shared/chatAppend.ts: an append continues a streaming reply holding exactly `from` characters. One that doesn't line
// up (missed, or the chat loaded mid-stream) is skipped; the whole item, resent every 2 s and once saved, puts it right.
function appendTo(e) {
  for (let i = state.chat.length - 1; i >= 0; i--) {
    const item = state.chat[i]
    if (item.id !== e.itemId) continue
    if ((item.kind !== 'assistant' && item.kind !== 'thinking') || item.streaming !== true || item.text.length !== e.from) return false
    state.chat[i] = { ...item, text: item.text + e.text }
    return true
  }
  return false
}
// The steps of an archive this phone started, or of the workspace it shows.
function archiveStep(e) {
  if (e.workspaceId !== state.archiving && !(state.view === 'thread' && state.wsId === e.workspaceId)) return
  const step = e.progress.status === 'running' && ARCHIVE_STEP[e.progress.step]
  if (step) toast('Archiving: ' + step + '…')
}
// The socket is sent the open chat's items and nothing of the others; on the Terminal tab, that workspace's terminals.
function syncView() {
  const thread = state.model && state.view === 'thread'
  const view = thread && state.tab === 'chat' && state.sessionId ? { sessionId: state.sessionId } : thread && state.tab === 'terminal' ? { workspaceId: state.wsId } : {}
  const key = JSON.stringify(view)
  if (!live || key === viewed) return
  viewed = key
  live.setView(view)
}

// ---------- events ----------
root.addEventListener('input', (event) => {
  const el = event.target
  if (el.id === 'draft') { state.drafts[state.sessionId] = el.value; sizeDraft(); syncComposer() }
  else if (el.id === 'search') { state.query = el.value; document.getElementById('scroller').innerHTML = listBody() }
  else if (el.id === 'prompt') state.newPrompt = el.value
  else if (el.dataset.note) state.notes[el.dataset.note] = el.value
  else if (el.dataset.comment !== undefined) state.commentDraft = el.value
  else if (el.dataset.other) {
    const [id, qi] = el.dataset.other.split('|')
    state.others[id + '|' + qi] = el.value
  }
})
root.addEventListener('keydown', (event) => {
  // A hardware keyboard sends with Enter; Shift+Enter (and the on-screen return key) adds a line.
  if (event.target.id === 'draft' && event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(hover: hover)').matches) {
    event.preventDefault()
    void send().catch(fail)
  }
})
// Tapping Queue/Steer must not take focus from the draft (on a phone that would close the keyboard).
root.addEventListener('pointerdown', (event) => { if (event.target.closest('.cmp .mode')) event.preventDefault() })
root.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]')
  if (!button || button.disabled) return
  const action = button.dataset.action
  const cut = action.indexOf(':')
  const name = cut < 0 ? action : action.slice(0, cut)
  const arg = cut < 0 ? '' : action.slice(cut + 1)
  const approval = () => {
    const a = state.model.approvals.find((x) => x.id === arg)
    if (!a) throw new Error('This request was already answered.')
    return a
  }
  try {
    if (name === 'retry') { await signedIn(); return render() }
    if (name === 'filter') { state.filter = arg; render(); if (arg === 'recent') { await loadRecent(); render() } return }
    if (name === 'open') { const a = state.model.approvals.find((x) => state.model.sessions.some((s) => s.id === x.sessionId && s.workspaceId === arg)); return openThread(arg, a?.sessionId || null) }
    if (name === 'back') { if (history.state?.thread) history.back(); else backToList(); return }
    if (name === 'sheet') { state.sheet = arg; render(); if (arg === 'menu') { await loadUsage(); if (state.sheet === 'menu') render() } return }
    if (name === 'close') { state.sheet = null; return render() }
    if (name === 'tab') { state.tab = arg; state.error = ''; render(); await loadTab(); return render() }
    if (name === 'session') { state.sessionId = arg; state.tab = 'chat'; state.chat = []; state.chatFor = null; state.sheet = null; state.limit = 120; render(); await loadTab(); return render() }
    if (name === 'older') { state.limit += 200; return render() }
    if (name === 'tools') { state.openTools.has(arg) ? state.openTools.delete(arg) : state.openTools.add(arg); return render() }
    if (name === 'file') { state.openFiles.has(arg) ? state.openFiles.delete(arg) : state.openFiles.add(arg); return render() }
    if (name === 'plan') { state.fullPlans.has(arg) ? state.fullPlans.delete(arg) : state.fullPlans.add(arg); return render() }
    if (name === 'reply') {
      state.replying.has(arg) ? state.replying.delete(arg) : state.replying.add(arg)
      render()
      if (state.replying.has(arg)) root.querySelector('[data-note="' + CSS.escape(arg) + '"]')?.focus()
      return
    }
    if (name === 'pick') {
      const [id, qi, oi] = arg.split('|')
      const a = state.model.approvals.find((x) => x.id === id)
      const q = a?.questions?.[qi]
      if (!q) return
      const label = q.options[oi].label
      const sel = (state.answers[id] ||= {})[qi] || []
      state.answers[id][qi] = q.multiSelect ? (sel.includes(label) ? sel.filter((l) => l !== label) : [...sel, label]) : (sel.includes(label) ? [] : [label])
      return render()
    }
    if (name === 'allow') return await respond(arg, { kind: 'tool', allow: true }, 'Allowed')
    if (name === 'deny') { approval(); return await respond(arg, { kind: 'tool', allow: false, message: state.replying.has(arg) ? state.notes[arg]?.trim() || undefined : undefined }, 'Denied') }
    if (name === 'approve') return await respond(arg, { kind: 'plan', approve: true }, 'Plan approved')
    if (name === 'gcont') return await respond(arg, { kind: 'gate', answer: 'continued' }, 'Flow continued')
    if (name === 'gback') return await respond(arg, { kind: 'gate', answer: 'sent-back', note: state.notes[arg]?.trim() || undefined }, 'Sent back')
    if (name === 'gstop') return await respond(arg, { kind: 'gate', answer: 'stopped' }, 'Flow stopped')
    if (name === 'pchoose') {
      const [id, ci] = arg.split('|')
      const a = state.model.approvals.find((x) => x.id === id)
      const choice = a?.choices?.[ci]
      if (!choice) return
      state.picks[id] = state.picks[id] === choice.step ? undefined : choice.step
      return render()
    }
    if (name === 'pgo') return state.picks[arg] ? await respond(arg, { kind: 'pick', chosen: state.picks[arg] }, 'Flow goes on with ' + state.picks[arg]) : undefined
    if (name === 'pstop') return await respond(arg, { kind: 'pick', chosen: null }, 'Flow stopped')
    if (name === 'reject') { approval(); return await respond(arg, { kind: 'plan', approve: false, feedback: state.replying.has(arg) ? state.notes[arg]?.trim() || undefined : undefined }, state.replying.has(arg) ? 'Feedback sent' : 'Plan rejected') }
    if (name === 'skip' || name === 'answer') {
      const a = approval()
      const answers = {}
      a.questions.forEach((q, i) => {
        const chosen = [...((state.answers[a.id] || {})[i] || [])]
        const other = (state.others[a.id + '|' + i] || '').trim()
        if (other) chosen.push(other)
        answers[q.question] = chosen.join(', ') || '(no answer)'
      })
      return await respond(a.id, { kind: 'question', answers, skipped: name === 'skip' }, name === 'skip' ? 'Skipped' : 'Answer sent')
    }
    if (name === 'send') return await send()
    if (name === 'mode') return flipMode(button)
    if (name === 'resume-at' || name === 'unresume' || name === 'resume-now') {
      await request('POST', '/api/chat/' + encodeURIComponent(state.sessionId) + '/resume-at', name === 'unresume' ? { cancel: true } : name === 'resume-now' ? { now: true } : { turnId: arg })
      toast(name === 'unresume' ? 'Resume cancelled' : name === 'resume-now' ? 'Resuming' : 'Resume armed')
      await refresh(); await loadTab(); return render()
    }
    // #127: a queued message sent into the running turn now, or deleted.
    if (name === 'qsteer' || name === 'qremove') {
      await request('POST', '/api/chat/' + encodeURIComponent(state.sessionId) + '/queued/' + encodeURIComponent(arg), { action: name === 'qsteer' ? 'steer' : 'remove' })
      toast(name === 'qsteer' ? 'Sent to the running agent' : 'Deleted from the queue')
      await refresh(); await loadTab(); return render()
    }
    // #127: diff comments: start one on a line, write it, add it; delete yours or resolve the agent's.
    if (name === 'cmt') {
      const cut = arg.lastIndexOf('|')
      state.commenting = { file: arg.slice(0, cut), line: Number(arg.slice(cut + 1)) }
      state.commentDraft = ''
      render()
      root.querySelector('[data-comment]')?.focus()
      return
    }
    if (name === 'cmt-cancel') { state.commenting = null; state.commentDraft = ''; return render() }
    if (name === 'cmt-save') {
      const at = state.commenting
      const body = state.commentDraft.trim()
      if (!at) return
      if (!body) { root.querySelector('[data-comment]')?.focus(); throw new Error('Write the comment first.') }
      await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/comment', { file: at.file, line: at.line, body })
      state.commenting = null
      state.commentDraft = ''
      toast('Comment added. It goes with your next message.')
      await refresh(); return render()
    }
    if (name === 'cdel' || name === 'cres') {
      await request('POST', '/api/comment/' + encodeURIComponent(arg), { action: name === 'cdel' ? 'delete' : 'resolve' })
      toast(name === 'cdel' ? 'Comment deleted' : 'Comment resolved')
      await refresh(); return render()
    }
    if (name === 'term') { state.term = arg; return render() }
    if (name === 'stop') {
      if (!confirm('Stop this agent run?')) return
      await request('POST', '/api/chat/' + encodeURIComponent(state.sessionId) + '/stop')
      toast('Stopped')
      await refresh(); await loadTab(); return render()
    }
    if (name === 'repo') { state.newRepo = arg; return render() }
    if (name === 'tpl') {
      const t = state.model.templates.find((x) => x.id === arg)
      if (t) state.newPrompt = t.body
      render()
      document.getElementById('prompt')?.focus()
      return
    }
    if (name === 'create') {
      const prompt = state.newPrompt.trim()
      if (!prompt) { document.getElementById('prompt')?.focus(); throw new Error('Describe what the agent should do.') }
      state.busy = true
      render()
      try {
        const result = await request('POST', '/api/workspace', { repoId: state.newRepo, prompt })
        state.newPrompt = ''
        await refresh()
        return openThread(result.id)
      } finally { state.busy = false }
    }
    if (name === 'new-chat') {
      const s = await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/chat', {})
      state.sheet = null
      await refresh()
      Object.assign(state, { sessionId: s.id, tab: 'chat', chat: [], chatFor: null })
      render(); await loadTab(); return render()
    }
    if (name === 'refresh') { state.sheet = null; await refresh(); await loadTab(); return render() }
    if (name === 'archive') {
      if (!confirm('Archive this workspace? The branch is kept.')) return
      state.archiving = state.wsId
      try { await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/archive', {}) } finally { state.archiving = null }
      toast('Archived')
      await refresh()
      if (history.state?.thread) history.back()
      return backToList()
    }
    if (name === 'run-checks') {
      const result = await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/checks', { approve: false })
      state.checkConsent = result.consent || null
      if (!result.consent) toast('Checks started')
      await loadTab(); return render()
    }
    if (name === 'approve-checks') {
      await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/checks', { approve: true, expected: state.checkConsent })
      state.checkConsent = null
      toast('Checks started')
      await loadTab(); return render()
    }
    if (name === 'enable-push') return await enablePush()
  } catch (err) { fail(err) }
})
window.addEventListener('popstate', () => { if (state.view === 'thread') backToList() })

;(async () => {
  const secret = new URLSearchParams(location.search).get('pair')
  if (secret) await startPairing(secret)
  else if (state.pairingId) { render(); pollPair() }
  else { await signedIn(); render() }
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || state.pairingId || !state.model) return
    await refresh(); await loadTab(); paint()
  })
})()
