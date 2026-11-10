// Foreman with no window (docs/server.md, "Headless"): when closing the last window quits, when the tray must show, and
// how --headless is read. The headless: false, keepRunning: false rows are the rule as it was before the setting.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseHeadless, quitsWhenWindowsClose, trayWanted, type HeadlessFacts } from '../src/main/headless'

const PLATFORMS: NodeJS.Platform[] = ['darwin', 'win32', 'linux']

function facts(platform: NodeJS.Platform, rest: Partial<HeadlessFacts> = {}): HeadlessFacts {
  return { platform, headless: false, keepRunning: false, phoneAccess: false, ...rest }
}

describe('quitsWhenWindowsClose', () => {
  it('keeps the rule it had: macOS stays, Windows stays while phone access is on, everything else quits', () => {
    expect(quitsWhenWindowsClose(facts('darwin'))).toBe(false)
    expect(quitsWhenWindowsClose(facts('darwin', { phoneAccess: true }))).toBe(false)
    expect(quitsWhenWindowsClose(facts('win32'))).toBe(true)
    expect(quitsWhenWindowsClose(facts('win32', { phoneAccess: true }))).toBe(false)
    expect(quitsWhenWindowsClose(facts('linux'))).toBe(true)
    // Linux never had the phone tray, so phone access alone doesn't keep it running.
    expect(quitsWhenWindowsClose(facts('linux', { phoneAccess: true }))).toBe(true)
  })

  it('never quits when started headless or with Keep running without a window on', () => {
    for (const platform of PLATFORMS) {
      for (const phoneAccess of [false, true]) {
        expect(quitsWhenWindowsClose(facts(platform, { headless: true, phoneAccess })), `${platform} headless`).toBe(false)
        expect(quitsWhenWindowsClose(facts(platform, { keepRunning: true, phoneAccess })), `${platform} keep running`).toBe(false)
        expect(quitsWhenWindowsClose(facts(platform, { headless: true, keepRunning: true, phoneAccess })), `${platform} both`).toBe(false)
      }
    }
  })
})

describe('trayWanted', () => {
  it('keeps the rule it had: only phone access on Windows forced the tray', () => {
    for (const platform of PLATFORMS) expect(trayWanted(facts(platform)), platform).toBe(false)
    expect(trayWanted(facts('win32', { phoneAccess: true }))).toBe(true)
    expect(trayWanted(facts('darwin', { phoneAccess: true }))).toBe(false)
    expect(trayWanted(facts('linux', { phoneAccess: true }))).toBe(false)
  })

  it('shows whenever Foreman may run with no window', () => {
    for (const platform of PLATFORMS) {
      expect(trayWanted(facts(platform, { headless: true })), `${platform} headless`).toBe(true)
      expect(trayWanted(facts(platform, { keepRunning: true })), `${platform} keep running`).toBe(true)
    }
  })

  it('is wanted wherever closing the window leaves Foreman running off macOS', () => {
    // Off macOS there is no Dock icon: an app that stays must have a way back and a way to quit.
    for (const platform of ['win32', 'linux'] as const) {
      for (const headless of [false, true]) {
        for (const keepRunning of [false, true]) {
          for (const phoneAccess of [false, true]) {
            const f = facts(platform, { headless, keepRunning, phoneAccess })
            if (!quitsWhenWindowsClose(f)) expect(trayWanted(f), JSON.stringify(f)).toBe(true)
          }
        }
      }
    }
  })
})

describe('parseHeadless', () => {
  it('finds --headless anywhere after the executable', () => {
    expect(parseHeadless(['Foreman.exe', '--headless'])).toBe(true)
    expect(parseHeadless(['electron', '.', '--headless'])).toBe(true)
    expect(parseHeadless(['Foreman', '--headless', 'C:\\repo'])).toBe(true)
    expect(parseHeadless(['/Applications/Foreman.app/Contents/MacOS/Foreman', '--inspect', '--headless'])).toBe(true)
  })

  it('ignores the executable and anything that only looks like it', () => {
    expect(parseHeadless([])).toBe(false)
    expect(parseHeadless(['--headless'])).toBe(false)
    expect(parseHeadless(['Foreman.exe'])).toBe(false)
    expect(parseHeadless(['Foreman.exe', '--headless=false'])).toBe(false)
    expect(parseHeadless(['Foreman.exe', 'headless'])).toBe(false)
    expect(parseHeadless(['Foreman.exe', 'foreman://open?headless'])).toBe(false)
  })
})

describe('index.ts and --headless', () => {
  // index.ts can't be loaded outside Electron, so its wiring is read instead. Both were found by starting the real app.
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')

  it('takes the switch off Chromium’s command line, whose own headless mode would hide every window opened later', () => {
    expect(source).toMatch(/app\.commandLine\.removeSwitch\('headless'\)/)
  })

  it('hands it to the running Foreman with the single-instance request, since the command line it sees has lost it', () => {
    expect(source).toMatch(/requestSingleInstanceLock\(\{ headless: parseHeadless\(process\.argv\) \}\)/)
    expect(source).toMatch(/app\.on\('second-instance', \(_event, argv, workingDirectory, data\)/)
  })
})
