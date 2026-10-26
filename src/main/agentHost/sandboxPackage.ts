// Cloud workspaces: what the base sandbox needs to run the agent host. The host bundle keeps the
// agent SDKs external, so they are installed in the sandbox from sandboxPackageJson(), next to the
// uploaded files. Versions come from Foreman's own package.json, bundled in at build time, with the
// range prefix dropped: this repo moves a range's floor with every lockfile bump, so the floor is the
// version Foreman ships and tests with (tests/sandboxHost.test.ts checks it against node_modules).
import { existsSync, readFileSync } from 'node:fs'
import { builtinModules } from 'node:module'
import path from 'node:path'
import { dependencies } from '../../../package.json'

export const SANDBOX_DEPENDENCIES = ['@agentclientprotocol/sdk', '@anthropic-ai/claude-agent-sdk', '@modelcontextprotocol/sdk', '@openai/codex-sdk', 'zod'] as const

/** "^1.8.0" → "1.8.0". */
export function pinned(range: string): string {
  return range.replace(/^[\^~=v\s]+/, '')
}

/**
 * The package.json for the folder the host bundle is uploaded to. `type: module` because the bundle is ESM
 * `.js`; install it in that same folder so the bundle and its chunks resolve the SDKs from its node_modules.
 */
export function sandboxPackageJson(): string {
  const deps: Record<string, string> = {}
  for (const name of SANDBOX_DEPENDENCIES) deps[name] = pinned(dependencies[name])
  return `${JSON.stringify({ name: 'foreman-sandbox-host', private: true, type: 'module', dependencies: deps }, null, 2)}\n`
}

const IMPORT = /^\s*(?:import|export)\b[^;'"]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm

/**
 * A built entry and the chunks it loads, relative to `outDir` (out/main), and the packages it imports.
 * The files are what gets uploaded to the sandbox; the packages must be node builtins or SANDBOX_DEPENDENCIES.
 */
export function bundleClosure(outDir: string, entry: string): { files: string[]; packages: string[] } {
  const files: string[] = []
  const packages = new Set<string>()
  const visit = (file: string) => {
    if (files.includes(file)) return
    files.push(file)
    const source = readFileSync(path.join(outDir, file), 'utf8')
    for (const match of source.matchAll(IMPORT)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec.startsWith('.')) {
        const next = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec))
        if (existsSync(path.join(outDir, next))) visit(next)
      } else packages.add(spec)
    }
  }
  visit(entry)
  return { files, packages: [...packages].sort() }
}

/** The package a specifier belongs to, or null for a node builtin. */
export function packageOf(spec: string): string | null {
  if (spec.startsWith('node:') || builtinModules.includes(spec)) return null
  const parts = spec.split('/')
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** What gets uploaded to a sandbox's /vercel/foreman: the host bundle and its chunks, the attach bridge, and package.json. */
export interface HostBundle {
  // Foreman's version: a sandbox with another one gets the files again.
  version: string
  // Paths relative to the upload folder.
  files: { path: string; data: Buffer }[]
  packageJson: string
}

/** The bundle from a build's out/main. Null when it hasn't been built (tests, or a dev run before the first build). */
export function readHostBundle(outDir: string, version: string): HostBundle | null {
  if (!existsSync(path.join(outDir, 'sandboxHost.js')) || !existsSync(path.join(outDir, 'sandboxAttach.js'))) return null
  const names = [...bundleClosure(outDir, 'sandboxHost.js').files, 'sandboxAttach.js']
  return { version, files: [...new Set(names)].map((name) => ({ path: name, data: readFileSync(path.join(outDir, name)) })), packageJson: sandboxPackageJson() }
}
