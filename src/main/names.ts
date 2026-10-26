import { WORKSPACE_PEOPLE } from '../shared/workspacePeople'

// The same local catalog supplies branch names and the session introduction.
const NAMES = WORKSPACE_PEOPLE.map((person) => person.name)

/** Pick a name not in `taken`; append -2, -3, … once every name is used. */
export function pickWorkspaceName(taken: Iterable<string>, random: () => number = Math.random): string {
  const used = new Set(taken)
  const free = NAMES.filter((name) => !used.has(name))
  if (free.length > 0) return free[Math.floor(random() * free.length)]
  for (let n = 2; ; n++) {
    const base = NAMES[Math.floor(random() * NAMES.length)]
    if (!used.has(`${base}-${n}`)) return `${base}-${n}`
  }
}
