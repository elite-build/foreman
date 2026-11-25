// @vitest-environment jsdom
// The file viewer next to the agent: the branch's changes beside the gutter, and a save that would undo the agent's edit
// (made after the file was opened) stops and asks: merge both, take the agent's text, or keep yours.
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceDiff } from '../src/shared/types'
import { FileViewer } from '../src/renderer/src/components/FileViewer'
import { fakeApi, resetFake } from './rendererStore'

// The fake store, with the two selectors the selection bar's default tab reads.
vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const own: Record<string, unknown> = {
    activeSessionId: (s: { activeSession?: Record<string, string> }, id: string) => s.activeSession?.[id],
    openSessions: (snapshot: { sessions: { workspaceId: string; closedAt?: string }[] }, id: string) => snapshot.sessions.filter((s) => s.workspaceId === id && !s.closedAt)
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})
vi.mock('../src/renderer/src/components/OpenIn', () => ({ OpenInViewerButton: () => null }))

const noDiff: WorkspaceDiff = { baseRef: 'main', scope: 'all', files: [], truncated: false }

function open(content: string, diff: WorkspaceDiff = noDiff) {
  fakeApi.readFile = vi.fn(async () => ({ content, binary: false, tooLarge: false }))
  fakeApi.getDiff = vi.fn(async () => diff)
  return render(<FileViewer workspaceId="ws" workspacePath="/ws" path="notes.txt" hasGit />)
}

const editor = () => screen.getByRole('textbox', { name: 'notes.txt' }) as HTMLTextAreaElement

async function edit(text: string) {
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
  fireEvent.change(editor(), { target: { value: text } })
}

beforeEach(() => resetFake())
afterEach(() => cleanup())

describe('the file viewer and the agent', () => {
  it('marks the lines the branch changed and counts them in the header', async () => {
    const diff: WorkspaceDiff = {
      ...noDiff,
      files: [
        {
          path: 'notes.txt',
          status: 'modified',
          binary: false,
          additions: 1,
          deletions: 1,
          hunks: [
            {
              header: '@@ -1,2 +1,2 @@',
              lines: [
                { type: 'ctx', text: 'a', oldNo: 1, newNo: 1 },
                { type: 'del', text: 'b', oldNo: 2 },
                { type: 'add', text: 'B', newNo: 2 }
              ]
            }
          ]
        }
      ]
    }
    const { container } = open('a\nB\n', diff)
    expect(await screen.findByText('1 change on this branch')).toBeTruthy()
    await waitFor(() => expect(container.querySelector('.ui-code-editor__gutter-row[data-line="2"]')?.getAttribute('data-change')).toBe('modified'))
    expect(container.querySelector('.ui-code-editor__gutter-row[data-line="1"]')?.hasAttribute('data-change')).toBe(false)
  })

  it('saves with the text it opened, and on a refusal offers the agent’s text instead of overwriting it', async () => {
    open('one\n')
    fakeApi.writeFile = vi.fn(async () => ({ current: 'agent\n' }))
    await edit('mine\n')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect(await screen.findByText(/The agent changed this file after you opened it/)).toBeTruthy()
    expect(fakeApi.writeFile).toHaveBeenCalledWith('ws', 'notes.txt', 'mine\n', 'one\n')
    // Both edited line 1: no merge, and it says why.
    expect(screen.queryByRole('button', { name: 'Merge both' })).toBeNull()
    expect(screen.getByText(/can’t be merged/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Use the agent’s' }))
    expect(editor().value).toBe('agent\n')
    expect(screen.queryByText(/The agent changed this file/)).toBeNull()
  })

  it('merges edits on different lines, and the next save expects the agent’s text', async () => {
    open('a\nb\nc\n')
    fakeApi.writeFile = vi.fn(async () => ({ current: 'a\nb\nC\n' }))
    await edit('A\nb\nc\n')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Merge both' }))
    expect(editor().value).toBe('A\nb\nC\n')
    fakeApi.writeFile = vi.fn(async () => null)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fakeApi.writeFile).toHaveBeenCalledWith('ws', 'notes.txt', 'A\nb\nC\n', 'a\nb\nC\n'))
  })

  it('Keep mine writes over the agent’s text it was shown, and nothing newer', async () => {
    open('one\n')
    fakeApi.writeFile = vi.fn(async () => ({ current: 'agent\n' }))
    await edit('mine\n')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText(/The agent changed this file/)
    fakeApi.writeFile = vi.fn(async () => null)
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }))
    await waitFor(() => expect(fakeApi.writeFile).toHaveBeenCalledWith('ws', 'notes.txt', 'mine\n', 'agent\n'))
    await waitFor(() => expect(screen.queryByText(/The agent changed this file/)).toBeNull())
  })
})
