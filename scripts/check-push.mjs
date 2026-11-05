// The pre-push hook (.githooks/pre-push): refuse a push whose commit holds a path the publication policy forbids
// (scripts/publication-paths.mjs), so a design mock (mocks/, mockups/, mock.html…) never reaches a pull request or main.
// A branch may carry a mock while it's worked on; the push that raises or updates its pull request may not.
//
// Only Node built-ins and git, like scripts/release.mjs: it runs in a checkout without node_modules.

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCREENSHOT_BRANCH } from './pr-screens.mjs'
import { forbiddenPath } from './publication-paths.mjs'

/** The forbidden files in `commit`'s tree: everything a merge of it would bring, not only what it changed. */
export function forbiddenInCommit(commit, cwd = process.cwd()) {
  return execFileSync('git', ['ls-tree', '-r', '--name-only', '-z', commit], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split('\0').filter(Boolean).filter(forbiddenPath)
}

/** `remote ref: file` for each forbidden file a push sends, from the lines git writes to a pre-push hook's stdin. */
export function checkPush(input, cwd = process.cwd()) {
  const errors = []
  for (const line of input.split('\n')) {
    const [, local, remoteRef] = line.trim().split(' ')
    // A deletion sends nothing; the screenshot branch shares no history with main and never merges.
    if (!local || /^0+$/.test(local) || remoteRef === `refs/heads/${SCREENSHOT_BRANCH}`) continue
    for (const file of forbiddenInCommit(local, cwd)) errors.push(`${remoteRef}: ${file}`)
  }
  return errors
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const errors = checkPush(readFileSync(0, 'utf8'))
  if (errors.length) {
    console.error(`Push blocked: these files must not reach a pull request or main (scripts/publication-paths.mjs):
${errors.map(e => `  ${e}`).join('\n')}

Take them out of the branch, keeping your copy in the workspace, then push again:
  git rm -r --cached -- <path>
  echo '<path>' >> "$(git rev-parse --git-path info/exclude)"
  git commit -m "Take the mocks out of the branch"`)
    process.exitCode = 1
  }
}
