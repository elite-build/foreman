// Types for release.mjs, for tests/release.test.ts.
export declare function parseVersion(text: string): { major: number; minor: number; patch: number; pre: string[] } | null
export declare function compareVersions(a: string, b: string): number
export declare function nextVersion(current: string, request: string | undefined): string
export declare function setVersion(packageJson: string, packageLock: string, version: string): { packageJson: string; packageLock: string }
export declare function tagProblems(input: { version: string; tags: string[] }): string[]
