// Files chosen in the new-workspace dialog: staged before the worktree exists, attached when the first message goes.
import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Core } from '../src/main/core'
import { stageAttachment } from '../src/main/files'
import { SecretStore } from '../src/main/secrets'
import { Store } from '../src/main/store'
import type { Session, Workspace } from '../src/shared/types'
import { tempDir } from './helpers'

afterEach(() => vi.restoreAllMocks())

async function setup(state: Workspace['state']) {
  const dir = await tempDir('foreman-first-files-')
  const store = new Store(dir)
  await store.load()
  vi.spyOn(store, 'save').mockImplementation(() => {})
  const secrets = new SecretStore(path.join(dir, 'secrets.bin'), { available: () => false, encrypt: () => Buffer.from(''), decrypt: () => '' })
  const core = new Core(store, secrets, {
    broadcast() {}, applyTheme() {}, pickDirectory: async () => null, pickFiles: async () => [], pickPath: async () => null,
    openPath: async () => {}, openExternal: async () => {}, setBadge() {}, setZoom() {}, keepAwake() {},
    metrics: () => ({ cpuPercent: 0, memoryMb: 0 }), cliShim: () => ''
  })
  const wsDir = await tempDir('foreman-first-files-ws-')
  const ws: Workspace = {
    id: 'ws', repoId: 'repo', name: 'ws', branch: 'b', baseBranch: 'main', path: wsDir, portBase: 50040, state, createdAt: new Date().toISOString()
  }
  store.state.workspaces.push(ws)
  store.state.sessions.push({ id: 's1', workspaceId: 'ws' } as Session)
  const send = vi.spyOn(core.sessions, 'send').mockResolvedValue('started')
  const internals = core as unknown as { firstMessages: Map<string, unknown>; sendFirstMessages(): void; stagingDir: string }
  const staged = await tempDir('foreman-first-files-staged-')
  internals.stagingDir = staged
  const hold = (files: string[], text = 'look') => internals.firstMessages.set('ws', { sessionId: 's1', text, files })
  return { core, ws, wsDir, send, hold, flush: () => internals.sendFirstMessages(), staged }
}

/** The send's attachments, once the async copy has happened. */
async function sentAttachments(send: ReturnType<typeof vi.spyOn>) {
  await vi.waitFor(() => expect(send).toHaveBeenCalled())
  return (send.mock.calls[0][2] as { attachments: { name: string; path: string; kind: string }[] }).attachments
}

describe('first-message files', () => {
  it('stages pasted data in its own folder under the staging dir', async () => {
    const root = await tempDir('foreman-stage-')
    const a = await stageAttachment(root, 'image.png', Buffer.from('one').toString('base64'))
    const b = await stageAttachment(root, 'image.png', Buffer.from('two').toString('base64'))
    expect(a).not.toBe(b)
    expect(path.dirname(path.dirname(a))).toBe(root)
    expect(await readFile(a, 'utf8')).toBe('one')
    expect(await readFile(b, 'utf8')).toBe('two')
  })

  it('copies the files into the workspace and sends them with the message', async () => {
    const { wsDir, send, hold, flush, staged } = await setup('ready')
    const shot = await stageAttachment(staged, 'shot.png', Buffer.from('png').toString('base64'))
    hold([shot])
    flush()
    const [attachment] = await sentAttachments(send)
    expect(send.mock.calls[0][1]).toBe('look')
    expect(attachment).toMatchObject({ name: 'shot.png', kind: 'image' })
    expect(attachment.path.startsWith(path.join(wsDir, '.context', 'attachments'))).toBe(true)
    expect(await readFile(attachment.path, 'utf8')).toBe('png')
    // The staged copy goes once it is in the workspace.
    await vi.waitFor(() => expect(existsSync(path.dirname(shot))).toBe(false))
  })

  it('leaves files chosen from disk where they are', async () => {
    const { send, hold, flush } = await setup('ready')
    const own = path.join(await tempDir('foreman-own-'), 'notes.md')
    await writeFile(own, '# notes')
    hold([own])
    flush()
    const [attachment] = await sentAttachments(send)
    expect(attachment).toMatchObject({ name: 'notes.md', kind: 'text' })
    expect(existsSync(own)).toBe(true)
  })

  it('sends files with no text', async () => {
    const { core, send, flush, staged } = await setup('ready')
    const shot = await stageAttachment(staged, 'shot.png', Buffer.from('png').toString('base64'))
    // Through startChat, which used to drop a first message without text.
    ;(core as unknown as { startChat(...args: unknown[]): string }).startChat('ws', '', undefined, undefined, undefined, undefined, [shot])
    flush()
    const attachments = await sentAttachments(send)
    expect(send.mock.calls[0][1]).toBe('')
    expect(attachments).toHaveLength(1)
  })

  it('skips a file that has gone missing instead of losing the message', async () => {
    const { send, hold, flush, staged } = await setup('ready')
    const shot = await stageAttachment(staged, 'shot.png', Buffer.from('png').toString('base64'))
    hold([path.join(staged, 'gone', 'missing.png'), shot])
    flush()
    const attachments = await sentAttachments(send)
    expect(attachments.map((a) => a.name)).toEqual(['shot.png'])
  })

  it('keeps the files through a failed setup and Start anyway', async () => {
    const { core, ws, send, hold, flush, staged } = await setup('setup-failed')
    const shot = await stageAttachment(staged, 'shot.png', Buffer.from('png').toString('base64'))
    hold([shot])
    flush()
    expect(send).not.toHaveBeenCalled()
    expect(ws.heldMessage?.files).toEqual([shot])
    await core.startHeldMessage('ws')
    const [attachment] = await sentAttachments(send)
    expect(attachment.name).toBe('shot.png')
  })
})
