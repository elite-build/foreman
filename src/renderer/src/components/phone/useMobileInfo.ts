import { useEffect, useState } from 'react'
import type { MobileInfo } from '../../../../shared/mobile'
import { api } from '../../store'

/** Mobile access as the main process sees it, polled: pairing finishes on the phone. */
export function useMobileInfo(intervalMs: number): [MobileInfo | null, (next: MobileInfo) => void] {
  const [info, setInfo] = useState<MobileInfo | null>(null)
  useEffect(() => {
    let live = true
    const poll = () => void api.mobileInfo().then((next) => live && setInfo(next), () => undefined)
    poll()
    const timer = setInterval(poll, intervalMs)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [intervalMs])
  return [info, setInfo]
}
