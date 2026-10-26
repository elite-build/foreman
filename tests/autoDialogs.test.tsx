// @vitest-environment jsdom
// The consent dialogs that moved off the old Modal onto ui/Dialog: Auto-fix CI, Auto review, the sensitive-files diff
// and a repo command's approval. Each is one named dialog with its actions in the footer and Escape to leave.
import './domShims'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoFixDialog } from '../src/renderer/src/components/AutoFix'
import { AutoReviewDialog } from '../src/renderer/src/components/AutoReview'
import { useSavedCommandRunner } from '../src/renderer/src/components/SavedCommands'
import { AlertDiffDialog } from '../src/renderer/src/components/SensitiveAlert'
import { fakeApi, fakeState, resetFake, storeModule } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const spy = (name: string) => storeModule[name] as ReturnType<typeof vi.fn>

beforeEach(() => {
  resetFake()
  spy('openSessions').mockReturnValue([{ id: 's1', title: 'Fix login', agent: 'claude' }])
  spy('activeSessionId').mockReturnValue('s1')
  spy('openAlertDiff').mockClear()
})
afterEach(cleanup)

const footerOf = (dialog: HTMLElement) => dialog.querySelector('.ui-dialog__foot') as HTMLElement

describe('Auto-fix consent', () => {
  const preview = { sessionId: 's1', agent: 'claude', permissions: 'Same as the tab', prompt: 'Fix the failing check', perHead: 1, perPr: 3, maxMinutes: 20, pr: 'PR #42' }

  beforeEach(() => {
    Object.assign(fakeState.snapshot, { workspaces: [{ id: 'w1', name: 'login', repoId: 'r1' }] })
    fakeApi.autoFixPreview = vi.fn(async () => preview)
    fakeApi.setAutoFix = vi.fn(async () => undefined)
  })

  it('is a dialog with the exact prompt and budget, named groups, and its buttons in the footer', async () => {
    render(<AutoFixDialog workspaceId="w1" onClose={() => undefined} />)
    const dialog = await screen.findByRole('dialog', { name: 'Fix CI automatically in login?' })
    expect(await within(dialog).findByText('Fix the failing check')).toBeTruthy()
    expect(within(dialog).getByRole('group', { name: 'Prompt' })).toBeTruthy()
    expect(within(dialog).getByRole('group', { name: 'Budget' })).toBeTruthy()
    const foot = footerOf(dialog)
    expect(within(foot).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    // Without a CI watch yet, the footer says approving also turns one on.
    expect(within(foot).getByText('Also turns on CI notifications for this PR').className).toContain('dlg-start')
  })

  it('approves what was previewed, and Escape closes', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AutoFixDialog workspaceId="w1" onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    const approve = within(footerOf(dialog)).getByRole('button', { name: 'Turn on auto-fix' })
    await waitFor(() => expect((approve as HTMLButtonElement).disabled).toBe(false))
    await user.click(approve)
    await waitFor(() => expect(fakeApi.setAutoFix).toHaveBeenCalledWith('w1', { sessionId: 's1', agent: 'claude', permissions: 'Same as the tab', prompt: 'Fix the failing check' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    onClose.mockClear()
    await user.keyboard('{Escape}')
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

describe('Auto review consent', () => {
  const shown = {
    reviewer: { agent: 'claude', model: 'sonnet', fast: false },
    exclusions: ['*.md'],
    perDay: 5,
    maxMinutes: 15,
    idleMinutes: 2,
    readOnly: 'plan',
    prompt: 'Review the diff'
  }

  beforeEach(() => {
    Object.assign(fakeState.snapshot, { repos: [{ id: 'r1', name: 'foreman', defaultBranch: 'main' }] })
    fakeApi.autoReviewPreview = vi.fn(async () => shown)
    fakeApi.setAutoReview = vi.fn(async () => undefined)
  })

  it('shows the terms as named groups with the actions in the footer', async () => {
    render(<AutoReviewDialog repoId="r1" onClose={() => undefined} />)
    const dialog = await screen.findByRole('dialog', { name: 'Turn on auto review for foreman?' })
    expect(await within(dialog).findByRole('group', { name: 'Runs when' })).toBeTruthy()
    expect(within(dialog).getByRole('group', { name: 'Budget' })).toBeTruthy()
    const foot = footerOf(dialog)
    expect(within(foot).getByText('Waits until nothing else runs in the workspace').className).toContain('dlg-start')
    expect(within(foot).getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('turns it on with the previewed terms and the parsed exclusions', async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()
    render(<AutoReviewDialog repoId="r1" onClose={onClose} />)
    const dialog = await screen.findByRole('dialog')
    await within(dialog).findByRole('group', { name: 'Runs when' })
    await user.click(within(footerOf(dialog)).getByRole('button', { name: 'Turn on auto review' }))
    await waitFor(() => expect(fakeApi.setAutoReview).toHaveBeenCalledWith('r1', expect.objectContaining({ exclusions: ['*.md'], perDay: 5 })))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })
})

describe('the sensitive-files diff', () => {
  it('is a wide dialog that says when no net change remains, and Escape closes it', async () => {
    const user = userEvent.setup()
    Object.assign(fakeState.snapshot, { workspaces: [{ id: 'w1', name: 'login', alerts: [{ id: 'a1', files: ['.env'] }] }] })
    fakeApi.getAlertDiff = vi.fn(async () => ({ files: [], truncated: false }))
    render(<AlertDiffDialog workspaceId="w1" alertId="a1" />)
    const dialog = await screen.findByRole('dialog', { name: 'Sensitive files, start to end of the turn' })
    expect(dialog.className).toContain('ui-dialog--xl')
    expect(await within(dialog).findByText('No net change remains in these files.')).toBeTruthy()
    await user.keyboard('{Escape}')
    expect(spy('openAlertDiff')).toHaveBeenCalledWith(null)
  })
})

describe('a repo command approval', () => {
  const command = { id: 'c1', name: 'lint', command: 'npm run lint' }
  const item = { name: 'lint', command: 'npm run lint', source: 'shared' }
  const open = vi.fn()

  function Host() {
    const { run, dialog } = useSavedCommandRunner('w1', 'r1', open)
    return (
      <>
        <button onClick={() => run(command as never)}>Run lint</button>
        {dialog}
      </>
    )
  }

  beforeEach(() => {
    open.mockClear()
    fakeApi.savedCommandConsent = vi.fn(async () => item)
    fakeApi.approveSavedCommand = vi.fn(async () => undefined)
  })

  it('asks first in a dialog with the command and its buttons in the footer, then opens the tab on approval', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'Run lint' }))
    const dialog = await screen.findByRole('dialog', { name: 'Run a command from the repo?' })
    expect(within(dialog).getByText(/npm run lint/)).toBeTruthy()
    expect(within(footerOf(dialog)).getByRole('button', { name: 'Cancel' })).toBeTruthy()
    await user.click(within(footerOf(dialog)).getByRole('button', { name: 'Approve and run' }))
    await waitFor(() => expect(fakeApi.approveSavedCommand).toHaveBeenCalledWith('w1', 'c1', 'npm run lint'))
    await waitFor(() => expect(open).toHaveBeenCalledWith(command))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('Escape leaves without running it', async () => {
    const user = userEvent.setup()
    render(<Host />)
    await user.click(screen.getByRole('button', { name: 'Run lint' }))
    await screen.findByRole('dialog')
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(open).not.toHaveBeenCalled()
  })
})
