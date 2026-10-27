import { ArrowLeft, ArrowRight, Camera, ExternalLink, MousePointer2, PanelLeftClose, PanelLeftOpen, RotateCw, Square } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserCommand } from '../../../shared/browser'
import { browserUrl } from '../../../shared/browser'
import type { Session } from '../../../shared/types'
import { api, attempt, bridge, fillComposer, getState, splitBrowserTab, useStore, useWindowVisible } from '../store'
import { useT } from '../i18n'
import { Button, Callout, IconButton, Select, Spinner, TextInput } from '../ui'
import './workspaceBrowser.css'

/** Native content occupies only this measured slot, and steps aside for renderer overlays. */
export function WorkspaceBrowser({ workspaceId, visible, sessions, activeId }: { workspaceId: string; visible: boolean; sessions: Session[]; activeId?: string }) {
  const t = useT()
  const tab = useStore(s => s.browserTabs[workspaceId])!
  const addressRequest = useStore(s => s.browserAddressRequest)
  const state = tab.state
  const [address, setAddress] = useState(state?.url ?? tab.url)
  const [ready, setReady] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selecting, setSelecting] = useState(false)
  const [target, setTarget] = useState(activeId ?? '')
  const input = useRef<HTMLInputElement>(null)
  const slot = useRef<HTMLDivElement>(null)
  const targetId = sessions.some(s => s.id === target) ? target : activeId ?? sessions[0]?.id ?? ''
  const command = (cmd: BrowserCommand) => attempt(() => bridge.browser.command(workspaceId, cmd))

  useEffect(() => { setTarget(activeId ?? '') }, [activeId])
  useEffect(() => { setAddress(state?.url ?? tab.url) }, [state?.url, tab.url])
  useEffect(() => {
    let live = true
    void bridge.browser.command(workspaceId, { type: 'open', url: tab.url }).then(() => { if (live) setReady(true) }).catch(err => { if (live) void attempt(() => Promise.reject(err)) })
    return () => { live = false }
  }, [workspaceId, tab.request, tab.url])
  useEffect(() => {
    if (addressRequest?.workspaceId === workspaceId && visible) { input.current?.focus(); input.current?.select() }
  }, [addressRequest, workspaceId, visible])

  // The slot is measured every frame while shown. A minimized or hidden window stops that (the native view keeps its place,
  // unseen with the window) and starts it again once the window is back.
  const windowVisible = useWindowVisible()
  const resume = useRef<(() => void) | null>(null)
  useLayoutEffect(() => {
    let last = ''
    let frame = 0
    let stopped = false
    const sync = () => {
      frame = 0
      if (stopped) return
      const el = slot.current
      const rect = el?.getBoundingClientRect()
      // Native views paint above the renderer. Never let one cover a dialog, menu or tour.
      const overlay = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .ui-popover__panel, .ui-hovercard__panel, .tour-layer')].some(e => e.getClientRects().length > 0)
      const bounds = visible && ready && !state?.error && !document.hidden && !overlay && rect && rect.width > 0 && rect.height > 0
        ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null
      const key = JSON.stringify(bounds)
      if (key !== last) {
        last = key
        void bridge.browser.command(workspaceId, { type: 'bounds', bounds }).catch(() => undefined)
      }
      if (visible && getState().windowVisible !== false) frame = requestAnimationFrame(sync)
    }
    resume.current = () => {
      if (!frame) sync()
    }
    sync()
    return () => {
      stopped = true
      resume.current = null
      cancelAnimationFrame(frame)
      void bridge.browser.command(workspaceId, { type: 'bounds', bounds: null }).catch(() => undefined)
    }
  }, [workspaceId, visible, ready, state?.error])
  useEffect(() => {
    if (windowVisible) resume.current?.()
  }, [windowVisible])

  const navigate = () => void attempt(async () => {
    const url = browserUrl(address)
    setAddress(url)
    await bridge.browser.command(workspaceId, { type: 'navigate', url })
  })
  const selectElement = async () => {
    if (selecting) { await command({ type: 'cancel-selection' }); return }
    if (!targetId) return
    setSelecting(true)
    await attempt(async () => {
      const element = await bridge.browser.selectElement(workspaceId)
      if (element) fillComposer(workspaceId, targetId, t('browser.selectionContext', element))
    })
    setSelecting(false)
  }
  const screenshot = async () => {
    if (!targetId || busy) return
    setBusy(true)
    await attempt(async () => {
      const shot = await bridge.browser.capture(workspaceId)
      const attachment = await api.attachData(workspaceId, `browser-${Date.now()}.png`, shot.base64)
      fillComposer(workspaceId, targetId, t('browser.screenshotContext', { url: shot.url }), undefined, [attachment])
    })
    setBusy(false)
  }

  return <section className="workspace-browser" aria-label={t('browser.tab')} style={{ display: visible ? undefined : 'none' }}>
    <div className="workspace-browser-toolbar">
      <IconButton label={t('browser.back')} disabled={!state?.canGoBack} onClick={() => void command({ type: 'back' })}><ArrowLeft size={15} /></IconButton>
      <IconButton label={t('browser.forward')} disabled={!state?.canGoForward} onClick={() => void command({ type: 'forward' })}><ArrowRight size={15} /></IconButton>
      <IconButton label={t(state?.loading ? 'browser.stop' : 'browser.reload')} onClick={() => void command({ type: state?.loading ? 'stop' : 'reload' })}>{state?.loading ? <Square size={14} /> : <RotateCw size={15} />}</IconButton>
      <TextInput ref={input} aria-label={t('browser.address')} value={address} onChange={e => setAddress(e.target.value)} onFocus={e => e.currentTarget.select()} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); navigate() } }} mono compact className="workspace-browser-address" />
      <Button size="sm" onClick={navigate}>{t('browser.go')}</Button>
      <IconButton label={t('browser.external')} onClick={() => void attempt(() => api.openExternal(browserUrl(state?.url ?? address)))}><ExternalLink size={15} /></IconButton>
      <IconButton label={t(tab.split ? 'browser.unsplit' : 'browser.split')} pressed={tab.split} disabled={!sessions.length} onClick={() => splitBrowserTab(workspaceId, !tab.split)}>{tab.split ? <PanelLeftClose size={15} /> : <PanelLeftOpen size={15} />}</IconButton>
    </div>
    <div className="workspace-browser-feedback">
      {state?.loading && <Spinner size={14} label={t('browser.loading')} />}
      <span className="spacer" />
      <Select label={t('browser.target')} value={targetId} options={sessions.map(s => ({ value: s.id, label: s.title || t('workspaceView.tab.newChat') }))} onChange={setTarget} disabled={!sessions.length || selecting || busy} className="workspace-browser-target" />
      <IconButton label={t(selecting ? 'browser.cancelSelection' : 'browser.selectElement')} pressed={selecting} disabled={!ready || !targetId || busy || Boolean(state?.error)} onClick={() => void selectElement()}><MousePointer2 size={15} /></IconButton>
      <Button size="sm" icon={<Camera size={14} />} disabled={!ready || !targetId || busy || selecting || Boolean(state?.error)} onClick={() => void screenshot()}>{t('browser.screenshot')}</Button>
    </div>
    {selecting && <Callout role="status">{t('browser.selectHint')}</Callout>}
    {state?.error && <Callout tone="error" title={t('browser.failed')} actions={<Button size="sm" onClick={() => void command({ type: 'reload' })}>{t('common.retry')}</Button>}>{state.error}</Callout>}
    <div ref={slot} className="workspace-browser-page">
      <Button variant="ghost" onClick={() => void command({ type: 'focus' })}>{t('browser.focus')}</Button>
    </div>
  </section>
}
