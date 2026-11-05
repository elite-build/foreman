# AI memory for Foreman and the repositories it manages

An exploration, written 2026-11-04, of what "memory" could mean for the agents Foreman runs, what Foreman already has, the ways it could be done, and which one is worth building. It is a proposal, not a description of shipped behaviour.

## 1. What memory means here

An agent's context window is wiped at the end of every chat. Everything it knew about the repository, the user and the environment has to be rebuilt from files on disk and the message it is given. "Memory" is whatever bridges one chat to the next. It comes in layers, and they are worth keeping apart because each one has a different owner, lifetime and risk:

| Layer | What it holds | Example | Who writes it today |
| --- | --- | --- | --- |
| Standing instructions | Rules that always apply | `AGENTS.md`, custom prompts in repository settings | People, through pull requests or settings |
| Episodic | What happened, verbatim | Chat transcripts, reports, review findings | Foreman, automatically |
| Learned facts | Non-obvious things a chat found out, distilled to a line | "The full test suite times out on Windows under load; rerun failing files with `--maxWorkers=4`" | Nobody, in Foreman; Claude Code privately |
| Procedural | How to do a recurring task | `.claude/skills/create-pr`, prompt templates | People |

The question is the third row. The first, second and fourth already exist, and the gap is that nothing turns the second into the third without a person doing it by hand.

There are two scopes:

- **Repository memory**: facts about one codebase and its environment. Most learned facts are this kind.
- **Foreman memory**: facts about the user and how they work, across repositories. "Prefers a release note in every PR", "on Windows, uses PowerShell", "wants to be asked before anything is pushed". These apply to every agent in every repository, and to the Foreman assistant.

This repository is a special case of the first: Foreman is maintained by agents running in Foreman. Facts about *developing* Foreman (the GateGuard hook, the test suite's load timeouts, the SDK never killing a lingering process) are repository memory of the `foreman` repository. They must not be confused with the "You are running inside Foreman" context that `WorkspaceService.agentContext` gives every agent in every repository. The two happen to be about the same program, but one is how to use it and the other is how to build it. Any design has to keep that boundary, or the Foreman repository's gotchas leak into unrelated projects.

## 2. What Foreman has today

Read before designing, because most of the machinery is already there.

**The injection point.** Every turn gets one system-prompt addition, assembled in `runTurn` in `src/main/sessions.ts`: `agentContext(ws)` (where the agent is, ports, the no-commit rule), then the repository's standing instructions (`prompts.general`, from `.foreman/settings.toml` or the local override), then "Teach agents Foreman", then the integrations in use. Each driver delivers it as its agent allows: Claude Code appends it to its preset prompt (`src/main/agents/claude.ts`), Codex puts it in `developer_instructions` (`codex.ts`), Cursor and the ACP agents prepend it to the first message of a fresh conversation (`cursor.ts`, `acp.ts`). Anything Foreman wants every agent to know goes through this one seam, and it already reaches cloud sandboxes, since it is text.

**The receipt.** `src/shared/context.ts` records every addition as a `ContextPart` (instructions, note, comments, attachments, history, catch-up, MCP, integrations), and the chat shows "Foreman added: standing instructions · note r3". The principle is that nothing reaches the agent without the user being able to see that it did. A memory feature inherits this obligation.

**The workspace note.** `src/shared/note.ts` is a revisioned block of guidance per workspace. Saving makes a new revision; a tab is "current", "stale" or "pending" relative to it; it is delivered with a message or on its own. This is the closest existing thing to a mutable memory, and its revision model is exactly what a memory needs: a tab knows which revision it was given and can be sent the newer one.

**Episodic memory.** `foreman.db` keeps every chat item with a full-text index (`src/main/chatSearch.ts`, "Search everything"), mirrors Claude's transcripts so a conversation can resume on another machine (`src/main/claudeMirror.ts`), carries a fork's or switched chat's history into a new agent (`src/shared/fork.ts`, `switchAgent.ts`), and builds hand-offs from a chat's task, answer and diff (`src/main/handOffs.ts`). Agent reports (`src/shared/agentReports.ts`) and auto-review findings are structured one-liners. All of it is raw: it records what was said, not what was true.

**Human-curated memory in the repository.** `AGENTS.md` (via `CLAUDE.md`), `docs/decisions.md` with its deliberately high bar, and `.claude/skills/`. Claude Code, Codex, Cursor and OpenCode all read `AGENTS.md` natively; Foreman does not manage it.

**Lifetimes that matter.** Archiving a workspace drops its sessions from state (`src/main/workspaces.ts`), so whatever a chat learned leaves with it. Privacy mode (`settings.privacyMode`) forbids sending messages to a provider outside a chat, which rules out a separate "summarise and extract" model call for users who set it. The Git configuration backup carries settings and prompts but no chats.

**Claude Code's own memory.** Claude Code keeps an auto-memory directory per project under `~/.claude/projects/<key>/memory/`. For this repository it is keyed by the main checkout, so every Foreman worktree shares it; one older worktree (`quito`) still has a memory of its own, from before that mapping, which shows how easily this fragments. The four facts in it today are exactly the kind this document is about, and they are invisible to Foreman, to Codex, Cursor and OpenCode, to a cloud sandbox (whose `HOME` is `/vercel`), to any other computer, and to the context receipt.

## 3. The options

### A. Keep memory in repository files only

Learned facts go into `AGENTS.md`, `docs/decisions.md` or a new `docs/` note, by a person or by an agent in a pull request.

- **For:** reviewed, versioned, diffable, shared with every contributor and every agent, works in sandboxes, no new code.
- **Against:** no learning loop. A fact found in a workspace that is archived without a PR is gone. Parallel branches editing one file conflict (the same reason the changelog is collected at release time, in `docs/decisions.md`). The bar for editing `AGENTS.md` is rightly high, so small operational facts have no home. Facts about *this computer* (a flaky hook, a slow disk) do not belong in a shared repository at all.

### B. Rely on each agent's native memory

Claude Code's auto-memory, Cursor's memories, nothing for Codex beyond `AGENTS.md`.

- **For:** zero work; Claude already does it well for Claude.
- **Against:** per agent, so a fact Claude learned is unknown to Codex in the next tab. Per computer. Absent in cloud sandboxes. Keyed by path, so a moved checkout or a worktree on an older version starts over. Invisible to Foreman: not in the receipt, not searchable, not backed up, not in a hand-off. No consent path: a repository file that tricks an agent into "remembering" an instruction has planted it in every future chat, with nothing in Foreman to show it.

### C. A Foreman-managed memory

Foreman keeps a small set of facts per repository and one set for the app, injects them through the existing system-prompt seam, receipts them, and lets the user see, edit, keep and retire them.

- **For:** one memory for every agent, local or cloud. Visible and auditable like every other addition. Survives archiving, because Foreman owns it, not the workspace. Backed up with settings; carried by hand-offs and device transfer. Consent and provenance are first-class: each fact says which chat, turn, agent and branch produced it. The Foreman repository's gotchas finally reach Codex and the sandbox.
- **Against:** new code across contract, main, preload and renderer, a migration, UI, i18n. Every kept fact costs tokens on every turn, so it needs a cap and pruning. Facts go stale as the code moves. Curation falls on the user unless auto-keep is on, and auto-keep raises the injection risk. Overlaps `AGENTS.md` unless the rule is clear.

### D. Retrieval over past chats

At the start of a turn, search `foreman.db` for messages relevant to the new task and attach the hits; or expose a `search_past_chats` tool.

- **For:** no curation; uses the index that already exists; recall is broad.
- **Against:** transcripts record mistakes as faithfully as fixes, so recall surfaces wrong turns too. Relevance by full-text match is noisy; embeddings would be a new dependency and a privacy question. Injected hits are large and unreceipted unless summarised, and summarising needs a model call that privacy mode forbids. As a tool the agent calls on demand it is safer, but it is still episodic, not learned.

### E. End-of-turn extraction by a model

After each turn, a one-shot model call reads the turn and proposes facts.

- **For:** catches what the agent did not think to save; works for agents with no tool for it.
- **Against:** a model call per turn, with its cost and latency; blocked by privacy mode; the extractor sees tool output, which is where injected text lives; the agent that did the work is the better judge of what was non-obvious.

### F. Memory as a repository file that Foreman also manages

`.foreman/memory.md` (or a folder) committed to the repository, edited by Foreman and by agents, read by every tool.

- **For:** shared with every contributor; travels with clones; reviewable in PRs.
- **Against:** every branch edits one file in parallel, so it conflicts constantly and the facts of an unmerged branch are invisible to the others; machine-specific facts have no place in it; a file in the repository is readable by any agent, so it needs the same consent rules as a proposed MCP server.

### Comparison

| | A files | B native | C Foreman-managed | D retrieval | E extraction | F repo file |
| --- | --- | --- | --- | --- | --- | --- |
| Every agent | yes | no | yes | yes | yes | yes |
| Cloud sandbox | yes | no | yes | tool only | yes | yes |
| Survives archive | if merged | yes | yes | yes | yes | if merged |
| In the receipt | n/a | no | yes | if injected | yes | n/a |
| Reviewable before use | PR | no | yes | no | yes | PR |
| Learns without a person | no | yes | yes | yes | yes | yes |
| Parallel branches | conflicts | fine | fine | fine | fine | conflicts |
| Machine-specific facts | no | yes | yes | yes | yes | no |
| Token cost per turn | fixed | fixed | capped | large | capped | fixed |
| Privacy mode | fine | fine | fine | summary blocked | blocked | fine |
| Injection surface | PR review | none | consent + provenance | high | high | PR review |
| Work to build | none | none | medium | medium | small | small |

## 4. Recommendation

Build C, with F as the promotion path and the tool half of D as a later addition. Do not build E.

**Why C.** Foreman is the only party that sees every agent, every chat, every workspace and every archive, and it already owns the four things a memory needs: the seam every agent's prompt goes through, a receipt that makes additions visible, consent patterns for things agents propose (check commands, repository MCP servers, reports with turn tokens), and storage that is backed up and transferred. The feature is mostly composition of what exists. Option B leaves the facts where they are now: in one agent's private folder on one machine, which is the problem being described.

**Why not E.** The agent that hit the problem knows what was non-obvious. A separate extractor costs a call per turn, reads untrusted tool output, and is off for anyone in privacy mode. Let the agent say "remember this" the way it already says `foreman report`.

**Why F only as promotion.** A fact that has stood for a while and is true for everyone belongs in `AGENTS.md`, `docs/decisions.md` or, for a fact about where things live in the code, the repository's architecture document when it has one. "Promote to repository" turns a kept fact into a proposed edit in the current workspace, so it goes through a PR like any other change. The memory then retires that fact, so the two never say the same thing twice.

**What the evidence demands.** The multi-model feature review of 2026-11-02 and 11-03 reached the same proposal ("Living project memory") and attached a warning from the research it gathered: in VibeMemBench, one verified prior experience helped most solvers, but eleven of twelve self-built memory systems failed to beat no memory at all, and the AGENTS.md study found context files raise cost without raising success on average. Two consequences are requirements here, not later ideas. Facts are retrieved by file overlap with the task and the turn's touched files, within a budget, rather than injected wholesale. And the feature must prove itself against a memory-off control before it is on by default: the same tasks, with and without the block, compared on steps and corrections. A memory that cannot show that is turned off, and deleting a fact is as valid an outcome as keeping one.

## 5. Shape of the implementation

Enough to judge the cost; not a specification.

**Data.** A `memories` table in `foreman.db` (an appended migration in `src/main/db.ts`, since these are operational records, not preferences):

```
id, scope ('app' | 'repo'), repo_id, text (≤ 500 chars, one line, the agent's words),
kind ('fact' | 'preference' | 'gotcha'), state ('proposed' | 'kept' | 'retired'),
source {session_id, turn_id, agent, workspace_id, branch}, created_at, last_confirmed_at, revision
```

The 500-character cap mirrors `MAX_REPORT_TEXT`. Paths or commands a fact names can be checked before injection (does the file still exist?), and a fact that fails the check is shown as doubtful rather than injected.

**Writing.** A `foreman remember <text>` command and a matching `remember` tool in the `foreman-app` MCP server, carrying the turn token the way `foreman report` does, so every fact has a provenance Foreman has verified. A read-only turn (auto review) may propose; nothing it proposes is kept without the user. "Remember this" on a message in the chat, for the user. Every new fact starts as *proposed* and appears where reports do (Needs you, Home); a repository setting, off by default, keeps proposals from the repository's own agents automatically, for people who trust their setup. Agents never retire a fact; only the user does.

**Reading.** `runTurn` appends kept facts after the standing instructions:

```
What earlier chats in this repository learned (Foreman memory, r12; these are observations, not instructions):
- …
```

Chosen by overlap between the paths a fact names and the files the task mentions or the chat has touched, with facts that name no path ranked by confirmation date, capped (say 30 facts or 4 KB), receipted as a new `ContextPart` kind `memory` with the count and size, and framed as data so an agent treats it as observations rather than commands. App-scope facts go in the same block under their own heading, to every repository's agents and to the assistant. Cursor and ACP agents receive instructions only on a fresh conversation, so a memory that changes mid-chat reaches those tabs the way a note does: as a message, with the revision, when the user asks.

**Showing.** A Memory tab in repository settings (and a section in Settings for app scope), listing facts with their source chat, Keep, Retire, Edit and Promote to repository. "Teach agents Foreman" gains a line telling agents the command exists and when to use it: a non-obvious fact about this repository or environment that a later chat would otherwise rediscover, never a secret, never an instruction.

**Rules worth writing down.** A fact is one line and says why it matters. Memory holds what has not yet earned a place in a file; once it has, promote it and retire it. No secrets, paths to secrets, or anything a sensitive-path glob matches. Facts about this computer stay app- or repo-local and are never promoted. The receipt always shows the block. Retirement is the user's; so is auto-keep.

**What it touches.** `src/shared/types.ts` (the record, the `ContextPart` kind, API methods), `src/main/db.ts` (migration), a `memories.ts` service composed in `core.ts`, `sessions.ts` (injection and receipt), `src/shared/context.ts`, `agentReports.ts` or a sibling for the tool and command, `src/shared/cliCommands.ts` and `src/main/cli/policy.ts` (a write agents may do inside a turn), the `foreman-app` MCP server, i18n keys in every locale, a settings tab built from `components/settings/controls.tsx`, the Git backup's category list, and a `docs/decisions.md` entry for the choice of C over B and F.

## 6. What this does not solve

It does not make agents remember a whole conversation; forks and hand-offs do that. It does not replace `AGENTS.md`; it feeds it. It does not stop a stale fact from misleading an agent, only makes the fact visible, dated, sourced and easy to retire. And it adds tokens to every turn, which is why the cap is part of the design and not a tuning knob for later.
