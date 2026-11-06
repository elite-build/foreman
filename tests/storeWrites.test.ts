import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { Store } from '../src/main/store'
import { tempDir } from './helpers'

// state.json is replaced by renaming a temporary file into place. A debounced save (async) and a synchronous flush
// (a flow run flushes before it launches) can overlap; each must use its own temporary file, the newer write must
// win, and nothing may be left behind or thrown.

async function loaded(): Promise<{ store: Store; dir: string }> {
  const dir = await tempDir('foreman-store-writes-')
  const store = new Store(dir)
  await store.load()
  return { store, dir }
}

const stateFile = (dir: string) => path.join(dir, 'state.json')
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.startsWith('state.json.') && f.endsWith('.tmp'))

describe('state.json writes', () => {
  it('a flush during an in-flight save neither throws nor leaves a temporary file, and the file stays valid JSON', async () => {
    const { store, dir } = await loaded()
    store.state.settings.language = 'de'
    const inFlight = (store as unknown as { writeState(): Promise<void> }).writeState()
    store.state.settings.language = 'fr'
    store.flush()
    await expect(inFlight).resolves.toBeUndefined()
    expect(JSON.parse(readFileSync(stateFile(dir), 'utf8')).settings.language).toBe('fr')
    expect(leftovers(dir)).toEqual([])
    store.close()
  })

  it('a save that finishes after a newer flush does not put older state over it', async () => {
    const { store, dir } = await loaded()
    store.state.settings.language = 'de'
    const older = (store as unknown as { writeState(): Promise<void> }).writeState()
    store.state.settings.language = 'ja'
    store.flush()
    await older
    expect(JSON.parse(readFileSync(stateFile(dir), 'utf8')).settings.language).toBe('ja')
    store.close()
  })

  it('two saves in flight at once each use their own file and the last one lands', async () => {
    const { store, dir } = await loaded()
    const write = () => (store as unknown as { writeState(): Promise<void> }).writeState()
    store.state.settings.language = 'de'
    const first = write()
    store.state.settings.language = 'ko'
    const second = write()
    await Promise.all([first, second])
    expect(JSON.parse(readFileSync(stateFile(dir), 'utf8')).settings.language).toBe('ko')
    expect(leftovers(dir)).toEqual([])
    store.close()
  })
})
