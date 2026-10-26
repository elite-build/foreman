// Low-contrast dark and the code themes are gone: a saved choice for either is
// dropped on load and never written back; the colour-vision setting stays.
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { defaultSettings, Store } from '../src/main/store'
import { tempDir } from './helpers'

describe('removed appearance settings', () => {
  it('drops lowContrastDark and codeTheme from older state and keeps colorVision', async () => {
    const dir = await tempDir('foreman-themes-')
    const older = { ...defaultSettings(), lowContrastDark: true, codeTheme: 'dracula', colorVision: 'tritanopia' }
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos: [], settings: older }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings).not.toHaveProperty('lowContrastDark')
    expect(store.state.settings).not.toHaveProperty('codeTheme')
    expect(store.state.settings.colorVision).toBe('tritanopia')
    store.flush()
    store.close()
    const saved = JSON.parse(await readFile(path.join(dir, 'state.json'), 'utf8')) as { settings: Record<string, unknown> }
    expect(saved.settings).not.toHaveProperty('lowContrastDark')
    expect(saved.settings).not.toHaveProperty('codeTheme')
    expect(saved.settings.colorVision).toBe('tritanopia')
  })

  it('new installs never have them', () => {
    expect(defaultSettings()).not.toHaveProperty('lowContrastDark')
    expect(defaultSettings()).not.toHaveProperty('codeTheme')
  })
})
