// The keyboard walks (accessibility plan, TESTING.md layer 4; SCENARIO.md Session 1 as a test). Each one starts on a
// screen of the screens run with a fresh page, plays keys the way Priya would, and says what must be true after each.
// Run with `npm run screens -- --walk`; the transcripts go to walk-<name>.json beside the screenshots and are compared
// with tests/fixtures/walks/<name>.json. Keys are chords as the shortcut registry writes them, so `mod` is Cmd on macOS
// and Ctrl on Windows, and nothing below depends on the platform.
import type { Walk } from './keyboardWalk'

/**
 * A tool approval is pending on the fixture chat (a real request in main, so pressing No really denies it). Reach the
 * panel with the what-needs-me key, Tab to No and press Enter: the request is denied and the panel is gone.
 */
export const APPROVAL_KEYS: Walk = {
  name: 'approval-keys',
  screen: 'workspace-chat',
  approval: { expect: 'denied' },
  waitFor: '.approval-panel',
  steps: [
    { key: 'mod+alt+.', expect: { focus: { role: 'group', name: 'Run this command\\?' } } },
    { key: 'Tab', until: { focus: { name: '^No\\b' }, max: 12 }, expect: { focus: { role: 'button', name: '^No\\b' } } },
    { key: 'Enter', expect: { absent: ['.approval-panel'] } }
  ]
}

/** The jump keys: the latest turn's heading, the one before, the first turn's edge, and what needs me when nothing does. */
export const CHAT_TURNS: Walk = {
  name: 'chat-turns',
  screen: 'workspace-chat',
  steps: [
    { key: 'mod+alt+]', expect: { focus: { role: 'heading', level: 3, name: '^Turn \\d+' } } },
    { key: 'mod+alt+[', expect: { focus: { role: 'heading', level: 3, name: '^Turn \\d+' } } },
    { key: 'mod+alt+[', expect: { announced: 'first turn' } },
    { key: 'mod+alt+.', expect: { announced: 'Nothing needs you' } }
  ]
}

/** Changes: Tab to the first hunk's heading, walk its rows with the arrows, extend the selection, clear it. */
export const DIFF_ROWS: Walk = {
  name: 'diff-rows',
  screen: 'file-diff',
  steps: [
    { key: 'Tab', until: { focus: { name: '^Hunk 1 of' }, max: 200 }, expect: { focus: { role: 'heading', name: '^Hunk 1 of' } } },
    { key: 'ArrowDown', expect: { focus: { role: 'row', tag: '^tr$' } } },
    { key: 'shift+ArrowDown', expect: { focus: { role: 'row' }, announced: 'Selected 2 lines' } },
    { key: 'Escape', expect: { focus: { role: 'row' } } }
  ]
}

/** The rebound previous and next workspace keys switch workspaces, and say so. */
export const WORKSPACE_KEYS: Walk = {
  name: 'workspace-keys',
  screen: 'workspace-chat',
  steps: [
    // The fixture opens on the last workspace in the sidebar, so go up first, then back down.
    { key: 'mod+alt+PageUp', expect: { announced: 'Switched to' } },
    { key: 'mod+alt+PageDown', expect: { announced: 'Switched to' } }
  ]
}

export const WALKS: readonly Walk[] = [APPROVAL_KEYS, CHAT_TURNS, DIFF_ROWS, WORKSPACE_KEYS]

/** The walks FOREMAN_SCREENSHOTS_WALK_ONLY names (comma-separated), or all of them. */
export function selectWalks(only?: string, walks: readonly Walk[] = WALKS): Walk[] {
  const names = only?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  return names.length ? walks.filter((w) => names.includes(w.name)) : [...walks]
}
