// The phone's live connection to Foreman (docs/server.md, "The wire" and "The phone"): one WebSocket to /api/ws that
// says hello, carries calls, events and the view, and comes back after a drop. A plain script with no build step; the
// socket class, the timers and the document can be injected, so tests/mobileLive.test.ts drives it without a browser.
;(function (root) {
  // The paired-computer link's backoff, so a phone and a browser come back at the same pace.
  const BACKOFF = [2000, 5000, 10000, 20000, 40000, 60000]
  // Phone access turned off on the computer: look again now and then, not on the backoff.
  const OFF_RETRY = 60000
  // The server pings too, but a frame from this side keeps a NAT's mapping open on networks that drop quiet paths.
  const PING_MS = 25000
  const PROTOCOL = 1

  function connect(options) {
    const WS = options.WebSocket || root.WebSocket
    const later = options.setTimeout || ((fn, ms) => root.setTimeout(fn, ms))
    const cancel = options.clearTimeout || ((t) => root.clearTimeout(t))
    const doc = options.document !== undefined ? options.document : root.document
    const pending = new Map()
    let socket = null, live = false, bye = null, view = null, nextId = 1, attempt = 0
    let retry = null, ping = null, paused = false, stopped = false, off = false
    const handle = { status: null, setView, close, call }

    function status(next) {
      if (handle.status === next) return
      handle.status = next
      if (options.onStatus) options.onStatus(next)
    }
    function send(frame) {
      if (socket && socket.readyState === 1) socket.send(JSON.stringify(frame))
    }
    function rejectAll() {
      for (const p of pending.values()) p.reject(new Error('The connection to Foreman closed.'))
      pending.clear()
    }
    function clearTimers() {
      if (retry !== null) cancel(retry)
      if (ping !== null) cancel(ping)
      retry = ping = null
    }
    function keepAlive() {
      ping = later(() => { ping = null; if (live) { send({ t: 'ping' }); keepAlive() } }, PING_MS)
    }

    function open() {
      retry = null
      paused = false
      if (stopped) return
      bye = null
      let s
      try { s = new WS(options.url) } catch { return schedule() }
      socket = s
      s.onopen = () => { if (socket === s) send({ t: 'hello', protocol: PROTOCOL, version: '', client: options.client }) }
      s.onmessage = (event) => { if (socket === s) receive(event.data) }
      s.onerror = () => undefined
      s.onclose = () => { if (socket === s) closed() }
    }

    function receive(data) {
      let frame
      try { frame = JSON.parse(typeof data === 'string' ? data : String(data)) } catch { return }
      if (!frame || typeof frame !== 'object') return
      if (frame.t === 'welcome') {
        if (!frame.ok) {
          // A credential or scope refusal is a signed-out phone; a protocol or version one, a page older than its server.
          stopped = true
          return status(frame.refused === 'credential' || frame.refused === 'scope' ? 'revoked' : 'outdated')
        }
        live = true
        off = false
        attempt = 0
        keepAlive()
        if (view) send({ t: 'view', view })
        status('live')
        if (options.onWelcome) options.onWelcome(frame)
      } else if (frame.t === 'reply') {
        const p = pending.get(frame.id)
        if (!p) return
        pending.delete(frame.id)
        if (frame.ok) p.resolve(frame.value)
        else p.reject(Object.assign(new Error(frame.error || 'Foreman could not complete the request.'), { code: frame.code }))
      } else if (frame.t === 'event') {
        if (options.onEvent) options.onEvent(frame.event, frame.seq)
      } else if (frame.t === 'bye') bye = frame.reason
    }

    function closed() {
      socket = null
      live = false
      if (ping !== null) cancel(ping)
      ping = null
      rejectAll()
      if (stopped) return
      if (bye === 'revoked') { stopped = true; return status('revoked') }
      // Off stays off, through the refused connections that follow, until a welcome says it is back on.
      if (bye === 'off') off = true
      status(off ? 'off' : 'reconnecting')
      schedule()
    }

    function schedule() {
      if (stopped || retry !== null) return
      const ms = off ? OFF_RETRY : BACKOFF[Math.min(attempt, BACKOFF.length - 1)]
      attempt++
      retry = later(() => {
        retry = null
        // A phone in a pocket doesn't keep dialling; it tries again the moment it is looked at.
        if (doc && doc.hidden) paused = true
        else open()
      }, ms)
    }

    function visible() {
      if (stopped || socket || (doc && doc.hidden) || (retry === null && !paused)) return
      if (retry !== null) cancel(retry)
      open()
    }

    function setView(next) {
      view = next
      if (live) send({ t: 'view', view })
    }

    function call(method, args) {
      if (!live) return Promise.reject(new Error('Not connected to Foreman.'))
      const id = nextId++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        send({ t: 'call', id, method, args: args || [] })
      })
    }

    function close() {
      stopped = true
      clearTimers()
      if (doc) doc.removeEventListener('visibilitychange', visible)
      const s = socket
      socket = null
      live = false
      rejectAll()
      if (s) try { s.close() } catch {}
    }

    if (doc) doc.addEventListener('visibilitychange', visible)
    status('connecting')
    open()
    return handle
  }

  root.ForemanLive = { connect }
})(typeof window !== 'undefined' ? window : globalThis)
