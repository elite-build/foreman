import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_LIMITS, ExportFileError, decrypt, encrypt, pack, parse } from '../src/main/exportFile'
import { git } from '../src/main/git'
import { normalizeRemoteUrl, unsafeEntryPath, type ImportPreview } from '../src/shared/portable'
import type { ChatItem } from '../src/shared/types'
import { makeRepo, tempDir } from './helpers'
import { machine, seed, type Machine } from './portabilityRig'

const stage = async (m: Machine, file: string, passphrase?: string) => {
  const result = await m.portability.stage(file, passphrase)
  if (result.kind !== 'staged') throw new Error('expected a staged import')
  return result.preview
}

describe('export and import', () => {
  it('round-trips a selected share into a history-only workspace', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'dakar.foreman')
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    expect(summary).toMatchObject({ encrypted: false, chats: 2, attachments: 1 })
    // Reviewed chats only, no tool output unless asked, no native handles.
    const raw = (await readFile(out)).toString('latin1')
    expect(raw).not.toContain('SECRET-OUTPUT')
    expect(raw).not.toContain('native-1')
    // No machine path: neither the data folder nor the workspace folder.
    expect(raw).not.toContain(src.dataDir)
    expect(raw).not.toContain(ws.path!)

    const dst = await machine({ name: 'Studio' })
    const preview = await stage(dst, out)
    expect(preview).toMatchObject({ version: 1, mode: 'share', sourceMachine: 'MacBook Air', workspace: { name: 'dakar', branch: 'feat/dakar' }, missingAttachments: [], attachments: 1 })
    expect(preview.tabs.map((t) => t.title)).toEqual(['Fix login', 'Tests'])
    // Suggested by remote URL and root commit, but nothing is chosen for the user.
    expect(preview.suggested.map((o) => [o.repoId, o.reasons])).toEqual([[dst.repo.id, ['remote', 'root commit']]])
    expect(preview.suggested[0].branchExists).toBe(false)
    expect(dst.store.state.workspaces).toHaveLength(0)

    const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id, tabs: { 'sess-1': 'fresh' } })
    expect(imported).toMatchObject({ id: 'ws-1', state: 'history', name: 'dakar', repoId: dst.repo.id })
    expect(imported.path).toBeUndefined()
    expect(imported.provenance).toMatchObject({ exportId: summary.exportId, sourceMachine: 'MacBook Air' })
    const [a, b] = dst.store.state.sessions
    expect([a.importedMode, b.importedMode]).toEqual(['fresh', 'history'])
    expect(a).toMatchObject({ nativeLineage: 'foreign', status: 'idle', queue: [] })
    expect(a.agentSessionId).toBeUndefined()
    expect(a.lastAssistantUuid).toBeUndefined()
    expect(a.resumeAt).toBeUndefined()

    const items = await dst.store.readChat('sess-1')
    // The latest version of each message, not the superseded draft.
    expect(items.find((i) => i.id === 'a1')).toMatchObject({ text: 'final answer' })
    const user = items.find((i) => i.kind === 'user')!
    expect(user).not.toHaveProperty('resumeFrom')
    const attachment = (user as Extract<ChatItem, { kind: 'user' }>).attachments![0]
    expect(await readFile(attachment.path, 'utf8')).toBe('attached text\n')
    expect(attachment.path.startsWith(dst.dataDir)).toBe(true)
    expect(items.find((i) => i.kind === 'tool')).not.toHaveProperty('output')
    // Quarantine is gone once imported, and the comment came along as already sent.
    expect(existsSync(path.join(dst.dataDir, 'quarantine', preview.stageId))).toBe(false)
    expect(dst.store.state.comments).toMatchObject([{ id: 'c1', workspaceId: 'ws-1', state: 'sent' }])
  })

  it('preserves exported account choices as unresolved references instead of using the destination defaults', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    src.store.state.integrations = { connections: [], defaults: { linear: 'work-linear' }, rules: [], people: [] }
    src.repo.integrations = { services: { github: 'off' } }
    const out = path.join(await tempDir(), 'work.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const dst = await machine()
    dst.store.state.integrations = { connections: [], defaults: { linear: 'personal-linear' }, rules: [], people: [] }
    const preview = await stage(dst, out)
    await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    expect(dst.repo.integrations?.services).toEqual({ github: 'off', linear: 'imported:work-linear', slack: 'off', langfuse: 'off' })
  })

  it('keeps tool output when the share asks for it', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', includeToolOutput: true, sessionIds: ['sess-1'], outPath: out })
    const dst = await machine()
    const preview = await stage(dst, out)
    expect(preview.tabs).toHaveLength(1)
    await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    expect((await dst.store.readChat('sess-1')).find((i) => i.kind === 'tool')).toMatchObject({ output: 'SECRET-OUTPUT' })
  })

  it('encrypts a backup, and a wrong passphrase gets nothing', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    src.setVars([{ scope: 'repo', name: 'API_TOKEN' }, { scope: 'user', name: 'OPENAI_KEY' }])
    const out = path.join(await tempDir(), 'dakar.foreman')
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'correct horse', outPath: out })
    expect(summary).toMatchObject({ encrypted: true, variables: 2 })
    const bytes = (await readFile(out)).toString('latin1')
    expect(bytes).not.toContain('please fix')
    expect(bytes).not.toContain('dakar')

    const dst = await machine()
    expect(await dst.portability.stage(out)).toEqual({ kind: 'needs-passphrase' })
    await expect(dst.portability.stage(out, 'wrong')).rejects.toMatchObject({ code: 'bad-passphrase' })
    const preview = await stage(dst, out, 'correct horse')
    // Names only: the preview asks for the variables, and holds no values.
    expect(preview.variables.map((v) => v.name).sort()).toEqual(['API_TOKEN', 'OPENAI_KEY'])
    expect(preview.variablesToSet).toBe(2)
    const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    expect(imported.variablesToSet?.sort()).toEqual(['API_TOKEN', 'OPENAI_KEY'])
    expect(preview.mode).toBe('backup')
  })

  it('detects a changed file, plain or encrypted', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const dir = await tempDir()
    const plain = path.join(dir, 'share.foreman')
    const sealed = path.join(dir, 'backup.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: plain })
    await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', outPath: sealed })
    const dst = await machine()

    const flipped = await readFile(plain)
    flipped[flipped.length - 3] ^= 0xff
    await writeFile(plain, flipped)
    await expect(dst.portability.stage(plain)).rejects.toMatchObject({ code: 'tampered' })

    const sealedBytes = await readFile(sealed)
    sealedBytes[sealedBytes.length - 40] ^= 0xff
    await writeFile(sealed, sealedBytes)
    await expect(dst.portability.stage(sealed, 'pw')).rejects.toMatchObject({ code: 'bad-passphrase' })
    expect(await readdir(path.join(dst.dataDir, 'quarantine')).catch(() => [])).toEqual([])
  })

  it('refuses path traversal, absolute paths and links before extracting anything', async () => {
    const good = pack({ exportId: 'e', createdAt: 'now', sourceMachine: 'm', mode: 'share', workspaceName: 'w' }, [{ path: 'workspace.json', data: Buffer.from('{}') }])
    const rewrite = (change: (entry: Record<string, unknown>) => void) => {
      const headerLength = good.readUInt32BE(5)
      const header = JSON.parse(good.subarray(9, 9 + headerLength).toString()) as { entries: Record<string, unknown>[] }
      change(header.entries[0])
      const next = Buffer.from(JSON.stringify(header))
      const length = Buffer.alloc(4)
      length.writeUInt32BE(next.length)
      return Buffer.concat([good.subarray(0, 5), length, next, good.subarray(9 + headerLength)])
    }
    for (const bad of ['../evil', 'a/../../evil', '/etc/passwd', 'C:/x', 'a\\b', 'a//b', './a', 'a:b']) {
      expect(unsafeEntryPath(bad)).not.toBeNull()
      expect(() => parse(rewrite((e) => (e.path = bad)))).toThrow(expect.objectContaining({ code: 'unsafe' }))
    }
    expect(() => parse(rewrite((e) => (e.type = 'symlink')))).toThrow(expect.objectContaining({ code: 'unsafe' }))
    expect(() => pack({ exportId: 'e', createdAt: 'now', sourceMachine: 'm', mode: 'share', workspaceName: 'w' }, [{ path: '../x', data: Buffer.alloc(1) }])).toThrow()
    // Nothing was written outside the quarantine folder.
    const dst = await machine()
    const evil = path.join(await tempDir(), 'evil.foreman')
    await writeFile(evil, rewrite((e) => (e.path = '../escape')))
    await expect(dst.portability.stage(evil)).rejects.toMatchObject({ code: 'unsafe' })
    expect(existsSync(path.join(dst.dataDir, 'escape'))).toBe(false)
  })

  it('applies extraction limits', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const dst = await machine({ limits: { ...DEFAULT_LIMITS, entries: 3 } })
    await expect(dst.portability.stage(out)).rejects.toMatchObject({ code: 'too-large' })
    const small = await machine({ limits: { ...DEFAULT_LIMITS, totalBytes: 10 } })
    await expect(small.portability.stage(out)).rejects.toMatchObject({ code: 'too-large' })
  })

  it('rejects an unsupported version, and files that are not exports', async () => {
    const good = pack({ exportId: 'e', createdAt: 'now', sourceMachine: 'm', mode: 'share', workspaceName: 'w' }, [])
    const headerLength = good.readUInt32BE(5)
    const header = JSON.parse(good.subarray(9, 9 + headerLength).toString()) as { version: number; manifest: { version: number } }
    header.version = 2
    header.manifest.version = 2
    const next = Buffer.from(JSON.stringify(header))
    const length = Buffer.alloc(4)
    length.writeUInt32BE(next.length)
    const future = Buffer.concat([good.subarray(0, 5), length, next])
    expect(() => parse(future)).toThrow(expect.objectContaining({ code: 'unsupported-version', message: expect.stringContaining('Update Foreman') }))
    expect(() => parse(Buffer.from('hello there, not an export'))).toThrow(expect.objectContaining({ code: 'not-an-export' }))
    const sealed = await encrypt(good, 'pw')
    expect(parse(await decrypt(sealed, 'pw')).manifest.exportId).toBe('e')
    await expect(decrypt(sealed, '')).rejects.toMatchObject({ code: 'needs-passphrase' })
    expect(ExportFileError).toBeDefined()
  })

  it('offers open-existing or a copy for the same export, and a copy remaps every reference', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', outPath: out })

    // Importing into the machine it came from: the workspace is already here.
    const same = await stage(src, out, 'pw')
    expect(same.duplicate).toMatchObject({ workspaceId: 'ws-1', reason: 'workspace' })
    await expect(src.portability.importStaged(same.stageId, { repoId: src.repo.id })).rejects.toThrow(/import as a copy/)

    const dst = await machine()
    const first = await dst.portability.importStaged((await stage(dst, out, 'pw')).stageId, { repoId: dst.repo.id })
    const again = await stage(dst, out, 'pw')
    expect(again.duplicate).toMatchObject({ workspaceId: first.id, reason: 'export' })
    await expect(dst.portability.importStaged(again.stageId, { repoId: dst.repo.id })).rejects.toThrow(/already here/)
    const dupCount = dst.store.state.workspaces.length

    const staged = await stage(dst, out, 'pw')
    const copy = await dst.portability.importStaged(staged.stageId, { repoId: dst.repo.id, asCopy: true })
    expect(dst.store.state.workspaces).toHaveLength(dupCount + 1)
    expect(copy.id).not.toBe(first.id)
    expect(copy.name).toBe('dakar (copy)')
    const copied = dst.store.state.sessions.filter((s) => s.workspaceId === copy.id)
    expect(copied).toHaveLength(2)
    for (const s of copied) expect(['sess-1', 'sess-2']).not.toContain(s.id)
    const fix = copied.find((s) => s.title === 'Fix login')!
    const items = await dst.store.readChat(fix.id)
    const user = items.find((i) => i.kind === 'user') as Extract<ChatItem, { kind: 'user' }>
    // The checkpoint ref names the chat it was saved for, so it follows the new id.
    expect(user.checkpoint).toBe(`${fix.id}-t1-start`)
    expect(user.attachments![0].path).toContain(copy.id)
    expect(await readFile(user.attachments![0].path, 'utf8')).toBe('attached text\n')
    // The first import is untouched.
    expect((await dst.store.readChat('sess-1')).find((i) => i.kind === 'user')).toMatchObject({ checkpoint: 'sess-1-t1-start' })
    const comments = dst.store.state.comments.filter((c) => c.workspaceId === copy.id)
    expect(comments).toHaveLength(1)
    expect(comments[0].id).not.toBe('c1')
    expect(copy.provenance?.exportId).toBe(first.provenance?.exportId)
  })

  it('reports an attachment whose file was gone, and keeps it visible', async () => {
    const src = await machine()
    const { ws, attachmentPath } = await seed(src)
    await rm(attachmentPath)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const dst = await machine()
    const preview = await stage(dst, out)
    expect(preview.missingAttachments).toEqual(['notes.txt'])
    expect(preview.attachments).toBe(0)
    await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    const user = (await dst.store.readChat('sess-1')).find((i) => i.kind === 'user') as Extract<ChatItem, { kind: 'user' }>
    expect(user.attachments![0]).toMatchObject({ name: 'notes.txt' })
    expect(existsSync(user.attachments![0].path)).toBe(false)
  })

  it('chooses attachments for a share and leaves them out on request', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', includeAttachments: false, outPath: out })
    const preview = await stage(await machine(), out)
    expect(preview.attachments).toBe(0)
    expect(preview.missingAttachments).toEqual(['notes.txt'])
  })

  it('lists the chats for review', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const info = await src.portability.exportInfo(ws.id)
    expect(info.chats).toMatchObject([
      { id: 'sess-1', title: 'Fix login', messages: 2, toolCalls: 1, attachments: 1 },
      { id: 'sess-2', title: 'Tests', messages: 1, toolCalls: 0 }
    ])
  })

  it('activates only when the branch exists here, and says why when it does not', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const dst = await machine()
    const imported = await dst.portability.importStaged((await stage(dst, out)).stageId, { repoId: dst.repo.id })
    await expect(dst.workspaces.activateWorkspace(imported.id)).rejects.toThrow(/stays history only/)
    expect(imported.state).toBe('history')
    expect(imported.path).toBeUndefined()

    await git(dst.repoDir, ['branch', 'feat/dakar'])
    await dst.workspaces.activateWorkspace(imported.id)
    for (let i = 0; i < 100 && imported.state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(imported.state).toBe('ready')
    expect(existsSync(imported.path!)).toBe(true)
    await mkdir(path.join(imported.path!, 'x'), { recursive: true })
  })

  it('suggests repositories by remote and root commit, never by name alone', async () => {
    expect(normalizeRemoteUrl('git@github.com:Acme/App.git')).toBe('github.com/acme/app')
    expect(normalizeRemoteUrl('https://user:tok@github.com/acme/app/')).toBe('github.com/acme/app')
    expect(normalizeRemoteUrl('ssh://git@github.com:22/acme/app.git')).toBe('github.com/acme/app')
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'a.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    // Same name, unrelated history and remote: not suggested.
    const other = await makeRepo({ 'x.txt': 'x\n' })
    const dst = await machine({ repoDir: other })
    await git(other, ['remote', 'set-url', 'origin', 'https://example.com/other/thing.git'])
    dst.repo.remoteUrl = 'https://example.com/other/thing.git'
    const preview = await stage(dst, out)
    expect(preview.suggested).toEqual([])
    expect(preview.repos).toHaveLength(1)
  })
})

describe('import presentation helpers', () => {
  it('shows tool paths relative to the source root and labels the import button from the choices', async () => {
    const { relativeToRoots, toolRoots, importLabel } = await import('../src/shared/portable')
    const roots = toolRoots({ path: undefined, provenance: { sourceRoot: '/Users/a/ws/dakar' } })
    expect(relativeToRoots('/Users/a/ws/dakar/src/x.ts', roots)).toBe('src/x.ts')
    expect(relativeToRoots('/Users/a/ws/dakar-2/x.ts', roots)).toBe('/Users/a/ws/dakar-2/x.ts')
    expect(relativeToRoots('C:\\work\\repo\\src\\x.ts', 'C:\\work\\repo')).toBe('src/x.ts')
    expect(relativeToRoots('C:\\work\\repo-other\\x.ts', 'C:\\work\\repo')).toBe('C:\\work\\repo-other\\x.ts')
    expect(relativeToRoots('/work/repo/src/back\\slash.ts', '/work/repo')).toBe('src/back\\slash.ts')
    expect(importLabel(['fresh', 'history', 'history'])).toBe('Import (1 fresh, 2 history)')
    expect(importLabel(['history'])).toBe('Import (1 history)')
  })

  it('rewrites structured tool paths to workspace-relative and writes no source path', async () => {
    const src = await machine()
    const { ws, s1 } = await seed(src)
    await src.store.appendChat(s1.id, { kind: 'tool', id: 'x2', turnId: 't1', name: 'Read', input: { file_path: path.join(ws.path!, 'src/x.ts') }, status: 'done' })
    await src.store.appendChat(s1.id, { kind: 'tool', id: 'x3', turnId: 't1', name: 'Grep', input: { pattern: 'a', path: ws.path }, status: 'done' })
    await src.store.appendChat(s1.id, { kind: 'tool', id: 'x4', turnId: 't1', name: 'Read', input: { file_path: '/Users/someone/else/y.ts' }, status: 'done' })
    for (const mode of ['share', 'backup'] as const) {
      const out = path.join(await tempDir(), `${mode}.foreman`)
      await src.portability.exportWorkspace(ws.id, { mode, outPath: out, passphrase: 'pw', includeToolOutput: true })
      const dst = await machine({ name: 'Studio' })
      const preview = mode === 'share' ? await stage(dst, out) : ((await dst.portability.stage(out, 'pw')) as { kind: 'staged'; preview: ImportPreview }).preview
      const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
      expect(imported.provenance?.sourceRoot).toBeUndefined()
      const items = await dst.store.readChat(dst.store.state.sessions[0].id)
      const inputs = items.filter((i) => i.kind === 'tool').map((i) => (i as { input: Record<string, unknown> }).input)
      expect(inputs).toContainEqual({ file_path: 'src/x.ts' })
      expect(inputs).toContainEqual({ pattern: 'a', path: '.' })
      expect(inputs).toContainEqual({ file_path: '(outside workspace)/y.ts' })
      if (mode === 'share') expect((await readFile(out)).toString('latin1')).not.toContain(ws.path!)
    }
  })

  it('still reads an older file whose manifest carries the source root', async () => {
    const src = await machine()
    const { ws } = await seed(src)
    const out = path.join(await tempDir(), 'new.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: out })
    const { manifest, entries } = parse(await readFile(out), DEFAULT_LIMITS)
    const old = path.join(await tempDir(), 'old.foreman')
    const { format: _f, version: _v, contentHash: _c, ...rest } = manifest
    void [_f, _v, _c]
    await writeFile(old, pack({ ...rest, pathsRelative: undefined, sourceRoot: ws.path }, entries.map((e) => ({ path: e.path, data: e.data }))))
    const dst = await machine({ name: 'Studio' })
    const preview = await stage(dst, old)
    const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    expect(imported.provenance?.sourceRoot).toBe(ws.path)
  })
})
