import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { canonicalChords, chordsOf, SHORTCUTS } from '../src/renderer/src/shortcuts'
import {
  compareTranscript,
  describeKey,
  focusMatches,
  formatDiffs,
  keyEvents,
  matches,
  parseChord,
  runWalk,
  type ExpectedTranscript,
  type FocusInfo,
  type Reading,
  type Walk,
  type WalkDriver
} from '../src/main/keyboardWalk'
import { selectWalks, WALKS } from '../src/main/walks'

const focus = (role: string, name: string, extra: Partial<FocusInfo> = {}): FocusInfo => ({ role, name, tag: 'div', ...extra })

/** A page that answers from a script: each press moves to the next reading. The reading after press n is `script[n - 1]`. */
function fakeDriver(script: Reading[], initial: Reading = { activeElement: focus('', ''), announced: '', nonce: 0 }): WalkDriver & { pressed: string[]; watched: string[][] } {
  let at = -1
  const pressed: string[] = []
  const watched: string[][] = []
  return {
    pressed,
    watched,
    async press(key) {
      pressed.push(key)
      at++
    },
    async read(watch) {
      watched.push(watch)
      return script[at] ?? initial
    }
  }
}

const instantly = { delay: async () => undefined }

describe('chords', () => {
  it('turns a registry chord into a key event with the right modifiers and code', () => {
    const win = parseChord('mod+alt+]', 'win32')
    expect(win).toMatchObject({ ctrl: true, alt: true, meta: false, shift: false, code: 'BracketRight', key: ']', windowsVirtualKeyCode: 221 })
    expect(win.text).toBeUndefined()
    const mac = parseChord('mod+alt+]', 'darwin')
    expect(mac).toMatchObject({ ctrl: false, meta: true, alt: true, code: 'BracketRight' })
  })

  it('accepts codes, characters and key names alike', () => {
    expect(describeKey('Period').code).toBe('Period')
    expect(describeKey('.').code).toBe('Period')
    expect(describeKey('k').code).toBe('KeyK')
    expect(describeKey('KeyK').windowsVirtualKeyCode).toBe(75)
    expect(describeKey('Digit1').code).toBe('Digit1')
    expect(describeKey('Esc').code).toBe('Escape')
    expect(describeKey('Down').code).toBe('ArrowDown')
    expect(() => describeKey('NoSuchKey')).toThrow(/Unknown key/)
    expect(() => parseChord('hyper+k', 'win32')).toThrow(/Unknown modifier/)
    expect(() => parseChord('', 'win32')).toThrow()
  })

  it('types a character only without Ctrl, Alt or Cmd', () => {
    expect(parseChord('a', 'win32').text).toBe('a')
    expect(parseChord('shift+a', 'win32')).toMatchObject({ key: 'A', text: 'A' })
    expect(parseChord('ctrl+a', 'win32').text).toBeUndefined()
    expect(parseChord('mod+alt+.', 'darwin').text).toBeUndefined()
    expect(parseChord('Enter', 'win32').text).toBe('\r')
    expect(parseChord('Tab', 'win32').text).toBeUndefined()
  })

  it('presses a chord as a down and an up, with the modifier bits the protocol uses', () => {
    const [down, up] = keyEvents('mod+alt+PageDown', 'win32')
    expect(down).toMatchObject({ type: 'rawKeyDown', modifiers: 1 | 2, code: 'PageDown', windowsVirtualKeyCode: 34 })
    expect(up).toMatchObject({ type: 'keyUp', modifiers: 3, code: 'PageDown' })
    expect(keyEvents('mod+alt+PageDown', 'darwin')[0].modifiers).toBe(1 | 4)
    expect(keyEvents('shift+ArrowDown', 'win32')[0].modifiers).toBe(8)
    // Enter types a carriage return, so a focused button takes it as a press.
    expect(keyEvents('Enter', 'win32')[0]).toMatchObject({ type: 'keyDown', text: '\r', code: 'Enter' })
  })

  it('agrees with the shortcut registry about every chord the walks press', () => {
    const canonicalKey = (code: string) => /^Key([A-Z])$/.exec(code)?.[1].toLowerCase() ?? /^Digit(\d)$/.exec(code)?.[1] ?? code
    for (const platform of ['win32', 'darwin'] as const) {
      for (const walk of WALKS) {
        for (const step of walk.steps) {
          const c = parseChord(step.key, platform)
          const mods = [c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.meta && 'meta'].filter(Boolean)
          expect([...mods, canonicalKey(c.code)].join('+'), `${walk.name}: ${step.key} on ${platform}`).toBe(canonicalChords(step.key, platform)[0])
        }
      }
    }
  })

  it('presses only chords the registry has (the global ones) or keys a component handles', () => {
    const registered = (platform: 'win' | 'mac') => new Set(SHORTCUTS.flatMap((e) => chordsOf(e.keys[platform]).flatMap((c) => canonicalChords(c, platform))))
    const win = registered('win')
    const mac = registered('mac')
    for (const walk of WALKS) {
      for (const step of walk.steps) {
        if (!step.key.includes('mod+')) continue
        expect(win.has(canonicalChords(step.key, 'win')[0]), `${step.key} on Windows`).toBe(true)
        expect(mac.has(canonicalChords(step.key, 'mac')[0]), `${step.key} on macOS`).toBe(true)
      }
    }
  })
})

describe('matches', () => {
  it('tests a regular expression source, unanchored', () => {
    expect(matches('^Turn \\d+', 'Turn 7, Claude')).toBe(true)
    expect(matches('Turn', 'The Turn')).toBe(true)
    expect(matches('^Turn', 'The Turn')).toBe(false)
    expect(matches('^$', '')).toBe(true)
  })

  it('never matches a pattern that is not a regular expression', () => {
    expect(matches('(', '(')).toBe(false)
  })

  it('checks each field of a focus expectation that is given', () => {
    const heading = focus('heading', 'Turn 2, Claude', { level: 3, tag: 'h3' })
    expect(focusMatches({}, heading)).toBe(true)
    expect(focusMatches({ role: 'heading', level: 3, name: '^Turn \\d+' }, heading)).toBe(true)
    expect(focusMatches({ role: 'heading', level: 4 }, heading)).toBe(false)
    expect(focusMatches({ tag: '^div$' }, heading)).toBe(false)
  })
})

describe('runWalk', () => {
  const walk: Walk = {
    name: 'demo',
    screen: 'workspace-chat',
    steps: [
      { key: 'mod+alt+]', expect: { focus: { role: 'heading' } } },
      { key: 'Enter', expect: { announced: 'started' } }
    ]
  }

  it('presses each key, then records the focus and what was announced', async () => {
    const driver = fakeDriver([
      { activeElement: focus('heading', 'Turn 2', { level: 3 }), announced: '', nonce: 0 },
      { activeElement: focus('button', 'Yes'), announced: 'Claude started working.', nonce: 1 }
    ])
    const transcript = await runWalk(driver, walk, instantly)
    expect(driver.pressed).toEqual(['mod+alt+]', 'Enter'])
    expect(transcript).toEqual({
      name: 'demo',
      screen: 'workspace-chat',
      steps: [
        { key: 'mod+alt+]', presses: 1, activeElement: { role: 'heading', name: 'Turn 2', tag: 'div', level: 3 }, announced: '' },
        { key: 'Enter', presses: 1, activeElement: { role: 'button', name: 'Yes', tag: 'div' }, announced: 'Claude started working.' }
      ]
    })
    expect(compareTranscript(walk, transcript)).toEqual([])
  })

  it('waits the settle time before every read', async () => {
    const waits: number[] = []
    const driver = fakeDriver([{ activeElement: focus('', ''), announced: '', nonce: 0 }, { activeElement: focus('', ''), announced: '', nonce: 0 }])
    await runWalk(driver, walk, { settleMs: 1234, delay: async (ms) => void waits.push(ms) })
    expect(waits).toEqual([1234, 1234])
  })

  it('counts an announcement once: a sentence still in the live region from an earlier key is not the next key\'s', async () => {
    const said: Reading = { activeElement: focus('', ''), announced: 'Switched to osaka.', nonce: 4 }
    const driver = fakeDriver([said, { ...said }], { activeElement: focus('', ''), announced: '', nonce: 3 })
    const transcript = await runWalk(driver, { name: 'x', screen: 's', steps: [{ key: 'a' }, { key: 'b' }] }, instantly)
    expect(transcript.steps.map((s) => s.announced)).toEqual(['Switched to osaka.', ''])
  })

  it('ignores what setup announced before the first key', async () => {
    const driver = fakeDriver([{ activeElement: focus('', ''), announced: 'Approval needed.', nonce: 2 }], { activeElement: focus('', ''), announced: 'Approval needed.', nonce: 2 })
    const transcript = await runWalk(driver, { name: 'x', screen: 's', steps: [{ key: 'a' }] }, instantly)
    expect(transcript.steps[0].announced).toBe('')
  })

  it('repeats a key until focus matches, and says how many presses it took', async () => {
    const reads = ['Skip', 'Reason', 'No', 'Yes'].map((name, i): Reading => ({ activeElement: focus('button', name), announced: '', nonce: i * 0 }))
    const driver = fakeDriver(reads)
    const transcript = await runWalk(driver, { name: 'x', screen: 's', steps: [{ key: 'Tab', until: { focus: { name: '^No$' } } }] }, instantly)
    expect(driver.pressed).toEqual(['Tab', 'Tab', 'Tab'])
    expect(transcript.steps[0]).toMatchObject({ presses: 3, activeElement: { name: 'No' } })
  })

  it('stops repeating at the limit, with the focus it has', async () => {
    const driver = fakeDriver([], { activeElement: focus('button', 'Skip'), announced: '', nonce: 0 })
    const transcript = await runWalk(driver, { name: 'x', screen: 's', steps: [{ key: 'Tab', until: { focus: { name: '^No$' }, max: 4 } }] }, instantly)
    expect(driver.pressed).toHaveLength(4)
    expect(transcript.steps[0]).toMatchObject({ presses: 4, activeElement: { name: 'Skip' } })
  })

  it('asks the page about the selectors a step expects, and only those', async () => {
    const driver = fakeDriver([{ activeElement: focus('', ''), announced: '', nonce: 0, present: { '.approval-panel': false } }])
    const transcript = await runWalk(driver, { name: 'x', screen: 's', steps: [{ key: 'Enter', expect: { absent: ['.approval-panel'] } }] }, instantly)
    expect(driver.watched.at(-1)).toEqual(['.approval-panel'])
    expect(transcript.steps[0].present).toEqual({ '.approval-panel': false })
    const plain = fakeDriver([{ activeElement: focus('', ''), announced: '', nonce: 0 }])
    expect((await runWalk(plain, { name: 'x', screen: 's', steps: [{ key: 'a' }] }, instantly)).steps[0]).not.toHaveProperty('present')
  })
})

describe('compareTranscript', () => {
  const transcript = {
    name: 'demo',
    screen: 'workspace-chat',
    steps: [
      { key: 'mod+alt+]', presses: 1, activeElement: focus('heading', 'Turn 2, Claude, 2:03 PM', { level: 3 }), announced: '' },
      { key: 'Enter', presses: 1, activeElement: focus('button', 'Yes'), announced: 'Claude started working.', present: { '.approval-panel': false } }
    ]
  }

  it('is empty when every expectation holds, and ignores what is not expected', () => {
    const expected: ExpectedTranscript = {
      steps: [
        { key: 'mod+alt+]', expect: { focus: { role: 'heading', level: 3, name: '^Turn \\d+' } } },
        { key: 'Enter', expect: { announced: 'started working', absent: ['.approval-panel'] } }
      ]
    }
    expect(compareTranscript(expected, transcript)).toEqual([])
    expect(compareTranscript({ steps: [{ key: 'mod+alt+]' }, { key: 'Enter' }] }, transcript)).toEqual([])
  })

  it('reports each field that differs, with the step and key', () => {
    const expected: ExpectedTranscript = {
      steps: [
        { key: 'mod+alt+]', expect: { focus: { role: 'heading', level: 4, name: '^Reply' } } },
        { key: 'Enter', expect: { announced: '^Denied', present: ['.approval-panel'] } }
      ]
    }
    const diffs = compareTranscript(expected, transcript)
    expect(diffs.map((d) => [d.step, d.key, d.field])).toEqual([
      [1, 'mod+alt+]', 'focus.name'],
      [1, 'mod+alt+]', 'focus.level'],
      [2, 'Enter', 'announced'],
      [2, 'Enter', 'present .approval-panel']
    ])
    expect(diffs[1]).toMatchObject({ expected: '4', actual: '3' })
    expect(diffs[3]).toMatchObject({ expected: 'present', actual: 'absent' })
    expect(formatDiffs('demo', diffs)[0]).toBe('demo step 1 (mod+alt+]): focus.name: expected "^Reply", got "Turn 2, Claude, 2:03 PM"')
  })

  it('reports a selector the page was not asked about, rather than passing it', () => {
    const diffs = compareTranscript({ steps: [{ key: 'mod+alt+]', expect: { absent: ['.x'] } }, { key: 'Enter' }] }, transcript)
    expect(diffs).toEqual([{ step: 1, key: 'mod+alt+]', field: 'absent .x', expected: 'absent', actual: 'not read' }])
  })

  it('reports a different number of steps and a different key', () => {
    expect(compareTranscript({ steps: [{ key: 'mod+alt+]' }] }, transcript)[0]).toMatchObject({ step: 0, field: 'steps', expected: '1', actual: '2' })
    expect(compareTranscript({ steps: [{ key: 'Tab' }, { key: 'Enter' }] }, transcript)[0]).toMatchObject({ step: 1, field: 'key', expected: 'Tab', actual: 'mod+alt+]' })
  })
})

describe('the walks', () => {
  const fixtures = path.join(__dirname, 'fixtures', 'walks')

  it('have unique names and every step names a key the parser knows', () => {
    expect(new Set(WALKS.map((w) => w.name)).size).toBe(WALKS.length)
    for (const walk of WALKS) for (const step of walk.steps) expect(() => parseChord(step.key, 'win32'), `${walk.name}: ${step.key}`).not.toThrow()
  })

  it('start on a screen the renderer hook knows', () => {
    const known = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'src', 'screens.ts'), 'utf8')
    for (const walk of WALKS) expect(known, walk.name).toContain(`'${walk.screen}'`)
  })

  it('have an expected transcript beside the fixture with the same keys in the same order, and valid patterns', () => {
    for (const walk of WALKS) {
      const file = path.join(fixtures, `${walk.name}.json`)
      expect(existsSync(file), file).toBe(true)
      const expected = JSON.parse(readFileSync(file, 'utf8')) as ExpectedTranscript
      expect(expected.steps.map((s) => s.key), walk.name).toEqual(walk.steps.map((s) => s.key))
      for (const step of expected.steps) {
        const e = step.expect
        for (const pattern of [e?.focus?.role, e?.focus?.name, e?.focus?.tag, e?.announced]) if (pattern !== undefined) expect(() => new RegExp(pattern), `${walk.name}: ${pattern}`).not.toThrow()
      }
    }
  })

  it('can be picked by name', () => {
    expect(selectWalks().map((w) => w.name)).toEqual(WALKS.map((w) => w.name))
    expect(selectWalks('chat-turns, diff-rows').map((w) => w.name)).toEqual(['chat-turns', 'diff-rows'])
    expect(selectWalks('')).toHaveLength(WALKS.length)
  })

  it('keep the approval walk to a real request that must end denied', () => {
    const approval = WALKS.find((w) => w.name === 'approval-keys')!
    expect(approval.approval).toEqual({ expect: 'denied' })
    expect(approval.waitFor).toBe('.approval-panel')
  })
})
