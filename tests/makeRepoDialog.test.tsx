// @vitest-environment jsdom
// "Make it a Git repository": the offer for a folder outside Git, and the name and email form when Git can't commit.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MakeRepoDialog } from '../src/renderer/src/components/AddRepository'
import { resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>
const DIR = 'C:\\code\\my-site'

beforeEach(() => {
  resetFake()
  spy('makeRepository').mockReset()
  spy('openMakeRepo').mockReset()
})
afterEach(cleanup)

describe('MakeRepoDialog', () => {
  it('explains what it will do and offers the button', async () => {
    render(<MakeRepoDialog dir={DIR} />)
    const dialog = await screen.findByRole('dialog', { name: 'This folder isn’t a Git repository' })
    expect(within(dialog).getByText(DIR)).toBeTruthy()
    const note = within(dialog).getByText('Foreman works in Git repositories').closest('.ui-callout') as HTMLElement
    expect(note.textContent).toContain('runs git init')
    expect(note.textContent).toContain('first commit')
    expect(note.textContent).toContain('my-site')
    expect(within(note).getByRole('button', { name: 'Make it a Git repository' })).toBeTruthy()
  })

  it('makes the repository from the button', async () => {
    spy('makeRepository').mockResolvedValue('added')
    const user = userEvent.setup()
    render(<MakeRepoDialog dir={DIR} />)
    await user.click(await screen.findByRole('button', { name: 'Make it a Git repository' }))
    await waitFor(() => expect(spy('makeRepository')).toHaveBeenCalledWith(DIR, undefined))
  })

  it('asks for a name and email when Git has none, then retries with them', async () => {
    spy('makeRepository').mockResolvedValueOnce('needs-identity').mockResolvedValueOnce('added')
    const user = userEvent.setup()
    render(<MakeRepoDialog dir={DIR} />)
    await user.click(await screen.findByRole('button', { name: 'Make it a Git repository' }))

    const dialog = await screen.findByRole('dialog', { name: 'Git needs to know who you are' })
    const save = within(dialog).getByRole('button', { name: 'Save and continue' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    await user.type(within(dialog).getByRole('textbox', { name: 'Your name' }), 'Ada Lovelace')
    await user.type(within(dialog).getByRole('textbox', { name: 'Your email' }), 'not-an-email')
    expect(save.disabled).toBe(true)
    await user.clear(within(dialog).getByRole('textbox', { name: 'Your email' }))
    await user.type(within(dialog).getByRole('textbox', { name: 'Your email' }), 'ada@example.com')
    expect(save.disabled).toBe(false)
    await user.click(save)
    await waitFor(() => expect(spy('makeRepository')).toHaveBeenLastCalledWith(DIR, { name: 'Ada Lovelace', email: 'ada@example.com', global: false }))
  })

  it('saves the identity globally only when that box is ticked', async () => {
    spy('makeRepository').mockResolvedValueOnce('needs-identity').mockResolvedValueOnce('added')
    const user = userEvent.setup()
    render(<MakeRepoDialog dir={DIR} />)
    await user.click(await screen.findByRole('button', { name: 'Make it a Git repository' }))
    await user.type(await screen.findByRole('textbox', { name: 'Your name' }), 'Ada')
    await user.type(screen.getByRole('textbox', { name: 'Your email' }), 'ada@example.com')
    const global = screen.getByRole('checkbox', { name: 'Also use them for every Git repository on this computer' }) as HTMLInputElement
    expect(global.checked).toBe(false)
    await user.click(global)
    await user.click(screen.getByRole('button', { name: 'Save and continue' }))
    await waitFor(() => expect(spy('makeRepository')).toHaveBeenLastCalledWith(DIR, { name: 'Ada', email: 'ada@example.com', global: true }))
  })

  it('shows a refusal as an alert and stays on the offer', async () => {
    spy('makeRepository').mockRejectedValue(new Error("Error invoking remote method 'makeRepo': Error: C:\\ is the top of a drive. Choose a project folder inside it instead."))
    const user = userEvent.setup()
    render(<MakeRepoDialog dir="C:\\" />)
    await user.click(await screen.findByRole('button', { name: 'Make it a Git repository' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('is the top of a drive')
    expect(alert.textContent).not.toContain('Error invoking')
    expect(screen.getByRole('button', { name: 'Make it a Git repository' })).toBeTruthy()
  })

  it('closes with Cancel and Escape', async () => {
    const user = userEvent.setup()
    render(<MakeRepoDialog dir={DIR} />)
    await user.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(spy('openMakeRepo')).toHaveBeenCalledWith(null)
    spy('openMakeRepo').mockClear()
    await user.keyboard('{Escape}')
    expect(spy('openMakeRepo')).toHaveBeenCalledWith(null)
  })
})
