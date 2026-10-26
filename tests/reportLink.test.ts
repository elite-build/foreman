// O20 (G4): renderer errors reach Report a problem's log, and error toasts carry a "Report…" link.
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { rendererErrorLine } from '../src/main/reportProblem'

const at = new Date(2026, 9, 22, 14, 6, 9)

describe('renderer error lines', () => {
  it('keeps console errors only, marked renderer, with the script name and line but not its path', () => {
    expect(rendererErrorLine({ level: 'error', message: 'Uncaught TypeError: x is undefined', sourceId: 'file:///C:/Users/yatin/app/out/renderer/assets/index-abc.js?v=1', lineNumber: 42 }, at)).toBe(
      '14:06:09 [renderer] Uncaught TypeError: x is undefined (index-abc.js:42)'
    )
    expect(rendererErrorLine({ level: 3, message: 'old style level' }, at)).toBe('14:06:09 [renderer] old style level')
    expect(rendererErrorLine({ level: 'warning', message: 'meh' }, at)).toBeNull()
    expect(rendererErrorLine({ level: 'info', message: 'hi' }, at)).toBeNull()
  })

  it('handles Windows-style source paths', () => {
    expect(rendererErrorLine({ level: 'error', message: 'boom', sourceId: 'C:\\app\\chunk.js', lineNumber: 0 }, at)).toBe('14:06:09 [renderer] boom (chunk.js)')
  })
})

describe('Report… on error toasts', () => {
  let store: typeof import('../src/renderer/src/store')
  beforeAll(async () => {
    vi.stubGlobal('window', { foreman: { invoke: async () => undefined, send: { setUnread() {} }, onEvent() {} }, addEventListener() {}, dispatchEvent() {} })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem() {} })
    vi.stubGlobal('document', { hasFocus: () => true })
    store = await import('../src/renderer/src/store')
  })

  it('an error toast gets the link, which opens the dialog with the error; info toasts and opted-out ones do not', () => {
    const opened: string[] = []
    const options = store.withReportLink('Push failed', 'error', undefined, 'Report…', (about) => opened.push(about))!
    expect(options.actions?.map((a) => a.label)).toEqual(['Report…'])
    expect(options.durationMs).toBe(8000)
    void options.actions![0].run()
    expect(opened).toEqual(['Push failed'])
    expect(store.withReportLink('Saved', 'info', undefined, 'Report…', () => {})).toBeUndefined()
    expect(store.withReportLink('x', 'error', { report: false }, 'Report…', () => {})).toEqual({ report: false })
  })

  it('comes after the toast’s own buttons and keeps their duration', () => {
    const undo = { label: 'Undo', run: () => {} }
    const options = store.withReportLink('Move failed', 'error', { action: undo }, 'Report…', () => {})!
    const toast = store.makeToast(1, 'Move failed', 'error', options)
    expect(toast.toast.actions?.map((a) => a.label)).toEqual(['Undo', 'Report…'])
    expect(toast.durationMs).toBe(10_000)
  })

  it('showToast wires it to Report a problem', async () => {
    store.showToast('Couldn’t archive', 'error')
    const toast = store.getState().toast!
    expect(toast.actions?.map((a) => a.label)).toEqual(['Report…'])
    store.runToastAction(toast.id, 0)
    await Promise.resolve()
    expect(store.getState()).toMatchObject({ toast: null, reportProblemOpen: true, reportProblemAbout: 'Couldn’t archive' })
    store.openReportProblem(false)
    expect(store.getState().reportProblemAbout).toBeNull()
  })
})
