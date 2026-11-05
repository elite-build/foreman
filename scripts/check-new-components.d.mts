// Types for check-new-components.mjs, for tests/newComponents.test.ts.
export declare const LABEL: string
export declare function exportsOf(indexSource: string): Map<string, string>
export declare function newComponentProblems(input: {
  baseIndex: string
  headIndex: string
  changed: string[]
  labels: string[] | null
  has: (path: string) => boolean
  gallery: string
}): string[]
export declare function addedExports(baseIndex: string, headIndex: string): [name: string, module: string][]
export declare function orderProblems(input: { baseIndex: string; headIndex: string; changed: string[] }): string[]
