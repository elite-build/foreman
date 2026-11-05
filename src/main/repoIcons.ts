// Repository icons Foreman picks itself, once per repository: when it's added, and at launch for repositories added
// before. An icon you chose (the picker or `foreman repo settings`) always wins. Otherwise, in order: the project's own
// icon file on its default branch (Claude picks among the likely files when it can), a GitHub organisation's or GitLab
// project's avatar that someone uploaded, a Lucide icon Claude suggests from the name and README, else the letters.
import path from 'node:path'
import { IMAGE_MIME, imageInfo, previewFormat, sniffFormat } from '../shared/imageInfo'
import { SUGGESTED_REPO_ICONS } from '../shared/repoIcons'
import type { Repo, RepoIcon } from '../shared/types'
import { projectAvatar, type GitlabApi } from './gitlab'

export interface IconImage {
  bytes: Buffer
  type: string
}

export interface TreeEntry {
  path: string
  oid: string
  size: number
}

export interface IconCandidate extends TreeEntry {
  // Lower is likelier.
  score: number
  // Named and placed like a project's icon (build/icon.png, public/favicon.svg…): used without Claude's say.
  strong: boolean
}

export interface IconChoice {
  file?: IconCandidate
  lucide?: string
}

export const MAX_ICON_BYTES = 1_000_000
// Stored as they are up to this size; larger ones are scaled down (Host.shrinkImage) or passed over.
const MAX_STORED_BYTES = 48 * 1024
// Shown at 16 px; 64 keeps it sharp on a high-density screen, like an upload in the picker.
export const ICON_PIXELS = 64
const MAX_CANDIDATES = 30
const README_CHARS = 1500

const IMAGE_EXT = /\.(svg|png|ico|webp|jpe?g)$/i
const ICON_WORD = /favicon|icon|logo/i
// Other projects' pictures, tests and samples.
const SKIP_DIRS = /(^|\/)(node_modules|vendor|third[-_]party|fixtures|__fixtures__|__tests__|tests?|spec|e2e|examples?|samples?|demos?|screenshots)(\/|$)/i
// Where projects keep their icon, at the top or in a monorepo's package (frontend/public, apps/web/public).
const PLACES = [
  'public', 'static', 'app', 'src', 'src/app', 'src/assets', 'build', 'resources', 'assets', 'assets/images', 'images', 'img', 'media', 'brand',
  'branding', 'logo', 'logos', 'icons', 'favicon', '.github', 'docs', 'docs/images', 'docs/assets', 'public/images', 'public/img', 'public/favicon',
  'public/logo', 'static/img'
]
const isPlace = (dir: string) => dir === '' || PLACES.some((p) => dir === p || dir.endsWith(`/${p}`))
// The file's name without its extension, as icons are usually named: lower is likelier.
const STEMS: Record<string, number> = { icon: 0, 'app-icon': 0, appicon: 0, favicon: 1, 'apple-touch-icon': 1, logo: 2, logomark: 2, 'logo-mark': 2 }
const STEM_PREFIXES = Object.keys(STEMS).sort((a, b) => b.length - a.length)
const VARIANT = /(^|[-_.@])(dev|debug|test|beta|canary|nightly|insiders|staging|old|legacy)($|[-_.@])/i

// Git blob ids of starter templates' default icons (Next.js, Create React App, Angular, Vite, SvelteKit): a project
// that kept one hasn't chosen an icon.
const STARTER_BLOBS = new Set([
  'af98450595e8b8efd9e505cddc5ed705b665a4d8', '718d6fea4835ec2d246af9800eddb7ffb276240c', // create-next-app favicon.ico
  'a11777cc471a4344702741ab1c8a588998b1311a', 'fc44b0a3796c0e0a64c3d858ca038bd4570465d9', 'a4e47a6545bc15971f8f63fba70e4013df88a664', '9dfc1c058cebbef8b891c5062be6f31033d7d186', // CRA
  '57614f9c967596fad0a3989bec2b1deff33034f6', '997406ad22c29aae95893fb3d666c30258a09537', // Angular favicon.ico
  '6893eb13237060adc0c968a690149a49faa2d7d3', '0906f9ca5ea46fa7481d645fa1fd380cba0428ad', 'e7b8dfb1b2a60bd50538bec9f876511b9cac21e3', // Vite
  'cc5dc66a3a524f4167cc097452cbe3c3883a684c', '825b9e65af7c104cfb07089bb28659393b4f2097' // SvelteKit
])

/** `git ls-tree -r -l -z` output as its files. */
export function parseTree(listing: string): TreeEntry[] {
  const out: TreeEntry[] = []
  for (const line of listing.split('\0')) {
    const tab = line.indexOf('\t')
    if (tab < 0) continue
    const [, type, oid, size] = line.slice(0, tab).split(/\s+/)
    if (type === 'blob') out.push({ path: line.slice(tab + 1), oid, size: Number(size) })
  }
  return out
}

function rank(file: string, repoName: string): { score: number; strong: boolean } | null {
  const dir = path.posix.dirname(file) === '.' ? '' : path.posix.dirname(file)
  const name = path.posix.basename(file)
  const stem = name.replace(IMAGE_EXT, '').toLowerCase()
  // A file named after the project (docs/archify.svg) is as good as a logo.
  let base = STEMS[stem] ?? (stem === repoName.toLowerCase() ? 2 : undefined)
  if (base === undefined) {
    // icon-192.png, logo@2x.png, favicon-32x32.png: a size or variant of one.
    const prefix = STEM_PREFIXES.find((s) => stem.startsWith(s) && /^[-_.@]/.test(stem.slice(s.length)))
    if (prefix) base = STEMS[prefix] + 1
  }
  if (base === undefined && !ICON_WORD.test(stem)) return null
  const variant = VARIANT.test(stem)
  const known = isPlace(dir.toLowerCase())
  const depth = dir ? dir.split('/').length : 0
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
  const score = (base ?? 6) + (variant ? 3 : 0) + (known ? 0 : 2) + Math.max(0, depth - 2) + (ext === 'svg' || ext === 'png' ? 0 : ext === 'ico' ? 0.5 : 1)
  return { score, strong: base !== undefined && !variant && known }
}

/** The repository's image files that may be its icon, likeliest first. */
export function iconCandidates(entries: TreeEntry[], repoName: string): IconCandidate[] {
  const out: IconCandidate[] = []
  for (const entry of entries) {
    if (!IMAGE_EXT.test(entry.path) || SKIP_DIRS.test(entry.path) || STARTER_BLOBS.has(entry.oid)) continue
    if (!(entry.size > 0 && entry.size <= MAX_ICON_BYTES)) continue
    const r = rank(entry.path, repoName)
    if (r) out.push({ ...entry, ...r })
  }
  return out.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path)).slice(0, MAX_CANDIDATES)
}

/** The question for Claude: one of the files, and a Lucide icon that fits. Its answer is a short label, like a chat title. */
export function iconPrompt(name: string, candidates: IconCandidate[], readme: string): string {
  return [
    `Choose an icon for the code repository "${name}", shown at 16 pixels in a developer tool's sidebar.`,
    '',
    candidates.length ? 'Image files in the repository whose names suggest an icon or logo (path, size):' : 'The repository has no image files named like an icon or logo.',
    ...candidates.map((c, i) => `${i + 1}. ${c.path} (${c.size} bytes)`),
    '',
    readme.trim() ? `The start of its README:\n"""\n${readme.trim()}\n"""` : 'It has no README.',
    '',
    'Reply with a number and an icon name separated by a space, such as "2 Rocket", and nothing else:',
    "- The number of the file that is this project's own icon or logo, or 0 when none is. Prefer the main app icon or favicon",
    '  over variants (dev builds, sizes, dark versions). A framework or starter template default (React, Next.js, Vite, Angular,',
    "  Svelte, Vercel), another product's logo or a screenshot is not the project's own: answer 0 for those.",
    `- The name from this list that best fits what the project is about: ${SUGGESTED_REPO_ICONS.join(', ')}`
  ].join('\n')
}

const SUGGESTED = new Map(SUGGESTED_REPO_ICONS.map((n) => [n.toLowerCase(), n]))

/** Claude's answer, held to what was offered: a listed file and a listed icon, or nothing. */
export function parseIconAnswer(answer: string, candidates: IconCandidate[]): IconChoice {
  // The number leads; digits in an icon's name (Gamepad2) aren't one.
  const number = /^\W*(\d+)\b/.exec(answer)
  const index = number ? Number(number[1]) - 1 : -1
  const file = index >= 0 ? candidates[index] : undefined
  const lucide = answer.match(/[A-Za-z][A-Za-z0-9]*/g)?.map((w) => SUGGESTED.get(w.toLowerCase())).find(Boolean)
  return { ...(file ? { file } : {}), ...(lucide ? { lucide } : {}) }
}

function dataUrl(image: IconImage): string {
  return `data:${image.type};base64,${image.bytes.toString('base64')}`
}

/** What the bytes are, from their header (an SVG from its name and an <svg> tag); null for anything else. */
function asImage(bytes: Buffer, file: string): IconImage | null {
  if (previewFormat(file) === 'svg') return /<svg[\s>]/i.test(bytes.toString('utf8')) ? { bytes, type: IMAGE_MIME.svg } : null
  const format = sniffFormat(bytes)
  return format ? { bytes, type: IMAGE_MIME[format] } : null
}

/**
 * A GitHub organisation's avatar when someone uploaded it. GitHub's generated default is a 420 px pattern whatever
 * size is asked for, so it gives itself away; a person's avatar is their face on every repository, so it's skipped.
 */
export async function githubOrgAvatar(slug: string, api: (args: string[]) => Promise<string>, fetchFn: typeof fetch = fetch): Promise<IconImage | null> {
  const repo = JSON.parse(await api(['api', `repos/${slug}`])) as { owner?: { type?: string; avatar_url?: string } }
  const url = repo.owner?.type === 'Organization' ? repo.owner.avatar_url : undefined
  if (!url?.startsWith('https://avatars.githubusercontent.com/')) return null
  const res = await fetchFn(`${url}${url.includes('?') ? '&' : '?'}s=${ICON_PIXELS}`, { signal: AbortSignal.timeout(15_000) })
  if (!res.ok) return null
  const bytes = Buffer.from(await res.arrayBuffer())
  const format = sniffFormat(bytes)
  if (!format) return null
  const { width } = imageInfo(bytes, format)
  if (format === 'png' && width !== undefined && width > ICON_PIXELS) return null
  return { bytes, type: IMAGE_MIME[format] }
}

/** A GitLab project's own avatar, or null when it has none. */
export async function gitlabProjectAvatar(api: GitlabApi, project: string): Promise<IconImage | null> {
  const got = await projectAvatar(api, project)
  if (!got) return null
  return got.type.includes('svg') ? asImage(got.bytes, 'avatar.svg') : asImage(got.bytes, 'avatar')
}

export interface RepoIconDeps {
  repo(id: string): Repo | undefined
  changed(): void
  // `git ls-tree -r -l -z <ref>` in the repository, or null when the ref isn't there.
  listTree(root: string, ref: string): Promise<string | null>
  blob(root: string, oid: string): Promise<Buffer>
  // Claude's one-line answer, or null without one (privacy mode, or Claude isn't installed or signed in).
  ask(prompt: string): Promise<string | null>
  remoteAvatar(repo: Repo): Promise<IconImage | null>
  // The image scaled down to `pixels` on its long side, as a PNG data URL; null when it can't be read. Absent in tests.
  shrink?(image: IconImage, pixels: number): Promise<string | null>
}

export class RepoIcons {
  // One repository at a time: each may start Claude.
  private queue: Promise<void> = Promise.resolve()

  constructor(private deps: RepoIconDeps) {}

  /** Look for the repository's icon in the background, once. Resolves when it's done (tests). */
  pick(repoId: string): Promise<void> {
    const run = this.queue.then(() => this.pickNow(repoId)).catch((err: unknown) => console.error('Repository icon:', err))
    this.queue = run
    return run
  }

  /** The repository still wants an icon from Foreman: it has none and Foreman hasn't looked yet. */
  private wanting(repoId: string): Repo | undefined {
    const repo = this.deps.repo(repoId)
    return repo && !repo.icon && !repo.iconChecked ? repo : undefined
  }

  private async pickNow(repoId: string): Promise<void> {
    const repo = this.wanting(repoId)
    if (!repo) return
    const icon = await this.find(repo)
    // Chosen meanwhile (in the picker, or a backup's): that one stays.
    const now = this.wanting(repoId)
    if (!now) return
    if (icon) now.icon = icon
    now.iconChecked = true
    this.deps.changed()
  }

  async find(repo: Repo): Promise<RepoIcon | null> {
    const entries = await this.tree(repo)
    const candidates = iconCandidates(entries, repo.name)
    let choice: IconChoice | undefined
    const choose = async () => (choice ??= await this.choose(repo, entries, candidates))
    if (candidates.length) {
      const file = (await choose()).file
      const url = file ? await this.fileUrl(repo, file) : null
      if (url) return { kind: 'image', dataUrl: url }
    }
    const avatar = await this.deps.remoteAvatar(repo).catch(() => null)
    const avatarUrl = avatar ? await this.storedUrl(avatar) : null
    if (avatarUrl) return { kind: 'image', dataUrl: avatarUrl }
    const lucide = (await choose()).lucide
    return lucide ? { kind: 'lucide', name: lucide } : null
  }

  /** The likeliest icon file by name and place alone, at full size (the picker's "From the repo" tab scales it). */
  async detectFile(repo: Repo): Promise<string | null> {
    const best = iconCandidates(await this.tree(repo), repo.name).find((c) => c.strong)
    if (!best) return null
    const image = asImage(await this.deps.blob(repo.rootPath, best.oid), best.path)
    return image ? dataUrl(image) : null
  }

  /** The default branch's files, so the icon doesn't change with whatever is checked out. */
  private async tree(repo: Repo): Promise<TreeEntry[]> {
    const listing = (await this.deps.listTree(repo.rootPath, repo.defaultBranch)) ?? (await this.deps.listTree(repo.rootPath, 'HEAD'))
    return parseTree(listing ?? '')
  }

  private async choose(repo: Repo, entries: TreeEntry[], candidates: IconCandidate[]): Promise<IconChoice> {
    const answer = await this.deps.ask(iconPrompt(repo.name, candidates, await this.readme(repo, entries))).catch(() => null)
    // Without Claude: the file named and placed most like an icon, and no suggestion.
    return answer?.trim() ? parseIconAnswer(answer, candidates) : { file: candidates.find((c) => c.strong) }
  }

  private async readme(repo: Repo, entries: TreeEntry[]): Promise<string> {
    const entry = entries.find((e) => /^readme(\.(md|markdown|rst|txt|adoc))?$/i.test(e.path))
    if (!entry) return ''
    const bytes = await this.deps.blob(repo.rootPath, entry.oid).catch(() => null)
    return bytes ? bytes.subarray(0, README_CHARS * 4).toString('utf8').slice(0, README_CHARS) : ''
  }

  private async fileUrl(repo: Repo, file: IconCandidate): Promise<string | null> {
    const bytes = await this.deps.blob(repo.rootPath, file.oid).catch(() => null)
    const image = bytes ? asImage(bytes, file.path) : null
    return image ? this.storedUrl(image) : null
  }

  /** The image as it's kept in the repository's settings: small. An SVG stays a vector; others are scaled to icon size. */
  private async storedUrl(image: IconImage): Promise<string | null> {
    if (image.type === IMAGE_MIME.svg) return image.bytes.length <= MAX_STORED_BYTES ? dataUrl(image) : null
    const small = this.deps.shrink ? await this.deps.shrink(image, ICON_PIXELS).catch(() => null) : null
    return small ?? (image.bytes.length <= MAX_STORED_BYTES ? dataUrl(image) : null)
  }
}
