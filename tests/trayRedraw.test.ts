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
    tray.update(empty, { attention: true, phone: false, t })
    tray.update({ ...empty }, { attention: true, phone: false, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(1)
    expect(fake.trays[0].setContextMenu).toHaveBeenCalledTimes(1)
    tray.update(waiting, { attention: true, phone: false, t })
    tray.update(waiting, { attention: true, phone: false, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(2)
    expect(fake.trays[0].setToolTip).toHaveBeenLastCalledWith('Foreman · attention.tray.count {"count":1}')
    // Phone access adds its section.
    tray.update(waiting, { attention: true, phone: true, t })
    expect(fake.buildFromTemplate).toHaveBeenCalledTimes(3)
    // A tray made again after being removed draws in full.
    tray.update(waiting, { attention: false, phone: false, t })
    tray.update(waiting, { attention: true, phone: true, t })
    expect(fake.trays).toHaveLength(2)
    expect(fake.trays[1].setContextMenu).toHaveBeenCalledTimes(1)
    tray.destroy()
  })
})
