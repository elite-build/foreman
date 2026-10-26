import { describe, expect, it } from 'vitest'
import { chatToMarkdown } from '../src/shared/transcript'
import type { ChatItem } from '../src/shared/types'

const items: ChatItem[] = [
  { kind: 'user', id: 'u1', turnId: 't1', text: 'Fix the bug', at: '', attachments: [{ name: 'shot.png', path: '/ws/.context/attachments/shot.png', kind: 'image' }] },
  { kind: 'thinking', id: 'k1', turnId: 't1', text: 'secret reasoning' },
  { kind: 'assistant', id: 'a1', turnId: 't1', text: 'Looking.' },
  { kind: 'tool', id: 'x1', turnId: 't1', name: 'Bash', input: { command: 'cat .env\nmore' }, status: 'done', output: 'KEY=1\n```\nfence\n```\n' },
  { kind: 'assistant', id: 'a2', turnId: 't1', text: 'Done.' },
  { kind: 'result', id: 'r1', turnId: 't1', ok: true },
  { kind: 'turn-end', id: 'e1', turnId: 't1', outcome: 'completed' },
  { kind: 'user', id: 'u2', turnId: 't2', text: 'Thanks', at: '', steered: true }
]

describe('chat transcript', () => {
  it('messages only: no tools, thinking or attachment contents; names only', () => {
    const md = chatToMarkdown(items, { toolOutput: false })
    expect(md).toBe(
      ['## You', 'Fix the bug\n\n_Attachments: shot.png_', '## Assistant', 'Looking.', 'Done.', '## You (sent while the agent worked)', 'Thanks'].join('\n\n') + '\n'
    )
    expect(md).not.toContain('secret reasoning')
    expect(md).not.toContain('KEY=1')
    expect(md).not.toContain('/ws/.context')
  })

  it('with tool output: includes calls in order and fences safely', () => {
    const md = chatToMarkdown(items, { toolOutput: true })
    expect(md).toContain('**Tool: Bash** `cat .env`')
    expect(md).toContain('````\nKEY=1\n```\nfence\n```\n````')
    expect(md.indexOf('Looking.')).toBeLessThan(md.indexOf('Tool: Bash'))
    expect(md.indexOf('Tool: Bash')).toBeLessThan(md.indexOf('Done.'))
    expect(md).not.toContain('secret reasoning')
  })

  it('is empty for an empty chat', () => {
    expect(chatToMarkdown([], { toolOutput: true })).toBe('')
  })
})

describe('answer for Start workspace with this answer', () => {
  it('joins one turn\'s assistant text, without tools, thinking or other turns', async () => {
    const { turnAnswer } = await import('../src/shared/handOff')
    const chat: ChatItem[] = [
      { kind: 'assistant', id: 'a', turnId: 't1', text: 'Earlier.' },
      { kind: 'assistant', id: 'b', turnId: 't2', text: 'Plan:' },
      { kind: 'thinking', id: 'k', turnId: 't2', text: 'hmm' },
      { kind: 'tool', id: 'x', turnId: 't2', name: 'Bash', input: {}, status: 'done', output: 'out' },
      { kind: 'assistant', id: 'c', turnId: 't2', text: ' 1. do it ' },
      { kind: 'assistant', id: 'd', turnId: 't2', text: 'typing', streaming: true }
    ]
    expect(turnAnswer(chat, 't2')).toBe('Plan:\n\n1. do it')
    expect(turnAnswer(chat, 'none')).toBe('')
  })
})
