// Checks of the GitHub Actions workflows themselves (`npm run check:workflows`; CI's "Types and design system" job):
//
//   1. The repository's own rules, also run by tests/workflowPolicy.test.ts: every workflow sets top-level
//      `permissions`; every action is pinned to a full commit SHA with its version in a comment; nothing uses
//      `pull_request_target`; a workflow a pull request starts gives none of its jobs a secret or an environment, and a
//      reusable workflow it calls reaches its secrets and environments only behind an `if:`; the required check names
//      listed in docs/maintenance.md are still the names of CI's pull-request jobs.
//   2. actionlint (a pinned, checksum-verified release from scripts/security-tools.json), for syntax, expressions,
//      job references and action inputs. It also runs shellcheck over each `run:` script when shellcheck is on the
//      PATH, as it is on GitHub's Ubuntu runners; elsewhere that part is skipped. Its pyflakes integration is off.
//
// The parsing below is line-based and relies on the two-space indentation every workflow here uses; actionlint is
// what reads them as YAML.

import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const indent = (line) => line.length - line.trimStart().length
const meaningful = (line) => line.trim() !== '' && !line.trimStart().startsWith('#')

/** The events under `on:` (inline or as a block). */
export function triggers(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^on:/.test(l))
  if (at < 0) return []
  const inline = lines[at].replace(/^on:\s*/, '').replace(/#.*$/, '').trim()
  if (inline) return inline.replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean)
  const events = []
  for (const line of lines.slice(at + 1)) {
    if (!meaningful(line)) continue
    if (indent(line) === 0) break
    const m = /^ {2}([\w-]+):?/.exec(line)
    if (m && indent(line) === 2) events.push(m[1])
  }
  return events
}

/** Each job under `jobs:`, as { id, text } with the job's own lines. */
export function jobs(text) {
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex((l) => /^jobs:\s*$/.test(l))
  if (at < 0) return []
  const out = []
  for (const line of lines.slice(at + 1)) {
    if (meaningful(line) && indent(line) === 0) break
    const m = /^ {2}([\w-]+):\s*$/.exec(line)
    if (m) out.push({ id: m[1], lines: [] })
    else if (out.length) out[out.length - 1].lines.push(line)
  }
  return out.map((j) => ({ id: j.id, text: j.lines.join('\n') }))
}

/** A job's display name (its `name:`), or its id when it has none. */
export function jobName(job) {
  return /^ {4}name:\s*(.+?)\s*$/m.exec(job.text)?.[1].replace(/^(['"])(.*)\1$/, '$2') ?? job.id
}

/** Every `uses:` in the text, with the comment after it. */
export function actionRefs(text) {
  const refs = []
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:-\s+)?uses:\s*(['"]?)([^\s'"#]+)\1\s*(?:#\s*(.*))?$/.exec(line)
    if (m) refs.push({ ref: m[2], comment: m[3]?.trim() ?? '' })
  }
  return refs
}

const PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/
const usesSecrets = (text) => /\bsecrets\.(?!GITHUB_TOKEN\b)\w+|\bsecrets\[/.test(text)

/**
 * What is wrong with the workflows (`files`: file name → text) and the required check names `maintenance` (the text of
 * docs/maintenance.md) lists; empty when nothing is.
 */
export function workflowProblems(files, maintenance) {
  const problems = []
  const names = Object.keys(files).sort()
  const byPath = new Map(names.map((n) => [`./.github/workflows/${n}`, n]))
  for (const name of names) {
    const text = files[name]
    if (!/^permissions:/m.test(text)) problems.push(`${name}: no top-level permissions`)
    for (const { ref, comment } of actionRefs(text)) {
      if (ref.startsWith('./')) {
        if (ref.includes('/workflows/') && !byPath.has(ref)) problems.push(`${name}: calls ${ref}, which doesn't exist`)
        continue
      }
      if (ref.startsWith('docker://')) {
        if (!/@sha256:[0-9a-f]{64}$/.test(ref)) problems.push(`${name}: ${ref} is not pinned to an image digest`)
        continue
      }
      if (!PINNED.test(ref)) problems.push(`${name}: ${ref} is not pinned to a full commit SHA`)
      else if (!/^v?\d/.test(comment)) problems.push(`${name}: ${ref} has no version comment (# vX.Y.Z)`)
    }
    const events = triggers(text)
    if (events.includes('pull_request_target')) problems.push(`${name}: uses pull_request_target, which runs with secrets and a write token on fork pull requests`)
    if (!events.includes('pull_request')) continue
    for (const job of jobs(text)) {
      if (usesSecrets(job.text)) problems.push(`${name}: job ${job.id} runs on pull requests and references a secret`)
      if (/^ {4}secrets:/m.test(job.text)) problems.push(`${name}: job ${job.id} runs on pull requests and passes secrets to a reusable workflow`)
      if (/^ {4}environment:/m.test(job.text)) problems.push(`${name}: job ${job.id} runs on pull requests and deploys to an environment`)
      const called = /^ {4}uses:\s*(\.\/\S+)/m.exec(job.text)?.[1]
      const target = called && byPath.get(called)
      if (!target) continue
      // The called workflow's own secrets and environments must sit behind a condition its inputs decide.
      for (const inner of jobs(files[target])) {
        if ((usesSecrets(inner.text) || /^ {4}environment:/m.test(inner.text)) && !/^ {4}if:/m.test(inner.text)) {
          problems.push(`${target}: job ${inner.id} reaches secrets or an environment unconditionally, and ${name} calls it on pull requests`)
        }
      }
    }
  }
  // docs/maintenance.md names the checks the Require CI ruleset requires; each must still be a pull-request job's name.
  const listed = /required check names are ([^.]+)\./i.exec(maintenance)?.[1]
  const required = listed ? [...listed.matchAll(/`([^`]+)`/g)].map((m) => m[1]) : []
  if (!required.length) problems.push('docs/maintenance.md no longer says "The required check names are `…` and `…`."')
  const prJobs = names.filter((n) => triggers(files[n]).includes('pull_request')).flatMap((n) => jobs(files[n]).map((j) => ({ file: n, job: j })))
  for (const check of required) {
    const found = prJobs.find(({ job }) => jobName(job) === check)
    if (!found) problems.push(`The required check "${check}" (docs/maintenance.md) is no longer the name of a job that runs on pull requests`)
    else if (/^ {4}strategy:/m.test(found.job.text)) problems.push(`The required check "${check}" is a matrix job, whose check names carry the matrix values`)
  }
  return problems
}

/** The workflow files in `root`, by name. */
export function readWorkflows(root) {
  const dir = path.join(root, '.github', 'workflows')
  return Object.fromEntries(readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).map((f) => [f, readFileSync(path.join(dir, f), 'utf8')]))
}

async function actionlint(root) {
  if (process.arch !== 'x64') throw new Error('The actionlint manifest supports x64 Linux and Windows')
  const entry = JSON.parse(readFileSync(new URL('./security-tools.json', import.meta.url), 'utf8')).actionlint[process.platform]
  if (!entry) throw new Error(`No actionlint for ${process.platform} in scripts/security-tools.json`)
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new Error(`actionlint: download failed (${response.status})`)
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length > 32 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) throw new Error('actionlint: archive verification failed')
  mkdirSync(path.join(root, 'out'), { recursive: true })
  const work = mkdtempSync(path.join(root, 'out', 'workflow-check-'))
  const archive = path.join(work, `actionlint${entry.url.endsWith('.zip') ? '.zip' : '.tar.gz'}`)
  writeFileSync(archive, bytes)
  const filename = `actionlint${process.platform === 'win32' ? '.exe' : ''}`
  // Extract exactly the verified archive's executable, never arbitrary members. On Windows, Windows' own tar, which
  // reads zip files; Git Bash's GNU tar comes first on its PATH and does not.
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
  execFileSync(tar, ['-xf', archive, '-C', work, filename], { stdio: 'pipe', timeout: 30_000 })
  const executable = path.join(work, filename)
  if (process.platform !== 'win32') chmodSync(executable, 0o700)
  return spawnSync(executable, ['-pyflakes=', '-no-color'], { cwd: root, stdio: 'inherit', timeout: 120_000 }).status
}

// import.meta.url is the real path; argv[1] may reach it through a symlink, junction or subst drive.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const root = process.cwd()
  const problems = workflowProblems(readWorkflows(root), readFileSync(path.join(root, 'docs', 'maintenance.md'), 'utf8'))
  for (const p of problems) console.error(p)
  if (!problems.length) console.log('Workflow policy: every action pinned, permissions set, no secrets on pull requests, required checks present')
  try {
    const status = await actionlint(root)
    if (status !== 0) console.error(`actionlint found problems (exit ${status})`)
    else console.log('actionlint: no problems')
    if (problems.length || status !== 0) process.exitCode = 1
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
