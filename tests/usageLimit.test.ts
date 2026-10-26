import { describe, expect, it } from 'vitest'
import { clockTime, dayOf, looksLikeUsageLimit, parseResetTime, usageLimitOf } from '../src/shared/usageLimit'

// 2026-10-22 11:52 in London (BST, UTC+1), a Thursday.
const NOW = Date.parse('2026-10-22T10:52:00Z')
const iso = (ms: number | undefined) => (ms === undefined ? undefined : new Date(ms).toISOString())
const at = (text: string, now = NOW, local = 'Europe/London') => iso(parseResetTime(text, now, local)?.at)

describe('telling a usage limit from other errors', () => {
  it.each([
    'Claude AI usage limit reached|1792677600',
    'Claude usage limit reached. Your limit will reset at 2pm (America/New_York).',
    '5-hour limit reached ∙ resets 2:30pm (Europe/London)',
    'You’ve hit your limit · resets 2:30pm (Europe/London)',
    "You've hit your Opus limit · resets 3am (Asia/Tokyo)",
    'Weekly limit reached ∙ resets Oct 27, 9am (Europe/London) · /upgrade to Max',
    'Session limit reached ∙ resets 7pm',
    'You’ve reached your usage limit. Your limit resets at 2:30 PM (Europe/London).',
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your rate limit."}}',
    'You\'ve hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 13 minutes.',
    'stream error: exceeded retry limit, last status: 429 Too Many Requests',
    'Spending cap reached resets 5pm'
  ])('%s', (text) => expect(looksLikeUsageLimit(text)).toBe(true))

  it.each([
    'Prompt is too long',
    'Context limit reached · /compact or /clear to continue',
    'Reached maximum number of turns (20)',
    'Reached maximum budget ($5)',
    'API Error: 500 Internal server error',
    'Invalid API key · Please run /login',
    'spawn claude ENOENT',
    '',
    undefined
  ])('not %s', (text) => expect(looksLikeUsageLimit(text)).toBe(false))
})

describe('reading the reset time', () => {
  it('reads a time with its zone, as the next time that clock shows it', () => {
    expect(at('5-hour limit reached ∙ resets 2:30pm (Europe/London)')).toBe('2026-10-22T13:30:00.000Z')
    expect(parseResetTime('You’ve hit your limit · resets 2:30pm (Europe/London)', NOW, 'UTC')).toEqual({
      at: Date.parse('2026-10-22T13:30:00Z'),
      source: 'resets 2:30pm (Europe/London)',
      timeZone: 'Europe/London'
    })
  })

  it('takes the zone the error names, not this computer’s', () => {
    expect(at('Your limit will reset at 2pm (America/New_York).', NOW, 'Asia/Tokyo')).toBe('2026-10-22T18:00:00.000Z')
    // 3am in Tokyo has already passed today there (it is 19:52), so it is tomorrow's.
    expect(at("You've hit your Opus limit · resets 3am (Asia/Tokyo)")).toBe('2026-10-22T18:00:00.000Z')
    expect(at('resets 10:00pm (Australia/Sydney)')).toBe('2026-10-22T11:00:00.000Z')
    expect(at('resets 4pm (America/Argentina/Buenos_Aires)')).toBe('2026-10-22T19:00:00.000Z')
    expect(at('resets 6pm UTC')).toBe('2026-10-22T18:00:00.000Z')
    expect(at('resets 6pm (GMT)')).toBe('2026-10-22T18:00:00.000Z')
  })

  it('reads a time with no zone in this computer’s zone, and says it named none', () => {
    const read = parseResetTime('Session limit reached ∙ resets 7pm', NOW, 'America/Los_Angeles')
    // It is 03:52 in Los Angeles: 7pm PDT today.
    expect(iso(read?.at)).toBe('2026-10-23T02:00:00.000Z')
    expect(read?.timeZone).toBeUndefined()
    expect(read?.source).toBe('resets 7pm')
  })

  it('reads 12- and 24-hour clocks, with and without minutes and spaces', () => {
    expect(at('resets 2:30 PM (Europe/London)')).toBe('2026-10-22T13:30:00.000Z')
    expect(at('resets 2:30 p.m. (Europe/London)')).toBe('2026-10-22T13:30:00.000Z')
    expect(at('Usage limit reached. Resets at 14:30 (Europe/London).')).toBe('2026-10-22T13:30:00.000Z')
    expect(at('resets 12pm (Europe/London)')).toBe('2026-10-22T11:00:00.000Z')
    // Midnight: the coming one.
    expect(at('resets 12am (Europe/London)')).toBe('2026-10-22T23:00:00.000Z')
    expect(at('resets 00:15 (Europe/London)')).toBe('2026-10-22T23:15:00.000Z')
  })

  it('rolls a time already past today to tomorrow', () => {
    expect(at('resets 9am (Europe/London)')).toBe('2026-10-23T08:00:00.000Z')
    expect(at('resets 11:52am (Europe/London)')).toBe('2026-10-23T10:52:00.000Z')
    expect(at('resets 11:53am (Europe/London)')).toBe('2026-10-22T10:53:00.000Z')
  })

  it('reads dates, weekdays and tomorrow for weekly limits', () => {
    expect(at('Weekly limit reached ∙ resets Oct 27, 9am (Europe/London)')).toBe('2026-10-27T09:00:00.000Z')
    expect(at('resets 27 Oct at 09:00 (Europe/London)')).toBe('2026-10-27T09:00:00.000Z')
    expect(at('resets October 27th, 2026, 9am (Europe/London)')).toBe('2026-10-27T09:00:00.000Z')
    expect(at('Opus weekly limit reached ∙ resets Mon 9am (Europe/London)')).toBe('2026-10-26T09:00:00.000Z')
    expect(at('resets Thursday at 9am (Europe/London)')).toBe('2026-10-29T09:00:00.000Z')
    expect(at('resets Thu 1pm (Europe/London)')).toBe('2026-10-22T12:00:00.000Z')
    expect(at('resets tomorrow at 2pm (Europe/London)')).toBe('2026-10-23T13:00:00.000Z')
    expect(at('resets Thu 23 Oct 9am (Europe/London)')).toBe('2026-10-23T08:00:00.000Z')
  })

  it('reads a date early next year in late December as next year’s', () => {
    const dec = Date.parse('2026-12-30T12:00:00Z')
    expect(at('resets Jan 2, 9am (Europe/London)', dec)).toBe('2027-01-02T09:00:00.000Z')
  })

  it('reads timestamps: ISO with an offset, and Claude Code’s older epoch form', () => {
    expect(at('Your limit resets at 2026-10-22T14:30:00+01:00.')).toBe('2026-10-22T13:30:00.000Z')
    expect(at('resets 2026-10-22T13:30:00Z')).toBe('2026-10-22T13:30:00.000Z')
    expect(parseResetTime('Claude AI usage limit reached|1792677600', NOW, 'UTC')).toEqual({
      at: 1792677600_000,
      source: 'usage limit reached|1792677600',
      timeZone: 'UTC'
    })
  })

  describe('around clock changes', () => {
    it('takes the later of a time that happens twice, so it never goes early', () => {
      // London's clocks go back at 02:00 BST on Sunday 25 October 2026: 01:30 happens at 00:30Z and 01:30Z.
      const sat = Date.parse('2026-10-24T22:00:00Z')
      expect(at('resets 1:30am (Europe/London)', sat)).toBe('2026-10-25T01:30:00.000Z')
      // New York goes back on 1 November 2026.
      const ny = Date.parse('2026-11-01T04:00:00Z')
      expect(at('resets 1:30am (America/New_York)', ny)).toBe('2026-11-01T06:30:00.000Z')
    })

    it('puts a time that doesn’t exist just after the gap', () => {
      // London skips 01:00–02:00 GMT on 29 March 2026.
      const sat = Date.parse('2026-03-28T23:00:00Z')
      expect(at('resets 1:30am (Europe/London)', sat)).toBe('2026-03-29T01:30:00.000Z')
    })

    it('rolls to tomorrow on the zone’s calendar, not by 24 hours', () => {
      // Saturday 24 Oct 18:00 BST; 9am is past, and tomorrow (Sunday) is on GMT.
      const sat = Date.parse('2026-10-24T17:00:00Z')
      expect(at('resets 9am (Europe/London)', sat)).toBe('2026-10-25T09:00:00.000Z')
    })
  })

  describe('says unknown rather than guessing', () => {
    it.each([
      'You’ve hit your usage limit. Try again later.',
      'API Error: 429 rate_limit_error',
      'resets soon',
      'resets 3',
      'resets in 2 hours',
      'resets 25:00 (Europe/London)',
      'resets 13pm (Europe/London)',
      'resets 2:75pm (Europe/London)',
      'resets 2pm (PDT)',
      'resets 2pm (Mars/Olympus_Mons)',
      'resets 2pm (see /usage)',
      'resets Feb 30, 9am (Europe/London)',
      // Two months out is a misreading, not a plan limit.
      'resets Dec 25, 9am (Europe/London)',
      'resets 2026-10-01T09:00:00Z',
      'Claude AI usage limit reached|1600000000',
      '',
      undefined
    ])('%s', (text) => expect(parseResetTime(text, NOW, 'Europe/London')).toBeNull())
  })
})

describe('what a failed turn says about a limit', () => {
  it('gives Claude a reset time and its source', () => {
    expect(usageLimitOf('claude', '5-hour limit reached ∙ resets 2:30pm (Europe/London)', NOW, 'UTC')).toEqual({
      resetAt: '2026-10-22T13:30:00.000Z',
      source: 'resets 2:30pm (Europe/London)',
      timeZone: 'Europe/London'
    })
  })

  it('is unknown when Claude’s error names no time', () => {
    expect(usageLimitOf('claude', 'You’ve hit your usage limit. Try again later.', NOW, 'UTC')).toEqual({})
  })

  it('is unknown for Codex and the others, whatever the words say', () => {
    expect(usageLimitOf('codex', "You've hit your usage limit. Try again later.", NOW, 'UTC')).toEqual({})
    expect(usageLimitOf('codex', 'usage limit · resets 2:30pm (Europe/London)', NOW, 'UTC')).toEqual({})
    expect(usageLimitOf('opencode', 'Rate limit reached', NOW, 'UTC')).toEqual({})
  })

  it('is nothing for an error that isn’t a limit, unless the adapter detected one', () => {
    expect(usageLimitOf('claude', 'Prompt is too long', NOW, 'UTC')).toBeUndefined()
    expect(usageLimitOf('claude', 'Something odd', NOW, 'UTC', true)).toEqual({})
  })
})

describe('showing the time', () => {
  it('uses a 24-hour local clock and names the day', () => {
    expect(clockTime(Date.parse('2026-10-22T13:30:00Z'), 'en', 'Europe/London')).toBe('14:30')
    expect(dayOf(Date.parse('2026-10-22T13:30:00Z'), NOW, 'en', 'Europe/London')).toBe('today')
    expect(dayOf(Date.parse('2026-10-23T08:00:00Z'), NOW, 'en', 'Europe/London')).toBe('tomorrow')
    expect(dayOf(Date.parse('2026-10-27T09:00:00Z'), NOW, 'en', 'Europe/London')).toMatch(/Tue/)
  })
})
