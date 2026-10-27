// The MCP bridge on its own (out/main/bridge.js): what the app starts for an agent's `foreman-app` and
// integration servers, as `bridge.js mcp-bridge <service>`, the same words `foreman mcp-bridge` takes.
// It imports only the bridge (node:net), never the CLI's commands, settings or translations, so each
// bridge process stays small. Its stdout is the MCP channel: nothing else may print there.
import { runBridge } from './bridge'

const args = process.argv.slice(2)
const service = args[0] === 'mcp-bridge' ? args[1] : args[0]
void runBridge(service ?? '').then(() => process.exit(0))
