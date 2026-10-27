# Windows

Foreman targets macOS and Windows from one codebase, but so far it has been verified on macOS only.

Foreman includes Windows shell selection, process cleanup, path handling, CLI launchers and NSIS packaging. The full Windows app workflow still needs validation; Linux has platform helpers and an AppImage build target but no dedicated distribution script.

What still needs checking on a Windows machine:

1. **Prerequisites.** Install a Node version listed in the [README](../README.md#run-it) and Git for Windows. Claude Code on Windows needs Git Bash. If it can't find it, set `CLAUDE_CODE_GIT_BASH_PATH`; Foreman passes that variable through to the agent.
2. **`npm install && npm test`.** This exercises worktrees, checkpoints, diffs and a setup script run through `cmd.exe`. Fix anything that fails here first.
3. **`npm run dev`, then walk through:** add a repo, create a workspace, open a terminal (PowerShell by default), configure an agent, send a message, approve a tool request where supported, check Changes, use Restore to here, and Archive. Check additional shells under Settings → General → Terminal.
4. **Archiving with a running dev server.** Windows locks open files, so `git worktree remove` can fail while something in the worktree is still running. Foreman kills its own terminals first and shows git's error if removal still fails.
5. **Long paths.** Worktrees are created with `core.longpaths=true`. Keep the workspaces folder short (Settings); the default is `%USERPROFILE%\foreman\workspaces`.
6. **Editor command.** Verify that `code`, `cursor` and other editor launchers open the workspace; Windows installations may use `.cmd` shims.
7. **Installer.** Run `npm run dist:win` on Windows, or download the Windows artifact from a manual **Installers** workflow run. Code signing isn't configured yet (and isn't configured for macOS either).
