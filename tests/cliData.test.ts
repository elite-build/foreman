import { describe, expect, it, vi } from 'vitest'
import { DATA_METHODS } from '../src/main/cli/data'
import { CliCodedError } from '../src/main/cli/host'
import type { CliContext } from '../src/main/cli/methods'
import { defaultSettings } from '../src/main/store'
import type { BackupNowResult, BackupStatusResult, DataInfoResult, DeleteLegacyResult, GitBackupNowResult, GitBackupPreviewResult, GitBackupRestoreCliResult, GitBackupStatusResult, UsageResult } from '../src/shared/cli/data'
import type { GitBackupPreview, GitBackupRestoreChoice, GitBackupStatus } from '../src/shared/gitBackup'
import type { Api, DataInfo, Repo } from '../src/shared/types'
import type { UsageReport } from '../src/shared/usageReport'
import { fakeApi, stubHost } from './cliHost'

const ctx = { request: { method: 'x' }, caller: undefined, signal: undefined, progress: () => undefined } as CliContext

function setup(api: Partial<Api> = {}, repos: Repo[] = []) {
  const host = stubHost({ state: () => ({ repos, workspaces: [], sessions: [], settings: defaultSettings() }), api: fakeApi(api) })
  const call = <T>(method: string, params?: unknown) => DATA_METHODS[method].handle(host, params, ctx) as Promise<T>
  return { call }
}

async function failure(promise: Promise<unknown>): Promise<CliCodedError> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(CliCodedError)
  return err as CliCodedError
}

const info = (over: Partial<DataInfo> = {}): DataInfo => ({ path: '/data/foreman.db', dataFolder: '/data', sizeBytes: 5 * 1024 * 1024, messages: 1200, legacy: { files: 0, bytes: 0 }, backupFolder: '/data/backups', claudeTranscripts: { sessions: 3, errors: 0 }, ...over })

const preview = (over: Partial<GitBackupPreview> = {}): GitBackupPreview => ({
  stageId: 'stage-1',
  createdAt: '2026-10-20T08:00:00.000Z',
  settingsChanged: ['theme', 'loadouts'],
  machinePaths: [{ key: 'workspacesRoot', saved: '/old/ws', available: false }],
  templates: [{ id: 't1', name: 'One', action: 'add' }, { id: 't2', name: 'Two', action: 'same' }],
  repositories: [{ id: 'r1', name: 'alpha', rootPath: '/old/alpha', defaultBranch: 'main', remote: 'origin', local: {}, suggestedPath: '/here/alpha', matchedRepoId: 'x' }],
  workspaces: [{ id: 'w1', repoId: 'r1', name: 'lisbon', branch: 'lisbon', baseBranch: 'main', path: '/old/lisbon', alreadyAdded: false }],
  variableNames: { user: ['API_KEY'], repos: {} },
  variableChecklist: [{ scope: 'User', name: 'API_KEY', present: false }],
  unavailableAccounts: ['octo'],
  ...over
})

describe('the data methods', () => {
  it('puts the status reads in the read tier and everything that writes or touches a remote in admin', () => {
    expect(Object.fromEntries(Object.entries(DATA_METHODS).map(([k, m]) => [k, m.tier]))).toEqual({
      'backup-now': 'admin',
      'backup-status': 'read',
      'git-backup-status': 'read',
      'git-backup-configure': 'admin',
      'git-backup-create-repo': 'admin',
      'git-backup-now': 'admin',
      'git-backup-preview': 'admin',
      'git-backup-restore': 'admin',
      'data-info': 'read',
      'data-delete-legacy': 'admin',
      usage: 'read'
    })
  })

  describe('the database backup', () => {
    it('backs up now', async () => {
      const backupNow = vi.fn(async () => ({ path: '/data/backups/2026-10-24', manifest: 'manifest.json', attachments: 4, missingAttachments: 1, at: '2026-10-24T10:00:00.000Z' }))
      const { call } = setup({ backupNow })
      const result = await call<BackupNowResult>('backup-now')
      expect(backupNow).toHaveBeenCalledTimes(1)
      expect(result.path).toBe('/data/backups/2026-10-24')
      expect(result.text).toContain('4 attachments')
      expect(result.text).toContain('1 attachment could not be found')
    })

    it('reports the database, the last backup and what is left over', async () => {
      const dataInfo = vi.fn(async () => info({ lastBackup: { at: '2026-10-23T09:30:00.000Z', path: '/data/backups/x' }, legacy: { files: 12, bytes: 2048 } }))
      const { call } = setup({ dataInfo })
      const status = await call<BackupStatusResult>('backup-status')
      expect(status).toMatchObject({ path: '/data/foreman.db', sizeBytes: 5 * 1024 * 1024, messages: 1200, lastBackup: { path: '/data/backups/x' }, legacy: { files: 12 } })
      expect(status.text).toContain('5 MB')
      expect(status.text).toContain('Last backup: 2026-10-23 09:30 UTC')
      expect(status.text).toContain('12 files')
      const full = await call<DataInfoResult>('data-info')
      expect(full).toMatchObject({ dataFolder: '/data', claudeTranscripts: { sessions: 3, errors: 0 } })
      expect(full.text).toContain('Data folder: /data')
    })

    it('says so when no backup has been made', async () => {
      const { call } = setup({ dataInfo: async () => info() })
      expect((await call<BackupStatusResult>('backup-status')).text).toContain('No backup yet.')
    })

    it('deletes the left-over files only when there are some', async () => {
      const deleteLegacyFiles = vi.fn(async () => undefined)
      const some = setup({ dataInfo: async () => info({ legacy: { files: 3, bytes: 4096 } }), deleteLegacyFiles })
      const result = await some.call<DeleteLegacyResult>('data-delete-legacy')
      expect(deleteLegacyFiles).toHaveBeenCalledTimes(1)
      expect(result).toMatchObject({ files: 3, bytes: 4096 })
      deleteLegacyFiles.mockClear()
      const none = setup({ dataInfo: async () => info(), deleteLegacyFiles })
      expect((await none.call<DeleteLegacyResult>('data-delete-legacy')).files).toBe(0)
      expect(deleteLegacyFiles).not.toHaveBeenCalled()
    })
  })

  describe('the Git backup', () => {
    const status: GitBackupStatus = { config: { remoteUrl: 'https://user:ghp_secret@github.com/me/backup.git', account: 'me', daily: true }, lastSuccessAt: '2026-10-24T08:00:00.000Z', lastError: 'push to https://user:ghp_secret@github.com/me/backup.git failed' }

    it('reports the status without the remote’s credentials', async () => {
      const { call } = setup({ gitBackupStatus: async () => status })
      const result = await call<GitBackupStatusResult>('git-backup-status')
      expect(result).toMatchObject({ configured: true, config: { remote: 'https://github.com/me/backup.git', account: 'me', daily: true }, lastSuccessAt: '2026-10-24T08:00:00.000Z' })
      expect(JSON.stringify(result)).not.toContain('ghp_secret')
      expect((await setup({ gitBackupStatus: async () => ({}) }).call<GitBackupStatusResult>('git-backup-status')).configured).toBe(false)
    })

    it('configures with the daily choice kept from before unless given', async () => {
      const configureGitBackup = vi.fn(async (config: { remoteUrl: string; account?: string; daily: boolean }) => ({ config }))
      const { call } = setup({ gitBackupStatus: async () => ({ config: { remoteUrl: 'x', daily: true } }), configureGitBackup })
      await call('git-backup-configure', { remote: 'git@github.com:me/backup.git', account: 'me' })
      expect(configureGitBackup).toHaveBeenLastCalledWith({ remoteUrl: 'git@github.com:me/backup.git', account: 'me', daily: true })
      await call('git-backup-configure', { remote: 'git@github.com:me/backup.git', daily: false })
      expect(configureGitBackup).toHaveBeenLastCalledWith({ remoteUrl: 'git@github.com:me/backup.git', daily: false })
      const first = setup({ gitBackupStatus: async () => ({}), configureGitBackup })
      await first.call('git-backup-configure', { remote: 'https://example.com/b.git' })
      expect(configureGitBackup).toHaveBeenLastCalledWith({ remoteUrl: 'https://example.com/b.git', daily: false })
      expect((await failure(call('git-backup-configure', { remote: ' ' }))).code).toBe('invalid')
    })

    it('creates the GitHub repository, backs up now and previews a remote', async () => {
      const createGitBackupGithubRepo = vi.fn(async (_name: string, _account?: string) => ({ config: { remoteUrl: 'https://github.com/me/foreman-backup.git', daily: false } }))
      const gitBackupNow = vi.fn(async () => ({ changed: true, at: '2026-10-24T10:00:00.000Z', remoteUrl: 'https://u:p@github.com/me/b.git' }))
      const previewGitBackup = vi.fn(async (_remote: string, _account?: string) => preview())
      const { call } = setup({ createGitBackupGithubRepo, gitBackupNow, previewGitBackup })
      await call('git-backup-create-repo', { name: 'foreman-backup', account: 'me' })
      expect(createGitBackupGithubRepo).toHaveBeenCalledWith('foreman-backup', 'me')
      const now = await call<GitBackupNowResult>('git-backup-now')
      expect(now).toMatchObject({ changed: true, remote: 'https://github.com/me/b.git' })
      const shown = await call<GitBackupPreviewResult>('git-backup-preview', { remote: 'https://github.com/me/b.git', account: 'me' })
      expect(previewGitBackup).toHaveBeenCalledWith('https://github.com/me/b.git', 'me')
      expect(shown.stageId).toBe('stage-1')
      for (const line of ['Settings that differ here: theme, loadouts', 'Templates: 1 new, 0 changed, 1 the same', 'alpha → /here/alpha (already added)', 'lisbon', 'workspacesRoot', 'API_KEY (User)', 'octo']) expect(shown.text).toContain(line)
    })

    it('restore without confirmation returns the preview and restores nothing', async () => {
      const previewGitBackup = vi.fn(async () => preview())
      const restoreGitBackup = vi.fn()
      const { call } = setup({ previewGitBackup, restoreGitBackup })
      const result = await call<GitBackupRestoreCliResult>('git-backup-restore', { remote: 'git@github.com:me/b.git', categories: ['settings', 'repos'] })
      expect(result).toMatchObject({ restored: false, needsConfirmation: true })
      expect(result.preview?.stageId).toBe('stage-1')
      expect(result.text).toContain('settings, repositories')
      expect(restoreGitBackup).not.toHaveBeenCalled()
    })

    it('restore with confirmation restores the stage that was previewed, with the categories chosen', async () => {
      const previewGitBackup = vi.fn(async () => preview({ stageId: 'fresh' }))
      const restoreGitBackup = vi.fn(async (_choice: GitBackupRestoreChoice) => ({ settings: 12, templates: 2, repositories: 1, workspaces: 0, skipped: ['Repository beta: folder is unavailable'] }))
      const { call } = setup({ previewGitBackup, restoreGitBackup })
      const shown = await call<GitBackupRestoreCliResult>('git-backup-restore', { remote: 'r', confirmed: true, stageId: 'stage-1', categories: ['settings,templates'] })
      expect(restoreGitBackup).toHaveBeenCalledWith({ stageId: 'stage-1', categories: { settings: true, templates: true, repositories: false, workspaces: false }, repositoryPaths: {}, workspacePaths: {} })
      expect(previewGitBackup).not.toHaveBeenCalled()
      expect(shown).toMatchObject({ restored: true, result: { settings: 12 } })
      expect(shown.text).toContain('Repository beta: folder is unavailable')

      // Without a stage id a fresh preview is made first, and every category is restored by default.
      await call('git-backup-restore', { remote: 'r', confirmed: true })
      expect(previewGitBackup).toHaveBeenCalledTimes(1)
      expect(restoreGitBackup).toHaveBeenLastCalledWith({ stageId: 'fresh', categories: { settings: true, templates: true, repositories: true, workspaces: true }, repositoryPaths: {}, workspacePaths: {} })
    })

    it('restore refuses an unknown category before touching the remote', async () => {
      const previewGitBackup = vi.fn()
      const { call } = setup({ previewGitBackup })
      expect((await failure(call('git-backup-restore', { remote: 'r', categories: ['everything'] }))).message).toMatch(/Unknown category/)
      expect(previewGitBackup).not.toHaveBeenCalled()
    })
  })

  describe('usage', () => {
    const figures = (turns: number, costUsd: number | null, partial = false) => ({ turns, agentMs: turns * 60_000, costUsd, costKnownTurns: partial ? turns - 1 : turns, costUnknownTurns: partial ? 1 : 0, partial, workspaceIds: [] })
    const report: UsageReport = {
      days: 30,
      since: '2026-09-24T00:00:00.000Z',
      total: figures(10, 4.5, true),
      byRepo: [{ repoId: 'r1', ...figures(7, 3.25) }, { repoId: 'gone', ...figures(3, null, true) }],
      byModel: [{ agent: 'claude', model: 'claude-opus-5-5[1m]', ...figures(10, 4.5, true) }]
    }

    it('asks for the last 30 days by default and for the days it is given', async () => {
      const usageReport = vi.fn(async (_days: number) => report)
      const { call } = setup({ usageReport }, [{ id: 'r1', name: 'alpha' } as Repo])
      const result = await call<UsageResult>('usage', { days: 30 })
      expect(usageReport).toHaveBeenCalledWith(30)
      await call('usage')
      expect(usageReport).toHaveBeenLastCalledWith(30)
      await call('usage', { days: 7 })
      expect(usageReport).toHaveBeenLastCalledWith(7)
      expect(result.total).toMatchObject({ turns: 10, costUsd: 4.5, partial: true })
      expect(result.byRepo.map((r) => [r.name, r.costUsd])).toEqual([['alpha', 3.25], ['gone', null]])
      expect(result.byModel[0]).toMatchObject({ agent: 'claude', model: 'claude-opus-5-5[1m]' })
      expect(result.text).toContain('≥ $4.50')
      expect(result.text).toContain('1 turn had no cost reported')
    })

    it('refuses a number of days that is not a whole number up to a year', async () => {
      const usageReport = vi.fn()
      const { call } = setup({ usageReport })
      for (const days of [0, -1, 1.5, 1000]) expect((await failure(call('usage', { days }))).code).toBe('invalid')
      expect(usageReport).not.toHaveBeenCalled()
    })
  })
})
