// O17 (G4): a notification once per cutoff when it lets the computer sleep while agents run.
import { describe, expect, it } from 'vitest'
import { KeepAwake, type PowerReading } from '../src/main/keepAwake'
import { createT } from '../src/shared/i18n'
import { keepAwakeCutoffNotice, type KeepAwakeSettings } from '../src/shared/keepAwake'

const on: KeepAwakeSettings = { keepAwake: true, keepAwakeBatteryCutoff: true, keepAwakeBatteryPercent: 20, keepAwakeThermalCutoff: true, keepAwakeOnlyOnPower: false }

function setup() {
  const power: { reading: PowerReading } = { reading: { onBattery: false, thermal: null } }
  const ka = new KeepAwake(() => {}, () => power.reading, () => 0)
  return { ka, power }
}

describe('keep-awake cutoff notice', () => {
  it('fires once when a cutoff starts while agents run, not again for the same cutoff', () => {
    const { ka, power } = setup()
    ka.setBattery(15)
    ka.update(2, on)
    expect(ka.takeCutoffNotice()).toBeNull()
    power.reading = { onBattery: true, thermal: null }
    ka.update(2, on)
    expect(ka.takeCutoffNotice()).toBe('low-battery')
    expect(ka.takeCutoffNotice()).toBeNull()
    // Flapping back to power and onto battery again doesn't repeat it.
    power.reading = { onBattery: false, thermal: null }
    ka.update(2, on)
    power.reading = { onBattery: true, thermal: null }
    ka.update(2, on)
    expect(ka.takeCutoffNotice()).toBeNull()
  })

  it('a different cutoff is told too, and the set resets once agents stop', () => {
    const { ka, power } = setup()
    power.reading = { onBattery: false, thermal: 'serious' }
    ka.update(1, on)
    expect(ka.takeCutoffNotice()).toBe('hot')
    power.reading = { onBattery: true, thermal: null }
    ka.update(1, { ...on, keepAwakeOnlyOnPower: true })
    expect(ka.takeCutoffNotice()).toBe('on-battery')
    ka.update(0, on)
    expect(ka.takeCutoffNotice()).toBeNull()
    power.reading = { onBattery: false, thermal: 'critical' }
    ka.update(1, on)
    expect(ka.takeCutoffNotice()).toBe('hot')
  })

  it('never fires with no agents, with the setting off, or when no signal can be read', () => {
    const { ka, power } = setup()
    power.reading = { onBattery: true, thermal: 'critical' }
    ka.update(0, on)
    ka.update(3, { ...on, keepAwake: false })
    expect(ka.takeCutoffNotice()).toBeNull()
    power.reading = { onBattery: null, thermal: null }
    ka.update(3, { ...on, keepAwakeOnlyOnPower: true })
    expect(ka.takeCutoffNotice()).toBeNull()
  })

  it('wording, in English and Spanish', () => {
    expect(keepAwakeCutoffNotice('low-battery', 3, on, createT('en'))).toEqual({
      title: 'Sleep allowed while agents run',
      body: 'Stopped keeping the computer awake: battery below 20%. 3 agents still working; a cutoff never stops them.'
    })
    expect(keepAwakeCutoffNotice('hot', 1, on, createT('es')).body).toBe(
      'Ya no se mantiene el equipo despierto: el equipo está caliente. Los agentes siguen trabajando (1 agente); un corte nunca los detiene.'
    )
  })
})
