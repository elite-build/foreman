import { useEffect, useState } from 'react'
import { useWindowVisible } from './store'

/**
 * The time, moved on every `everyMs`, for labels such as "running for 4 min". The clock stops while the window is minimized
 * or hidden (nothing re-renders for a label nobody sees) and catches up as soon as the window is shown again.
 */
export function useClock(everyMs: number): number {
  const visible = useWindowVisible()
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!visible) return
    setNow((was) => (Date.now() - was >= everyMs ? Date.now() : was))
    const timer = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(timer)
  }, [visible, everyMs])
  return now
}
