// Types for third-party-packages.mjs, for electron.vite.config.ts.
import type { Plugin } from 'vite'

export declare const BUNDLED_PACKAGES_FILE: string
export declare function packagePathOf(id: string, root: string): string | null
export declare function thirdPartyPackages(root?: string): Plugin
