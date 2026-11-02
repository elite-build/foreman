import { useEffect, useState } from 'react'
import type { MobileInfo } from '../../../../shared/mobile'
import { api, useWindowVisible } from '../../store'

/**
 * Mobile access as the main process sees it, polled: pairing finishes on the phone. Only while the window can be
 * seen (each poll lists the network interfaces in main); the last answer stays until the next.
 */
export function useMobileInfo(intervalMs: number): [MobileInfo | null, (next: MobileInfo) => void] {
  const [info, setInfo] = useState<MobileInfo | null>(null)
  const visible = useWindowVisible()
  useEffect(() => {
    if (!visible) return
    let live = true
    const poll = () => void api.mobileInfo().then((next) => live && setInfo(next), () => undefined)
    poll()
    const timer = setInterval(poll, intervalMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [intervalMs, visible])
  return [info, setInfo]
}
