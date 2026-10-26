// @vitest-environment jsdom
import './domShims'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'
import { WorkspaceBrowser } from '../src/renderer/src/components/WorkspaceBrowser'
vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)
const command = vi.fn(async () => null)
const capture = vi.fn(async () => ({ base64: 'image', url: 'http://localhost:50230/form' }))
const sessions = [{ id: 's1', title: 'Frontend' }, { id: 's2', title: 'Review' }] as never
beforeEach(() => {
  resetFake()
  command.mockClear()
  capture.mockClear()
  fakeState.browserTabs = { w1: { url: 'http://localhost:50230/', request: 1, active: true, split: false } }
  fakeState.browserAddressRequest = null
  ;(storeModule.bridge as any).browser = { command, capture }
  vi.mocked(storeModule.fillComposer as any).mockClear()
  fakeApi.attachData = vi.fn(async () => ({ path: '/worktree/screenshot.png', name: 'screenshot.png', kind: 'image' }))
})
afterEach(cleanup)
it('opens only once and hides native content on chat switches without closing the page', async () => {
  const { rerender, unmount } = render(<WorkspaceBrowser workspaceId="w1" visible sessions={sessions} activeId="s1" />)
  await waitFor(() => expect(command).toHaveBeenCalledWith('w1', { type: 'open', url: 'http://localhost:50230/' }))
  rerender(<WorkspaceBrowser workspaceId="w1" visible={false} sessions={sessions} activeId="s1" />)
  expect(command).toHaveBeenCalledWith('w1', { type: 'bounds', bounds: null })
  rerender(<WorkspaceBrowser workspaceId="w1" visible sessions={sessions} activeId="s1" />)
  expect(command.mock.calls.filter((call: any[]) => call[1].type === 'open')).toHaveLength(1)
  unmount()
  expect(command.mock.calls.some((call: any[]) => call[1].type === 'close')).toBe(false)
})
it('navigates from the address bar and attaches a screenshot to the chosen chat draft without sending', async () => {
  render(<WorkspaceBrowser workspaceId="w1" visible sessions={sessions} activeId="s1" />)
  const address = screen.getByRole('textbox', { name: 'Browser address' })
  fireEvent.change(address, { target: { value: 'localhost:50230/form' } })
  fireEvent.keyDown(address, { key: 'Enter' })
  await waitFor(() => expect(command).toHaveBeenCalledWith('w1', { type: 'navigate', url: 'http://localhost:50230/form' }))
  fireEvent.change(screen.getByRole('combobox', { name: 'Send screenshot to chat' }), { target: { value: 's2' } })
  fireEvent.click(screen.getByRole('button', { name: 'Screenshot to chat' }))
  await waitFor(() => expect(storeModule.fillComposer).toHaveBeenCalledWith('w1', 's2', 'Browser screenshot: http://localhost:50230/form', undefined, [expect.objectContaining({ name: 'screenshot.png' })]))
  expect(fakeApi.sendMessage).toBeUndefined()
})
it('offers retry on load failure and enables split through the existing workspace state', async () => {
  fakeState.browserTabs.w1.state = { url: 'http://localhost:50230/', error: 'Connection refused', loading: false }
  render(<WorkspaceBrowser workspaceId="w1" visible sessions={sessions} activeId="s1" />)
  expect(screen.getByText('Connection refused')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(command).toHaveBeenCalledWith('w1', { type: 'reload' })
  fireEvent.click(screen.getByRole('button', { name: 'Split with chat' }))
  expect(storeModule.splitBrowserTab).toHaveBeenCalledWith('w1', true)
})

it('adds selected element context to the chosen chat as a draft', async () => {
  const selectElement = vi.fn(async () => ({ url: 'https://example.com/', selector: '#save', text: 'Save' }))
  ;(storeModule.bridge as any).browser.selectElement = selectElement
  render(<WorkspaceBrowser workspaceId="w1" visible sessions={sessions} activeId="s1" />)
  await waitFor(() => expect((screen.getByRole('button', { name: 'Select element' }) as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByRole('button', { name: 'Select element' }))
  await waitFor(() => expect(storeModule.fillComposer).toHaveBeenCalledWith('w1', 's1', 'Selected element: #save\nPage: https://example.com/\nVisible text: Save'))
  expect(capture).not.toHaveBeenCalled()
  expect(fakeApi.sendMessage).toBeUndefined()
})
