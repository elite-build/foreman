import { describe, expect, it } from 'vitest'
import { textMatches } from '../src/renderer/src/components/findInChat'
import { PtyEventRouter } from '../src/renderer/src/ptyEvents'

describe('chat search matching', () => {
  it('treats code and regular expression characters as literal text', () => {
    expect(textMatches('Use a[0].map() then A[0].MAP()', 'a[0].map()')).toEqual([
      { start: 4, end: 14 },
      { start: 20, end: 30 }
    ])
    expect(textMatches('\\ $ + * ? {foo}', '\\')).toEqual([{ start: 0, end: 1 }])
  })
  it('preserves offsets after Unicode text and handles empty queries', () => {
    expect(textMatches('İstanbul 😀 needle', 'needle')).toEqual([{ start: 12, end: 18 }])
    expect(textMatches('anything', '')).toEqual([])
    expect(textMatches('anything', 'missing')).toEqual([])
  })
})

describe('terminal event delivery', () => {
  it('retains fast command output and exit until its terminal subscribes', () => {
    const router = new PtyEventRouter()
    const events: (string | number)[] = []
    router.dispatch('fast', { data: 'hello' })
    router.dispatch('fast', { code: 7 })
    router.listen('fast', { data: (s) => events.push(s), exit: (code) => events.push(code) })
    expect(events).toEqual(['hello', 7])
  })
  it('isolates concurrent commands and removes listeners on disposal', () => {
    const router = new PtyEventRouter()
    const output: string[] = []
    const stop = router.listen('one', { data: (s) => output.push(s), exit() {} })
    router.dispatch('two', { data: 'other command' })
    router.dispatch('one', { data: 'first' })
    stop()
    router.dispatch('one', { data: 'after disposal' })
    expect(output).toEqual(['first'])
  })
})
