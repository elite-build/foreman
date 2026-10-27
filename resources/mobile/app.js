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
  drafts: {}, notes: {}, answers: {}, others: {}, replying: new Set(), fullPlans: new Set(),
  openTools: new Set(), openFiles: new Set(), limit: 120,
  error: '', pairingId: sessionStorage.getItem('pairingId'), pairCode: sessionStorage.getItem('pairCode'),
  lastKey: '', busy: false, recent: null
}

async function request(method, path, body) {
  const response = await fetch(path, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined })
  let value
  try { value = await response.json() } catch { value = {} }
  if (!response.ok) throw new Error(value.error || 'Foreman could not complete the request.')
  return value
}
let toastTimer
function toast(text) {
  toastEl.textContent = text
  toastEl.classList.add('on')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 2400)
}
function fail(err) { state.error = err.message || String(err); render() }

// ---------- model helpers ----------
const ws = () => state.model?.workspaces.find((w) => w.id === state.wsId)
const repoOf = (w) => state.model.repos.find((r) => r.id === w.repoId)
const sessionsOf = (w) => state.model.sessions.filter((s) => s.workspaceId === w.id)
const approvalsOf = (w) => state.model.approvals.filter((a) => state.model.sessions.some((s) => s.id === a.sessionId && s.workspaceId === w.id))
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
function banner() { return state.error ? '<div class="banner err" role="alert">' + safe(state.error) + '</div>' : '' }
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
}
function placeScroll(same, top, atBottom) {
  const sc = document.getElementById('scroller')
  if (!sc) return
  const chat = state.view === 'thread' && state.tab === 'chat'
  if (chat && (!same || atBottom)) sc.scrollTop = sc.scrollHeight
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
  return { top, body: listBody(), over: '<button class="fab" data-action="sheet:new">' + icon('plus') + 'New</button>' + sheetHtml() }
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
  if (armed && armed.missed) return '<div class="sys err">Missed ' + hhmm(Date.parse(armed.resetAt)) + '. Resume or dismiss it in Foreman.</div>'
  if (armed) return '<div class="sys">Resumes at ' + hhmm(Date.parse(armed.at)) + ' · sends “' + safe(armed.text) + '” once <button class="linkish" data-action="unresume:' + safe(i.turnId) + '">Cancel</button></div>'
  const at = i.limit.resetAt ? Date.parse(i.limit.resetAt) : NaN
  if (s.agent !== 'claude' || !i.limit.source || !(at > Date.now())) return '<div class="sys">Reset time unknown</div>'
  const latest = s.lastTurn && s.lastTurn.turnId === i.turnId && s.status !== 'running' && !s.queued
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
  if (!items.length && !approvals.length && s.status !== 'running') out = '<div class="empty"><b>New chat</b>Send a message to start ' + safe(agentName(s.agent)) + '.</div>'
  return '<div class="msgs">' + out + '</div>'
}
function requestHtml(a) {
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
  const file = (f) => {
    const open = state.openFiles.has(f.path)
    const slash = f.path.lastIndexOf('/')
    let body = ''
    if (open) {
      if (f.binary) body = '<div class="cut">Binary file</div>'
      else {
        let budget = 400
        body = '<div class="hunks">' + f.hunks.map((h) => {
          if (budget <= 0) return ''
          const lines = h.lines.slice(0, budget)
          budget -= lines.length
          return '<div class="hh">' + safe(h.header) + '</div>' + lines.map((l) => '<div class="ln ' + l.type + '"><span class="no">' + (l.type === 'add' ? '' : l.oldNo ?? '') + '</span><span class="no">' + (l.type === 'del' ? '' : l.newNo ?? '') + '</span><span class="tx">' + (l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' ') + safe(l.text) + '</span></div>').join('')
        }).join('') + (budget <= 0 ? '<div class="cut">Diff shortened. Open it on your computer for the rest.</div>' : '') + '</div>'
      }
    }
    return '<div class="file' + (open ? ' open' : '') + '"><button data-action="file:' + safe(f.path) + '">' + icon('chev', 'sm chev') + '<span class="p"><bdi>' + safe(f.path.slice(0, slash + 1)) + '<b>' + safe(f.path.slice(slash + 1)) + '</b></bdi></span><span class="n"><span class="a">+' + f.additions + '</span> <span class="d">−' + f.deletions + '</span></span></button>' + body + '</div>'
  }
  return '<div class="pad"><div class="sum"><span>' + d.files.length + ' file' + (d.files.length === 1 ? '' : 's') + ' vs ' + safe(d.baseRef) + '</span><span class="mono"><span class="a">+' + add + '</span> <span class="d">−' + del + '</span></span></div>' +
    (d.truncated ? '<div class="banner info" style="margin:0 0 8px">This diff was too large to send in full.</div>' : '') + d.files.map(file).join('') + '</div>'
}
function checksHtml() {
  const c = state.checks
  if (!c) return '<div class="empty">Loading checks…</div>'
  if (!c.configured && !c.rows.length) return '<div class="empty"><b>No checks configured</b>Add checks for this repository in Foreman on your computer.</div>'
  const mark = (r) => r.result?.status === 'running' || (c.running && !r.result) ? ['run', 'clock'] : r.result?.status === 'passed' ? ['ok', 'check'] : r.result ? ['bad', 'x'] : ['', 'minus']
  return '<div class="pad">' + (state.checkConsent ? '<div class="consent"><p>Approve these check commands?</p><pre class="cmd">' + safe(state.checkConsent.map((x) => x.name + ': ' + x.command).join('\n')) + '</pre><button class="btn pri" data-action="approve-checks">Approve and run</button></div>' : '') +
    '<div class="card">' + c.rows.map((r) => { const [cls, ic] = mark(r); return '<div class="ck"><span class="st ' + cls + '">' + icon(ic, 'sm') + '</span><span class="nm"><b>' + safe(r.name) + '</b><small>' + safe(r.command) + '</small></span><span class="tm">' + (r.result?.durationMs ? secs(r.result.durationMs) : r.stale && r.result ? 'stale' : r.result ? '' : 'not run') + '</span></div>' }).join('') + '</div>' +
    '<button class="btn dark" data-action="run-checks"' + (c.running ? ' disabled' : '') + '>' + (c.running ? 'Checks are running…' : 'Run checks') + '</button></div>'
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
    '<div class="subtabs">' + tab('chat', 'Chat') + tab('changes', 'Changes' + (state.diff?.files.length ? ' <span class="n">' + state.diff.files.length + '</span>' : '')) + tab('checks', 'Checks ' + checkMark) + tab('pr', 'PR' + (state.git?.pr ? ' <span class="n">#' + safe(state.git.pr.number) + '</span>' : '')) + '</div>'
  const elsewhere = approvals.find((a) => a.sessionId !== state.sessionId)
  let body = elsewhere ? '<div style="padding:8px 12px 0"><button class="other-req" data-action="session:' + safe(elsewhere.sessionId) + '">' + icon('lock', 'sm') + 'Another chat in this workspace needs you' + icon('chev', 'sm') + '</button></div>' : ''
  let foot = ''
  if (state.tab === 'chat') {
    if (s) {
      const draft = state.drafts[s.id] || ''
      const running = s.status === 'running'
      body += chatHtml(s)
      foot = (s.queued ? '<p class="hint">' + s.queued + ' message' + (s.queued === 1 ? '' : 's') + ' queued for the next turn</p>' : '') +
        '<div class="cmp"><textarea id="draft" rows="1" placeholder="Message ' + safe(agentName(s.agent)) + '" enterkeyhint="send">' + safe(draft) + '</textarea>' +
        '<button class="round send" data-action="send" aria-label="Send"' + (running && !draft.trim() ? ' hidden' : '') + '>' + icon('up') + '</button>' +
        '<button class="round stop" data-action="stop" aria-label="Stop the agent"' + (running && !draft.trim() ? '' : ' hidden') + '><i></i></button></div>'
    } else body += '<div class="empty"><b>No chat yet</b><button class="btn pri" style="margin-top:14px" data-action="new-chat">Start a chat</button></div>'
  } else body += state.tab === 'changes' ? diffHtml() : state.tab === 'checks' ? checksHtml() : prHtml()
  return { top, body, foot, over: sheetHtml() }
}

// ---------- sheets ----------
function sheetHtml() {
  if (!state.sheet) return ''
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
      '<button data-action="new-chat">' + icon('plus') + 'New chat</button><button data-action="refresh">' + icon('refresh') + 'Refresh</button><button class="danger" data-action="archive">' + icon('archive') + 'Archive workspace</button></div>'
  } else if (state.sheet === 'device') {
    const https = location.protocol === 'https:'
    inner = '<h3>This phone <button data-action="close">Done</button></h3><div class="menu">' +
      '<div class="kv" style="border:0"><span>Connection</span><b>' + (https ? 'Private HTTPS' : 'Same Wi-Fi') + '</b></div>' +
      (https ? '<button data-action="enable-push">' + icon('bell') + 'Enable phone alerts</button>' : '<p class="sub">Same-Wi-Fi access works only while you are nearby, and cannot send alerts. Pair through the private HTTPS address for alerts and access away from home.</p>') +
      '<p class="sub" style="margin-top:12px">To unpair, revoke this phone from the phone button in Foreman on your computer.</p></div>'
  }
  return '<div class="dim" data-action="close"></div><div class="sheet" role="dialog" aria-modal="true"><div class="grab"></div>' + inner + '</div>'
}

// ---------- pairing ----------
function pairView() {
  return { body: '<div class="pair"><div class="logo">F</div><h1>Confirm on your computer</h1><p>Check that Foreman shows the same code, then approve this phone.</p>' +
    '<div class="code-card"><div class="code">' + safe(state.pairCode || '··· ···') + '</div></div>' +
    '<div class="wait"><span class="typing"><i></i><i></i><i></i></span>Waiting for approval · expires in 2 minutes</div></div>' }
}
function unpairedView() {
  return { body: '<div class="pair"><div class="logo">F</div><h1>Pair this phone</h1><p>Control your Foreman agents from here.</p>' +
    '<div class="steps"><div><b>1</b>Open Foreman on your computer.</div><div><b>2</b>Click the phone button at the top of the sidebar.</div><div><b>3</b>Scan the QR code with this phone’s camera.</div></div>' +
    '<button class="btn dark" data-action="retry">I’ve paired, try again</button></div>' }
}

// ---------- data ----------
async function refresh() {
  try {
    state.model = await request('GET', '/api/state')
    state.error = ''
  } catch (err) {
    if (err.message.includes('not paired')) state.model = null
    state.error = err.message
  }
}
async function loadTab() {
  if (state.view !== 'thread' || !state.wsId) return
  const wsPath = '/api/workspace/' + encodeURIComponent(state.wsId)
  try {
    if (state.tab === 'chat' && state.sessionId) {
      const id = state.sessionId
      const chat = await request('GET', '/api/chat/' + encodeURIComponent(id))
      if (id === state.sessionId) { state.chat = chat; state.chatFor = id }
    }
    if (state.tab === 'changes') state.diff = await request('GET', wsPath + '/diff')
    if (state.tab === 'checks') state.checks = await request('GET', wsPath + '/checks')
    if (state.tab === 'pr') state.git = await request('GET', wsPath + '/git')
  } catch (err) { state.error = err.message }
}
function openThread(id, sessionId = null, push = true) {
  if (push && state.view !== 'thread') history.pushState({ thread: id }, '')
  Object.assign(state, { view: 'thread', wsId: id, sessionId, tab: 'chat', chat: [], chatFor: null, diff: null, checks: null, git: null, checkConsent: null, sheet: null, limit: 120, error: '' })
  state.openFiles.clear()
  render()
  void loadTab().then(render)
}
function backToList() {
  Object.assign(state, { view: 'list', wsId: null, sessionId: null, sheet: null, error: '' })
  render()
}
async function startPairing(secret) {
  try {
    const name = /iPhone|iPad|Android/i.exec(navigator.userAgent)?.[0] || 'Phone'
    const p = await request('POST', '/api/pair/start', { token: secret, name })
    state.pairingId = p.id
    state.pairCode = p.code
    sessionStorage.setItem('pairingId', p.id)
    sessionStorage.setItem('pairCode', p.code)
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
}
async function pollPair() {
  if (!state.pairingId) return
  try {
    const p = await request('GET', '/api/pair/status?id=' + encodeURIComponent(state.pairingId))
    if (p.state === 'approved') { clearPairing(); await refresh(); render(); return }
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
}
async function send() {
  const id = state.sessionId
  const text = (state.drafts[id] || '').trim()
  if (!text || state.busy) return
  state.busy = true
  try {
    const result = await request('POST', '/api/chat/' + encodeURIComponent(id) + '/send', { text })
    state.drafts[id] = ''
    if (result.disposition === 'queued') toast('Queued for the next turn')
    await refresh()
    await loadTab()
    render()
  } finally { state.busy = false }
}

// ---------- events ----------
root.addEventListener('input', (event) => {
  const el = event.target
  if (el.id === 'draft') { state.drafts[state.sessionId] = el.value; sizeDraft(); syncComposer() }
  else if (el.id === 'search') { state.query = el.value; document.getElementById('scroller').innerHTML = listBody() }
  else if (el.id === 'prompt') state.newPrompt = el.value
  else if (el.dataset.note) state.notes[el.dataset.note] = el.value
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
    if (name === 'retry') { await refresh(); return render() }
    if (name === 'filter') { state.filter = arg; render(); if (arg === 'recent') { await loadRecent(); render() } return }
    if (name === 'open') { const a = state.model.approvals.find((x) => state.model.sessions.some((s) => s.id === x.sessionId && s.workspaceId === arg)); return openThread(arg, a?.sessionId || null) }
    if (name === 'back') { if (history.state?.thread) history.back(); else backToList(); return }
    if (name === 'sheet') { state.sheet = arg; return render() }
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
    if (name === 'resume-at' || name === 'unresume') {
      await request('POST', '/api/chat/' + encodeURIComponent(state.sessionId) + '/resume-at', name === 'unresume' ? { cancel: true } : { turnId: arg })
      toast(name === 'unresume' ? 'Resume cancelled' : 'Resume armed')
      await refresh(); await loadTab(); return render()
    }
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
      await request('POST', '/api/workspace/' + encodeURIComponent(state.wsId) + '/archive', {})
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
  else { await refresh(); render() }
  setInterval(async () => {
    if (state.pairingId || !state.model || document.hidden) return
    await refresh()
    if (state.view === 'list' && state.filter === 'recent') await loadRecent()
    if (state.view === 'thread' && (state.tab === 'chat' || (state.tab === 'checks' && state.checks?.running))) await loadTab()
    paint()
  }, 4000)
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden || state.pairingId || !state.model) return
    await refresh(); await loadTab(); paint()
  })
})()
