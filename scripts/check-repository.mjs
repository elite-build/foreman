// Nonconfidential publication policy. Human review must protect this guard too.
import { execFileSync } from 'node:child_process'
import { lstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseToml } from 'smol-toml'

export function forbiddenPath(file) {
  const p = file.replaceAll('\\', '/').toLowerCase()
  return /^(?:design|\.publication-private|out|dist|release|node_modules|\.workspace-people-cache)\//.test(p)
    || /^docs\/[^/]+-spec\//.test(p)
    || /^(?:features\.md|publication-[^/]+\.md)$/.test(p)
    || /(?:^|\/)(?:state\.json|foreman\.db(?:-wal|-shm)?|secrets\.json|credentials\.json)$/.test(p)
    || /(?:^|\/)\.env(?:\..*)?$/.test(p) && !/(?:^|\/)\.env\.(?:example|sample)$/.test(p)
    || /\.(?:pem|key|p8|p12|pfx|log)$/.test(p)
    || /(?:^|\/)(?:mocks?(?:[-.][^/]*)?|mockups?)(?:\/|\.html$)/.test(p)
}

export function candidateFiles(root = process.cwd()) {
  return [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))]
    // Inspect the entry itself: existsSync follows links and hides dangling ones from policy checks.
    .filter(file => lstatSync(path.join(root, file), { throwIfNoEntry: false }) !== undefined)
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
  else console.log('Repository path policy checks passed')
}
