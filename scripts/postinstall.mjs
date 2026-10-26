// node-pty's prebuilt macOS/Linux packages ship spawn-helper without the
// execute bit, which makes every terminal fail with "posix_spawnp failed".
// CI installs with --ignore-scripts and runs this file explicitly after `npm rebuild node-pty`: keep it offline and rerunnable.
import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, readdirSync } from 'node:fs'
import path from 'node:path'

if (process.platform !== 'win32') {
  const prebuilds = path.join('node_modules', 'node-pty', 'prebuilds')
  if (existsSync(prebuilds)) {
    for (const dir of readdirSync(prebuilds)) {
      const helper = path.join(prebuilds, dir, 'spawn-helper')
      if (existsSync(helper)) chmodSync(helper, 0o755)
    }
  }
}

// Turn on the repo's git hooks (.githooks/pre-commit runs the design-system check) for anyone who installs from a clone.
// Not in CI, not outside a git work tree, and not over a hooks path someone has already chosen. Never fails the install:
// git missing, a tarball without .git, or a read-only config all end quietly.
if (!process.env.CI && existsSync(path.join('.githooks', 'pre-commit'))) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    if (git('rev-parse', '--is-inside-work-tree') === 'true') {
      let current = ''
      try {
        current = git('config', '--get', 'core.hooksPath')
      } catch {
        // exit 1: not set
      }
      if (!current) {
        git('config', 'core.hooksPath', '.githooks')
        console.log('foreman: git hooks enabled (core.hooksPath = .githooks)')
      }
    }
  } catch {
    // no git, or not a repository
  }
}
