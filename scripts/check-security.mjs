// Pinned, checksum-verified tools. No repository token, install hook or third-party action is needed.
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { candidateFiles, checkRepository } from './check-repository.mjs'

const root = process.cwd()
const policy = checkRepository(root)
if (policy.length) throw new Error(policy.join('\n'))
mkdirSync(path.join(root, 'out'), { recursive: true })
const work = mkdtempSync(path.join(root, 'out', 'security-check-'))
const catalog = JSON.parse(readFileSync(new URL('./security-tools.json', import.meta.url), 'utf8'))
const config = path.join(root, '.gitleaks.toml')
const emptyIgnore = path.join(work, 'empty-ignore')
writeFileSync(emptyIgnore, '')

async function tool(name) {
  if (process.arch !== 'x64') throw new Error('This scanner manifest supports x64 Linux and Windows; use the hosted Security job on other platforms')
  const entry = catalog[name][process.platform]
  if (!entry) throw new Error(`Unsupported scanner platform: ${process.platform}`)
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`${name}: download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 64 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error(`${name}: archive verification failed`)
  const archive = path.join(work, `${name}${entry.url.endsWith('.zip') ? '.zip' : '.tar.gz'}`)
  writeFileSync(archive, bytes)
  const filename = name + (process.platform === 'win32' ? '.exe' : '')
  // Extract exactly the verified archive's expected executable, never arbitrary members.
  execFileSync('tar', ['-xf', archive, '-C', work, filename], { stdio: 'pipe', timeout: 30_000 })
  const executable = path.join(work, filename)
  if (process.platform !== 'win32') chmodSync(executable, 0o700)
  return executable
}

const leaks = await tool('gitleaks')
const lint = await tool('actionlint')
const linted = spawnSync(lint, ['-shellcheck=', '.github/workflows/ci.yml'], { encoding: 'utf8', timeout: 60_000 })
if (linted.status !== 0) {
  console.error(linted.stdout || linted.stderr || 'Workflow validation failed')
  process.exit(1)
}

function scan(label, mode, source, extra = []) {
  const report = path.join(work, `${label}.json`)
  const result = spawnSync(leaks, [mode, source, '--config', config, '--gitleaks-ignore-path', emptyIgnore,
    '--ignore-gitleaks-allow', '--redact=100', '--no-banner', '--no-color', '--max-decode-depth=5', '--max-archive-depth=2',
    '--timeout=300', '--report-format=json', '--report-path', report, ...extra], { encoding: 'utf8', timeout: 330_000, maxBuffer: 8 * 1024 * 1024 })
  writeFileSync(path.join(work, `${label}.log`), (result.stdout ?? '') + (result.stderr ?? ''))
  if (![0, 1].includes(result.status)) throw new Error(`${label}: scanner failed (status ${result.status}); scan is incomplete`)
  const findings = JSON.parse(readFileSync(report, 'utf8'))
  return { status: result.status, findings }
}

// Prove a new secret in an excepted file still fails. This random string is never a working credential.
const probe = path.join(work, 'probe', 'tests')
mkdirSync(probe, { recursive: true })
writeFileSync(path.join(probe, 'agentKeys.test.ts'), `const api_key = '${randomBytes(24).toString('base64url')}'\n`)
if (!scan('probe', 'dir', path.dirname(probe)).findings.some(f => f.RuleID === 'generic-api-key')) throw new Error('Secret detector self-test failed')

const snapshot = path.join(work, 'source')
mkdirSync(snapshot)
for (const file of candidateFiles(root)) {
  const target = path.resolve(snapshot, file)
  if (!target.startsWith(snapshot + path.sep)) throw new Error('Unsafe snapshot path')
  mkdirSync(path.dirname(target), { recursive: true })
  copyFileSync(path.join(root, file), target)
}
// Default Gitleaks rules exclude lockfiles and its own config by filename. Scan their text too.
const metadata = path.join(work, 'scanner-metadata')
mkdirSync(metadata)
copyFileSync(path.join(root, 'package-lock.json'), path.join(metadata, 'lockfile.txt'))
copyFileSync(config, path.join(metadata, 'scan-config.txt'))
let failed = false
for (const [label, mode, source, extra] of [['source', 'dir', snapshot, []], ['metadata', 'dir', metadata, []], ['history', 'git', root, ['--log-opts=--all --full-history -m']]]) {
  const result = scan(label, mode, source, extra)
  console.log(`${label}: ${result.findings.length} secret findings`)
  for (const finding of result.findings) console.error(`${finding.File}:${finding.StartLine} (${finding.RuleID})`)
  if (result.status || result.findings.length) failed = true
}
if (failed) process.exitCode = 1
else console.log('Secret detection self-test, source/history scans and workflow lint passed')
