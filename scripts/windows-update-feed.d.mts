// Types for windows-update-feed.mjs, for tests/windowsUpdateFeed.test.ts.
export declare function refreshUpdateFeed(dir: string): Promise<{
  version: string
  path: string
  sha512: string
  releaseDate?: string
  files: { url: string; sha512: string; size: number }[]
}>
