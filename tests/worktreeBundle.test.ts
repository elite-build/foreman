import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { git, gitOut } from '../src/main/git'
import { bundleSummary, dirtySubmodules, freeBranchName, incompatibleNames, lfsMissing } from '../src/shared/worktreeBundle'
import type { ImportPreview } from '../src/shared/portable'
import { commit, tempDir } from './helpers'
import { liveWorkspace, machine, type Machine } from './portabilityRig'

const IDENTITY = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false']

async function stage(m: Machine, file: string, passphrase?: string): Promise<ImportPreview> {
  const result = await m.portability.stage(file, passphrase)
  if (result.kind !== 'staged') throw new Error('expected staged')
  return result.preview
}

/** A workspace with a committed change, a staged change, an unstaged change, an untracked file and an ignored file. */
async function dirtyWorkspace(src: Machine) {
  const ws = await liveWorkspace(src)
  const dir = ws.path!
  await writeFile(path.join(dir, 'committed.txt'), 'committed\n')
  await git(dir, ['add', 'committed.txt'])
  await git(dir, [...IDENTITY, 'commit', '-q', '-m', 'on the branch'])
  await writeFile(path.join(dir, 'README.md'), 'edited but not committed\n')
  await writeFile(path.join(dir, 'staged.txt'), 'staged\n')
  await git(dir, ['add', 'staged.txt'])
  await writeFile(path.join(dir, 'untracked.txt'), 'untracked\n')
  await writeFile(path.join(dir, '.gitignore'), '*.log\n.env\n')
  await git(dir, ['add', '.gitignore'])
  await writeFile(path.join(dir, 'debug.log'), 'ignored\n')
  await writeFile(path.join(dir, '.env'), 'SECRET=1\n')
  return ws
}

async function waitReady(m: Machine, id: string) {
  await m.portability.restored(id)
  const ws = m.workspaces.workspace(id)
  for (let i = 0; i < 200 && (ws.state === 'creating' || ws.state === 'setting-up'); i++) await new Promise((r) => setTimeout(r, 50))
  return ws
}

describe('worktree bundle', () => {
  it('round-trips committed work, staged and unstaged edits and an untracked file, and activates without the branch', async () => {
    const src = await machine()
    const ws = await dirtyWorkspace(src)
    const out = path.join(await tempDir(), 'w.foreman')
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: out })
    expect(summary.worktree).toMatchObject({ status: 'included' })
    // Ignored files are listed as left behind, not packed.
    const raw = (await readFile(out)).toString('latin1')
    expect(raw).not.toContain('SECRET=1')
    expect(summary.worktree!.notes.map((n) => n.kind)).toContain('ignored')
    // Nothing is left behind in the source repository, and the source tree is untouched.
    expect(await gitOut(src.repoDir, ['for-each-ref', 'refs/switchyard-checkpoints'])).toBe('')
    expect(await readFile(path.join(ws.path!, 'README.md'), 'utf8')).toBe('edited but not committed\n')

    const dst = await machine({ name: 'Studio' })
    const preview = await stage(dst, out)
    expect(preview.worktree).toMatchObject({ branch: 'feat/live', files: 0 })
    expect(preview.worktree!.omitted.sort()).toEqual(['.env', 'debug.log'])
    expect(preview.repos[0].bundle).toEqual({ ok: true })
    expect(preview.suggested[0].branchExists).toBe(false)
    const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    expect(imported.state).toBe('history')
    expect(imported.carried).toMatchObject({ branch: 'feat/live' })

    await dst.portability.activate(imported.id)
    const live = await waitReady(dst, imported.id)
    expect(live.state).toBe('ready')
    expect(live.branch).toBe('feat/live')
    const dir = live.path!
    expect(await readFile(path.join(dir, 'committed.txt'), 'utf8')).toBe('committed\n')
    expect(await readFile(path.join(dir, 'README.md'), 'utf8')).toBe('edited but not committed\n')
    expect(await readFile(path.join(dir, 'untracked.txt'), 'utf8')).toBe('untracked\n')
    expect(existsSync(path.join(dir, '.env'))).toBe(false)
    // The index came back too: staged.txt is staged, README.md is not.
    expect((await gitOut(dir, ['diff', '--cached', '--name-only'])).split('\n').sort()).toEqual(['.gitignore', 'staged.txt'])
    expect(await gitOut(dir, ['rev-parse', 'HEAD'])).toBe(await gitOut(ws.path!, ['rev-parse', 'HEAD']))
    expect(live.carried).toBeUndefined()
    expect(await gitOut(dst.repoDir, ['for-each-ref', 'refs/switchyard-checkpoints'])).toBe('')
  })

  it('brings ignored files from the files-to-copy list only when asked', async () => {
    const src = await machine()
    const ws = await dirtyWorkspace(src)
    await writeFile(path.join(src.repoDir, '.worktreeinclude'), '.env\n')
    const info = await src.portability.exportInfo(ws.id)
    expect(info.worktree).toMatchObject({ available: true, copyFiles: 1 })
    const out = path.join(await tempDir(), 'w.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', includeCopyFiles: true, outPath: out })
    const dst = await machine()
    const staged = await dst.portability.stage(out, 'pw')
    if (staged.kind !== 'staged') throw new Error('staged')
    expect(staged.preview.worktree).toMatchObject({ files: 1, omitted: ['debug.log'] })
    const imported = await dst.portability.importStaged(staged.preview.stageId, { repoId: dst.repo.id })
    await dst.portability.activate(imported.id)
    const live = await waitReady(dst, imported.id)
    expect(await readFile(path.join(live.path!, '.env'), 'utf8')).toBe('SECRET=1\n')
  })

  it('refuses while a tab, check or run script is active', async () => {
    const src = await machine()
    const ws = await dirtyWorkspace(src)
    src.seams.busy = 'a run script is running'
    await expect(src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: path.join(await tempDir(), 'x.foreman') })).rejects.toThrow(/while a run script is running/)
    // Without the option nothing is captured and nothing is refused.
    const plain = await src.portability.exportWorkspace(ws.id, { mode: 'share', outPath: path.join(await tempDir(), 'y.foreman') })
    expect(plain.worktree).toBeUndefined()
  })

  it('fails the export when HEAD or the index moves during capture, and leaves no refs behind', async () => {
    const src = await machine()
    const ws = await dirtyWorkspace(src)
    src.seams.afterCheckpoint = async () => {
      await writeFile(path.join(ws.path!, 'late.txt'), 'late\n')
      await git(ws.path!, ['add', 'late.txt'])
    }
    const out = path.join(await tempDir(), 'x.foreman')
    await expect(src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: out })).rejects.toThrow(/changed while it was being captured/)
    expect(existsSync(out)).toBe(false)
    expect(await gitOut(ws.path!, ['for-each-ref', 'refs/switchyard-checkpoints'])).toBe('')
    // A moved HEAD is caught the same way.
    src.seams.afterCheckpoint = async () => {
      await git(ws.path!, [...IDENTITY, 'commit', '-q', '--allow-empty', '-m', 'sneaky'])
    }
    await expect(src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: out })).rejects.toThrow(/changed while it was being captured/)
  })

  it('gives a branch name clash a suffix and never moves the existing branch', async () => {
    const src = await machine()
    const ws = await dirtyWorkspace(src)
    const out = path.join(await tempDir(), 'w.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: out })
    const dst = await machine({ name: 'Studio' })
    await git(dst.repoDir, ['branch', 'feat/live'])
    await git(dst.repoDir, ['branch', 'feat/live-imported'])
    const before = await gitOut(dst.repoDir, ['rev-parse', 'feat/live'])
    const imported = await dst.portability.importStaged((await stage(dst, out)).stageId, { repoId: dst.repo.id })
    await dst.portability.activate(imported.id)
    const live = await waitReady(dst, imported.id)
    expect(live.state).toBe('ready')
    expect(live.branch).toBe('feat/live-imported-2')
    expect(await gitOut(dst.repoDir, ['rev-parse', 'feat/live'])).toBe(before)
    expect(await readFile(path.join(live.path!, 'untracked.txt'), 'utf8')).toBe('untracked\n')
  })

  it('says so when the bundle does not verify here, and creates nothing', async () => {
    const src = await machine()
    const ws = await liveWorkspace(src)
    const dir = ws.path!
    // The base moved on the source machine only: the bundle leaves that commit out, so the destination lacks a prerequisite.
    await writeFile(path.join(dir, 'x.txt'), 'x\n')
    await git(dir, ['add', '-A'])
    await git(dir, [...IDENTITY, 'commit', '-q', '-m', 'only here'])
    await git(src.repoDir, ['update-ref', 'refs/heads/main', await gitOut(dir, ['rev-parse', 'HEAD'])])
    await writeFile(path.join(dir, 'y.txt'), 'y\n')
    await git(dir, ['add', '-A'])
    await git(dir, [...IDENTITY, 'commit', '-q', '-m', 'on top'])
    const out = path.join(await tempDir(), 'w.foreman')
    await src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: out })
    const dst = await machine({ name: 'Studio' })
    const preview = await stage(dst, out)
    expect(preview.repos[0].bundle).toMatchObject({ ok: false, error: expect.stringMatching(/doesn’t have the history/) })
    const imported = await dst.portability.importStaged(preview.stageId, { repoId: dst.repo.id })
    await expect(dst.portability.activate(imported.id)).rejects.toThrow(/doesn’t have the history/)
    expect(dst.workspaces.workspace(imported.id).state).toBe('history')
    expect(dst.workspaces.workspace(imported.id).path).toBeUndefined()
    expect(await gitOut(dst.repoDir, ['for-each-ref', 'refs/heads', 'refs/switchyard-checkpoints'])).not.toContain('feat/live')
  })

  it('reports a repository without commits and an unresolved merge instead of bundling', async () => {
    const src = await machine()
    const ws = await liveWorkspace(src)
    // A merge in progress.
    const dir = ws.path!
    await git(dir, ['checkout', '-q', '-b', 'other'])
    await writeFile(path.join(dir, 'README.md'), 'other\n')
    await git(dir, ['add', '-A'])
    await git(dir, [...IDENTITY, 'commit', '-q', '-m', 'other'])
    await git(dir, ['checkout', '-q', 'feat/live'])
    await writeFile(path.join(dir, 'README.md'), 'mine\n')
    await git(dir, ['add', '-A'])
    await git(dir, [...IDENTITY, 'commit', '-q', '-m', 'mine'])
    await git(dir, [...IDENTITY, 'merge', 'other'], { allowFail: true })
    const summary = await src.portability.exportWorkspace(ws.id, { mode: 'share', includeWorktree: true, outPath: path.join(await tempDir(), 'm.foreman') })
    expect(summary.worktree).toMatchObject({ status: 'skipped', reason: 'merge' })
    expect(summary.chats).toBe(1)
  })

  it('backup includes the worktree by default; a workspace with no folder is reported, not failed', async () => {
    const src = await machine()
    const ws = await liveWorkspace(src)
    const a = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', outPath: path.join(await tempDir(), 'b.foreman') })
    expect(a.worktree?.status).toBe('included')
    const off = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', includeWorktree: false, outPath: path.join(await tempDir(), 'c.foreman') })
    expect(off.worktree).toBeUndefined()
    ws.path = path.join(src.dataDir, 'gone')
    const gone = await src.portability.exportWorkspace(ws.id, { mode: 'backup', passphrase: 'pw', outPath: path.join(await tempDir(), 'd.foreman') })
    expect(gone.worktree).toMatchObject({ status: 'skipped', reason: 'no-folder' })
  })
})

describe('worktree rules', () => {
  it('finds names another system cannot hold', () => {
    expect(incompatibleNames(['a/b.txt', 'aux.txt', 'x/Readme', 'x/README', 'bad:name', 'trail.'])).toEqual(['aux.txt', 'bad:name', 'trail.', 'x/README', 'x/Readme'])
    expect(incompatibleNames(['src/index.ts'])).toEqual([])
  })
  it('reads dirty submodules from status output and missing LFS objects', () => {
    const status = ['1 .M N... 100644 100644 100644 a b src/x.ts', '1 .M S.M. 160000 160000 160000 a b vendor/lib', '1 .M SC.. 160000 160000 160000 a b vendor/other', '1 .. S... 160000 160000 160000 a b vendor/clean'].join('\n')
    expect(dirtySubmodules(status)).toEqual(['vendor/lib', 'vendor/other'])
    expect(lfsMissing('abc123 * a.bin\nfff000 - big.psd')).toEqual(['big.psd'])
  })
  it('picks the first free branch name and summarises what travels', () => {
    expect(freeBranchName('feat/a', (n) => n === 'feat/a')).toBe('feat/a-imported')
    expect(freeBranchName('feat/a', (n) => ['feat/a', 'feat/a-imported'].includes(n))).toBe('feat/a-imported-2')
    expect(bundleSummary({ branch: 'b', omitted: ['x'], omittedMore: 2, files: [] })).toBe('branch b and its uncommitted work, 3 ignored items left behind')
  })
})
