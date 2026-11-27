# What leaves your computer

Foreman has no account, no server of its own and no telemetry. Your workspaces, chats and settings are kept in its data folder on your computer (see [Uninstall](../README.md#uninstall) for where). This page lists every place Foreman itself sends something over the network, and when. The coding agents Foreman starts (Claude Code, Codex, Cursor, OpenCode and other ACP agents) are separate programs: they talk to their model providers, and to anything their tools reach, under their own sign-in and their own terms.

Only two things happen without you setting anything up: the update check, and Git and GitHub requests for repositories you add. Everything else waits until you connect a service, turn a feature on, or ask for it.

## On from the start

| Where | When | What is sent |
| --- | --- | --- |
| `api.github.com` (`elite-build/foreman` releases) | An installed Foreman, a few seconds after it starts, when the computer wakes, and every 4 hours (hourly or daily if you choose). Off in **Settings → General → Updates**. | One unauthenticated request; GitHub sees your IP address and Foreman's version in the `User-Agent`. |
| GitHub release downloads (`github.com` and GitHub's download servers) | When an update is found and the update mode downloads it, or after you choose to update. | Requests for the update feed and installer. |
| Your Git remotes, and GitHub through the `gh` command | When you clone, fetch, push, open or merge a pull request, and when the Git panel looks up a workspace's pull request. | Git and `gh` use their own sign-in. Foreman never sees a password, only the token in a GitHub token connection you add. |
| `avatars.githubusercontent.com`, GitLab | When a repository is added (and at start for older ones), to fetch a GitHub organisation's or GitLab project's uploaded avatar as its icon. | One image request. |

## Model providers, through your agents

Each chat turn goes to the agent you picked, which sends it to its model provider with your login or API key. Foreman also uses the same agents for a few requests of its own, which go to the same providers the same way: the title and branch name of a new chat from its first message, the prompt writer in **New workspace**, the built-in assistant, a repository's icon (its name, file list and README), and the reviews, fixes and checks you turn on. **Privacy mode** (**Settings → Account & privacy**) turns off the ones that send your messages or repository details outside a chat. Model lists are refreshed through the agents' own programs at start-up.

## Only when you set them up

| Where | When | What is sent |
| --- | --- | --- |
| GitHub API (`api.github.com`) with a token connection | When you add a GitHub token connection and when Foreman acts with it. | Your token, with the requests it authorizes. |
| GitLab (`<your GitLab host>/api/v4`) | For repositories on GitLab with a token you added. | Your token, with merge request and project requests. |
| Linear (`api.linear.app`, `mcp.linear.app`) | When you add a Linear connection, open an issue link, an agent uses the Linear tools, or an AI employee watches for Linear assignments. | Your Linear key, sent only to Linear; agents never see it. |
| Slack (`slack.com/api`) | When you add a Slack connection, a Slack rule fires on a pull request event, or an agent uses the Slack tools. | Your bot token and the message text. |
| Langfuse (`cloud.langfuse.com` or the address you enter) | Off by default. When on: after each turn and on a regular sweep. | Traces with token counts, cost, a device id and Foreman's version; prompts and answers only with **Include prompts and answers** on. |
| Remote sandboxes: Vercel (`api.vercel.com`), E2B (`api.e2b.app`), Daytona (`app.daytona.io`) | When you connect one and create or use a remote workspace (experimental). | Your provider key, the workspace's files and commands. |
| Git backup remote | Every 30 minutes, when Git backup is set up. | Settings, templates and the repository list, not the secrets vault. |
| Base branch and pull request watching | Every few minutes, for repositories and workspaces where you turned it on. | `git fetch` and `gh` requests with their own sign-in. |
| Dictation model (`huggingface.co`) | Once, when you agree to download the local dictation model. | Requests for four files (about 73 MB), each checked against a pinned SHA-256. After that, dictation stays on your computer. |
| OpenAI transcription (`api.openai.com`) | Only with the cloud dictation engine and your OpenAI key; refused in Privacy mode. | The recorded audio. |
| Web push services (the one your phone's browser chose) | When a paired phone has notifications on. | A short, signed notification title and body. |
| Another computer you paired | When you hand off a workspace or control it from another computer. | Encrypted traffic directly between the two computers; no server in between. |

Links Foreman shows (pull requests, release pages, sign-in pages) open in your browser; Foreman itself makes no request for them. Images in chat and Markdown may load from the web, like any web page. Crash reports stay on your computer (`uploadToServer` is off).

## What listens on your computer

| What | Where | When |
| --- | --- | --- |
| The `foreman` command's socket | A socket in the data folder (a named pipe on Windows), for your user only; settings changes need the token in `cli.token`. | Always, while Foreman runs. |
| Agents on this computer (MCP) | `127.0.0.1:47634` | When you turn it on. |
| Phone and browser access | `127.0.0.1:47632`, and `47633` on the network address you pick for access over Wi-Fi | When you turn them on; every device is paired and approved by you. |
| Hand-off and remote control | Port `47631` on all network interfaces | While hand-offs or remote control are on, or a pairing code is showing. |

## How this was checked

On 2026-11-26 the main process, shared code, command line and phone client were searched for outbound requests: `fetch(`, `https.request`, `http.request`, `https.get(`, `net.connect`, `net.createConnection`, `tls.connect`, `new WebSocket(`, hostnames in `http(s)://` and `ws(s)://` literals, `electron-updater` and `autoUpdater`, `crashReporter`, `shell.openExternal`, `web-push`, the SDKs of the sandbox providers, Langfuse, Linear and Slack clients, `gh`, `glab` and `git push`/`fetch`/`clone` invocations, `npm install` and registry calls (none on your computer), timers in the watchers, and listeners (`.listen(`, `createServer(`). The renderer's Content Security Policy (`src/renderer/index.html`) allows connections only to Foreman itself and local servers, and fonts only from the app. Sandbox setup scripts that download tools (`e2bTemplate.ts`, `daytonaImage.ts`) run inside the sandbox, not on your computer. When you add a feature that contacts a new service, add it here.
