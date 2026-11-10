// The tray's native menu is built again only when what it shows changed (each attention pass draws it).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppTray } from '../src/main/tray'
import type { TFunction } from '../src/shared/i18n'
import type { TrayView } from '../src/shared/attention'

const fake = vi.hoisted(() => ({ trays: [] as Record<string, ReturnType<typeof vi.fn>>[], buildFromTemplate: vi.fn((template: unknown) => ({ template })) }))

vi.mock('electron', () => ({
  app: { getAppPath: () => '/nowhere' },
  Menu: { buildFromTemplate: fake.buildFromTemplate },
  nativeImage: { createEmpty: () => ({}) },
  Tray: class {
    constructor() {
      const tray = { on: vi.fn(), setContextMenu: vi.fn(), setImage: vi.fn(), setToolTip: vi.fn(), setTitle: vi.fn(), destroy: vi.fn() }
      fake.trays.push(tray)
      return tray
    }
  }
}))

const t = ((key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key)) as unknown as TFunction
const empty: TrayView = { count: 0, attention: [], working: [] }
const waiting: TrayView = { count: 1, oldestSince: new Date().toISOString(), attention: [{ workspaceId: 'w1', sessionId: 's1', name: 'kyoto', label: 'Approve Bash', since: new Date().toISOString() }], working: [] }

afterEach(() => {
  fake.trays.length = 0
  fake.buildFromTemplate.mockClear()
})

describe('AppTray', () => {
  it('builds the menu again only when its rows, count or words changed', () => {
    const tray = new AppTray({ act: () => {}, show: () => {} })
    tray.update(empty, { attention: true, phone: false, keep: false, t })
    tray.update({ ...empty }, { attention: true, phone: false, keep: false, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(fake.trays[0].setContextMenu).toHaveBeenCalledTimes(1)
    tray.update(waiting, { attention: true, phone: false, keep: false, t })
    tray.update(waiting, { attention: true, phone: false, keep: false, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(2)
    expect(fake.trays[0].setToolTip).toHaveBeenLastCalledWith('Foreman · attention.tray.count {"count":1}')
    // Phone access adds its section.
    tray.update(waiting, { attention: true, phone: true, keep: false, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(3)
    // A tray made again after being removed draws in full.
    tray.update(waiting, { attention: false, phone: false, keep: false, t })
    tray.update(waiting, { attention: true, phone: true, keep: false, t })
    expect(fake.trays).toHaveLength(2)
    expect(fake.trays[1].setContextMenu).toHaveBeenCalledTimes(1)
    tray.destroy()
  })

  it('stays up with the attention section off while Foreman may run with no window, and goes when that ends', () => {
    const tray = new AppTray({ act: () => {}, show: () => {} })
    tray.update(waiting, { attention: false, phone: false, keep: true, t })
    expect(tray.shown).toBe(true)
    // No attention rows: the app's name, then Open Home, Show Foreman and Quit.
    const template = fake.buildFromTemplate.mock.lastCall![0] as { label?: string }[]
    expect(template[0].label).toBe('Foreman')
    expect(template.map((item) => item.label)).toEqual(expect.arrayContaining(['attention.tray.home', 'attention.tray.show', 'attention.tray.quit']))
    expect(fake.trays[0].setToolTip).toHaveBeenLastCalledWith('Foreman')
    tray.update(waiting, { attention: false, phone: false, keep: false, t })
    expect(tray.shown).toBe(false)
    expect(fake.trays[0].destroy).toHaveBeenCalled()
  })
})
