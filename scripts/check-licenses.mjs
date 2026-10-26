// Exact-package evidence supplements the conservative metadata inventory. Source
// publication does not imply permission to redistribute installed SDKs or binaries.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const allowed = new Set([
  'MIT', 'MIT-0', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0',
  'Unlicense', 'BlueOak-1.0.0', 'Python-2.0', 'OFL-1.1', 'CC-BY-4.0',
  '(Apache-2.0 AND BSD-3-Clause)', '(MIT OR CC0-1.0)', '(MPL-2.0 OR Apache-2.0)',
  'WTFPL', 'WTFPL OR ISC', '(WTFPL OR MIT)'
])

export function licenseErrors(lock, policy, readNotice, { distribution = false } = {}) {
  const errors = []
  const reviewed = new Map()
  if (policy.schemaVersion !== 1 || !Array.isArray(policy.reviews)) return ['Unsupported dependency license review format']
  for (const review of policy.reviews) {
    if (!review.id || !review.reason || !review.license || !/^https:\/\//.test(review.source ?? '')
      || !['allowed', 'source-required', 'review-required'].includes(review.distribution)
      || !/^docs\/licenses\/[a-z0-9-]+\.txt$/.test(review.notice ?? '')
      || !/^[a-f0-9]{64}$/.test(review.noticeSha256 ?? '') || !review.packages?.length) {
      errors.push(`${review.id ?? 'Review'}: incomplete license evidence`)
      continue
    }
    try {
      const notice = readNotice(review.notice).replace(/\r\n/g, '\n')
      if (createHash('sha256').update(notice).digest('hex') !== review.noticeSha256) errors.push(`${review.id}: license notice changed; review required`)
    } catch { errors.push(`${review.id}: license notice missing`) }
    for (const entry of review.packages) {
      if (reviewed.has(entry.path)) errors.push(`${entry.path}: duplicate license review`)
      reviewed.set(entry.path, { review, entry })
      const pkg = lock.packages[entry.path]
      if (!pkg) errors.push(`${entry.path}: stale license review`)
      else if (!entry.version || !entry.integrity || pkg.version !== entry.version || pkg.integrity !== entry.integrity
        || (pkg.license ?? null) !== entry.declaredLicense) errors.push(`${entry.path}: package changed; renew license evidence`)
    }
  }
  for (const [name, pkg] of Object.entries(lock.packages)) {
    if (!name) continue
    if (!pkg.version || !pkg.integrity) errors.push(`${name}: incomplete package identity`)
    const evidence = reviewed.get(name)
    if (!allowed.has(pkg.license) && !evidence) errors.push(`${name}@${pkg.version}: unreviewed ${pkg.license ?? 'UNKNOWN'} license`)
    if (distribution && evidence && evidence.review.distribution !== 'allowed') {
      errors.push(`${name}@${pkg.version}: ${evidence.review.distribution === 'review-required' ? 'vendor redistribution terms need clearance' : 'corresponding source and distributed notices need verification'}`)
    }
  }
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.some(arg => arg !== '--distribution')) throw new Error('Usage: node scripts/check-licenses.mjs [--distribution]')
  const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'))
  const policy = JSON.parse(readFileSync('scripts/dependency-license-reviews.json', 'utf8'))
  const errors = licenseErrors(lock, policy, file => readFileSync(file, 'utf8'), { distribution: args.includes('--distribution') })
  if (errors.length) {
    console.error(errors.join('\n'))
    process.exitCode = 1
  } else console.log('Source dependency license inventory passed. Vendor packages keep their own terms; this is not installer redistribution clearance. See docs/dependency-licenses.md.')
}
