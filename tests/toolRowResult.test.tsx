// @vitest-environment jsdom
// A tool row says how its call ended in a shape and a word, never only a red icon: a command "● Passed · exit 0" or
// "◆ Failed · exit 1", any other failed call "◆ Failed". An AI employee's run's own tools read by plain name, and a call that
// asked the person or had an outward action held for them says so ("▲ Asked you", "▲ Held for you").
import './domShims'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { exitCodeOf, toolResult, ToolRow } from '../src/renderer/src/components/ToolRow'
import { resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

type Over = { name?: string; input?: Record<string, unknown>; status?: 'running' | 'done' | 'error'; output?: string; exitCode?: number; task?: unknown }
const tool = (over: Over = {}) => ({ kind: 'tool', id: 'x1', turnId: 't1', name: 'Bash', input: { command: 'npm test -- session', description: 'Run the session tests' }, status: 'done', output: 'ok', ...over }) as never

function row(over: Over = {}) {
  const { container } = render(<ToolRow item={tool(over)} workspacePath="/w" files={null} expandByDefault={false} />)
  return { text: container.textContent ?? '', status: container.querySelector('.ui-status'), container }
}

beforeEach(resetFake)
afterEach(cleanup)

describe('a command row', () => {
  it('ends with ● Passed and the exit code the agent reported', () => {
    const { text, status } = row({ exitCode: 0 })
    expect(text).toContain('Run the session tests')
    expect(text).toContain('Passed · exit 0')
    expect(status?.classList.contains('ui-status--ok')).toBe(true)
  })

  it('ends with ◆ Failed and the exit code from Claude Code’s "Exit code N" line', () => {
    const { text, status } = row({ status: 'error', output: 'Exit code 1\n× resets the window after a minute' })
    expect(text).toContain('Failed · exit 1')
    expect(status?.classList.contains('ui-status--error')).toBe(true)
  })

  it('reads the code Cursor puts on the last line, and says Passed without a code when there is none', () => {
    expect(exitCodeOf(tool({ status: 'error', output: 'boom\nExit code 2' }))).toBe(2)
    expect(exitCodeOf(tool({ output: 'all good' }))).toBeUndefined()
    expect(row({ output: 'all good' }).text).toMatch(/Passed$/)
  })

  it('says nothing while it runs', () => {
    expect(row({ status: 'running', output: undefined }).status).toBeNull()
  })
})

describe('other rows', () => {
  it('a failed call of any kind says Failed in words', () => {
    const { text, status } = row({ name: 'WebFetch', input: { url: 'https://example.com' }, status: 'error', output: 'timed out' })
    expect(text).toContain('Failed')
    expect(status?.classList.contains('ui-status--error')).toBe(true)
  })

  it('a read or a search that worked adds nothing', () => {
    expect(toolResult(tool({ name: 'Grep', input: { pattern: 'x' } }))).toBeNull()
    expect(row({ name: 'WebSearch', input: { query: 'x' } }).status).toBeNull()
  })

  it('a subagent’s row leaves its ending to its task', () => {
    expect(toolResult(tool({ name: 'Task', status: 'error', task: { status: 'failed' } }))).toBeNull()
  })

  it('a Glob that found one file says "1 file"', () => {
    expect(row({ name: 'Glob', input: { pattern: '*.ts' }, output: 'src/a.ts' }).text).toContain('1 file')
    expect(row({ name: 'Glob', input: { pattern: '*.ts' }, output: 'src/a.ts' }).text).not.toContain('1 files')
  })
})

describe('an AI employee’s run', () => {
  it('asking the person reads "Ask you" and ends with ▲ Asked you', () => {
    const { text, status } = row({ name: 'mcp__foreman-app__ask_person', input: { question: 'Which region should it deploy to?' }, output: 'Asked. Your task now waits for the person’s answer…' })
    expect(text).toContain('Ask you')
    expect(text).toContain('Which region should it deploy to?')
    expect(text).toContain('Asked you')
    expect(text).not.toContain('ask_person')
    expect(status?.classList.contains('ui-status--warn')).toBe(true)
  })

  it('a push held for approval reads "Push the branch" and ends with ▲ Held for you', () => {
    const { text, status } = row({ name: 'mcp__foreman-app__request_push', input: {}, output: 'Held for the person: a push of fix-login is recorded (action a1)…' })
    expect(text).toContain('Push the branch')
    expect(text).toContain('Held for you')
    expect(text).not.toContain('request_push')
    expect(text).not.toContain('foreman-app')
    expect(status?.classList.contains('ui-status--warn')).toBe(true)
    // Asked again, the broker answers with the action's state.
    expect(toolResult(tool({ name: 'mcp__foreman-app__request_push', output: 'Already recorded as action a1 in this run: it is held for the person’s approval. Nothing new was made.' }))?.word).toBe('held')
  })

  it('a pull request that was sent says nothing more than its name and title', () => {
    const { text, status } = row({ name: 'mcp__foreman-app__request_pull_request', input: { title: 'Fix the login redirect', body: '' }, output: 'Sent: a pull request (https://x/1). Recorded as action a2.' })
    expect(text).toContain('Open a pull request')
    expect(text).toContain('Fix the login redirect')
    expect(status).toBeNull()
  })

  it('any other of Foreman’s own tools names Foreman as its server', () => {
    expect(row({ name: 'mcp__foreman-app__memory_search', input: { query: 'x' }, output: '' }).text).toContain('Foreman')
  })
})
