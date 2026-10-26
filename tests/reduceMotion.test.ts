// @vitest-environment jsdom
// Reduce Motion (phase D): the setting ('auto', 'on', 'off') is resolved once in theme.ts against the OS preference into
// html[data-reduce-motion], which the stylesheets key on, and into reduceMotion() / useReduceMotion(), which code reads.
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Listener = () => void

/** A matchMedia whose reduced-motion query the test can flip, telling the listeners as the browser does. */
function installMedia(initial: boolean) {
  const state = { reduces: initial, listeners: new Set<Listener>() }
  vi.stubGlobal('matchMedia', (query: string) => ({
    media: query,
    get matches() {
      return query.includes('prefers-reduced-motion') ? state.reduces : false
    },
    addEventListener: (_type: string, listener: Listener) => state.listeners.add(listener),
    removeEventListener: (_type: string, listener: Listener) => state.listeners.delete(listener),
    addListener: () => undefined,
    removeListener: () => undefined
  }))
  return {
    setOs(reduces: boolean) {
      state.reduces = reduces
      for (const listener of state.listeners) listener()
    }
  }
}

const attribute = () => document.documentElement.dataset.reduceMotion

async function loadTheme(osReduces: boolean) {
  vi.resetModules()
  const os = installMedia(osReduces)
  const theme = await import('../src/renderer/src/theme')
  return { os, theme }
}

beforeEach(() => {
  delete document.documentElement.dataset.reduceMotion
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('resolving the setting', () => {
  it("'on' and 'off' decide; 'auto' (and anything unknown) follows the OS", async () => {
    const { theme } = await loadTheme(false)
    const { resolveReduceMotion } = theme
    expect(resolveReduceMotion('on', false)).toBe(true)
    expect(resolveReduceMotion('on', true)).toBe(true)
    expect(resolveReduceMotion('off', true)).toBe(false)
    expect(resolveReduceMotion('off', false)).toBe(false)
    expect(resolveReduceMotion('auto', true)).toBe(true)
    expect(resolveReduceMotion('auto', false)).toBe(false)
    expect(resolveReduceMotion(undefined, true)).toBe(true)
    expect(resolveReduceMotion(undefined, undefined)).toBe(false)
  })
})

describe('html[data-reduce-motion]', () => {
  it("is set from the OS before any setting arrives (so 'auto' keeps working until the store loads)", async () => {
    await loadTheme(true)
    expect(attribute()).toBe('on')
    await loadTheme(false)
    expect(attribute()).toBe('off')
  })

  it.each([
    { setting: 'auto', os: true, want: 'on' },
    { setting: 'auto', os: false, want: 'off' },
    { setting: 'on', os: false, want: 'on' },
    { setting: 'on', os: true, want: 'on' },
    { setting: 'off', os: true, want: 'off' },
    { setting: 'off', os: false, want: 'off' }
  ] as const)('is $want for $setting when the OS reduces motion: $os', async ({ setting, os, want }) => {
    const { theme } = await loadTheme(os)
    theme.setReduceMotionSetting(setting)
    expect(attribute()).toBe(want)
    expect(theme.reduceMotion()).toBe(want === 'on')
  })

  it("follows the OS live while 'auto', and ignores it when 'on' or 'off'", async () => {
    const { os, theme } = await loadTheme(false)
    theme.setReduceMotionSetting('auto')
    os.setOs(true)
    expect(attribute()).toBe('on')
    expect(theme.reduceMotion()).toBe(true)
    os.setOs(false)
    expect(attribute()).toBe('off')

    theme.setReduceMotionSetting('off')
    os.setOs(true)
    expect(attribute()).toBe('off')
    expect(theme.reduceMotion()).toBe(false)

    theme.setReduceMotionSetting('on')
    os.setOs(false)
    expect(attribute()).toBe('on')
    expect(theme.reduceMotion()).toBe(true)
  })

  it("treats a missing setting as 'auto'", async () => {
    const { theme } = await loadTheme(true)
    theme.setReduceMotionSetting('off')
    expect(attribute()).toBe('off')
    theme.setReduceMotionSetting(undefined)
    expect(attribute()).toBe('on')
  })
})

describe('useReduceMotion()', () => {
  it('returns the resolved value and re-renders when the setting or the OS changes it', async () => {
    const { os, theme } = await loadTheme(false)
    const { result } = renderHook(() => theme.useReduceMotion())
    expect(result.current).toBe(false)
    act(() => theme.setReduceMotionSetting('on'))
    expect(result.current).toBe(true)
    act(() => theme.setReduceMotionSetting('auto'))
    expect(result.current).toBe(false)
    act(() => os.setOs(true))
    expect(result.current).toBe(true)
    act(() => theme.setReduceMotionSetting('off'))
    expect(result.current).toBe(false)
  })
})

describe('code that read the OS directly', () => {
  it("ui/flash.ts uses the resolved value: still when 'on' even if the OS does not ask, animated when 'off' even if it does", async () => {
    vi.useFakeTimers()
    const { os, theme } = await loadTheme(false)
    const { flash } = await import('../src/renderer/src/ui/flash')
    const target = document.body.appendChild(document.createElement('div'))

    theme.setReduceMotionSetting('on')
    flash(target)
    vi.advanceTimersByTime(1001)
    expect(target.hasAttribute('data-ui-flash')).toBe(false)

    os.setOs(true)
    theme.setReduceMotionSetting('off')
    flash(target)
    vi.advanceTimersByTime(1001)
    expect(target.hasAttribute('data-ui-flash')).toBe(true)
    vi.advanceTimersByTime(400)
    expect(target.hasAttribute('data-ui-flash')).toBe(false)
  })

  it("the chat's jump-to scroll is only smooth while motion is not reduced", async () => {
    const { theme } = await loadTheme(false)
    theme.setReduceMotionSetting('off')
    expect(theme.reduceMotion() ? 'auto' : 'smooth').toBe('smooth')
    theme.setReduceMotionSetting('on')
    expect(theme.reduceMotion() ? 'auto' : 'smooth').toBe('auto')
  })
})

describe('content text size', () => {
  it('writes --content-font-size on <html> within 12-24, and removes it for the default', async () => {
    const { theme } = await loadTheme(false)
    const value = () => document.documentElement.style.getPropertyValue('--content-font-size')
    theme.setContentFontSize(18)
    expect(value()).toBe('18px')
    theme.setContentFontSize(40)
    expect(value()).toBe('24px')
    theme.setContentFontSize(3)
    expect(value()).toBe('12px')
    theme.setContentFontSize(undefined)
    expect(value()).toBe('')
  })

  it("a terminal on 'content' uses the content size; a number keeps its own", async () => {
    const { theme } = await loadTheme(false)
    const base = { terminalFont: '', terminalScrollbackMb: 10 }
    expect(theme.terminalOptions({ ...base, terminalFontSize: 'content', contentFontSize: 18 }).fontSize).toBe(18)
    expect(theme.terminalOptions({ ...base, terminalFontSize: 'content' }).fontSize).toBe(13)
    expect(theme.terminalOptions({ ...base, terminalFontSize: 14, contentFontSize: 18 }).fontSize).toBe(14)
    expect(theme.terminalOptions({ ...base, terminalFontSize: 'content', contentFontSize: 24 }).fontSize).toBe(24)
  })
})
