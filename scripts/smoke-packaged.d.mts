// Types for smoke-packaged.mjs, for tests/smokePackaged.test.ts.
type Command = [file: string, args: string[]]
type Reply = { ok: boolean; result?: unknown; error?: string; code?: string } | null

export declare const DB_FILE: string
export declare const TOKEN_FILE: string
export declare const ADMIN_PROBE: { v: 2; method: string; params: Record<string, never> }
export declare function socketPathFor(dataDir: string, platform?: NodeJS.Platform, tmp?: string): string
export declare function findInstaller(files: string[], platform: NodeJS.Platform): string
export declare function installPlan(platform: NodeJS.Platform, installer: string, root: string): { install: Command[]; executable: string; uninstall: Command[] }
export declare function isSqlite(bytes: Buffer): boolean
export declare function healthProblems(reply: Reply, expected: { version?: string; dataDir: string; socket?: string; platform: NodeJS.Platform }): string[]
export declare function refusalProblems(reply: Reply, label: string): string[]
export declare function acceptedProblems(reply: Reply): string[]
export declare function request(socket: string, body: unknown, timeoutMs?: number): Promise<Reply>
export declare function smoke(dist: string, options?: { version?: string; platform?: NodeJS.Platform; startupMs?: number }): Promise<string[]>
