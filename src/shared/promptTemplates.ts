// Saved prompts the user can drop into the composer. A template may contain
// {{placeholders}}; the first one is selected after inserting so typing replaces it.
import { createT, type PlainKey, type TFunction } from './i18n'
import type { PromptTemplate } from './types'

const enT = createT('en')

/** The built-in template that proposes a repo's .foreman/settings.toml (R-3). */
export const SETUP_REPO_TEMPLATE_ID = 'default-setup-repo'

export const SETUP_REPO_BODY = `Inspect this repository and propose a .foreman/settings.toml for it. Create or edit that one file in this workspace so the proposal shows up as a diff in Changes. Do not commit it, and do not change any other file.

Propose only what you can justify from the repository itself (package.json scripts, Makefile, CI workflows, lockfiles, README, docs):
- [scripts] setup: the command a fresh checkout needs to become runnable (install dependencies).
- [[checks]]: name and command pairs for the tests, lint and typecheck commands the repo already uses (a command passes on exit code 0).
- sensitive_paths: globs for files a reviewer should look at closely (migrations, lockfiles, CI and deploy config, .env* templates, secrets-adjacent folders).
- Optionally a [scripts.run.dev] entry with a preview URL, if the repo has an obvious dev server.

Only read files while you inspect. Do not run commands that change the system or the project: no installs, builds, test runs, migrations, network calls, git writes or anything that starts a server. If something is unclear, leave it commented out with a note rather than guessing.

These settings are executable once applied, so finish by listing each command you proposed and where you found it, so I can review them before anything runs.`

export const DEFAULT_PROMPT_TEMPLATES: PromptTemplate[] = [
  {
    id: 'default-explain',
    name: 'Explain code',
    body: 'Explain how {{file or feature}} works: the main pieces, how data flows through them, and anything surprising. Don’t change any code.'
  },
  {
    id: 'default-fix-bug',
    name: 'Fix a bug',
    body: 'Fix this bug: {{what happens and what should happen}}\n\nFind the root cause first, add a test that fails without the fix, then fix it and run the relevant tests.'
  },
  {
    id: 'default-fix-issue',
    name: 'Fix an issue',
    // Made for the command line: `foreman run issue ENG-123`.
    body: 'Fix issue {{issue id}}. Read it in the issue tracker first (through its MCP server or CLI), find the root cause, add a test that fails without the fix, then fix it, run the relevant tests and open a pull request that references {{issue id}}.'
  },
  {
    id: 'default-write-tests',
    name: 'Write tests',
    body: 'Write tests for {{file or feature}}. Follow the existing test conventions, cover edge cases and error paths, and run them.'
  },
  {
    id: 'default-refactor',
    name: 'Refactor',
    body: 'Refactor {{file or feature}} to {{goal}} without changing its behavior. Keep the change focused and run the tests afterwards.'
  },
  {
    id: 'default-review',
    name: 'Review my changes',
    body: 'Review the uncommitted changes in this workspace for bugs, regressions and missing edge cases. List concrete problems with file and line; skip style nitpicks.'
  },
  { id: SETUP_REPO_TEMPLATE_ID, name: 'Set up this repo', body: SETUP_REPO_BODY }
]

// The built-in templates' names, shown in the UI language while the user hasn't renamed them.
const DEFAULT_NAME_KEYS: Record<string, PlainKey> = {
  'default-explain': 'automations.default.explain',
  'default-fix-bug': 'automations.default.fixBug',
  'default-fix-issue': 'automations.default.fixIssue',
  'default-write-tests': 'automations.default.writeTests',
  'default-refactor': 'automations.default.refactor',
  'default-review': 'automations.default.review',
  [SETUP_REPO_TEMPLATE_ID]: 'automations.default.setupRepo'
}

/** A template's name to show: a built-in one still under its own name reads in the UI language; others as written. */
export function templateName(template: PromptTemplate, t: TFunction = enT): string {
  const key = DEFAULT_NAME_KEYS[template.id]
  return key && template.name === DEFAULT_PROMPT_TEMPLATES.find((d) => d.id === template.id)?.name ? t(key) : template.name
}

const PLACEHOLDER = /\{\{[^{}\n]*\}\}/

/** Templates whose name or body contains every word of the query. */
export function filterTemplates(templates: PromptTemplate[], query: string): PromptTemplate[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return templates
  const named = (t: PromptTemplate) => words.every((w) => t.name.toLowerCase().includes(w))
  const matching = templates.filter((t) => words.every((w) => `${t.name}\n${t.body}`.toLowerCase().includes(w)))
  // Name matches first.
  return [...matching.filter(named), ...matching.filter((t) => !named(t))]
}

/**
 * Put a template's body in place of the selection [start, end). Returns the new
 * text and what to select: the first {{placeholder}} in the body, or the end of it.
 */
export function insertTemplate(text: string, start: number, end: number, body: string): { text: string; selection: [number, number] } {
  const before = text.slice(0, start)
  const after = text.slice(end)
  // Keep the template on its own lines when inserted mid-text.
  const lead = before && !before.endsWith('\n') ? '\n\n' : ''
  const trail = after && !after.startsWith('\n') ? '\n\n' : ''
  const at = before.length + lead.length
  const placeholder = PLACEHOLDER.exec(body)
  const selection: [number, number] = placeholder
    ? [at + placeholder.index, at + placeholder.index + placeholder[0].length]
    : [at + body.length, at + body.length]
  return { text: before + lead + body + trail + after, selection }
}

export function newTemplateId(): string {
  return `t-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

/** A template's name as a command-line friendly slug: "Fix a bug" → "fix-a-bug". */
export function templateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The template a command-line argument names: its id, its name or slug, or a
 * unique match on the name's words. Ambiguous or unknown names are an error.
 */
export function findTemplate(templates: PromptTemplate[], query: string): { template: PromptTemplate } | { error: string } {
  const q = query.trim().toLowerCase()
  if (!q) return { error: 'Name a template' }
  const exact =
    templates.find((t) => t.id.toLowerCase() === q) ??
    templates.find((t) => t.name.trim().toLowerCase() === q) ??
    templates.find((t) => templateSlug(t.name) === templateSlug(q))
  if (exact) return { template: exact }
  const words = q.split(/[\s-]+/).filter(Boolean)
  const matches = templates.filter((t) => words.every((w) => t.name.toLowerCase().includes(w)))
  if (matches.length === 1) return { template: matches[0] }
  if (matches.length > 1) return { error: `“${query}” matches several templates: ${matches.map((t) => templateSlug(t.name)).join(', ')}` }
  return { error: `No template named “${query}”` }
}

/** The distinct {{placeholders}} in a body, in order of first appearance, without the braces. */
export function templatePlaceholders(body: string): string[] {
  const names = [...body.matchAll(new RegExp(PLACEHOLDER.source, 'g'))].map((m) => m[0].slice(2, -2).trim())
  return [...new Set(names)]
}

/**
 * Fill a template's placeholders with values, in order. A placeholder used more
 * than once gets the same value each time; extra values join the last one, so an
 * unquoted sentence still fills a single placeholder.
 */
export function fillTemplate(body: string, values: string[]): { text: string } | { error: string } {
  const names = templatePlaceholders(body)
  if (!names.length) return values.length ? { error: 'This template has no {{placeholders}} to fill' } : { text: body }
  if (values.length < names.length) {
    const missing = names.slice(values.length).map((n) => `{{${n}}}`)
    return { error: `Missing a value for ${missing.join(', ')}` }
  }
  const filled = new Map(names.map((name, i) => [name, i === names.length - 1 ? values.slice(i).join(' ') : values[i]]))
  return { text: body.replace(new RegExp(PLACEHOLDER.source, 'g'), (m) => filled.get(m.slice(2, -2).trim()) ?? m) }
}

/**
 * The template a draft is still considered to come from. Editing the text,
 * including filling in its placeholders, keeps it; only clearing the draft
 * drops it. Inserting another template replaces it (the caller sets the new id).
 */
export function templateAfterEdit(templateId: string | undefined, text: string): string | undefined {
  return text.trim() ? templateId : undefined
}
