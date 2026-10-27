// Structural sharing for data that arrives whole and freshly copied (the state snapshot over IPC): the parts that
// didn't change keep the objects the previous copy had, so anything comparing by reference (React selectors, memos)
// sees only what really changed.

type Plain = Record<string, unknown>

const hasOwn = Object.prototype.hasOwnProperty

function isPlain(value: unknown): value is Plain {
  if (typeof value !== 'object' || value === null) return false
  const proto = Object.getPrototypeOf(value) as unknown
  return proto === Object.prototype || proto === null
}

/** A list entry's identity: its string or number `id`, for matching entries that moved. */
function idOf(value: unknown): unknown {
  if (!isPlain(value)) return undefined
  const id = value.id
  return typeof id === 'string' || typeof id === 'number' ? id : undefined
}

function shareArray(prev: unknown[], next: unknown[]): unknown[] {
  let same = prev.length === next.length
  let out: unknown[] | null = null
  // Built only when an entry with an id isn't where it was (a reorder, an insert or a removal before it).
  let byId: Map<unknown, unknown> | null = null
  for (let i = 0; i < next.length; i++) {
    const n = next[i]
    let p = prev[i]
    const id = idOf(n)
    if (id !== undefined && idOf(p) !== id) {
      if (!byId) {
        byId = new Map()
        for (const entry of prev) {
          const key = idOf(entry)
          if (key !== undefined && !byId.has(key)) byId.set(key, entry)
        }
      }
      p = byId.get(id)
    }
    const r = shareUnchanged(p, n)
    if (!Object.is(r, prev[i])) same = false
    if (r !== n) (out ??= next.slice())[i] = r
  }
  return same ? prev : (out ?? next)
}

function shareObject(prev: Plain, next: Plain): Plain {
  const keys = Object.keys(next)
  let same = keys.length === Object.keys(prev).length
  let out: Plain | null = null
  for (const key of keys) {
    const n = next[key]
    const p = prev[key]
    const r = shareUnchanged(p, n)
    if (!Object.is(r, p) || !hasOwn.call(prev, key)) same = false
    if (r !== n) (out ??= { ...next })[key] = r
  }
  return same ? prev : (out ?? next)
}

/**
 * `next`, with every part deeply equal to the matching part of `prev` replaced by `prev`'s object; `prev` itself when
 * the two are deeply equal. List entries with an `id` are matched by it, so a reorder or removal still reuses them;
 * others by position. Plain objects, arrays and dates are compared; any other object counts as changed. Neither
 * argument is modified: a container is copied only when it mixes reused and new parts. One walk, O(size of `next`).
 */
export function shareUnchanged<T>(prev: unknown, next: T): T {
  if (Object.is(prev, next)) return prev as T
  if (typeof next !== 'object' || next === null || typeof prev !== 'object' || prev === null) return next
  if (Array.isArray(next)) return (Array.isArray(prev) ? shareArray(prev, next) : next) as T
  if (next instanceof Date) return (prev instanceof Date && prev.getTime() === next.getTime() ? prev : next) as T
  if (isPlain(next) && isPlain(prev)) return shareObject(prev, next) as T
  return next
}
