// Nonconfidential publication and CI policy. Human review must protect this guard too.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from 'yaml'
import { parse as parseToml } from 'smol-toml'

const jobs = ['types', 'platform', 'design', 'mcp', 'security', 'publication']
const pins = new Set(['actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1', 'actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1'])

export function forbiddenPath(file) {
  const p = file.replaceAll('\\', '/').toLowerCase()
  return /^(?:design|\.publication-private|out|dist|release|node_modules|\.workspace-people-cache)\//.test(p)
    || /^docs\/[^/]+-spec\//.test(p)
    || /^(?:features\.md|publication-[^/]+\.md)$/.test(p)
    || /(?:^|\/)(?:state\.json|foreman\.db(?:-wal|-shm)?|secrets\.json|credentials\.json)$/.test(p)
    || /(?:^|\/)\.env(?:\..*)?$/.test(p) && !/(?:^|\/)\.env\.(?:example|sample)$/.test(p)
    || /\.(?:pem|key|p12|pfx|log)$/.test(p)
    || /(?:^|\/)(?:mocks?(?:[-.][^/]*)?|mockups?)(?:\/|\.html$)/.test(p)
}

export function candidateFiles(root = process.cwd()) {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
    // Inspect the entry itself: existsSync follows links and hides dangling ones from policy checks.
    .filter(file => lstatSync(path.join(root, file), { throwIfNoEntry: false }) !== undefined)
}

export function workflowErrors(workflow) {
  const errors = []
  const assert = (ok, message) => { if (!ok) errors.push(message) }
  const triggers = workflow.on ?? {}
  assert(Object.keys(triggers).sort().join() === 'pull_request,push', 'Only unprivileged PR and push triggers are permitted')
  assert(!triggers.pull_request?.paths && !triggers.pull_request?.['paths-ignore'] && !triggers.pull_request?.branches && !triggers.pull_request?.['branches-ignore'], 'Every PR must report checks')
  const events = ['opened', 'synchronize', 'reopened', 'edited', 'labeled', 'unlabeled', 'ready_for_review']
  assert(Array.isArray(triggers.pull_request?.types) && [...triggers.pull_request.types].sort().join() === events.sort().join(), 'PR checks must run on new commits, retargeting, labels and review readiness')
  assert(JSON.stringify(workflow.permissions) === JSON.stringify({ contents: 'read' }), 'Workflow token must be read-only')
  assert(!workflow.env, 'Workflow-wide environment requires review')
  assert(Object.keys(workflow.jobs ?? {}).sort().join() === [...jobs, 'summary'].sort().join(), 'CI job inventory changed')
  const names = { types: 'Types', platform: 'Validate / ${{ matrix.platform }} / Node ${{ matrix.node }}', design: 'Design system', mcp: 'MCP coverage', security: 'Security', publication: 'Publication policy', summary: 'CI result' }
  const expectedSteps = {
    types: ['npm run typecheck'], platform: ['node scripts/postinstall.mjs', 'npm test -- --maxWorkers=4', 'npm run build'],
    design: ['npm run check:ui', 'node scripts/check-new-components.mjs "$BASE_SHA"'],
    mcp: ['npm run check:mcp'], security: ['npm run check:security', 'npm audit --audit-level=high'],
    publication: ['npm run check:repository', 'npm run check:licenses']
  }
  for (const [id, job] of Object.entries(workflow.jobs ?? {})) {
    assert(job.name === names[id], `${id}: CI context name changed`)
    assert(!job.permissions, `${id}: job token override is forbidden`)
    assert(!job['continue-on-error'], `${id}: failures cannot be ignored`)
    assert(Number.isInteger(job['timeout-minutes']) && job['timeout-minutes'] > 0 && job['timeout-minutes'] <= 45, `${id}: bounded timeout required`)
    assert(id === 'summary' || !job.if, `${id}: CI job cannot be conditional`)
    assert(['ubuntu-24.04', '${{ matrix.os }}'].includes(job['runs-on']), `${id}: only reviewed hosted runners are permitted`)
    const commands = []
    for (const step of job.steps ?? []) {
      assert(!step['continue-on-error'], `${id}: step failures cannot be ignored`)
      if (step.uses) {
        assert(pins.has(step.uses), `${id}: unreviewed action or mutable revision`)
        if (step.uses.startsWith('actions/checkout@')) assert(step.with?.['persist-credentials'] === false, `${id}: checkout credentials must not persist`)
        if (step.uses.startsWith('actions/setup-node@')) assert(step.with?.['package-manager-cache'] === false && !step.with?.cache && !step.with?.['registry-url'], `${id}: shared caches/registry credentials require review`)
      }
      if (step.run) {
        commands.push(step.run)
        assert(!/\$\{\{/.test(step.run), `${id}: shell expressions must use environment data`)
        assert(!/\|\|\s*true|;\s*exit\s+0|--no-verify/.test(step.run), `${id}: failure masking is forbidden`)
        assert(!step.if || (id === 'design' && step.name === 'New component boundary' && step.if === "github.event_name == 'pull_request'"), `${id}: check step cannot be conditional`)
      }
    }
    if (id !== 'summary') {
      assert(commands.includes('npm ci --ignore-scripts --no-audit --no-fund'), `${id}: lifecycle-disabled install required`)
      for (const cmd of expectedSteps[id] ?? []) assert(commands.includes(cmd), `${id}: missing mandatory command ${cmd}`)
    }
  }
  const matrix = workflow.jobs?.platform?.strategy?.matrix?.include
  assert(JSON.stringify(matrix) === JSON.stringify([
    { os: 'windows-2022', platform: 'Windows', node: '22' }, { os: 'windows-2022', platform: 'Windows', node: '24' },
    { os: 'macos-15', platform: 'macOS', node: '22' }, { os: 'macos-15', platform: 'macOS', node: '24' }
  ]), 'Platform matrix must cover both supported OS and Node lines')
  const gate = workflow.jobs?.summary
  assert(gate?.if === 'always()', 'Aggregate must always run')
  assert([...(gate?.needs ?? [])].sort().join() === [...jobs].sort().join(), 'Aggregate must depend on every CI job')
  assert(gate?.steps?.[0]?.env?.RESULTS === '${{ toJSON(needs) }}', 'Aggregate must consume actual dependency results')
  assert(gate?.steps?.[0]?.run?.includes('results[id]?.result !== "success"') && gate?.steps?.[0]?.run?.includes('process.exit(1)'), 'Aggregate must reject all nonsuccess outcomes')
  assert(!/\$\{\{\s*secrets\.|id-token|write-all|pull_request_target|workflow_run|self-hosted/.test(JSON.stringify(workflow)), 'Privileged workflow capability is forbidden')
  return errors
}

export function checkRepository(root = process.cwd()) {
  const files = candidateFiles(root)
  const errors = files.filter(forbiddenPath).map(p => `Forbidden publication path: ${p}`)
  for (const file of files) if (lstatSync(path.join(root, file)).isSymbolicLink()) errors.push(`Symlink needs explicit export review: ${file}`)
  const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'))
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!pkg.resolved) continue
    try {
      const url = new URL(pkg.resolved)
      if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.username || url.password || url.search || url.hash) errors.push(`${name}: unreviewed dependency source or URL credentials`)
    } catch { errors.push(`${name}: dependency source is not a reviewed registry URL`) }
  }
  const workflows = files.filter(f => /^\.github\/workflows\/.*\.ya?ml$/.test(f))
  if (workflows.join() !== '.github/workflows/ci.yml') errors.push('Workflow inventory must remain the single reviewed CI workflow')
  errors.push(...workflowErrors(parse(readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8'))))
  const scan = parseToml(readFileSync(path.join(root, '.gitleaks.toml'), 'utf8'))
  if (scan.extend?.useDefault !== true || scan.extend.disabledRules || scan.allowlist || scan.allowlists) errors.push('Use default secret rules without global exceptions or disabled detectors')
  for (const rule of scan.rules ?? []) {
    if (Object.keys(rule).some(k => !['id', 'allowlists'].includes(k))) errors.push('Secret detector overrides require independent review')
    for (const allow of rule.allowlists ?? []) if (allow.condition !== 'AND' || allow.regexTarget !== 'secret' || !allow.paths?.length || !allow.regexes?.length || allow.regexes.some(r => !r.startsWith('^') || !r.endsWith('$'))) errors.push('Secret exemptions must match an exact value AND a scoped path')
  }
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkRepository()
  if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1 }
  else console.log('Repository path and CI policy checks passed')
}
