// The launch token: a random secret in the data folder that the `foreman` command reads and presents with
// every version 2 request. It keeps other users on the computer away from the admin tier (the socket's own
// 0600 doesn't exist for a Windows named pipe). It does not hide anything from an agent running as the same
// user, which can read the data folder too; the tier policy is what holds agents back.
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { promisify } from 'node:util'
import { tokenPath } from '../../cli/protocol'

const run = promisify(execFile)

// 32 random bytes as hex.
const TOKEN = /^[0-9a-f]{64}$/

/** The token in `<dataDir>/cli.token`, or null when it isn't there or isn't a token (the command then sends none). */
export function readCliToken(dataDir: string): string | null {
  try {
    const text = readFileSync(tokenPath(dataDir), 'utf8').trim()
    return TOKEN.test(text) ? text : null
  } catch {
    return null
  }
}

/**
 * Make the file readable by this user only. 0600 elsewhere. On Windows the ACL is rewritten with icacls
 * (inheritance removed, one grant for the current user); this is best effort: if icacls is missing or
 * refuses, a warning is logged and the token still works, it is just as readable as the data folder.
 */
async function restrict(file: string): Promise<void> {
  if (process.platform !== 'win32') return chmodSync(file, 0o600)
  const user = process.env.USERNAME || os.userInfo().username
  try {
    // The grant comes first so the file is never left with no entries at all if it can't be made.
    await run('icacls', [file, '/grant:r', `${user}:(R,W)`, '/inheritance:r'], { windowsHide: true })
  } catch (err) {
    console.warn('Could not restrict the access of the command-line token file:', err instanceof Error ? err.message : err)
  }
}

/**
 * Read the token, making one (and the file) on first launch. The file's access is set on every launch, so a
 * token written by an older build or copied from a backup ends up restricted too.
 */
export async function ensureCliToken(dataDir: string, options: { restrict?: (file: string) => Promise<void> } = {}): Promise<string> {
  const file = tokenPath(dataDir)
  let token = readCliToken(dataDir)
  if (!token) {
    mkdirSync(dataDir, { recursive: true })
    token = randomBytes(32).toString('hex')
    // The mode applies at creation on Unix; an existing malformed file is overwritten in place.
    writeFileSync(file, `${token}\n`, { mode: 0o600 })
  }
  if (existsSync(file)) await (options.restrict ?? restrict)(file)
  return token
}
