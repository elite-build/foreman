import { describe, expect, it } from 'vitest'
import { fileName, LARGE_TEXT_SCREENS, planShots, type Shot } from '../src/main/screensPlan'

const base: Shot[] = [
  { screen: 'home', theme: 'light' },
  { screen: 'assistant', theme: 'light' },
  { screen: 'home', theme: 'light', zoom: 2 }
]

describe('screens plan', () => {
  it('leaves the usual run alone without the flag', () => {
    expect(planShots(base)).toEqual(base)
    expect(planShots(base, { only: ['home'] })).toEqual([base[0], base[2]])
  })

  it('adds both large-text variants for the four screens, in both themes, with --large-text', () => {
    const shots = planShots(base, { largeText: true })
    const large = shots.filter((s) => s.variant)
    expect(shots.slice(0, base.length)).toEqual(base)
    expect(large).toHaveLength(2 * 2 * LARGE_TEXT_SCREENS.length)
    expect(LARGE_TEXT_SCREENS).toEqual(['home', 'workspace-chat', 'file-diff', 'settings-accessibility'])
    expect(large.filter((s) => s.variant === 'zoom200').every((s) => s.zoom === 2)).toBe(true)
    expect(large.filter((s) => s.variant === 'content24').every((s) => s.zoom === undefined)).toBe(true)
  })

  it('takes a variant named in --only without the flag', () => {
    expect(planShots(base, { only: ['content24'] }).every((s) => s.variant === 'content24')).toBe(true)
    const one = planShots(base, { only: ['zoom200-home'] })
    expect(one.map((s) => [s.variant, s.screen, s.theme])).toEqual([['zoom200', 'home', 'light'], ['zoom200', 'home', 'dark']])
  })

  it('keeps a variant shot when --large-text and --only name the screen', () => {
    const shots = planShots(base, { largeText: true, only: ['home'] })
    expect(shots.filter((s) => s.variant === 'zoom200' && s.screen === 'home')).toHaveLength(2)
    expect(shots.some((s) => s.screen === 'assistant')).toBe(false)
  })

  it('names files so a variant never collides with the usual shots', () => {
    expect(fileName({ screen: 'home', theme: 'dark', zoom: 2 })).toBe('home-dark-z200.png')
    expect(fileName({ screen: 'home', theme: 'dark', zoom: 2, variant: 'zoom200' })).toBe('zoom200-home-dark.png')
    expect(fileName({ screen: 'file-diff', theme: 'light', variant: 'content24' }, 1)).toBe('content24-file-diff-light-p2.png')
    expect(fileName({ screen: 'home', theme: 'light', vision: 'red-green' })).toBe('home-light-red-green.png')
  })
})
