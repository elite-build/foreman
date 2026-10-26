// O4: the Windows shells the main process found. Looked up when a view that lists them
// mounts, and again on `refresh` (the Shell list and the new-terminal menu call it each time
// they open), so a shell installed a moment ago shows up without a restart.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShellDetection } from '../../../shared/shells'
import { api } from '../store'

export function useShells(enabled = true): { found: ShellDetection | null; refresh: () => void } {
  const [found, setFound] = useState<ShellDetection | null>(null)
  const alive = useRef(true)
  const refresh = useCallback(() => {
    api.detectShells().then(
      (next) => alive.current && setFound(next),
      () => undefined
    )
  }, [])
  useEffect(() => {
    alive.current = true
    if (enabled) refresh()
    return () => {
      alive.current = false
    }
  }, [enabled, refresh])
  return { found, refresh }
}
