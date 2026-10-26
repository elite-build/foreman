import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { candidateFiles, checkRepository, forbiddenPath } from '../scripts/check-repository.mjs'

test('reject private/export-only material while retaining runtime assets and test mocks', () => {
  for (const p of ['FEATURES.md', 'design/plan.md', 'design/mocks.html', '.publication-private/review.md', 'docs/vendor-spec/page.md', '.env', '.env.production', 'state.json', 'secret.pem', 'out/report.json']) assert.equal(forbiddenPath(p), true, p)
  for (const p of ['build/icons/foreman.svg', 'src/shared/types.ts', 'tests/fixtures/example.json', 'tests/mocks.ts', '.env.example', 'docs/design-system.md']) assert.equal(forbiddenPath(p), false, p)
})

test('reject a tracked dangling link instead of silently omitting it from the scanned source', () => {
  const workspace = realpathSync(process.cwd())
  mkdirSync(path.join(workspace, 'out'), { recursive: true })
  const output = realpathSync(path.join(workspace, 'out'))
  assert.ok(output.startsWith(workspace + path.sep))
  const root = mkdtempSync(path.join(output, 'policy-fixture-'))
  const git = (args, input) => execFileSync('git', args, { cwd: root, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    git(['init', '--quiet'])
    writeFileSync(path.join(root, 'kept.txt'), 'keep\n')
    writeFileSync(path.join(root, 'deleted.txt'), 'remove\n')
    git(['add', 'kept.txt', 'deleted.txt'])
    unlinkSync(path.join(root, 'deleted.txt'))
    const target = path.join(root, 'missing-target')
    mkdirSync(target)
    // Directory junctions exercise dangling links on Windows without symlink privileges.
    symlinkSync(target, path.join(root, 'dangling'), process.platform === 'win32' ? 'junction' : 'dir')
    rmdirSync(target)
    const hash = git(['hash-object', '-w', '--stdin'], 'missing-target').trim()
    git(['update-index', '--add', '--cacheinfo', `120000,${hash},dangling`])
    copyFileSync('.gitleaks.toml', path.join(root, '.gitleaks.toml'))
    writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }))

    const candidates = candidateFiles(root)
    assert.ok(candidates.includes('kept.txt'))
    assert.ok(!candidates.includes('deleted.txt'))
    assert.ok(candidates.includes('dangling'), 'tracked broken links must reach the policy check')
    assert.ok(checkRepository(root).includes('Symlink needs explicit export review: dangling'))
  } finally {
    assert.ok(realpathSync(root).startsWith(output + path.sep))
    rmSync(root, { recursive: true, force: true })
  }
})
