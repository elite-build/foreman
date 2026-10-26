// Turning what someone types into a safe FTS5 query, and a snippet back into
// text with its matches marked. The markers are control characters that never
// occur in chat text.
export const HIT_START = '\u0001'
export const HIT_END = '\u0002'

const hasWord = (s: string) => /[\p{L}\p{N}]/u.test(s)

/**
 * Every word must appear; the last may be a prefix, so results follow the typing.
 * Words are quoted, so code and punctuation are searched as text, never as query syntax.
 * Returns null when there is nothing to search for.
 */
export function ftsQuery(input: string): string | null {
  const words = input.split(/\s+/).filter(hasWord)
  if (!words.length) return null
  return words.map((w, i) => `"${w.replace(/"/g, '""')}"${i === words.length - 1 ? '*' : ''}`).join(' AND ')
}

export interface SnippetPart {
  text: string
  hit: boolean
}

/** Split a snippet at its markers, for rendering matches without trusting the text as markup. */
export function snippetParts(snippet: string): SnippetPart[] {
  const parts: SnippetPart[] = []
  let hit = false
  for (const piece of snippet.split(new RegExp(`([${HIT_START}${HIT_END}])`))) {
    if (piece === HIT_START) hit = true
    else if (piece === HIT_END) hit = false
    else if (piece) parts.push({ text: piece, hit })
  }
  return parts
}
