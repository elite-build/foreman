// Suggested follow-ups: up to three short chips after a completed answer. They only fill the
// composer; nothing is sent and they are never a status.
export const MAX_FOLLOWUPS = 3
export const MAX_FOLLOWUP_CHARS = 120

export type FollowupsCheck = { ok: true; items: string[] } | { ok: false; error: string }

/** Checks what the agent proposed. Too many, too long or not text is refused so the agent can try again. */
export function validateFollowups(raw: unknown): FollowupsCheck {
  if (!Array.isArray(raw)) return { ok: false, error: 'Pass an array of short strings.' }
  const items: string[] = []
  for (const entry of raw) {
    if (typeof entry !== 'string') return { ok: false, error: 'Every suggestion must be a string.' }
    const text = entry.replace(/\s+/g, ' ').trim()
    if (!text) continue
    if (text.length > MAX_FOLLOWUP_CHARS) return { ok: false, error: `Each suggestion must be at most ${MAX_FOLLOWUP_CHARS} characters.` }
    if (!items.includes(text)) items.push(text)
  }
  if (items.length > MAX_FOLLOWUPS) return { ok: false, error: `Suggest at most ${MAX_FOLLOWUPS} follow-ups.` }
  if (!items.length) return { ok: false, error: 'Suggest at least one follow-up.' }
  return { ok: true, items }
}
