// Types for pr-screens.mjs, for tests/prScreens.test.ts.
export declare const SCREENSHOT_BRANCH: string
export declare function githubRepo(url: string): string | null
export declare function folderName(name: string): string
export declare function publishedName(file: string): string
export declare function fileProblems(file: string): string[]
export declare function publishScreens(input: { cwd?: string; files: string[]; folder: string; remote?: string; branch?: string; attempts?: number }): { commit: string; paths: string[] }
export declare function withBaseWorktree<T>(root: string, ref: string, fn: (worktree: string) => T): T
export declare function parseArgs(argv: string[]): { command: string | undefined; options: Record<string, string>; positional: string[] }
