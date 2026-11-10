// Foreman with no window (docs/server.md, "Headless"): started with --headless, or kept running when the last window
// closes because Settings → Data & devices → Keep running without a window is on. Pure, so the rule is tested without
// Electron; src/main/index.ts reads the facts and acts on the answers.

export interface HeadlessFacts {
  platform: NodeJS.Platform
  // Started with --headless.
  headless: boolean
  // Settings → Data & devices → Keep running without a window.
  keepRunning: boolean
  // Phone access on, over Tailscale or the local network.
  phoneAccess: boolean
}

/** Phone access has kept Windows' tray up, and the app running behind it, since before this rule. */
function phoneKeepsTray(facts: HeadlessFacts): boolean {
  return facts.platform === 'win32' && facts.phoneAccess
}

/** Closing the last window quits Foreman only when nothing wants it to stay. */
export function quitsWhenWindowsClose(facts: HeadlessFacts): boolean {
  // macOS apps outlive their windows; the Dock icon opens one again.
  if (facts.platform === 'darwin') return false
  return !facts.headless && !facts.keepRunning && !phoneKeepsTray(facts)
}

/**
 * The tray shows whenever Foreman may be running with no window (headless, keep running, phone access), on every
 * platform where the app has a tray today. It is how the window comes back and how Foreman is quit. Without any of
 * these, Settings → General → Tray icon alone decides.
 */
export function trayWanted(facts: HeadlessFacts): boolean {
  return facts.headless || facts.keepRunning || phoneKeepsTray(facts)
}

/** Whether Foreman was started with --headless: anywhere after the executable, as Electron and a shortcut place it differently. */
export function parseHeadless(argv: readonly string[]): boolean {
  return argv.slice(1).includes('--headless')
}
