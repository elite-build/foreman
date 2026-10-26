// The welcome tour: which steps run, where the card goes, and who sees it on launch.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeCard, TOUR_STEPS, tourStartsOnLaunch, tourSteps } from '../src/shared/tour'
import { defaultSettings, Store } from '../src/main/store'
import { tempDir } from './helpers'

const VIEW = { width: 1280, height: 800 }
const CARD = { width: 320, height: 180 }

describe('tour steps', () => {
  it('opens on a welcome card and ends on the way back to it', () => {
    const ids = TOUR_STEPS.map((s) => s.id)
    expect(ids[0]).toBe('welcome')
    expect(TOUR_STEPS[0].target).toBeUndefined()
    expect(ids.at(-1)).toBe('help')
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('covers the basics and the main features, in order', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual(['welcome', 'addRepo', 'newWorkspace', 'needsYou', 'layout', 'automations', 'assistant', 'settings', 'help'])
    expect(TOUR_STEPS.map((s) => s.target).filter(Boolean)).toEqual(['add-repo', 'new-workspace', 'needs-you', 'automations', 'assistant', 'settings', 'help'])
  })

  it('no longer teaches the composer, the Git panel or the phone', () => {
    const ids = TOUR_STEPS.map((s) => s.id)
    for (const gone of ['composer', 'git', 'phone']) expect(ids).not.toContain(gone)
  })

  it('has a button where there is something to do, and a centered card for the layout (no stable control)', () => {
    expect(TOUR_STEPS.filter((s) => s.action).map((s) => [s.id, s.action])).toEqual([
      ['needsYou', 'filterNeedsYou'],
      ['layout', 'switchLayout'],
      ['automations', 'openAutomations'],
      ['assistant', 'openAssistant'],
      ['settings', 'openAccessibility']
    ])
    expect(TOUR_STEPS.find((s) => s.id === 'layout')!.target).toBeUndefined()
  })

  it('leaves the assistant out when it is turned off, and keeps steps whose control is elsewhere', () => {
    const all = tourSteps(() => true).map((s) => s.id)
    expect(all).toContain('assistant')
    // Nothing on screen (no workspace, sidebar hidden): only the optional step goes; the rest say where to look.
    const none = tourSteps(() => false).map((s) => s.id)
    expect(none).not.toContain('assistant')
    expect(none).toEqual(all.filter((id) => id !== 'assistant'))
  })

  it('opens by itself only until it has been seen', () => {
    expect(tourStartsOnLaunch({ tourSeen: false })).toBe(true)
    expect(tourStartsOnLaunch({ tourSeen: true })).toBe(false)
  })
})

describe('tour card placement', () => {
  it('is centered without a target', () => {
    expect(placeCard(null, CARD, VIEW)).toEqual({ left: 480, top: 310, side: 'center', arrow: 0 })
  })

  it('goes to the right of a control in the left sidebar, its arrow on the control', () => {
    const target = { left: 10, top: 300, width: 32, height: 32 }
    const p = placeCard(target, CARD, VIEW)
    expect(p.side).toBe('right')
    expect(p.left).toBe(10 + 32 + 14)
    // Centered on the control, so the arrow is in the middle of the card's edge.
    expect(p.top + p.arrow).toBe(316)
  })

  it('flips to the left when the sidebar is on the right', () => {
    const target = { left: 1230, top: 300, width: 40, height: 32 }
    const p = placeCard(target, CARD, VIEW)
    expect(p.side).toBe('left')
    expect(p.left + CARD.width).toBe(1230 - 14)
  })

  it('goes above a wide control at the bottom, like the composer', () => {
    const target = { left: 300, top: 680, width: 960, height: 100 }
    const p = placeCard(target, CARD, VIEW)
    expect(p.side).toBe('above')
    expect(p.top + CARD.height).toBe(680 - 14)
    expect(p.left).toBe(Math.round(300 + 480 - 160))
  })

  it('stays inside the window near its top and keeps the arrow on the card', () => {
    // The phone pill, in the title bar.
    const target = { left: 120, top: 8, width: 110, height: 24 }
    const p = placeCard(target, CARD, VIEW)
    expect(p.side).toBe('right')
    expect(p.top).toBe(8)
    expect(p.arrow).toBeGreaterThanOrEqual(18)
    expect(p.arrow).toBeLessThanOrEqual(CARD.height - 18)
  })

  it('still lands inside a window too small for any side', () => {
    const small = { width: 360, height: 220 }
    const p = placeCard({ left: 100, top: 60, width: 160, height: 100 }, CARD, small)
    expect(p.left).toBeGreaterThanOrEqual(8)
    expect(p.left + CARD.width).toBeLessThanOrEqual(small.width - 8)
    expect(p.top).toBeGreaterThanOrEqual(8)
  })
})

describe('tour on launch', () => {
  it('a new install has not seen it', async () => {
    expect(defaultSettings().tourSeen).toBe(false)
    const dir = await tempDir('foreman-tour-')
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.tourSeen).toBe(false)
    store.close()
  })

  it('someone upgrading with repositories already added does not get it popping up', async () => {
    const dir = await tempDir('foreman-tour-')
    const { tourSeen: _, ...older } = defaultSettings()
    const repo = { id: 'r1', name: 'foreman', rootPath: dir, defaultBranch: 'main', remote: 'origin', hasOrigin: true, local: {}, createdAt: new Date().toISOString() }
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos: [repo], settings: older }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.tourSeen).toBe(true)
    store.close()
  })

  it('someone upgrading before adding anything still gets it, and finishing it sticks', async () => {
    const dir = await tempDir('foreman-tour-')
    const { tourSeen: _, ...older } = defaultSettings()
    await writeFile(path.join(dir, 'state.json'), JSON.stringify({ version: 2, repos: [], settings: older }))
    const store = new Store(dir)
    await store.load()
    expect(store.state.settings.tourSeen).toBe(false)
    store.state.settings.tourSeen = true
    store.flush()
    store.close()
    const again = new Store(dir)
    await again.load()
    expect(again.state.settings.tourSeen).toBe(true)
    again.close()
  })
})
