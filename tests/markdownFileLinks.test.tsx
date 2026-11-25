// @vitest-environment jsdom
// A link in a reply that names a file opens it (as a tool call's path does); Ctrl-click shows it in its folder. Web links
// stay web links, and a cloud workspace's file links (files: null) open nothing on this computer.
import './domShims'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Markdown } from '../src/renderer/src/components/Markdown'
import { fakeApi, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

beforeEach(resetFake)
afterEach(cleanup)

describe('a file link in a reply', () => {
  it('opens a file:/// link, which Markdown would otherwise drop', async () => {
    const user = userEvent.setup()
    render(<Markdown text="Opened [mobile-mocks.html](file:///C:/Users/me/brain/mobile-mocks.html)." />)
    const link = screen.getByRole('link', { name: 'mobile-mocks.html' })
    expect(link.getAttribute('href')).toBe('file:///C:/Users/me/brain/mobile-mocks.html')
    await user.click(link)
    expect(fakeApi.openFile).toHaveBeenCalledWith('C:/Users/me/brain/mobile-mocks.html', 'open')
  })

  it('opens a drive path in angle brackets, and Ctrl-click shows it in its folder', async () => {
    const user = userEvent.setup()
    render(<Markdown text="[Open the prototype](</C:/Users/me/mocks/mobile/index.html>)" />)
    await user.keyboard('{Control>}')
    await user.click(screen.getByRole('link', { name: 'Open the prototype' }))
    await user.keyboard('{/Control}')
    expect(fakeApi.openFile).toHaveBeenCalledWith('C:/Users/me/mocks/mobile/index.html', 'reveal')
  })

  it('opens a path relative to the worktree from the keyboard', async () => {
    const user = userEvent.setup()
    render(<Markdown text="See [Markdown.tsx](src/Markdown.tsx#L12)." files={{ root: '/home/me/repo' }} />)
    screen.getByRole('link', { name: 'Markdown.tsx' }).focus()
    await user.keyboard('{Enter}')
    expect(fakeApi.openFile).toHaveBeenCalledWith('/home/me/repo/src/Markdown.tsx', 'open')
  })

  it('leaves web links and a cloud workspace’s file links alone', async () => {
    const user = userEvent.setup()
    render(<Markdown text="[site](https://example.com) [file](file:///C:/a.html)" files={null} />)
    expect(screen.getByRole('link', { name: 'site' }).getAttribute('target')).toBe('_blank')
    await user.click(screen.getByRole('link', { name: 'file' }))
    expect(fakeApi.openFile).toBeUndefined()
  })
})
