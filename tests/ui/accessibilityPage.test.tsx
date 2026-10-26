// @vitest-environment jsdom
// Settings → Accessibility (phase D): every control has a name, each row writes the setting it is for, and the terminal's
// screen reader switch moved here from Advanced under the same setting key.
import '../domShims'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AccessibilityPage } from '../../src/renderer/src/components/settings/AccessibilityPage'
import { AdvancedPage } from '../../src/renderer/src/components/settings/AdvancedPage'
import { fakeApi, fakeState, resetFake } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)

beforeEach(() => {
  resetFake()
  Object.assign(fakeState.snapshot.settings, { contentFontSize: 13, reduceMotion: 'auto', terminalFontSize: 12, terminalScreenReader: 'auto', announce: 'my-chat', announceSummary: true, earcons: false, speechOutput: 'off', speechVoice: '', speechRate: 1, speechVolume: 1 })
  fakeState.snapshot.screenReader = false
  fakeApi.updateSettings = vi.fn(async () => ({}))
  fakeApi.resetSettings = vi.fn(async () => ({}))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// An engine with two local voices and one remote one; the page lists only the local ones.
function stubSpeech() {
  const spoken: Array<{ text: string }> = []
  const voice = (name: string, lang: string, localService = true) => ({ name, lang, voiceURI: `uri:${name}`, localService, default: false })
  const synth = {
    getVoices: () => [voice('Zira', 'en-US'), voice('Cloud', 'en-US', false), voice('Anna', 'de-DE')],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    speak: (u: { text: string }) => void spoken.push(u),
    cancel: vi.fn(),
    speaking: false
  }
  vi.stubGlobal('speechSynthesis', synth)
  vi.stubGlobal('SpeechSynthesisUtterance', class { constructor(public text: string) {} })
  return { synth, spoken }
}

describe('the Accessibility page', () => {
  it('names every control', () => {
    render(<AccessibilityPage />)
    expect(screen.getByRole('heading', { level: 1, name: 'Accessibility' })).toBeTruthy()
    expect((screen.getByRole('slider', { name: 'Content text size' }) as HTMLInputElement).value).toBe('13')
    expect(screen.getByRole('switch', { name: 'Terminal text follows content size' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Reduce motion' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Screen reader support' })).toBeTruthy()
    expect(screen.getByRole('radiogroup', { name: 'Announce agent activity' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Say what changed when a turn ends' })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Sound cues' })).toBeTruthy()
    expect(screen.getByRole('heading', { level: 2, name: "Foreman's voice (beta)" })).toBeTruthy()
    expect(screen.getByRole('switch', { name: 'Foreman reads announcements aloud' })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Voice' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Speech rate' })).toBeTruthy()
    expect(screen.getByRole('slider', { name: 'Speech volume' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Test voice' })).toBeTruthy()
    // Nothing else a person can operate is left without a name.
    const controls = document.querySelectorAll('input, select, textarea, [role="switch"], [role="radio"], [role="slider"], [role="combobox"]')
    expect(controls.length).toBeGreaterThanOrEqual(15)
    for (const control of controls) {
      const name = control.getAttribute('aria-label') || control.textContent?.trim() || (control.id && document.querySelector(`label[for="${control.id}"]`)?.textContent?.trim())
      expect(name, control.outerHTML).toBeTruthy()
    }
  })

  it('saves the content text size once the slider settles, in the 12 to 24 range, with a spoken value', async () => {
    render(<AccessibilityPage />)
    const slider = screen.getByRole('slider', { name: 'Content text size' }) as HTMLInputElement
    expect(slider.min).toBe('12')
    expect(slider.max).toBe('24')
    fireEvent.change(slider, { target: { value: '18' } })
    expect(slider.getAttribute('aria-valuetext')).toBe('18px')
    await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ contentFontSize: 18 }))
    expect(fakeApi.updateSettings).toHaveBeenCalledTimes(1)
  })

  it('offers a reset for a changed content size', async () => {
    fakeState.snapshot.settings.contentFontSize = 16
    render(<AccessibilityPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Setting actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset' }))
    expect(fakeApi.resetSettings).toHaveBeenCalledWith(['contentFontSize'])
  })

  it('writes Reduce motion as auto, on or off', async () => {
    const user = userEvent.setup()
    render(<AccessibilityPage />)
    expect(screen.getByRole('radio', { name: 'Automatic' }).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('radio', { name: 'On' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ reduceMotion: 'on' })
    await user.click(screen.getByRole('radio', { name: 'Off' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ reduceMotion: 'off' })
  })

  it("turns the terminal's size over to the content size, and back to a number", async () => {
    const user = userEvent.setup()
    const { unmount } = render(<AccessibilityPage />)
    const follow = screen.getByRole('switch', { name: 'Terminal text follows content size' })
    expect(follow.getAttribute('aria-checked')).toBe('false')
    await user.click(follow)
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 'content' })
    unmount()
    fakeState.snapshot.settings.terminalFontSize = 'content'
    render(<AccessibilityPage />)
    const on = screen.getByRole('switch', { name: 'Terminal text follows content size' })
    expect(on.getAttribute('aria-checked')).toBe('true')
    await user.click(on)
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ terminalFontSize: 12 })
  })

  it('still writes terminalScreenReader from the terminal switch', async () => {
    render(<AccessibilityPage />)
    const select = screen.getByRole('combobox', { name: 'Screen reader support' }) as HTMLSelectElement
    expect([...select.options].map((o) => o.textContent)).toEqual(['Automatic', 'On', 'Off'])
    await userEvent.selectOptions(select, 'on')
    expect(fakeApi.updateSettings).toHaveBeenCalledWith({ terminalScreenReader: 'on' })
  })

  it('writes the announcement policy: only what needs me, my open chat, all chats', async () => {
    const user = userEvent.setup()
    render(<AccessibilityPage />)
    expect(screen.getByRole('heading', { level: 2, name: 'Announcements' })).toBeTruthy()
    expect(screen.getByRole('radio', { name: 'My open chat' }).getAttribute('aria-checked')).toBe('true')
    await user.click(screen.getByRole('radio', { name: 'Only what needs me' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ announce: 'needs-me' })
    await user.click(screen.getByRole('radio', { name: 'All chats' }))
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ announce: 'all' })
  })

  it('reads a policy it does not know as My open chat', () => {
    fakeState.snapshot.settings.announce = 'shout'
    render(<AccessibilityPage />)
    expect(screen.getByRole('radio', { name: 'My open chat' }).getAttribute('aria-checked')).toBe('true')
  })

  it('writes the end-of-turn summary switch (on by default) and the sound cues switch (off by default)', async () => {
    const user = userEvent.setup()
    render(<AccessibilityPage />)
    const summary = screen.getByRole('switch', { name: 'Say what changed when a turn ends' })
    expect(summary.getAttribute('aria-checked')).toBe('true')
    await user.click(summary)
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ announceSummary: false })
    const cues = screen.getByRole('switch', { name: 'Sound cues' })
    expect(cues.getAttribute('aria-checked')).toBe('false')
    await user.click(cues)
    expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ earcons: true })
  })

  it('offers a reset for a changed announcement policy', async () => {
    fakeState.snapshot.settings.announce = 'all'
    render(<AccessibilityPage />)
    await userEvent.click(screen.getByRole('button', { name: 'Setting actions' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset' }))
    expect(fakeApi.resetSettings).toHaveBeenCalledWith(['announce'])
  })

  describe("Foreman's voice", () => {
    it('is off by default, and its switch writes on and off', async () => {
      const user = userEvent.setup()
      const { unmount } = render(<AccessibilityPage />)
      const toggle = screen.getByRole('switch', { name: 'Foreman reads announcements aloud' })
      expect(toggle.getAttribute('aria-checked')).toBe('false')
      await user.click(toggle)
      expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ speechOutput: 'on' })
      unmount()
      fakeState.snapshot.settings.speechOutput = 'on'
      render(<AccessibilityPage />)
      const on = screen.getByRole('switch', { name: 'Foreman reads announcements aloud' })
      expect(on.getAttribute('aria-checked')).toBe('true')
      await user.click(on)
      expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ speechOutput: 'off' })
    })

    it('lists Automatic first, then the local voices with their language, and saves the chosen one', async () => {
      stubSpeech()
      render(<AccessibilityPage />)
      const select = screen.getByRole('combobox', { name: 'Voice' }) as HTMLSelectElement
      expect([...select.options].map((o) => o.textContent)).toEqual(['Automatic', 'Anna (de-DE)', 'Zira (en-US)'])
      await userEvent.selectOptions(select, 'uri:Anna')
      expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ speechVoice: 'uri:Anna' })
      await userEvent.selectOptions(select, '')
      expect(fakeApi.updateSettings).toHaveBeenLastCalledWith({ speechVoice: '' })
    })

    it('saves the rate (0.5 to 2) and the volume (0 to 1) once the slider settles, rounded to a tenth', async () => {
      render(<AccessibilityPage />)
      const rate = screen.getByRole('slider', { name: 'Speech rate' }) as HTMLInputElement
      expect([rate.min, rate.max, rate.step]).toEqual(['0.5', '2', '0.1'])
      fireEvent.change(rate, { target: { value: '1.3' } })
      expect(rate.getAttribute('aria-valuetext')).toBe('1.3 times')
      await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ speechRate: 1.3 }))
      const volume = screen.getByRole('slider', { name: 'Speech volume' }) as HTMLInputElement
      expect([volume.min, volume.max, volume.step]).toEqual(['0', '1', '0.1'])
      fireEvent.change(volume, { target: { value: '0.6' } })
      expect(volume.getAttribute('aria-valuetext')).toBe('60 percent')
      await waitFor(() => expect(fakeApi.updateSettings).toHaveBeenCalledWith({ speechVolume: 0.6 }))
    })

    it('offers a reset for a changed rate', async () => {
      fakeState.snapshot.settings.speechRate = 1.5
      render(<AccessibilityPage />)
      await userEvent.click(screen.getByRole('button', { name: 'Setting actions' }))
      await userEvent.click(await screen.findByRole('menuitem', { name: 'Reset' }))
      expect(fakeApi.resetSettings).toHaveBeenCalledWith(['speechRate'])
    })

    it('speaks a sample sentence from Test voice, even while the setting is off', async () => {
      const { spoken } = stubSpeech()
      render(<AccessibilityPage />)
      await userEvent.click(screen.getByRole('button', { name: 'Test voice' }))
      expect(spoken).toHaveLength(1)
      expect(spoken[0].text).toMatch(/^This is Foreman\./)
    })

    it('says a screen reader will also read it, only when one is running and the voice is on', () => {
      const note = () => screen.queryByText('A screen reader is running; it will also read what Foreman speaks.')
      const cases: Array<[boolean, 'on' | 'off', boolean]> = [
        [true, 'on', true],
        [true, 'off', false],
        [false, 'on', false],
        [false, 'off', false]
      ]
      for (const [screenReader, speechOutput, shown] of cases) {
        fakeState.snapshot.screenReader = screenReader
        fakeState.snapshot.settings.speechOutput = speechOutput
        const { unmount } = render(<AccessibilityPage />)
        expect(Boolean(note()), `screenReader ${screenReader}, speech ${speechOutput}`).toBe(shown)
        unmount()
      }
    })
  })

  it('is gone from the Advanced page', () => {
    fakeState.snapshot.homeDir = '/home/me'
    Object.assign(fakeState.snapshot.settings, { terminalScrollbackMb: 10, terminalCopyOnSelect: false, restoreTerminals: true, workspacesRoot: '/w' })
    render(<AdvancedPage />)
    expect(screen.queryByRole('combobox', { name: 'Screen reader support' })).toBeNull()
  })
})
