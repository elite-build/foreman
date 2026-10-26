import { describe, expect, it } from 'vitest'
import { BATTERY_STALE_MS, KeepAwake, type PowerReading } from '../src/main/keepAwake'
import { defaultSettings } from '../src/main/store'
import { createT } from '../src/shared/i18n'
import {
  batteryThreshold,
  decideKeepAwake,
  isCutoff,
  keepAwakeChip,
  keepAwakeNow,
  type KeepAwakeSettings,
  type KeepAwakeStatus,
  type PowerState
} from '../src/shared/keepAwake'

const t = createT('en')
const es = createT('es')

// Mock defaults: battery cutoff on at 20%, thermal cutoff on, "only on power" off.
const on: KeepAwakeSettings = {
  keepAwake: true,
  keepAwakeBatteryCutoff: true,
  keepAwakeBatteryPercent: 20,
  keepAwakeThermalCutoff: true,
  keepAwakeOnlyOnPower: false
}
const ac: PowerState = { onBattery: false, batteryPercent: 100, thermal: null }
const battery = (percent: number | null, thermal: PowerState['thermal'] = null): PowerState => ({ onBattery: true, batteryPercent: percent, thermal })
const status = (agents: number, settings: KeepAwakeSettings, power: PowerState): KeepAwakeStatus => ({ ...decideKeepAwake(agents, settings, power), agents, power })

describe('decideKeepAwake', () => {
  it('is off when the setting is off, whatever else', () => {
    expect(decideKeepAwake(3, { ...on, keepAwake: false }, ac)).toEqual({ keepAwake: false, reason: 'off' })
  })

  it('is idle with no agents working', () => {
    expect(decideKeepAwake(0, on, ac)).toEqual({ keepAwake: false, reason: 'idle' })
  })

  it('keeps awake on power while agents work', () => {
    expect(decideKeepAwake(1, on, ac)).toEqual({ keepAwake: true, reason: 'active' })
  })

  it('keeps awake on battery above the threshold, and at exactly the threshold', () => {
    expect(decideKeepAwake(2, on, battery(46))).toEqual({ keepAwake: true, reason: 'active' })
    expect(decideKeepAwake(2, on, battery(20))).toEqual({ keepAwake: true, reason: 'active' })
  })

  it('lets it sleep on battery below the threshold', () => {
    expect(decideKeepAwake(2, on, battery(19))).toEqual({ keepAwake: false, reason: 'low-battery' })
    expect(decideKeepAwake(2, { ...on, keepAwakeBatteryPercent: 50 }, battery(46)).reason).toBe('low-battery')
  })

  it('ignores a low level while charging, and when the battery cutoff is off', () => {
    expect(decideKeepAwake(2, on, { onBattery: false, batteryPercent: 5, thermal: null }).keepAwake).toBe(true)
    expect(decideKeepAwake(2, { ...on, keepAwakeBatteryCutoff: false }, battery(5)).keepAwake).toBe(true)
  })

  it('never trips a cutoff on a signal it cannot read', () => {
    expect(decideKeepAwake(2, on, battery(null)).keepAwake).toBe(true)
    expect(decideKeepAwake(2, { ...on, keepAwakeOnlyOnPower: true }, { onBattery: null, batteryPercent: 5, thermal: null }).keepAwake).toBe(true)
    expect(decideKeepAwake(2, on, { ...ac, thermal: 'unknown' }).keepAwake).toBe(true)
  })

  it('lets it sleep when macOS reports serious or critical thermal pressure', () => {
    expect(decideKeepAwake(1, on, { ...ac, thermal: 'serious' })).toEqual({ keepAwake: false, reason: 'hot' })
    expect(decideKeepAwake(1, on, { ...ac, thermal: 'critical' }).reason).toBe('hot')
    expect(decideKeepAwake(1, on, { ...ac, thermal: 'fair' }).keepAwake).toBe(true)
    expect(decideKeepAwake(1, { ...on, keepAwakeThermalCutoff: false }, { ...ac, thermal: 'critical' }).keepAwake).toBe(true)
  })

  it('with "only while on power", any battery lets it sleep, and that reason wins', () => {
    const only = { ...on, keepAwakeOnlyOnPower: true }
    expect(decideKeepAwake(1, only, battery(90))).toEqual({ keepAwake: false, reason: 'on-battery' })
    expect(decideKeepAwake(1, only, battery(5, 'critical')).reason).toBe('on-battery')
    expect(decideKeepAwake(1, only, ac).keepAwake).toBe(true)
  })

  it('a low battery wins over heat', () => {
    expect(decideKeepAwake(1, on, battery(10, 'critical')).reason).toBe('low-battery')
  })

  it('reads a stored threshold safely', () => {
    expect(batteryThreshold(20)).toBe(20)
    expect(batteryThreshold(2)).toBe(5)
    expect(batteryThreshold(120)).toBe(95)
    expect(batteryThreshold('x')).toBe(20)
    expect(batteryThreshold(Number.NaN)).toBe(20)
    expect(decideKeepAwake(1, { ...on, keepAwakeBatteryPercent: Number.NaN }, battery(19)).reason).toBe('low-battery')
  })

  it('names which reasons are cutoffs', () => {
    expect(['active', 'off', 'idle', 'on-battery', 'low-battery', 'hot'].filter((r) => isCutoff(r as never))).toEqual(['on-battery', 'low-battery', 'hot'])
  })

  it('the defaults match the mock: cutoffs on at 20%, "only on power" off, keep-awake itself off', () => {
    const d = defaultSettings()
    expect([d.keepAwake, d.keepAwakeBatteryCutoff, d.keepAwakeBatteryPercent, d.keepAwakeThermalCutoff, d.keepAwakeOnlyOnPower]).toEqual([false, true, 20, true, false])
  })
})

describe('keep-awake wording', () => {
  it('the chip says what it is doing', () => {
    expect(keepAwakeChip(status(3, on, battery(46)), on, t)).toBe('Keeping awake · 3 agents · on battery 46%')
    expect(keepAwakeChip(status(1, on, ac), on, t)).toBe('Keeping awake · 1 agent · on power')
    expect(keepAwakeChip(status(2, on, battery(null)), on, t)).toBe('Keeping awake · 2 agents · on battery')
    expect(keepAwakeChip(status(2, on, { onBattery: null, batteryPercent: null, thermal: null }), on, t)).toBe('Keeping awake · 2 agents')
  })

  it('the chip says why not when a cutoff applies', () => {
    expect(keepAwakeChip(status(3, on, battery(14)), on, t)).toBe('Sleep allowed · battery below 20%')
    expect(keepAwakeChip(status(3, on, { ...ac, thermal: 'serious' }), on, t)).toBe('Sleep allowed · machine is hot')
    const only = { ...on, keepAwakeOnlyOnPower: true }
    expect(keepAwakeChip(status(3, only, battery(80)), only, t)).toBe('Sleep allowed · on battery')
  })

  it('the chip is hidden when off or idle', () => {
    expect(keepAwakeChip(status(0, on, ac), on, t)).toBeNull()
    const off = { ...on, keepAwake: false }
    expect(keepAwakeChip(status(3, off, ac), off, t)).toBeNull()
  })

  it('the "Now:" line adds the power source and, where readable, thermal pressure', () => {
    expect(keepAwakeNow(status(3, on, battery(46, 'nominal')), on, t)).toBe('Now: keeping awake for 3 agents · on battery, 46% · thermal pressure normal')
    expect(keepAwakeNow(status(0, on, ac), on, t)).toBe('Now: no agents working · on power')
    expect(keepAwakeNow(status(2, on, battery(12)), on, t)).toBe('Now: sleep allowed, battery below 20% · on battery, 12%')
    expect(keepAwakeNow(status(2, on, battery(null)), on, t)).toBe('Now: keeping awake for 2 agents · on battery, level unknown')
    expect(keepAwakeNow(status(2, on, { onBattery: null, batteryPercent: null, thermal: 'unknown' }), on, t)).toBe(
      'Now: keeping awake for 2 agents · power source unknown · thermal pressure unknown'
    )
  })

  it('has Spanish', () => {
    expect(keepAwakeChip(status(3, on, battery(46)), on, es)).toBe('Manteniendo despierto · 3 agentes · con batería 46%')
    expect(keepAwakeChip(status(1, on, battery(10)), on, es)).toBe('Reposo permitido · batería por debajo del 20%')
  })
})

describe('KeepAwake (main)', () => {
  function setup(reading: PowerReading = { onBattery: false, thermal: null }) {
    const holds: boolean[] = []
    let clock = 1_000_000
    const power = { reading }
    const ka = new KeepAwake((v) => holds.push(v), () => power.reading, () => clock)
    return { ka, holds, power, tick: (ms: number) => (clock += ms) }
  }

  it('holds sleep off only while it should, calling the host on changes only', () => {
    const { ka, holds } = setup()
    expect(ka.update(0, on)).toBe(true)
    expect(ka.update(2, on)).toBe(true)
    expect(ka.update(3, on)).toBe(true)
    expect(ka.update(3, on)).toBe(false)
    expect(ka.update(0, on)).toBe(true)
    expect(holds).toEqual([true, false])
  })

  it('releases when the battery drops below the cutoff and holds again once plugged in', () => {
    const { ka, holds, power } = setup({ onBattery: true, thermal: null })
    ka.setBattery(46)
    ka.update(3, on)
    expect(ka.status).toMatchObject({ keepAwake: true, reason: 'active', power: { onBattery: true, batteryPercent: 46 } })
    ka.setBattery(19)
    expect(ka.update(3, on)).toBe(true)
    expect(ka.status.reason).toBe('low-battery')
    power.reading = { onBattery: false, thermal: null }
    ka.update(3, on)
    expect(ka.status.reason).toBe('active')
    expect(holds).toEqual([true, false, true])
  })

  it('forgets a battery level nobody has re-sent, and treats nonsense as unknown', () => {
    const { ka, tick } = setup({ onBattery: true, thermal: null })
    ka.setBattery(10)
    ka.update(1, on)
    expect(ka.status.reason).toBe('low-battery')
    tick(BATTERY_STALE_MS + 1)
    ka.update(1, on)
    expect(ka.status).toMatchObject({ keepAwake: true, power: { batteryPercent: null } })
    ka.setBattery(140)
    ka.update(1, on)
    expect(ka.status.power.batteryPercent).toBeNull()
  })

  it('a power read that throws counts as unknown, not a cutoff', () => {
    const ka = new KeepAwake(() => {}, () => {
      throw new Error('no powerMonitor')
    })
    ka.update(1, { ...on, keepAwakeOnlyOnPower: true })
    expect(ka.status).toMatchObject({ keepAwake: true, power: { onBattery: null, thermal: null } })
  })
})
