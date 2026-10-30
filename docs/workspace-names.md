# Workspace people

`src/shared/workspacePeople.json` is the bundled catalog used for both generated
workspace names and the introduction at the top of each of the workspace's chats.
It contains 2,050 scientists, inventors, philosophers, and thinkers. Each entry
has a unique branch-safe `name`, a `fullName`, a short `contribution`, and source
and article-history links. Familiar figures get short names such as `tesla`,
`newton`, and `aristotle`; shared surnames use a fuller name when necessary.

The catalog is included in the application bundle. Creating a workspace and
showing its introduction make no network requests and write no biography files,
comments, commits, or introductory chat messages to the target repository.
The person's name is a link that opens the entry's Wikipedia article.

The introduction is a faint divider line above the first message: "It's named
after Nikola Tesla. He helped shape how electricity powers our world, pioneering
AC motors and power systems." It shows whether or not the chat has started (a
workspace created with a task has its first message straight away) and scrolls
away with the conversation.

## Name reservations and persistence

Names used by active or archived workspaces in the same repository are skipped.
Local workspace records also reserve their original folder names. Once every
base name is reserved, the existing generator appends numeric suffixes; `tesla-2`
uses the same introduction as `tesla`. Different repositories can use the same
name independently.

New workspaces store their original catalog identifier in `Workspace.namesake`
in Foreman's app data, so a task-based rename does not change their introduction.
Older workspaces can resolve an introduction from their original placeholder
branch, current branch, or workspace name. Unknown names, including city names,
show no introduction. Existing target-repository files are not changed.

## Sources and maintenance

The catalog combines hand-written introductions for familiar figures with short
excerpts and adaptations from English Wikipedia introductions. Every entry links
to its source article and that article's revision history, which identifies its
contributors. Wikipedia-derived catalog text is available under
[CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).
Adaptations include removing pronunciation/date parentheses, selecting a short
contribution sentence, and sometimes restating a "known for" clause. The "It's
named after" lead-in is added by Foreman.
The source links are attribution, not a claim of endorsement.

The candidate discovery list comes from Part 1 of
[AgeDataset](https://github.com/Moradnejad/AgeDataset), augmented with a curated
list of scientists and philosophers. Attribution: Issa Annamoradnejad and
Rahimberdi Annamoradnejad (2022), "Age dataset: A structured general-purpose dataset
on life, work, and death of 1.22 million distinguished people,"
[doi:10.36190/2022.82](https://doi.org/10.36190/2022.82),
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
Candidate names are filtered, normalized to ASCII, and deduplicated.
Article identities are matched against the candidate's Wikidata identity where
available, and contribution sentences must refer to the person being introduced.

`scripts/buildWorkspacePeople.py` is an explicit maintenance tool, never an app
startup or workspace-creation step. It caches source responses in the ignored
`.workspace-people-cache/` directory and writes the bundled JSON. It respects
Wikimedia's API concurrency and request limits and retries rate-limit responses.
After changing or regenerating the catalog, review the summaries and run
`npm test -- tests/workspacePeople.test.ts tests/workspaces.test.ts` and
`npm run typecheck`. The biographies remain English; surrounding UI labels use
the normal translation system and its English fallback.
