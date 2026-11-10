// @vitest-environment jsdom
// Settings → Agents → Codex: the ChatGPT sign-in button, its waiting state, Cancel and the ways it ends.
import './domShims'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CodexSignIn } from '../src/renderer/src/components/settings/CodexSignIn'
import { fakeApi, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

type Result = { ok: boolean; error?: string; cancelled?: boolean }

/** A sign-in the test finishes by hand. */
function pending() {
  let finish!: (result: Result) => void
  const promise = new Promise<Result>((resolve) => (finish = resolve))
  fakeApi.codexSignIn = vi.fn(() => promise)
  fakeApi.codexSignInCancel = vi.fn(async () => finish({ ok: false, cancelled: true }))
  return finish
}

beforeEach(resetFake)
afterEach(cleanup)

describe('the Codex ChatGPT sign-in', () => {
  it('is the primary button until connected, then offers to sign in again', () => {
    const { rerender } = render(<CodexSignIn connected={false} onSignedIn={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
    rerender(<CodexSignIn connected onSignedIn={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Sign in again' })).toBeTruthy()
  })

  it('waits for the browser with a way to cancel, and refreshes the status once signed in', async () => {
    const finish = pending()
    const onSignedIn = vi.fn()
    const user = userEvent.setup()
    render(<CodexSignIn connected={false} onSignedIn={onSignedIn} />)
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    expect(fakeApi.codexSignIn).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('status').textContent).toContain('Finish signing in in your browser')
    expect(screen.queryByRole('button', { name: 'Sign in with ChatGPT' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    finish({ ok: true })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy())
    expect(onSignedIn).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('Cancel stops the sign-in without showing an error', async () => {
    pending()
    const onSignedIn = vi.fn()
    const user = userEvent.setup()
    render(<CodexSignIn connected={false} onSignedIn={onSignedIn} />)
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(fakeApi.codexSignInCancel).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy())
    expect(screen.queryByRole('alert')).toBeNull()
    expect(onSignedIn).not.toHaveBeenCalled()
  })

  it('says why a sign-in failed, in an alert, and clears it on the next try', async () => {
    fakeApi.codexSignIn = vi.fn(async () => ({ ok: false, error: 'Token exchange failed' }))
    const onSignedIn = vi.fn()
    const user = userEvent.setup()
    render(<CodexSignIn connected={false} onSignedIn={onSignedIn} />)
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Couldn’t sign in: Token exchange failed')
    expect(onSignedIn).not.toHaveBeenCalled()
    fakeApi.codexSignIn = vi.fn(async () => ({ ok: true }))
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    await waitFor(() => expect(onSignedIn).toHaveBeenCalled())
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('shows an error when the call itself is refused', async () => {
    fakeApi.codexSignIn = vi.fn(async () => Promise.reject(new Error('Not available while another computer is shown')))
    const user = userEvent.setup()
    render(<CodexSignIn connected={false} onSignedIn={vi.fn()} />)
    await user.click(screen.getByRole('button', { name: 'Sign in with ChatGPT' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Not available while another computer is shown')
    expect(screen.getByRole('button', { name: 'Sign in with ChatGPT' })).toBeTruthy()
  })
})
