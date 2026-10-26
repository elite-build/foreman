// #14 Open in detected apps, the renderer's side: what main found (shared by the Open menu,
// ⌘O, the file viewer and Settings), the file each workspace is showing (for ⌘O), and
// opening a target with the user's choice.
import { useEffect, useSyncExternalStore } from 'react'
import { openInAppName, resolveDefault, type OpenInApp, type OpenInChoice, type OpenInDetection, type OpenInTarget, type ResolvedDefault } from '../../shared/openIn'
import type { RendererT } from './i18n'
import { api, attempt, getState, useStore } from './store'

let detection: OpenInDetection | null = null
let loading: Promise<void> | null = null
const listeners = new Set<() => void>()

function set(next: OpenInDetection) {
  detection = next
  for (const listener of listeners) listener()
  loadIcons()
}

// ---- G4 #14: the apps' own icons, looked up once per detection (main caches them by file) ----

let icons: Partial<Record<string, string>> = {}
let iconsFor: string | null = null
const iconListeners = new Set<() => void>()

function loadIcons() {
  const at = detection?.checkedAt ?? null
  if (!at || iconsFor === at) return
  iconsFor = at
  void api.openInIcons().then(
    (next) => {
      icons = next
      for (const listener of iconListeners) listener()
    },
    () => undefined
  )
}

/** An app's own icon as a data: URL, or undefined (the menus show its monogram or glyph). */
export function useAppIconUrl(id: string): string | undefined {
  return useSyncExternalStore(
    (listener) => {
      iconListeners.add(listener)
      return () => iconListeners.delete(listener)
    },
    () => icons[id]
  )
}

/** G4 #14: right-click on an Open button sets the default app (the same setting as Settings → Open in apps). */
export function setDefaultApp(choice: OpenInChoice): Promise<unknown> {
  return attempt(() => api.updateSettings({ openInDefault: choice }))
}

/**
 * Ask main again. `detect` looks for apps again (the Open menu opening, Settings' Refresh);
 * without it main re-applies the user's paths to what it found last time.
 */
export function refreshOpenInApps(detect = false): Promise<void> {
  const run = api.openInApps(detect).then(set, () => undefined)
  loading = run
  return run
}

/** What main found, loaded on first use; null until then. */
export function useOpenInApps(): OpenInDetection | null {
  const value = useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => detection
  )
  useEffect(() => {
    if (!detection && !loading) void refreshOpenInApps()
  }, [])
  return value
}

// ---- the file each workspace shows, for ⌘O ----

const viewed = new Map<string, { path: string; line?: number }>()

/** The file viewer says what it shows; null when it closes. `path` is relative to the workspace. */
export function setViewedFile(workspaceId: string, file: { path: string; line?: number } | null): void {
  if (file) viewed.set(workspaceId, file)
  else viewed.delete(workspaceId)
}

export function viewedFile(workspaceId: string): { path: string; line?: number } | undefined {
  return viewed.get(workspaceId)
}

// ---- opening ----

export function defaultApp(found: OpenInDetection | null): ResolvedDefault {
  const settings = getState().snapshot?.settings
  return resolveDefault(settings?.openInDefault ?? '', found, settings?.editorCommand ?? '')
}

/** The default, kept current as Settings or the found apps change. */
export function useDefaultApp(found: OpenInDetection | null): ResolvedDefault {
  const choice = useStore((s) => s.snapshot?.settings.openInDefault ?? '')
  const custom = useStore((s) => s.snapshot?.settings.editorCommand ?? '')
  return resolveDefault(choice, found, custom)
}

/** Open with an app, the custom command, or (null) the default. Errors become a toast. */
export function openWith(choice: OpenInChoice | null, target: OpenInTarget): Promise<unknown> {
  return attempt(() => api.openIn(choice, target))
}

/** An app's name as the UI shows it: File Explorer and Finder are translated. */
export function appLabel(app: Pick<OpenInApp, 'id' | 'name'>, platform: string, t: RendererT): string {
  if (app.id === 'files') return platform === 'darwin' ? t('openIn.app.finder') : t('openIn.app.explorer')
  return app.name
}

/** The name of a default that isn't there: an app, or the custom command. */
export function missingLabel(choice: Exclude<OpenInChoice, ''>, platform: string, t: RendererT): string {
  if (choice === 'custom') return t('openIn.custom')
  return appLabel({ id: choice, name: openInAppName(choice, platform) }, platform, t)
}

/** What main found last, outside React (a click handler deciding whether to show the menu). */
export function openInAppsNow(): OpenInDetection | null {
  return detection
}
