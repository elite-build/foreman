// Ways to get a repository into Foreman besides opening a folder: clone
// one (from a URL or the user's GitHub repos) or start an empty one.
import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { GithubRepo } from '../shared/types'
import { git } from './git'
import { gh, githubEnv } from './github'

/** "https://github.com/acme/web.git" or "git@github.com:acme/web.git" → "web". */
export function repoNameFromUrl(url: string): string | null {
  const trimmed = url.trim().replace(/[/\\]+$/, '')
  const last = trimmed.split(/[/:\\]/).pop() ?? ''
  const name = last.replace(/\.git$/i, '')
  return /^[\w.-]+$/.test(name) && name !== '.' && name !== '..' ? name : null
}

/** Clone URLs git understands: https://, ssh://, git@host:path, or a local path. */
export function looksLikeCloneUrl(url: string): boolean {
  const u = url.trim()
  return /^(https?|ssh|git):\/\/\S+$/i.test(u) || /^[\w.-]+@[\w.-]+:\S+$/.test(u) || path.isAbsolute(u)
}

function isEmptyDir(dir: string): boolean {
  try {
    return readdirSync(dir).length === 0
  } catch {
    return true
  }
}

/** git clone into parentDir/<name>, reporting progress lines as they come. Returns the new folder. */
export function cloneRepo(url: string, parentDir: string, onLine: (line: string) => void, account?: string): Promise<string> {
  const name = repoNameFromUrl(url)
  if (!looksLikeCloneUrl(url) || !name) return Promise.reject(new Error("That doesn't look like a git URL"))
  const dest = path.join(parentDir, name)
  if (existsSync(dest) && !isEmptyDir(dest)) return Promise.reject(new Error(`${dest} already exists. Open it with Open project, or choose another location.`))
  let github: Record<string, string>
  try {
    github = githubEnv(account)
  } catch (err) {
    return Promise.reject(err)
  }
  return mkdir(parentDir, { recursive: true }).then(
    () =>
      new Promise<string>((resolve, reject) => {
        const child = spawn('git', ['clone', '--progress', url.trim(), dest], {
          cwd: parentDir,
          env: { ...process.env, ...github, GIT_TERMINAL_PROMPT: '0' },
          windowsHide: true
        })
        let tail = ''
        const read = (chunk: Buffer) => {
          // Progress lines end in \r; show each update.
          for (const line of chunk.toString('utf8').split(/[\r\n]+/)) {
            if (!line.trim()) continue
            tail = (tail + line + '\n').slice(-4000)
            onLine(line)
          }
        }
        child.stdout.on('data', read)
        child.stderr.on('data', read)
        child.on('error', (err) => reject(new Error(`Couldn't run git: ${err.message}`)))
        child.on('close', (code) => {
          if (code === 0) return resolve(dest)
          const auth = /terminal prompts disabled|Authentication failed|could not read Username|Permission denied \(publickey\)/i.test(tail)
          reject(
            new Error(
              auth
                ? `Git couldn't authenticate. Sign in with gh auth login (Settings → Account) or set up SSH keys, then try again.\n\n${tail.trim()}`
                : tail.trim() || `git clone exited with code ${code}`
            )
          )
        })
      })
  )
}

interface ApiRepo {
  full_name: string
  clone_url: string
  ssh_url: string
  description: string | null
  pushed_at: string | null
  private: boolean
}

/** The user's GitHub repositories, most recently pushed first (via the gh CLI). */
export async function githubRepos(account?: string): Promise<GithubRepo[]> {
  const out = await gh(process.cwd(), ['api', 'user/repos?sort=pushed&per_page=50&affiliation=owner,collaborator,organization_member'], 20_000, account)
  return (JSON.parse(out) as ApiRepo[]).map((r) => ({
    fullName: r.full_name,
    httpsUrl: r.clone_url,
    sshUrl: r.ssh_url,
    description: r.description ?? undefined,
    pushedAt: r.pushed_at ?? undefined,
    private: r.private
  }))
}

/** gh's preferred protocol for cloning. */
export async function gitProtocol(): Promise<'https' | 'ssh'> {
  const out = await gh(process.cwd(), ['config', 'get', 'git_protocol'], 5000).catch(() => '')
  return out.trim() === 'ssh' ? 'ssh' : 'https'
}

/** A new, empty repository: a folder with git initialised, a README and a first commit. */
export async function quickStart(parentDir: string, name: string): Promise<string> {
  const clean = name.trim()
  if (!/^[\w.-]+$/.test(clean) || clean === '.' || clean === '..') throw new Error('Use letters, numbers, dots, dashes or underscores for the name')
  const dir = path.join(parentDir, clean)
  if (existsSync(dir) && !isEmptyDir(dir)) throw new Error(`${dir} already exists`)
  await mkdir(dir, { recursive: true })
  await git(dir, ['init', '-q', '-b', 'main'])
  await writeFile(path.join(dir, 'README.md'), `# ${clean}\n`)
  await git(dir, ['add', '-A'])
  const commit = await git(dir, ['commit', '-q', '-m', 'Initial commit'], { allowFail: true })
  if (commit.code !== 0) {
    const identity = /user\.(name|email)|identity|Please tell me who you are/i.test(commit.stderr)
    throw new Error(
      identity
        ? 'Git needs your name and email first: run git config --global user.name "Your Name" and git config --global user.email you@example.com'
        : commit.stderr.trim() || 'git commit failed'
    )
  }
  return dir
}
