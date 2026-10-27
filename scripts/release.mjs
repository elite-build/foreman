// Cutting a release (see "Releases" in docs/maintenance.md). main is protected, so a release takes two steps:
//
//   npm run release -- prepare <patch|minor|major|x.y.z[-pre]>   On a branch: set the version in package.json and
//                                                                package-lock.json. Commit it and merge it through a PR.
//   npm run release -- tag [--push]                              After the merge: tag origin/main as v<version> with an
//                                                                annotated tag, and push it with --push.
//
// Then start the Release workflow on the tag: gh workflow run release.yml --ref v<version>
// Only Node built-ins and git are used, so this runs without an install.

import { execFileSync } from 'node:child_process'
import { readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/

/** A version as { major, minor, patch, pre } (pre: prerelease identifiers, empty for a release), or null if it isn't semver. */
export function parseVersion(text) {
  const m = SEMVER.exec(text)
  return m ? { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), pre: m[4] ? m[4].split('.') : [] } : null
}

/** Semver precedence: negative when a comes first, 0 when equal, positive when a comes later. */
export function compareVersions(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) throw new Error(`Not a version: ${x ? b : a}`)
  for (const k of ['major', 'minor', 'patch']) if (x[k] !== y[k]) return x[k] - y[k]
  // A prerelease comes before its release; identifiers compare numerically when both are numbers, otherwise as text.
  if (!x.pre.length || !y.pre.length) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const [p, q] = [x.pre[i], y.pre[i]]
    if (p === q) continue
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)]
    if (pn && qn) return Number(p) - Number(q)
    if (pn !== qn) return pn ? -1 : 1
    return p < q ? -1 : 1
  }
  return x.pre.length - y.pre.length
}

/** The version `prepare` moves to: a bump of `current`, or an explicit version that must come after it. */
export function nextVersion(current, request) {
  const v = parseVersion(current)
  if (!v) throw new Error(`package.json has no semver version: ${current}`)
  // Bumping a prerelease finishes it when the release is that step: 1.2.0-beta.1 -> minor or patch gives 1.2.0.
  if (request === 'major') return v.pre.length && !v.minor && !v.patch ? `${v.major}.0.0` : `${v.major + 1}.0.0`
  if (request === 'minor') return v.pre.length && !v.patch ? `${v.major}.${v.minor}.0` : `${v.major}.${v.minor + 1}.0`
  if (request === 'patch') return v.pre.length ? `${v.major}.${v.minor}.${v.patch}` : `${v.major}.${v.minor}.${v.patch + 1}`
  const wanted = request?.replace(/^v/, '')
  if (!wanted || !parseVersion(wanted)) throw new Error(`Expected patch, minor, major or a version like 1.2.3, not ${request ?? 'nothing'}`)
  if (compareVersions(wanted, current) <= 0) throw new Error(`${wanted} must come after the current version ${current}`)
  return wanted
}

/** package.json and package-lock.json with their own version set to `version`, leaving every other byte (line endings too) alone. */
export function setVersion(packageJson, packageLock, version) {
  const top = /^(\s*"version":\s*)"[^"]*"/m
  const pkg = packageJson.replace(top, `$1"${version}"`)
  // The lock has the version twice: at the top and on the root package (""). Dependencies further down keep theirs.
  const lock = packageLock.replace(top, `$1"${version}"`).replace(/("":\s*\{\s*"name":\s*"[^"]*",\s*"version":\s*)"[^"]*"/, `$1"${version}"`)
  const l = JSON.parse(lock)
  if (JSON.parse(pkg).version !== version || l.version !== version || l.packages?.['']?.version !== version) {
    throw new Error('Could not find the version fields in package.json and package-lock.json')
  }
  return { packageJson: pkg, packageLock: lock }
}

/** Why `version` can't be tagged (empty: it can). `tags`: every existing tag, local or on origin. */
export function tagProblems({ version, tags }) {
  if (!parseVersion(version)) return [`origin/main's package.json has no semver version: ${version}`]
  const problems = []
  if (tags.includes(`v${version}`)) problems.push(`v${version} already exists. Merge a version bump first: npm run release -- prepare <patch|minor|major>`)
  const released = tags.filter((t) => /^v/.test(t)).map((t) => t.slice(1)).filter((t) => t !== version && parseVersion(t))
  const latest = released.sort(compareVersions).at(-1)
  if (latest && compareVersions(version, latest) < 0) problems.push(`v${version} would come before the existing v${latest}`)
  return problems
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const lines = (text) => text.split('\n').map((l) => l.trim()).filter(Boolean)

function prepare(request) {
  if (git('status', '--porcelain')) throw new Error('Commit or set aside your changes first: the version bump should be a change of its own')
  if (git('rev-parse', '--abbrev-ref', 'HEAD') === 'main') throw new Error('main is protected: run this on a branch and merge the bump through a pull request')
  const packageJson = readFileSync('package.json', 'utf8')
  const current = JSON.parse(packageJson).version
  const version = nextVersion(current, request)
  const out = setVersion(packageJson, readFileSync('package-lock.json', 'utf8'), version)
  writeFileSync('package.json', out.packageJson)
  writeFileSync('package-lock.json', out.packageLock)
  console.log(`Version ${current} -> ${version} in package.json and package-lock.json.

Next:
  git commit -am "Release ${version}"
  Open a pull request, get it approved and merged, then run: npm run release -- tag --push`)
}

function tag(push) {
  git('fetch', '--quiet', 'origin', 'main', '--tags')
  const commit = git('rev-parse', 'origin/main')
  const version = JSON.parse(git('show', 'origin/main:package.json')).version
  const name = `v${version}`
  const local = lines(git('tag', '--list'))
  const remote = lines(git('ls-remote', '--tags', '--refs', 'origin')).map((l) => l.split('refs/tags/')[1])
  // A tag made by an earlier run without --push: reuse it if it is on origin/main, so `tag --push` can finish the job.
  const pending = local.includes(name) && !remote.includes(name)
  if (pending && git('rev-parse', `${name}^{commit}`) !== commit) throw new Error(`Your local ${name} is not origin/main. Delete it with: git tag -d ${name}`)
  const problems = tagProblems({ version, tags: [...new Set([...local.filter((t) => !(pending && t === name)), ...remote])] })
  if (problems.length) throw new Error(problems.join('\n'))
  if (pending) console.log(`Using your unpushed ${name} tag on ${commit.slice(0, 12)} (origin/main).`)
  else {
    git('tag', '--annotate', name, '--message', `Foreman ${version}`, commit)
    console.log(`Tagged ${commit.slice(0, 12)} (origin/main) as ${name}.`)
  }
  if (push) {
    git('push', 'origin', `refs/tags/${name}`)
    console.log(`Pushed ${name}.`)
  }
  console.log(`
Next:${push ? '' : `\n  git push origin refs/tags/${name}`}
  gh workflow run release.yml --ref ${name}
  When the run finishes, review the draft release on GitHub before deciding to publish it (docs/maintenance.md, "Releases").`)
}

// import.meta.url is the real path; argv[1] may reach it through a symlink, junction or subst drive.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const [command, ...rest] = process.argv.slice(2)
  try {
    if (command === 'prepare' && rest.length === 1) prepare(rest[0])
    else if (command === 'tag' && rest.every((a) => a === '--push')) tag(rest.includes('--push'))
    else throw new Error('Usage: npm run release -- prepare <patch|minor|major|x.y.z>\n       npm run release -- tag [--push]')
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
