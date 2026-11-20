// @vitest-environment jsdom
// A shell snippet in a reply runs only when Run is clicked. A hidden chat keeps its transcript in an Activity, which runs
// effect cleanups and mounts again when shown: that must not start the command a second time (an `open` in a reply
// opened its page in the browser each time the workspace was shown again).
import './domShims'
import { Activity, useEffect } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ShellSnippet } from '../src/renderer/src/components/ShellSnippet'
import { resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

// Like the real terminal: the process starts in a mount effect and is killed in its cleanup.
const spawned = vi.hoisted(() => [] as string[])
const killed = vi.hoisted(() => [] as string[])
vi.mock('../src/renderer/src/components/TerminalView', () => ({
  TerminalView: (props: { command?: string; onSpawn?: (id: string) => void; onExit?: (code: number) => void }) => {
    useEffect(() => {
      spawned.push(props.command ?? '')
      props.onSpawn?.('pty-1')
      return () => void killed.push(props.command ?? '')
    }, [])
    return (
      <div data-testid="terminal">
        <button onClick={() => props.onExit?.(0)}>finish</button>
      </div>
    )
  }
}))

const command = 'open ~/mocks/index.html'
const snippet = (mode: 'visible' | 'hidden') => (
  <Activity mode={mode}>
    <ShellSnippet workspaceId="ws" command={command} disabled={false}>
      <pre>{command}</pre>
    </ShellSnippet>
  </Activity>
)

beforeEach(() => {
  resetFake()
  spawned.length = 0
  killed.length = 0
})
afterEach(cleanup)

describe('a shell snippet in a chat that is hidden and shown again', () => {
  it('stops a running command when hidden and does not start it again when shown', async () => {
    const user = userEvent.setup()
    const { rerender } = render(snippet('visible'))
    await user.click(screen.getByRole('button', { name: 'Run' }))
    expect(spawned).toEqual([command])

    rerender(snippet('hidden'))
    expect(killed).toEqual([command])
    rerender(snippet('visible'))
    expect(spawned).toEqual([command])
    expect(screen.queryByTestId('terminal')).toBeNull()
    expect(screen.getByRole('status').textContent).toBe('Stopped')

    // Run starts it again.
    await user.click(screen.getByRole('button', { name: 'Run again' }))
    expect(spawned).toEqual([command, command])
  })

  it('does not run a finished command again when shown', async () => {
    const user = userEvent.setup()
    const { rerender } = render(snippet('visible'))
    await user.click(screen.getByRole('button', { name: 'Run' }))
    await user.click(screen.getByRole('button', { name: 'finish' }))

    rerender(snippet('hidden'))
    rerender(snippet('visible'))
    expect(spawned).toEqual([command])
    expect(screen.getByRole('status').textContent).toBe('Exit 0')
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy()
  })
})
