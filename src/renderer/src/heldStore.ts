import { useRef } from 'react'
import { useStore } from './store'

type StoreState = Parameters<Parameters<typeof useStore>[0]>[0]

/**
 * `useStore` for a view that may be hidden (a workspace switched away from, a chat tab behind another): while `held` it
 * keeps returning what it last read, so the store's events don't re-render a view nobody can see. Once no longer held it
 * reads the store again, and the view catches up in one render.
 */
export function useHeldStore<T>(selector: (s: StoreState) => T, held: boolean): T {
  const last = useRef<{ value: T } | null>(null)
  const value = useStore((s) => (held && last.current ? last.current.value : selector(s)))
  last.current = { value }
  return value
}
