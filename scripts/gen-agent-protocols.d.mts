// Types for gen-agent-protocols.mjs, for tests/agentProtocolPins.test.ts.
export declare const PINS_FILE: string
export declare const CODEX_PROTOCOL_DIR: string
export declare const ACP_SCHEMAS: string[]
export declare const CLAUDE_SDK_TYPES: string
export interface AgentProtocolPins {
  codex: { package: string; version: string; command: string; generated: { dir: string; sha256: string; files: number } }
  acp: { package: string; version: string; schemas: Record<string, string> }
  claudeAgentSdk: { package: string; version: string; types: { file: string; sha256: string } }
}
export declare function packageVersion(name: string, root?: string): string
export declare function fileHash(file: string): string
export declare function folderHash(dir: string): { sha256: string; files: number }
export declare function codexBinary(root?: string): string
export declare function currentPins(root?: string): AgentProtocolPins
export declare function readPins(root?: string): AgentProtocolPins
export declare function pinProblems(root?: string, pinned?: AgentProtocolPins): string[]
