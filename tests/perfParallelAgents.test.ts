// Load benchmark (main side): twelve workspaces, each with a running turn streaming a long reply in small deltas at the
// agents' 50 ms preview cadence, with tool calls between its text blocks. Everything is counted through the Host's
// broadcast, so it measures what the window is really sent. The clock is simulated and all turns move in lockstep, so
// the counts are the same on every run and every machine; nothing here measures wall-clock time.
// Guards (docs/performance.md): streaming text sends appends, not the whole growing block (bytes stay linear in the
// text), and text deltas never cause state broadcasts (only real changes do, coalesced across the twelve turns).
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { claudeDriver } from '../src/main/agents/claude'
import { registerDriver } from '../src/main/agents/registry'
import { Core } from '../src/main/core'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import { RESYNC_MS } from '../src/shared/chatAppend'
import type { MainEvent, Repo, Workspace } from '../src/shared/types'
import { fakeDriver } from './sessionHarness'
import { makeRepo, tempDir } from './helpers'

const AGENTS = 12
const BLOCKS = 4
// 20 KB per reply: four 5 KB text blocks with a tool call after each of the first three.
const BLOCK_CHARS = 5_000
// About 500 characters a second at one preview per 50 ms, a fast agent.
const DELTA_CHARS = 25
const FRAME_MS = 50

afterEach(() => {
  registerDriver(claudeDriver)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** The simulated 50 ms cadence: each turn waits for the next frame; the test moves the clock and releases them all. */
function frames() {
  let waiting: (() => void)[] = []
  return {
    next: () => new Promise<void>((resolve) => waiting.push(resolve)),
    waiting: () => waiting.length,
    release() {
      const now = waiting
      waiting = []
      for (const resolve of now) resolve()
      return now.length
    }
  }
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

function chunk(i: number): string {
  const words = 'the quick brown fox jumps over the lazy dog while agents stream '
  const start = (i * 7) % words.length
  return (words + words).slice(start, start + DELTA_CHARS)
}

async function setup() {
  const dir = await tempDir('foreman-perf-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  // Available: each turn's report token key lives in the vault.
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => true, encrypt: (s: string) => Buffer.from(s), decrypt: (b: Buffer) => b.toString() })
  const events: MainEvent[] = []
  const core = new Core(store, secrets, {
    broadcast: (event: MainEvent) => events.push(event), applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  core.attention.stop()
  // A turn's start doesn't wait on the test machine's gh.
  vi.spyOn(core.environment, 'githubReady').mockResolvedValue()
  const roots = await Promise.all(Array.from({ length: AGENTS }, () => makeRepo()))
  const sessions = roots.map((root, i) => {
    const repo = { id: `repo-${i}`, name: `repo-${i}`, rootPath: root, defaultBranch: 'main', remote: 'origin', hasOrigin: false, local: {}, createdAt: new Date().toISOString() } as Repo
    const ws: Workspace = { id: `ws-${i}`, repoId: repo.id, name: `ws-${i}`, branch: 'main', baseBranch: 'main', path: root, portBase: 51000 + i * 10, state: 'ready', createdAt: new Date().toISOString() }
    store.state.repos.push(repo)
    store.state.workspaces.push(ws)
    return core.sessions.createSession(ws.id, { agent: 'claude', title: `agent ${i}` })
  })
  await Promise.resolve()
  core.flushState()
  return { core, store, events, sessions }
}

describe('twelve agents streaming at once (main)', () => {
  it('sends appends for streaming text and broadcasts the state only for real changes', async () => {
    const { core, store, events, sessions } = await setup()
    const frame = frames()
    // What the turns did, to compare the broadcasts with.
    let previews = 0
    let previewChars = 0
    let streamedChars = 0
    let usageUpdates = 0
    const usageFrames = new Set<number>()
    let frameNo = 0

    registerDriver(fakeDriver(async (req, cb) => {
      const { turnId } = req
      for (let b = 0; b < BLOCKS; b++) {
        const id = `${turnId}:text-${b}`
        let text = ''
        for (let i = 0; text.length < BLOCK_CHARS; i++) {
          await frame.next()
          text += chunk(i)
          previews++
          previewChars += text.length
          cb.item({ kind: 'assistant', id, turnId, text, streaming: true }, true)
        }
        streamedChars += text.length
        cb.item({ kind: 'assistant', id, turnId, text })
        // A real state change at the end of each block, which every turn makes in the same frame.
        cb.usage({ used: (b + 1) * 10_000, limit: 200_000 })
        usageUpdates++
        usageFrames.add(frameNo)
        if (b < BLOCKS - 1) {
          const tool = { kind: 'tool' as const, id: `${turnId}:tool-${b}`, turnId, name: 'Read', input: { file_path: `src/file-${b}.ts` } }
          cb.item({ ...tool, status: 'running' })
          await frame.next()
          cb.item({ ...tool, status: 'done', output: 'x'.repeat(400) })
        }
      }
      cb.finished({ ok: true })
    }))

    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-27T10:00:00Z'))
    for (const [i, s] of sessions.entries()) expect(await core.sessions.send(s.id, `task ${i}`)).toBe('started')
    // Each start saves a real git checkpoint; streaming begins once all twelve are waiting for their first frame.
    await vi.waitFor(() => expect(frame.waiting()).toBe(AGENTS), { timeout: 60_000, interval: 20 })
    await settle()
    core.flushState()
    events.length = 0

    // Every frame: the clock moves 50 ms and each running turn sends its next preview.
    while (frame.waiting()) {
      vi.setSystemTime(Date.now() + FRAME_MS)
      frameNo++
      frame.release()
      await settle()
      if (!frame.waiting()) await vi.waitFor(() => expect(frame.waiting() > 0 || sessions.every((s) => s.status === 'idle')).toBe(true))
    }
    const streaming = [...events]
    vi.useRealTimers()
    await vi.waitFor(() => expect(store.state.sessions.filter((s) => s.lastTurn?.outcome === 'completed')).toHaveLength(AGENTS), { timeout: 60_000, interval: 20 })

    const bytes = (e: MainEvent) => Buffer.byteLength(JSON.stringify(e))
    const chat = streaming.filter((e) => e.type === 'chat-item' || e.type === 'chat-append')
    const appends = streaming.filter((e): e is Extract<MainEvent, { type: 'chat-append' }> => e.type === 'chat-append')
    const states = streaming.filter((e) => e.type === 'state')
    const chatBytes = chat.reduce((n, e) => n + bytes(e), 0)
    const stateBytes = states.reduce((n, e) => n + bytes(e), 0)
    const maxEventBytes = Math.max(...streaming.map(bytes))
    // The reply text the chat events carry: the appends' new text, and whole blocks (first previews, resyncs, saved items).
    const appendChars = appends.reduce((n, e) => n + e.text.length, 0)
    const wholeChars = chat.reduce((n, e) => n + (e.type === 'chat-item' && e.item.kind === 'assistant' ? e.item.text.length : 0), 0)
    const envelope = (chatBytes - appendChars - wholeChars) / chat.length
    const resyncs = previews - appends.length

    console.info(
      `[perf] main, ${AGENTS} agents x ${(BLOCKS * BLOCK_CHARS) / 1000} KB in ${DELTA_CHARS}-char deltas: ${frameNo} frames, ${previews} previews -> ${appends.length} appends + ${resyncs} whole; ` +
      `chat events ${(chatBytes / 1024).toFixed(0)} KB for ${(streamedChars / 1024).toFixed(0)} KB of text (${(chatBytes / streamedChars).toFixed(2)}x): ` +
      `text carried ${((appendChars + wholeChars) / streamedChars).toFixed(2)}x, envelope ${envelope.toFixed(0)} B/event; ` +
      `whole previews would carry ${(previewChars / 1024 / 1024).toFixed(1)} MB of text; ` +
      `${states.length} state broadcasts (${(stateBytes / 1024).toFixed(0)} KB) for ${usageUpdates} usage updates in ${usageFrames.size} frames; largest event ${(maxEventBytes / 1024).toFixed(1)} KB`
    )

    expect(streamedChars).toBe(AGENTS * BLOCKS * BLOCK_CHARS)
    // Appends: after a block's first preview only its new text goes, so the appends carry each character at most once...
    expect(appendChars).toBeLessThanOrEqual(streamedChars)
    // ...and the block goes whole again only once per RESYNC_MS (for a listener that missed an append), and once saved.
    const resyncBound = AGENTS * BLOCKS * (Math.ceil(((BLOCK_CHARS / DELTA_CHARS) * FRAME_MS) / RESYNC_MS) + 1)
    expect(resyncs).toBeLessThanOrEqual(resyncBound)
    // Linear in the text. Measured: the text carried 4.0x (1x appends, 2x resyncs of a 5 KB block every 2 s, 1x saved),
    // ~155 bytes of envelope per event. Sending each preview whole carries ~100x here, and grows with each block's length.
    expect(appendChars + wholeChars).toBeLessThan(streamedChars * 6)
    expect(envelope).toBeLessThan(256)
    expect(chatBytes).toBeLessThan(previewChars / 5)
    // Text deltas never broadcast the state: only the usage updates do, one broadcast per frame for all twelve turns.
    expect(states.length).toBeGreaterThan(0)
    expect(states.length).toBeLessThanOrEqual(usageFrames.size * 2 + 2)
    // No single event is a large structured clone: the state snapshot of twelve workspaces stays small.
    expect(maxEventBytes).toBeLessThan(256 * 1024)
  }, 120_000)
})
