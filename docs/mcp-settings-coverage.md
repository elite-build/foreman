# Keeping MCP coverage in sync with CLI settings

Run `npm run check:mcp` after changing settings or Foreman's MCP tools. CI runs the
same command on pull requests and pushes to main.

The CLI owns setting definitions and validation. `tests/cliSchema.test.ts` checks
that personal and repository settings are represented by the CLI schemas, or
explicitly classified as structured settings or non-settings. MCP reuses those
schemas as the input to `tests/mcpSettingsCoverage.test.ts`; it does not maintain a
second settings schema.

The MCP check keeps a reviewed snapshot of each CLI setting's complete schema,
built-in defaults, structured settings, exclusions and the current MCP tool
inventory. Adding, removing or changing those entries fails the check. Changes
to enum choices, bounds, sensitivity and write targets therefore require review,
not just changes to key names. Defaults come from code, never user data; home
paths are normalized for Windows and Unix.

Current decision: ordinary settings have no dedicated MCP read/write tools.
Loadouts have a partial dedicated read through `list_delegation_options`.
Running a configured check or opening a preview is an action, not an adapter for
reading or editing that setting.

The `run_foreman` CLI escape hatch is tracked separately and never counts as
dedicated coverage. Workspace agents can use CLI help and the reviewed
`settings list/get/keys/search/path` commands. Value reads use the CLI's existing
agent-readable settings filter; metadata discovery does not expose saved
sensitive values. Writes, `path --open`, confirmation flags, file import/export,
other commands and arbitrary shell execution are unavailable in this scope.
The assistant retains its existing broader `run_foreman` fallback with command
policy checks and Run/Cancel confirmation. Both interfaces prefer dedicated
tools. The snapshot records dedicated gaps and fallback access independently;
passing this check does **not** mean MCP has full CLI parity.

`MCP_CLI_READ_COMMANDS` pairs reviewed CLI runners with allowed server methods.
The bridge uses the CLI parser, runner and request handler, and checks both
the command and its emitted request. A new CLI command is not automatically
allowed. The guard also records the allowed commands' definitions and common
CLI options, so a new flag requires fallback policy review. The grant is checked
before execution and again before returning data;
the fallback never receives a CLI admin token. Extend this policy with behavior
and authorization tests when adding fallback commands. Keep routine workflows
in dedicated tools rather than expanding the fallback into the primary API.

When the check fails, inspect the diff and decide whether to expose the setting
through an existing CLI handler or retain a documented exclusion. For a new
adapter, update the coverage decisions and add handler/transport tests that
verify its behavior and authorization. Then update the reviewed snapshots with
`npm test -- tests/mcpSettingsCoverage.test.ts --update` and include the coverage
decision in the change description. Do not update snapshots merely to silence
the failure. This guard catches schema/default drift; it cannot prove arbitrary
implementation behavior or replace integration tests.
