// G2 backlog, #3: where an approval was answered, GitLab refs in history, the phone's Recent list and
// PR glyphs, and the tray icon's pixels (Windows badge, macOS template). Pure; no Electron.
import { describe, expect, it } from 'vitest'
import { describeEvent, phoneRecent, prGlyph, transitions, type AttentionEvent, type WorkspaceLook } from '../src/shared/attention'
import { approvalDraft } from '../src/main/attention'
import { badgeBox, badgeText, drawBadge, templateBitmap } from '../src/main/trayImage'
import type { ApprovalRequest } from '../src/shared/types'

const event = (patch: Partial<AttentionEvent>): AttentionEvent => ({ id: 'e', kind: 'turn-ended', workspaceId: 'w1', topic: 't', key: 'k', firstAt: '2026-10-22T10:00:00Z', at: '2026-10-22T10:05:00Z', count: 1, ...patch })

describe('approvals record where they were answered', () => {
  const request = { id: 'a', sessionId: 's1', kind: 'tool', toolName: 'Bash', input: {} } as unknown as ApprovalRequest
  it('says window or phone, and nothing for older callers', () => {
    expect(approvalDraft(request, { kind: 'tool', allow: true }, 'w1', 'phone')).toMatchObject({ via: 'phone', allowed: true })
    expect(approvalDraft(request, { kind: 'tool', allow: false }, 'w1', 'window')).toMatchObject({ via: 'window', allowed: false })
    expect(approvalDraft(request, { kind: 'tool', allow: true }, 'w1')).not.toHaveProperty('via')
    // Where it was answered doesn't make it a different event: repeats still fold.
    expect(approvalDraft(request, { kind: 'tool', allow: true }, 'w1', 'phone').key).toBe(approvalDraft(request, { kind: 'tool', allow: true }, 'w1', 'window').key)
  })
})

describe('GitLab merge requests in history', () => {
  const look = (pr: WorkspaceLook['pr']): WorkspaceLook => ({ reasons: [], turns: {}, reports: [], pr })
  it('marks CI and merge events of a GitLab MR', () => {
    const out = transitions('w1', look({ number: 5, state: 'OPEN', checks: 'passed', gitlab: true }), look({ number: 5, state: 'OPEN', checks: 'failing', failing: 2, gitlab: true }))
    expect(out).toEqual([expect.objectContaining({ kind: 'ci-failed', gitlab: true, pr: 5 })])
    const merged = transitions('w1', look({ number: 5, state: 'OPEN' }), look({ number: 5, state: 'MERGED' }))
    expect(merged[0]).not.toHaveProperty('gitlab')
  })

  it('gives a checked-out GitLab MR its provider before any read says so', () => {
    expect(prGlyph({ prInfo: { number: 3, state: 'OPEN', url: 'u' }, pullRequest: { repo: 'a/b', number: 3, gitlabHost: 'gitlab.com' } })?.provider).toBe('gitlab')
    expect(prGlyph({ prInfo: { number: 3, state: 'OPEN', url: 'u' } })?.provider).toBe('github')
  })
})

describe('the phone’s Recent list', () => {
  it('words each event in plain English', () => {
    expect(describeEvent(event({ kind: 'ci-failed', pr: 42, detail: '2' }))).toBe('CI failed · PR #42 · 2 failing')
    expect(describeEvent(event({ kind: 'pr-merged', pr: 7, gitlab: true }))).toBe('MR !7 merged')
    expect(describeEvent(event({ kind: 'approval-answered', label: 'plan', allowed: true, via: 'phone' }))).toBe('Plan approved · on your phone')
    expect(describeEvent(event({ kind: 'approval-answered', label: 'Bash', allowed: false }))).toBe('Bash denied')
    expect(describeEvent(event({ kind: 'approval-answered', label: 'question', allowed: true, via: 'window' }))).toBe('Question answered · in the window')
    expect(describeEvent(event({ kind: 'turn-ended', outcome: 'error', tab: 2, detail: 'Fix login' }))).toBe('Turn failed · Tab 2 · Fix login')
    expect(describeEvent(event({ kind: 'reason', label: 'Needs input', detail: 'which db?' }))).toBe('Needs input · which db?')
    expect(describeEvent(event({ kind: 'agent-report', label: 'stuck', detail: 'tests hang' }))).toBe('Agent report: stuck · “tests hang”')
  })

  it('keeps the newest, drops removed workspaces, and names each one', () => {
    const events = [event({ id: 'a', workspaceId: 'w1' }), event({ id: 'b', workspaceId: 'gone' }), event({ id: 'c', workspaceId: 'w2', count: 3 })]
    const rows = phoneRecent(events, [
      { id: 'w1', name: 'lisbon' },
      { id: 'w2', name: 'oslo' }
    ])
    expect(rows.map((r) => [r.id, r.name])).toEqual([
      ['a', 'lisbon'],
      ['c', 'oslo']
    ])
    expect(rows[1].count).toBe(3)
    expect(phoneRecent(events, [{ id: 'w1', name: 'l' }, { id: 'w2', name: 'o' }], 1)).toHaveLength(1)
  })
})

/** A size×size BGRA icon of one colour. */
const solid = (size: number, bgra: [number, number, number, number]) => {
  const buf = Buffer.alloc(size * size * 4)
  for (let i = 0; i < buf.length; i += 4) buf.set(bgra, i)
  return buf
}
const px = (buf: Buffer, size: number, x: number, y: number) => [...buf.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)]

describe('the Windows tray badge', () => {
  it('says the digit, then 9+', () => {
    expect(badgeText(0)).toBe('')
    expect(badgeText(-1)).toBe('')
    expect(badgeText(3)).toBe('3')
    expect(badgeText(9)).toBe('9')
    expect(badgeText(10)).toBe('9+')
    expect(badgeText(NaN)).toBe('')
  })

  it('sits in the bottom-right corner, sized to its text and scaled for @2x', () => {
    expect(badgeBox(16, '3')).toEqual({ x: 7, y: 7, w: 9, h: 9, scale: 1 })
    expect(badgeBox(16, '9+')).toEqual({ x: 5, y: 7, w: 11, h: 9, scale: 1 })
    expect(badgeBox(32, '3')).toEqual({ x: 14, y: 14, w: 18, h: 18, scale: 2 })
  })

  it('draws red with white digits there, and leaves the rest of the icon alone', () => {
    const base = solid(16, [10, 20, 30, 255])
    const out = drawBadge(base, 16, 1)
    // The input isn't changed.
    expect(px(base, 16, 15, 15)).toEqual([10, 20, 30, 255])
    // Top-left untouched; the badge's middle row is red (B, G, R = 25, 30, d9) or white ink.
    expect(px(out, 16, 0, 0)).toEqual([10, 20, 30, 255])
    expect(px(out, 16, 3, 12)).toEqual([10, 20, 30, 255])
    expect(px(out, 16, 9, 11)).toEqual([0x25, 0x30, 0xd9, 255])
    // "1" is drawn in the 3×5 font centred in the pill: its stem is column 1 of the glyph.
    expect(px(out, 16, 11, 11)).toEqual([255, 255, 255, 255])
    // Nothing to draw for 0.
    expect(drawBadge(base, 16, 0).equals(base)).toBe(true)
    // A transparent corner still gets an opaque badge.
    expect(px(drawBadge(solid(16, [0, 0, 0, 0]), 16, 5), 16, 9, 11)[3]).toBe(255)
  })

  it('draws at 32 px too, with the font doubled', () => {
    const out = drawBadge(solid(32, [0, 0, 0, 255]), 32, 9)
    const white = []
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (px(out, 32, x, y)[0] === 255 && px(out, 32, x, y)[2] === 255) white.push([x, y])
    // "9" has 12 lit cells of 3×5; each is 2×2 at this size.
    expect(white).toHaveLength(12 * 4)
    expect(white.every(([x, y]) => x >= 14 && y >= 14)).toBe(true)
  })
})

describe('the macOS template image', () => {
  it('keeps the bright hat as black with alpha and drops the dark tile', () => {
    const size = 2
    // Hat yellow, tile near-black, transparent, half-covered yellow (premultiplied).
    const icon = Buffer.from([0x3d, 0xb8, 0xf5, 255, 0x1b, 0x1d, 0x20, 255, 0, 0, 0, 0, 0x1e, 0x5c, 0x7a, 128])
    const out = templateBitmap(icon, size, size)
    expect([...out.subarray(0, 4)]).toEqual([0, 0, 0, 255])
    expect([...out.subarray(4, 8)]).toEqual([0, 0, 0, 0])
    expect([...out.subarray(8, 12)]).toEqual([0, 0, 0, 0])
    expect(out[15]).toBe(128)
    expect([out[12], out[13], out[14]]).toEqual([0, 0, 0])
  })
})
