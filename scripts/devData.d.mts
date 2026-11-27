// Types for devData.mjs, for tests/devData.test.ts.
export declare const REAL_DATA_FLAG: '--real-data'
export declare function appDataFolder(platform?: NodeJS.Platform, env?: Record<string, string | undefined>, home?: string): string
export declare function worktreeDataDir(worktree: string, appData: string, platform?: NodeJS.Platform): string
export declare function devDataDir(options?: {
  cwd?: string
  env?: Record<string, string | undefined>
  args?: string[]
  platform?: NodeJS.Platform
  home?: string
}): { source: 'env' | 'real' | 'worktree'; dir?: string; shown?: string; args: string[] }
