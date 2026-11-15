// @vitest-environment jsdom
// The composer's model picker: each row's number, name and keys sit in a line with gaps between them (with the app's
// stylesheets in the app's order), and its key hints follow the platform: words on Windows, symbols on macOS.
import '../domShims'
import { readFileSync } from 'node:fs'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPicker } from '../../src/renderer/src/components/composer/AgentPicker'
import { setModelCatalog } from '../../src/shared/agents'
import type { Session } from '../../src/shared/types'
import { fakeApi, fakeState, resetFake } from '../rendererStore'

vi.mock('../../src/renderer/src/store', async () => (await import('../rendererStore')).storeModule)

const session = (over: Partial<Session> = {}): Session =>
  ({ id: 's1', workspaceId: 'w1', agent: 'claude', model: 'm1', agentSessionId: 'conv', fastMode: false, planMode: false, status: 'idle', queue: [], ...over }) as Session

// ui/ui.css with its @imports inlined, as the app loads it.
const uiStylesheet = () =>
  readFileSync('src/renderer/src/ui/ui.css', 'utf8').replace(/@import '\.\/(css\/[\w-]+\.css)';/g, (_, file: string) => readFileSync(`src/renderer/src/ui/${file}`, 'utf8'))

const original = fakeState.snapshot
beforeEach(() => {
  resetFake()
  fakeApi.updateSession = vi.fn(async () => {})
  fakeState.snapshot = { ...original, platform: 'win32', workspaces: [{ id: 'w1', repoId: 'r1', name: 'lisbon', state: 'ready' }] }
  setModelCatalog({
    claude: [
      { id: 'm1', label: 'Model 1', agent: 'claude', efforts: [], supportsFast: true },
      { id: 'm2', label: 'Model 2', agent: 'claude', efforts: [], supportsFast: false }
    ],
    codex: [{ id: 'c1', label: 'Codex 1', agent: 'codex', efforts: [], supportsFast: false }]
  } as never)
  fakeState.snapshot.catalog = { agents: { claude: { fetchedAt: 'now' }, codex: { fetchedAt: 'now' } }, outputStyles: [] }
})
afterEach(() => {
  cleanup()
  setModelCatalog({})
  fakeState.snapshot = original
})

describe('a model row', () => {
  it('lays its content out in a line with the app’s stylesheets in the app’s order', () => {
    // In the app ui/ui.css comes after every feature sheet (main.tsx), so `.ui-pressable { display: block }` beat a lone
    // `.picker-row-main { display: flex }` of the same weight, and the row read "1Opus 5.5HighCtrl+Shift+1".
    const sheets = [readFileSync('src/renderer/src/styles/agent-picker.css', 'utf8'), uiStylesheet()]
    const styles = sheets.map((css) => {
      const style = document.createElement('style')
      style.textContent = css
      document.head.append(style)
      return style
    })
    try {
      render(<AgentPicker session={session()} hasHistory={false} open onOpenChange={() => undefined} />)
      const row = screen.getByRole('button', { name: /Model 2/ })
      expect(row.classList.contains('picker-row-main')).toBe(true)
      expect(getComputedStyle(row).display).toBe('flex')
      expect(getComputedStyle(row).alignItems).toBe('center')
    } finally {
      styles.forEach((style) => style.remove())
    }
  })
})

describe('the picker’s key hints', () => {
  it('spell the keys out on Windows', () => {
    render(<AgentPicker session={session()} hasHistory={false} open onOpenChange={() => undefined} />)
    const panel = screen.getByRole('dialog', { name: 'Agent and model' })
    expect(panel.textContent).toContain('Ctrl+Shift+/ cycle')
    expect(panel.textContent).toContain('Ctrl+Shift+E fast')
    expect(panel.textContent).not.toMatch(/[⌘⌥⇧↵⌫]/)
  })

  it('draw the symbols on macOS', () => {
    fakeState.snapshot.platform = 'darwin'
    render(<AgentPicker session={session()} hasHistory={false} open onOpenChange={() => undefined} />)
    const panel = screen.getByRole('dialog', { name: 'Agent and model' })
    expect(panel.textContent).toContain('⌘⇧/ cycle')
    expect(panel.textContent).toContain('⌘⇧E fast')
  })

  it('on the choice after picking another account in a chat with messages: Enter and Ctrl+Enter on Windows', async () => {
    fakeState.snapshot.settings = {
      ...original.settings,
      agentInstances: [{ id: 'ai-work0001', agent: 'claude', label: 'Work', auth: 'cli', home: '/accounts/work' }],
      agentPrefs: { claude: { moveChats: 'as-text' } }
    }
    const user = userEvent.setup()
    render(<AgentPicker session={session()} hasHistory open onOpenChange={() => undefined} />)
    await user.selectOptions(screen.getByLabelText('Account'), 'ai-work0001')
    const group = screen.getByRole('group', { name: 'Continue here or open a new chat' })
    expect(Array.from(group.querySelectorAll('kbd')).map((k) => k.textContent)).toEqual(['Enter', 'Ctrl+Enter'])
    expect(group.textContent).not.toMatch(/[⌘⌥⇧↵⌫]/)
  })
})
