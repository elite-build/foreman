// #16 (G4): the fork notice main writes into a fork's chat is in the app's language.
import { describe, expect, it } from 'vitest'
import { forkNoticeText } from '../src/shared/fork'
import { createT } from '../src/shared/i18n'

const en = createT('en')
const es = createT('es')

describe('fork notice text', () => {
  it('English keeps the wording the fork tests rely on', () => {
    expect(forkNoticeText(en, { native: true, sourceTitle: 'chat', agent: 'Claude Code' })).toBe(
      'Forked from “chat”. This chat continues the same conversation from here; files are shared with the other tabs in this worktree.'
    )
    expect(forkNoticeText(en, { native: false, agent: 'Codex' })).toBe(
      'Forked from another chat. Your next message starts a new Codex conversation and carries the history above as context. Files are shared with the other tabs in this worktree.'
    )
  })

  it('Edit and resend quotes the message, cut to one line, and says its changes are still in the files', () => {
    const text = forkNoticeText(en, { native: false, sourceTitle: 'chat', before: 'two\nlines', agent: 'Codex' })
    expect(text).toContain('before your message “two lines”')
    expect(text).toContain('Files are shared with the other tabs in this worktree, so anything that message changed is still in the files.')
    expect(forkNoticeText(en, { native: true, before: 'x', agent: 'Claude Code' })).toContain('anything that message changed is still in the files')
  })

  it('Spanish translates every variant', () => {
    expect(forkNoticeText(es, { native: true, sourceTitle: 'chat', agent: 'Claude Code' })).toBe(
      'Bifurcado de «chat». Este chat continúa la misma conversación desde aquí; los archivos se comparten con las demás pestañas de este worktree.'
    )
    const before = forkNoticeText(es, { native: false, before: 'dos', agent: 'Codex' })
    expect(before).toContain('antes de tu mensaje «dos»')
    expect(before).toContain('conversación nueva con Codex')
    expect(before).not.toMatch(/Forked|Files/)
  })
})
