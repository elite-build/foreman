import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { parse } from 'yaml'
import { candidateFiles, checkRepository, forbiddenPath, workflowErrors } from '../scripts/check-repository.mjs'

const workflow = () => parse(readFileSync('.github/workflows/ci.yml', 'utf8'))
test('reject private/export-only material while retaining runtime assets and test mocks', () => {
  for (const p of ['FEATURES.md', 'design/plan.md', 'design/mocks.html', '.publication-private/review.md', 'docs/vendor-spec/page.md', '.env', '.env.production', 'state.json', 'secret.pem', 'out/report.json']) assert.equal(forbiddenPath(p), true, p)
  for (const p of ['build/icons/foreman.svg', 'src/shared/types.ts', 'tests/fixtures/example.json', 'tests/mocks.ts', '.env.example', 'docs/design-system.md']) assert.equal(forbiddenPath(p), false, p)
})
test('current workflow implements the CI contract', () => {
  assert.deepEqual(workflowErrors(workflow()), [])
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
    mkdirSync(path.join(root, '.github', 'workflows'), { recursive: true })
    copyFileSync('.github/workflows/ci.yml', path.join(root, '.github', 'workflows', 'ci.yml'))
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

test('reject unsafe workflow changes', () => {
  const mutations = [
    w => { w.on.pull_request_target = {} }, w => { w.permissions.contents = 'write' },
    w => { w.on.pull_request.paths = ['src/**'] }, w => { delete w.jobs.security },
    w => { w.on.pull_request.types = ['closed'] }, w => { delete w.on.pull_request.types },
    w => { w.jobs.security.if = 'false' }, w => { w.jobs.security['continue-on-error'] = true },
    w => { w.jobs.security.name = 'Optional scan' },
    w => { w.jobs.types.steps[0].uses = 'actions/checkout@v4' },
    w => { w.jobs.types.steps[0].with['persist-credentials'] = true },
    w => { w.jobs.platform.strategy.matrix.include.pop() },
    w => { w.jobs.summary.needs.pop() },
    w => { w.jobs.security.steps.at(-1).run = 'echo passed' },
    w => { w.jobs.design.steps.find(s => s.run === 'npm run check:ui').if = 'false' },
    w => { w.jobs.platform.steps.find(s => s.run === 'npm test -- --maxWorkers=4').run = 'npm test -- tests/helpers.test.ts' },
    w => { w.jobs.platform.steps.find(s => s.run === 'npm test -- --maxWorkers=4').if = 'false' },
    w => { w.jobs.platform.steps.find(s => s.run === 'npm test -- --maxWorkers=4')['continue-on-error'] = true },
    w => { w.jobs.platform.steps.find(s => s.run === 'npm run build').run = 'echo passed' }
  ]
  for (const mutate of mutations) { const w = workflow(); mutate(w); assert.ok(workflowErrors(w).length, mutate.toString()) }
})
test('execute the actual aggregate against failed, skipped, cancelled, missing and successful results', () => {
  const gate = workflow().jobs.summary
  const code = gate.steps[0].run.split("-e '")[1].replace(/'\s*$/, '')
  for (const id of gate.needs) for (const result of ['success', 'failure', 'skipped', 'cancelled', 'unknown', undefined]) {
    const values = Object.fromEntries(gate.needs.map(id => [id, { result: 'success' }]))
    if (result === undefined) delete values[id]
    else values[id].result = result
    const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { env: { ...process.env, RESULTS: JSON.stringify(values) } })
    assert.equal(run.status, result === 'success' ? 0 : 1, `${id}: ${result}`)
  }
})
