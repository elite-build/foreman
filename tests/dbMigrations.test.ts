// foreman.db's migrations (src/main/db.ts SCHEMA) once shipped are never edited (AGENTS.md, "Data"): an install that
// already ran one never runs it again, so an edit reaches new installs only and the two drift apart. This pins every
// shipped migration by a hash of its text. A schema change is a new entry at the end of SCHEMA, which passes; add its
// hash (the test run prints it) at the end of SHIPPED below in the same pull request, so it is pinned once it ships.
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { SCHEMA, SCHEMA_VERSION } from '../src/main/db'

// The first 16 hex digits of the SHA-256 of each migration's text (line endings as LF), in order.
const SHIPPED = [
  '9ba8962caa7b0d9b',
  'd16f759d080305ff',
  'a8d51d67d1e9665b',
  'e39e46c3db3cd578',
  'af094f8486eef61b',
  '70b97fdc1804dbfd',
  '5ed1a1a11ebe7813',
  'eb08e006c0d3df9c',
  'b7b627543fbbaa59',
  'c133d274679921f9',
  'ba3ecae152210e79',
  '54698731ea30d407',
  '8e5c8115bac5db90',
  '4e9d8dae9bf7c5ed'
]

const hash = (sql: string) => createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)

describe('foreman.db migrations', () => {
  it('never changes or removes a shipped migration', () => {
    expect(SCHEMA.length, `SCHEMA has ${SCHEMA.length} migrations but ${SHIPPED.length} have shipped: a shipped migration was removed. Restore it; undo its effect in a new migration at the end instead.`).toBeGreaterThanOrEqual(SHIPPED.length)
    const changed = SHIPPED.flatMap((pinned, i) => (hash(SCHEMA[i]) === pinned ? [] : [i]))
    expect(changed, `Shipped migration${changed.length === 1 ? '' : 's'} ${changed.map((i) => `#${i + 1} (SCHEMA[${i}])`).join(', ')} changed. Installs that already ran ${changed.length === 1 ? 'it' : 'them'} never run ${changed.length === 1 ? 'it' : 'them'} again, so put the edit back and append a new migration at the end of SCHEMA in src/main/db.ts that makes the change.`).toEqual([])
  })

  it('allows new migrations at the end, and says which hash to pin for each', () => {
    const added = SCHEMA.slice(SHIPPED.length).map(hash)
    // Not a failure: a migration on a branch may still change before it ships. Pin it in the same pull request.
    if (added.length) console.warn(`New migration${added.length === 1 ? '' : 's'} at the end of SCHEMA. Before it ships, add ${added.map((h) => `'${h}'`).join(', ')} at the end of SHIPPED in tests/dbMigrations.test.ts.`)
    expect(SCHEMA_VERSION).toBe(SCHEMA.length)
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(SHIPPED.length)
  })
})
