// @vitest-environment jsdom
// The tool approval spells out what it asks for: a command part by part, with what each does and which leave this
// computer; an edit as its diff; and, above the buttons, exactly what "always allow" adds and what it leaves out.
import './domShims'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolApprovalPanel } from '../src/renderer/src/components/ApprovalPanel'
import { AGENTS } from '../src/shared/agents'
import { fakeApi, fakeState, resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const PUSH = 'npm test -- session && git push origin fix-login-redirect'

beforeEach(() => {
  resetFake()
  fakeApi.respondApproval = vi.fn(async () => undefined)
  fakeState.snapshot.platform = 'win32'
  fakeState.snapshot.sessions = [{ id: 's1', workspaceId: 'w1', agent: 'claude' }]
  fakeState.snapshot.workspaces = [{ id: 'w1', name: 'lisbon', path: '/w' }]
  fakeState.snapshot.employees = undefined
})
afterEach(cleanup)

const show = (overrides: Record<string, unknown>) =>
  render(<ToolApprovalPanel request={{ kind: 'tool', id: 'a1', sessionId: 's1', toolName: 'Bash', input: { command: PUSH }, ...overrides } as never} workspacePath="/w" />)

const rule = () => document.querySelector('.approval-rule')?.textContent ?? ''

describe('a command, part by part', () => {
  it('counts the commands in the title and lists each with what it does', () => {
    show({})
    expect(screen.getByRole('group', { name: 'Run 2 commands?' })).toBeTruthy()
    const items = within(screen.getByRole('list', { name: 'Parts of the command' })).getAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0].textContent).toContain('npm test -- session')
    expect(items[0].textContent).toContain('Runs tests')
    expect(items[0].textContent).toContain('On this computer')
    expect(items[1].textContent).toContain('only if that succeeds')
    expect(items[1].textContent).toContain('git push origin fix-login-redirect')
    expect(items[1].textContent).toContain('Pushes to origin')
  })

  it('marks the push with ▲ and words, not colour alone', () => {
    show({})
    const items = screen.getAllByRole('listitem')
    expect(items[1].textContent).toContain('Leaves this computer')
    expect(items[1].querySelector('[data-glyph="warn"]')).toBeTruthy()
    expect(items[0].textContent).not.toContain('Leaves this computer')
    expect(items[0].querySelector('[data-glyph="warn"]')).toBeNull()
  })

  it('marks a delete as one that can’t be undone', () => {
    show({ input: { command: 'rm -rf dist && npm run build' } })
    const items = screen.getAllByRole('listitem')
    expect(items[0].textContent).toContain('Deletes files')
    expect(items[0].textContent).toContain('Can’t be undone')
  })

  it('a command Foreman doesn’t know stays one line, with no tag', () => {
    show({ input: { command: './scripts/release.sh --all' } })
    expect(screen.getByRole('group', { name: 'Run this command?' })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    expect(screen.getByText('./scripts/release.sh --all')).toBeTruthy()
  })

  it('keeps the full request behind a quiet disclosure', () => {
    show({})
    const toggle = screen.getByRole('button', { name: 'Full request' })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.approval-request')?.closest('[hidden]')).toBeTruthy()
  })
})

describe('what always-allow adds', () => {
  it('names Claude Code’s rule, and says the push isn’t covered', () => {
    show({ alternate: 'always-allow', alwaysScope: 'npm test', alwaysRules: ['npm test:*'] })
    expect(screen.getByRole('button', { name: /^Always allow npm test/ })).toBeTruthy()
    expect(rule()).toContain('Commands starting with npm test run without asking in this chat.')
    expect(rule()).toContain('git push isn’t covered and will still ask.')
    expect(rule()).not.toContain('includes')
  })

  it('warns when the rule lets a push through', () => {
    show({ alternate: 'always-allow', alwaysScope: 'npm test, git push', alwaysRules: ['npm test:*', 'git push:*'] })
    expect(rule()).toContain('Commands starting with git push run without asking in this chat.')
    expect(rule()).not.toContain('isn’t covered')
    expect(screen.getByText('That includes git push, which leaves this computer.')).toBeTruthy()
  })

  it('without a scope, says the agent remembers it and Foreman can’t see what it covers', () => {
    show({ alternate: 'always-allow' })
    expect(screen.getByRole('button', { name: /^Always allow/ })).toBeTruthy()
    expect(rule()).toBe(`${AGENTS.claude.label} remembers this answer in this chat; Foreman can’t see exactly what it covers.`)
  })

  it('names a scope that isn’t a command', () => {
    show({ toolName: 'WebFetch', input: { url: 'https://github.com/x' }, alternate: 'always-allow', alwaysScope: 'github.com' })
    expect(rule()).toContain('Always allow adds one rule: github.com goes ahead without asking in this chat.')
  })

  it('has no rule line when there is no second answer', () => {
    show({})
    expect(document.querySelector('.approval-rule')).toBeNull()
  })

  it('keeps the reason out of the buttons’ row and writes the keys out for the platform', () => {
    show({ input: { command: 'npm test -- session' }, alternate: 'always-allow', alwaysScope: 'npm test', alwaysRules: ['npm test:*'] })
    const actions = document.querySelector('.decision-foot')!
    expect(actions.querySelector('input')).toBeNull()
    expect(screen.getByRole('textbox', { name: 'Tell the agent what to do instead (optional)' }).closest('.decision-body')).toBeTruthy()
    // Named for what they do, in one order, the main one last.
    expect(within(actions as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['Don’t run Esc', 'Always allow npm test Ctrl+Enter', 'Run Enter'])
  })

  it('a command that pushes has no key to run it or always allow it, and says it leaves this computer', () => {
    show({ alternate: 'always-allow', alwaysScope: 'npm test', alwaysRules: ['npm test:*'] })
    const actions = document.querySelector('.decision-foot') as HTMLElement
    expect(within(actions).getAllByRole('button').map((b) => b.textContent?.trim())).toEqual(['Don’t run Esc', 'Always allow npm test', 'Run 2 commands'])
    expect(actions.querySelectorAll('kbd')).toHaveLength(1)
    const consequence = document.querySelector('.decision-consequence')!
    expect(consequence.textContent?.startsWith('Leaves this computer')).toBe(true)
    expect(consequence.textContent).toContain('git push origin fix-login-redirect')
    // The rule line is part of what the card says above its buttons.
    expect(consequence.querySelector('.approval-rule')).toBeTruthy()
  })

  it('in an AI employee’s run, the rule lasts for the run and never widens what it was approved for', () => {
    fakeState.snapshot.workspaces = [{ id: 'w1', name: 'lisbon', path: '/w', startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e1', runId: 'r1', taskId: 't1', title: 'Fix' } }]
    fakeState.snapshot.employees = { o1: { employees: [{ id: 'e1', name: 'Ada' }] } }
    show({ alternate: 'always-allow', alwaysScope: 'npm test', alwaysRules: ['npm test:*'] })
    expect(rule()).toContain('Commands starting with npm test run without asking for the rest of this run.')
    expect(rule()).toContain('It never widens what Ada was approved for.')
    expect(rule()).not.toContain('in this chat')
  })
})

describe('an edit', () => {
  const edit = { toolName: 'Edit', input: { file_path: '/w/src/session.ts', old_string: '  localStorage.setItem(KEY, token)', new_string: '  if (token) localStorage.setItem(KEY, token)' }, alternate: 'edits-for-session' }

  it('shows the diff, the file and where it is, not JSON', () => {
    show(edit)
    expect(screen.getByRole('group', { name: 'Make these changes?' })).toBeTruthy()
    const change = document.querySelector('.approval-change')!
    expect(change.textContent).toContain('src/session.ts')
    expect(change.textContent).toContain('In this workspace')
    expect(change.querySelector('.tool-meta')?.textContent).toBe('+1 -1')
    expect(change.querySelector('.edit-preview .del')?.textContent).toBe('-  localStorage.setItem(KEY, token)')
    expect(change.querySelector('.edit-preview .add')?.textContent).toBe('+  if (token) localStorage.setItem(KEY, token)')
    expect(within(document.querySelector('.decision-foot') as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual(['Don’t edit Esc', 'Allow all edits in this chat Ctrl+Enter', 'Make this edit Enter'])
    expect(rule()).toBe('File edits in lisbon go through without asking in this chat. Commands still ask.')
  })

  it('says when the file is outside the workspace', () => {
    show({ ...edit, input: { ...edit.input, file_path: '/etc/hosts' } })
    expect(document.querySelector('.approval-change')?.textContent).toContain('Outside this workspace')
  })

  it('shows a new file’s lines as added', () => {
    show({ toolName: 'Write', input: { file_path: '/w/notes.md', content: 'one\ntwo' } })
    expect([...document.querySelectorAll('.approval-change .edit-preview .add')].map((l) => l.textContent)).toEqual(['+one', '+two'])
  })

  it('in an employee’s run, allows edits for the run', () => {
    fakeState.snapshot.workspaces = [{ id: 'w1', name: 'lisbon', path: '/w', startedBy: { via: 'employee', orgId: 'o1', employeeId: 'e1', runId: 'r1', taskId: 't1', title: 'Fix' } }]
    show(edit)
    expect(screen.getByRole('button', { name: /^Allow all edits for this run/ })).toBeTruthy()
    expect(rule()).toContain('for the rest of this run')
    // No roster in the snapshot: the employee is named by its id.
    expect(rule()).toContain('It never widens what e1 was approved for.')
  })
})
