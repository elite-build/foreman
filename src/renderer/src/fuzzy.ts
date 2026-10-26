// Small fuzzy matching for file pickers and the command palette.

/** Score for `query` as a subsequence of `text` (lower is better), or null if no match. */
export function fuzzyScore(text: string, query: string): number | null {
  const t = text.toLowerCase()
  const q = query.toLowerCase().trim()
  if (!q) return 0
  let at = 0
  let gaps = 0
  for (const ch of q) {
    const found = t.indexOf(ch, at)
    if (found === -1) return null
    gaps += found - at
    at = found + 1
  }
  const contiguous = t.includes(q) ? 0 : 50
  return contiguous + gaps
}

/** Rank file paths, preferring matches in the file name and shorter paths. */
export function rankFiles(files: string[], query: string, limit = 50): string[] {
  if (!query.trim()) return files.slice(0, limit)
  const q = query.toLowerCase()
  const scored: { file: string; score: number }[] = []
  for (const file of files) {
    const score = fuzzyScore(file, q)
    if (score === null) continue
    const name = file.slice(file.lastIndexOf('/') + 1).toLowerCase()
    const bonus = name.startsWith(q) ? -200 : name.includes(q) ? -100 : 0
    scored.push({ file, score: score + bonus + file.length / 10 })
  }
  return scored.sort((a, b) => a.score - b.score).slice(0, limit).map((s) => s.file)
}

export function rankItems<T>(items: T[], query: string, text: (item: T) => string): T[] {
  if (!query.trim()) return items
  return items
    .map((item) => ({ item, score: fuzzyScore(text(item), query) }))
    .filter((x): x is { item: T; score: number } => x.score !== null)
    .sort((a, b) => a.score - b.score)
    .map((x) => x.item)
}
