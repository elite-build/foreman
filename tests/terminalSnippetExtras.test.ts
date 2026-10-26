// #10 (G4): trimming a waiting block, the sent bubble's styled blocks, the chat chooser, and other views' sources.
import { describe, expect, it } from 'vitest'
import { createT } from '../src/shared/i18n'
import { chooseSnippetTarget, composeMessage, editSnippet, makeSnippet, snippetAttachmentName, snippetLabel, splitSentMessage } from '../src/shared/terminalSnippet'

const at = new Date(2026, 9, 22, 14, 6).getTime()
const snippet = (text: string, name?: string) => makeSnippet(text, name ? { kind: 'view', name } : { kind: 'terminal', n: 1 }, 'kigali', at)!

describe('trimming a waiting block', () => {
  it('takes the edited text and recounts its lines', () => {
    const s = snippet('one\ntwo\nthree\nfour')
    const trimmed = editSnippet(s, 'two\r\nthree')
    expect(trimmed).toMatchObject({ id: s.id, text: 'two\nthree', lines: 2, source: s.source })
    expect(editSnippet(s, '')).toMatchObject({ text: '', lines: 0 })
  })
})

describe('the sent message’s blocks', () => {
  it('splits what composeMessage built back into its blocks and the typed text', () => {
    const a = snippet('npm test\nFAIL src/a.test.ts')
    const b = snippet('has ``` fences ````')
    const message = composeMessage([a, b], 'why does this fail?')
    const { snippets, text } = splitSentMessage(message)
    expect(snippets).toEqual([
      { source: 'Terminal 1', workspace: 'kigali', time: '14:06', text: 'npm test\nFAIL src/a.test.ts', lines: 2 },
      { source: 'Terminal 1', workspace: 'kigali', time: '14:06', text: 'has ``` fences ````', lines: 1 }
    ])
    expect(text).toBe('why does this fail?')
  })

  it('a block on its own leaves no text', () => {
    expect(splitSentMessage(composeMessage([snippet('ls')], ''))).toEqual({ snippets: [{ source: 'Terminal 1', workspace: 'kigali', time: '14:06', text: 'ls', lines: 1 }], text: '' })
  })

  it('anything else stays plain text, including a look-alike that isn’t first or isn’t closed', () => {
    expect(splitSentMessage('hello')).toEqual({ snippets: [], text: 'hello' })
    const later = 'see below\n\nFrom Terminal 1 (kigali), 14:06:\n```text\nx\n```'
    expect(splitSentMessage(later)).toEqual({ snippets: [], text: later })
    const open = 'From Terminal 1 (kigali), 14:06:\n```text\nnever closed'
    expect(splitSentMessage(open)).toEqual({ snippets: [], text: open })
  })

  it('the bubble’s label reuses the composer’s wording', () => {
    const { snippets } = splitSentMessage(composeMessage([snippet('a\nb')], 'x'))
    expect(createT('en')('terminalChat.label', { source: snippets[0].source, workspace: snippets[0].workspace, time: snippets[0].time, count: snippets[0].lines })).toBe('From Terminal 1 · kigali · 14:06 · 2 lines')
  })
})

describe('the chat chooser', () => {
  it('goes to the chat picked last while it’s open, else the active one, else the first', () => {
    expect(chooseSnippetTarget(['a', 'b', 'c'], 'c', 'a')).toBe('c')
    expect(chooseSnippetTarget(['a', 'b'], 'gone', 'b')).toBe('b')
    expect(chooseSnippetTarget(['a', 'b'], undefined, undefined)).toBe('a')
    expect(chooseSnippetTarget([], 'c', 'a')).toBeUndefined()
  })

  it('has Spanish strings', () => {
    expect(createT('es')('terminalChat.sendTo')).toBe('Enviar a un chat')
    expect(createT('es')('terminalChat.sendToTitle', { key: 'Ctrl+L' })).toContain('Ctrl+L')
  })
})

describe('other terminal views', () => {
  it('name their output in the label and attachment name', () => {
    const s = snippet('sign-in failed', 'MCP sign-in')
    expect(composeMessage([s], '')).toMatch(/^From MCP sign-in \(kigali\), 14:06:/)
    expect(snippetLabel(s, createT('en'))).toBe('From MCP sign-in · kigali · 14:06 · 1 line')
    expect(snippetAttachmentName(s.source, new Set())).toBe('MCP sign-in output.txt')
  })
})
