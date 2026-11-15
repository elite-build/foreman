// @vitest-environment jsdom
// A Grep or Glob row says how much it found. A search that found nothing says 0, not "1 match" for Claude Code's
// "No matches found" line, and the headers and notes Claude Code adds around real results aren't counted as results.
import './domShims'
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ToolRow } from '../src/renderer/src/components/ToolRow'
import { resetFake } from './rendererStore'

vi.mock('../src/renderer/src/store', async () => (await import('./rendererStore')).storeModule)

const item = (name: 'Grep' | 'Glob', output: string) => ({ kind: 'tool', id: 't1', turnId: 'u1', name, input: { pattern: 'returnTo' }, status: 'done', output }) as never

function said(name: 'Grep' | 'Glob', output: string): string {
  const { container } = render(<ToolRow item={item(name, output)} workspacePath="/w" files={null} expandByDefault={false} />)
  return container.textContent ?? ''
}

beforeEach(resetFake)
afterEach(cleanup)

describe('a Grep row', () => {
  it.each([
    ['Claude Code’s content mode, nothing found', 'No matches found', '0 matches'],
    ['Claude Code’s file list, nothing found', 'No files found', '0 matches'],
    ['an empty output', '', '0 matches'],
    ['content lines', 'src/a.ts:3:returnTo\nsrc/b.ts:9:returnTo\n', '2 matches'],
    ['one content line', 'src/a.ts:3:returnTo', '1 match'],
    ['Claude Code’s file list, under its header', 'Found 2 files\nsrc/a.ts\nsrc/b.ts', '2 matches'],
    ['Claude Code’s count mode, with its total', 'src/a.ts:3\nsrc/b.ts:4\n\nFound 7 total occurrences across 2 files.', '7 matches'],
    ['content with a paging note', 'src/a.ts:3:returnTo\n\n[Showing results with pagination = limit: 1, offset: 0]', '1 match'],
    ['output Foreman cut short', 'src/a.ts:3:returnTo\nsrc/b.ts:9:returnTo\n… (truncated)', '2 matches']
  ])('%s', (_name, output, expected) => {
    expect(said('Grep', output)).toContain(expected)
  })
})

describe('a Glob row', () => {
  it.each([
    ['nothing found', 'No files found', '0 files'],
    ['files', 'src/a.ts\nsrc/b.ts\nsrc/c.ts', '3 files'],
    ['a truncated list', 'src/a.ts\nsrc/b.ts\n(Results are truncated. Consider using a more specific path or pattern.)', '2 files']
  ])('%s', (_name, output, expected) => {
    expect(said('Glob', output)).toContain(expected)
  })
})
