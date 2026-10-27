// @vitest-environment jsdom
// The language reaches components through one provider at the root: `useT` adds no store subscription of its own, so a long
// chat (every row translates) doesn't make each store event read the language setting thousands of times.
import './domShims'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LocaleProvider, useLocale, useT } from '../src/renderer/src/i18n'
import { useStoreMemo } from '../src/renderer/src/storeMemo'
import { fakeState, resetFake } from './rendererStore'

const counts = vi.hoisted(() => ({ listeners: new Set<() => void>(), selected: 0 }))

// The fake store, but live and counting its subscribers, as the real one would have them.
vi.mock('../src/renderer/src/store', async () => {
  const base = (await import('./rendererStore')).storeModule as Record<string, unknown>
  const { fakeState: state } = await import('./rendererStore')
  const subscribe = (listener: () => void) => {
    counts.listeners.add(listener)
    return () => void counts.listeners.delete(listener)
  }
  const own: Record<string, unknown> = {
    useStore: (selector: (s: typeof state) => unknown) => useSyncExternalStore(subscribe, () => selector(state))
  }
  return new Proxy(base, { get: (target, name: string) => (name in own ? own[name] : target[name]), has: () => true })
})

const notify = () => act(() => counts.listeners.forEach((l) => l()))

function Row({ n }: { n: number }) {
  const t = useT()
  return <p data-testid={`row${n}`}>{t('common.retry')}</p>
}

beforeEach(() => {
  resetFake()
  counts.selected = 0
  fakeState.snapshot = { ...fakeState.snapshot, settings: { ...fakeState.snapshot.settings, language: 'en' } }
})
afterEach(cleanup)

describe('useT', () => {
  it('subscribes to the store once, in the provider, however many components translate', () => {
    render(
      <LocaleProvider>
        {Array.from({ length: 50 }, (_, n) => (
          <Row key={n} n={n} />
        ))}
      </LocaleProvider>
    )
    expect(screen.getAllByText('Retry')).toHaveLength(50)
    expect(counts.listeners.size).toBe(1)
  })

  it('still re-renders every component when the language changes', () => {
    function Locale() {
      return <span data-testid="locale">{useLocale()}</span>
    }
    render(
      <LocaleProvider>
        <Row n={1} />
        <Locale />
      </LocaleProvider>
    )
    fakeState.snapshot = { ...fakeState.snapshot, settings: { ...fakeState.snapshot.settings, language: 'de' } }
    notify()
    expect(screen.getByTestId('row1').textContent).toBe('Erneut versuchen')
    expect(screen.getByTestId('locale').textContent).toBe('de')
  })

  it('gives every component the same t, so memo\'d rows see no change', () => {
    const seen: unknown[] = []
    function Probe() {
      seen.push(useT())
      return null
    }
    render(
      <LocaleProvider>
        <Probe />
        <Probe />
      </LocaleProvider>
    )
    expect(seen.length).toBeGreaterThan(1)
    expect(new Set(seen).size).toBe(1)
  })

  it('works without a provider (a component rendered on its own), in the language set now, with no subscription', () => {
    fakeState.snapshot.settings.language = 'de'
    render(<Row n={1} />)
    expect(screen.getByTestId('row1').textContent).toBe('Erneut versuchen')
    expect(counts.listeners.size).toBe(0)
  })
})

describe('useStoreMemo', () => {
  it('works its value out again only when an input changes, not on every store event', () => {
    fakeState.chats = { s1: [{ kind: 'user', id: 'u1' }] }
    function Probe() {
      const n = useStoreMemo(
        (s) => [s.chats.s1],
        ([chat]) => {
          counts.selected++
          return (chat as unknown[]).length
        }
      )
      return <p data-testid="n">{n}</p>
    }
    render(<Probe />)
    const first = counts.selected
    notify()
    notify()
    expect(counts.selected).toBe(first)
    fakeState.chats = { s1: [...fakeState.chats.s1, { kind: 'assistant', id: 'a1' }] }
    notify()
    expect(counts.selected).toBe(first + 1)
    expect(screen.getByTestId('n').textContent).toBe('2')
  })
})
