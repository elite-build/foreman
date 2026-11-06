// The flows Foreman ships (docs/loops-and-graphs.md, "Building one without writing a file"): listed as built-in on
// Automations, read-only there, and the "Start from" choices of a new personal flow. Their prompts are sent to agents,
// so they stay English like every agent prompt; the names shown in the app are translated from `id`.

export interface FlowStarter {
  id:
    | 'fix-until-green'
    | 'research-then-implement'
    | 'test-first'
    | 'issue-to-draft-pr'
    | 'second-opinion'
    | 'two-reviewers'
    | 'keep-branch-fresh'
    | 'flaky-test-triage'
    | 'document-what-changed'
    | 'worth-building'
    | 'idea-to-feature'
  toml: string
}

const FIX_UNTIL_GREEN = `name = "Fix until green"
description = "Implement, run checks, fix what fails, review, stop when the review is clean, then ask before shipping."

[inputs]
task = "What to build or fix"

[start]
step = "implement"

[steps.implement]
kind = "turn"                  # an agent turn in a tab of the flow's workspace
prompt = "{{task}}"
persona = "developer"          # who the step is: instructions, what it may do, what it is shown
loadout = 1                    # or agent = "claude", model = "…"; overrides the persona's default

[steps.checks]
kind = "checks"                # the repo's approved check commands, never an agent

[steps.fix]
kind = "turn"
prompt = "The checks below failed. Fix them and run them again."
context = ["checks.results", "implement.answer"]
same_tab = "implement"         # continue that conversation, else a new tab

[steps.review]
kind = "review"                # a read-only reviewer tab, as auto review does
persona = "qa-engineer"
loadout = 2
context = ["diff"]

[steps.address]
kind = "turn"
same_tab = "implement"
context = ["review.findings"]

[steps.ship-check]
kind = "gate"                  # a person looks before anything else happens
show = ["diff", "checks.results"]
ask = "The review is clean. Is this ready to ship?"

[edges]
implement = "checks"
checks = { passed = "review", failed = "fix" }
fix = "checks"
review = { clean = "ship-check", findings = "address" }
address = "checks"
ship-check = { continued = "done", sent-back = "address", stopped = "done" }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"        # or "compact-when-full" or "fresh-with-summary"

[loops.review-until-clean]
over = ["review", "address", "checks"]
at_most = { iterations = 2 }

[after]
workspace = "keep"            # keep | archive | delete-unchanged
`

const RESEARCH_THEN_IMPLEMENT = `name = "Research then implement"
description = "An architect plans, you check the plan, a developer implements and fixes until the checks pass, then QA reviews."

[inputs]
task = "What to research and build"

[start]
step = "plan"

[steps.plan]
kind = "turn"
persona = "architect"
loadout = 2
prompt = "Research how to do this and write a plan. Don't change any files yet. {{task}}"
context = ["task", "tree"]

[steps.plan-check]
kind = "gate"
show = ["plan.answer"]
ask = "Is this the plan you want implemented?"

[steps.implement]
kind = "turn"
persona = "developer"
prompt = "Implement the plan."
context = ["plan.answer"]

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
prompt = "The checks below failed. Fix them and run them again."
context = ["checks.results"]
same_tab = "implement"

[steps.qa]
kind = "review"
persona = "qa-engineer"
context = ["diff", "checks.results"]

[steps.address]
kind = "turn"
same_tab = "implement"
context = ["qa.findings"]

[edges]
plan = "plan-check"
plan-check = { continued = "implement", sent-back = "plan", stopped = "done" }
implement = "checks"
checks = { passed = "qa", failed = "fix" }
fix = "checks"
qa = { clean = "done", findings = "address" }
address = "checks"

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"

[loops.qa-until-clean]
over = ["qa", "address", "checks"]
at_most = { iterations = 2 }

[after]
workspace = "keep"
`

const TEST_FIRST = `name = "Test first, then make it pass"
description = "A developer writes failing tests for the change and the checks show they fail; then the developer makes them pass and fixes what fails, QA reviews, and you look before it ships."

[inputs]
task = "The change to test and then build"

[start]
step = "write-tests"

[steps.write-tests]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Write failing tests only, for this change: tests that fail now and pass once it is built. Don't implement the change. {{task}}"

[steps.red]
kind = "checks"

[steps.judge]
kind = "decide"
persona = "developer"
loadout = 2
options = ["yes", "rewrite"]
prompt = "The checks pass with the new tests, before anything is built. Do these tests exercise the change? Decide yes if they do (the behaviour is there already), or rewrite if they don't."
context = ["write-tests.answer", "diff"]

[steps.implement]
kind = "turn"
same_tab = "write-tests"
prompt = "Now make the tests pass: implement the change, without weakening the tests."

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "write-tests"
prompt = "Address what failed or what you were sent back for, and run the checks again."
context = ["checks.results"]

[steps.review]
kind = "review"
persona = "qa-engineer"
loadout = 2
context = ["write-tests.answer"]

[steps.ship-check]
kind = "gate"
show = ["diff", "checks.results", "review.findings"]
ask = "The tests pass. Is this ready to ship?"

[edges]
write-tests = "red"
red = { failed = "implement", passed = "judge" }
judge = { yes = "implement", rewrite = "write-tests" }
implement = "checks"
checks = { passed = "review", failed = "fix" }
fix = "checks"
review = "ship-check"
ship-check = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.tests-fail-first]
over = ["write-tests", "red", "judge"]
at_most = { iterations = 2 }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"

[after]
workspace = "keep"
`

const ISSUE_TO_DRAFT_PR = `name = "Issue to draft pull request"
description = "A developer resolves the issue until the checks pass and QA's review is clean; after you look, the developer commits, Foreman opens a draft pull request, and CI failures go back to the developer until it is green."

[inputs]
issue = "The issue to resolve: its link or its words"

[start]
step = "implement"

[steps.implement]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Resolve this issue: {{issue}}"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "implement"
prompt = "Address what failed or what you were sent back for, and run the checks again."
context = ["checks.results"]

[steps.review]
kind = "review"
persona = "qa-engineer"
loadout = 2
context = ["implement.answer"]

[steps.address]
kind = "turn"
same_tab = "implement"
prompt = "Address the review's findings, or what you were sent back for."
context = ["review.findings"]

[steps.pr-check]
kind = "gate"
show = ["diff", "checks.results", "review.findings"]
ask = "Open a draft PR?"

[steps.commit]
kind = "turn"
same_tab = "implement"
prompt = "Commit all of your changes on this branch with a message that says what changed and why. Don't push: Foreman pushes and opens the pull request next."

[steps.pr]
kind = "pr"
draft = true
body = "Resolves: {{issue}}\\n\\nWhat the flow did:\\n{{ledger}}"

[steps.ci]
kind = "wait"
on = "ci"

[steps.fix-ci]
kind = "turn"
same_tab = "implement"
prompt = "CI failed on the pull request. Find out why (foreman git or gh show the failing checks), fix it, commit and push."

[edges]
implement = "checks"
checks = { passed = "review", failed = "fix" }
fix = "checks"
review = { clean = "pr-check", findings = "address" }
address = "checks"
pr-check = { continued = "commit", sent-back = "address", stopped = "done" }
commit = "pr"
pr = { opened = "ci" }
ci = { green = "done", none = "done", failed = "fix-ci" }
fix-ci = "ci"

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"

[loops.review-until-clean]
over = ["review", "address", "checks"]
at_most = { iterations = 2 }

[loops.ci-until-green]
over = ["ci", "fix-ci"]
at_most = { iterations = 2 }

[after]
workspace = "keep"
`

const SECOND_OPINION = `name = "Second opinion, then pick"
description = "An architect plans and you check the plan; two developers on different loadouts each build it in a workspace of their own, made from the plan; you pick the result to go on with, QA reviews it there, and you look before it ships."

[inputs]
task = "What to plan and build"

[start]
step = "plan"

[steps.plan]
kind = "turn"
persona = "architect"
loadout = 2
prompt = "Research how to do this and write a plan. Don't change any files yet. {{task}}"
context = ["task", "tree"]

[steps.plan-check]
kind = "gate"
show = ["plan.answer"]
ask = "Build this?"

[steps.workspace-a]
kind = "workspace"
from = "plan"

[steps.implement-a]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Implement the plan below, and run the checks that cover it."
context = ["plan.answer"]

[steps.checks-a]
kind = "checks"

[steps.workspace-b]
kind = "workspace"
from = "plan"

[steps.implement-b]
kind = "turn"
persona = "developer"
loadout = 2
prompt = "Implement the plan below, and run the checks that cover it."
context = ["plan.answer"]

[steps.checks-b]
kind = "checks"

[steps.choose]
kind = "pick"
over = ["implement-a", "implement-b"]

[steps.review]
kind = "review"
persona = "qa-engineer"
loadout = 3
context = ["plan.answer"]

[steps.address]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Address the review's findings, or what you were sent back for, and run the checks that cover them."
context = ["review.findings"]

[steps.ship-check]
kind = "gate"
show = ["diff", "review.findings"]
ask = "Is the chosen result ready to ship?"

[edges]
plan = "plan-check"
plan-check = { continued = "workspace-a", sent-back = "plan", stopped = "done" }
workspace-a = "implement-a"
implement-a = "checks-a"
checks-a = "workspace-b"
workspace-b = "implement-b"
implement-b = "checks-b"
checks-b = "choose"
choose = "review"
review = { clean = "ship-check", findings = "address" }
address = "review"
ship-check = { continued = "done", sent-back = "address", stopped = "done" }

[loops.review-until-clean]
over = ["review", "address"]
at_most = { iterations = 2 }

[after]
workspace = "keep"
`

const TWO_REVIEWERS = `name = "Two reviewers must agree"
description = "A developer builds it until the checks pass; a QA engineer, then a security reviewer, read the same tree; any finding goes back to the developer and round again, until both are clean; then you look."

[inputs]
task = "What to build or fix"

[start]
step = "implement"

[steps.implement]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "{{task}}"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "implement"
prompt = "Address what failed or what you were sent back for, and run the checks again."
context = ["checks.results"]

[steps.review-quality]
kind = "review"
persona = "qa-engineer"
loadout = 2

[steps.review-security]
kind = "review"
persona = "security-reviewer"
loadout = 3

[steps.address-quality]
kind = "turn"
same_tab = "implement"
prompt = "Address the QA review's findings."
context = ["review-quality.findings"]

[steps.address-security]
kind = "turn"
same_tab = "implement"
prompt = "Address the security review's findings."
context = ["review-security.findings"]

[steps.ship-check]
kind = "gate"
show = ["diff", "checks.results", "review-quality.findings", "review-security.findings"]
ask = "Both reviews are clean. Is this ready to ship?"

[edges]
implement = "checks"
checks = { passed = "review-quality", failed = "fix" }
fix = "checks"
review-quality = { clean = "review-security", findings = "address-quality" }
review-security = { clean = "ship-check", findings = "address-security" }
address-quality = "checks"
address-security = "checks"
ship-check = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 4, minutes = 45 }
iteration = "same-tab"

[loops.until-both-agree]
over = ["checks", "review-quality", "review-security", "address-quality", "address-security"]
at_most = { iterations = 3 }

[after]
workspace = "keep"
`

const KEEP_FRESH = `name = "Keep a long-lived branch fresh"
description = "Meant for a schedule, started from the long-lived branch as its base: a developer merges origin/main into it and resolves the conflicts, the checks run and what fails is fixed, and you decide whether the merge is pushed to that branch."

[start]
step = "merge-main"

[steps.merge-main]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Merge origin/main into this branch: fetch first, resolve any conflicts keeping both sides' intent, and commit the merge. Don't push."
context = ["tree"]

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "merge-main"
prompt = "Address what failed after the merge, or what you were sent back for, commit, and run the checks again. Don't push."
context = ["checks.results"]

[steps.push-check]
kind = "gate"
show = ["diff", "checks.results"]
ask = "Push the merge?"

[steps.push]
kind = "turn"
same_tab = "merge-main"
prompt = "Push this branch's HEAD to the base branch the Tree section names, on origin (git push origin HEAD:<base branch>). Never force-push; if the push is refused, stop and say why."
context = ["tree"]

[edges]
merge-main = "checks"
checks = { passed = "push-check", failed = "fix" }
fix = "checks"
push-check = { continued = "push", sent-back = "fix", stopped = "done" }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 3 }
iteration = "same-tab"

[after]
workspace = "archive"
`

const FLAKY_TRIAGE = `name = "Flaky test triage"
description = "Runs your saved command flaky-tests (save one that runs the suspect tests three times); a developer decides from its output whether a test is flaky, failing for real or clean. A flaky test is quarantined with an issue note under docs/, a real failure is fixed until the checks pass, and you look at either."

[start]
step = "workspace"

[steps.workspace]
kind = "workspace"

[steps.run-tests]
kind = "script"
command = "flaky-tests"

[steps.triage]
kind = "decide"
persona = "developer"
loadout = 1
options = ["flaky", "real", "clean"]
prompt = "The output below is the same tests run three times. Decide flaky if a test both passed and failed across the runs, real if a test failed every time, or clean if every run passed."
context = ["run-tests.output"]

[steps.quarantine]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "A test is flaky: it passed and failed across three runs of the same code (the output is below). Mark it skipped or quarantined the way this repository does, with a comment saying why, and write an issue note under docs/ (docs/flaky/<test-name>.md): the test, the failures seen, what you suspect, and how to reproduce it."
context = ["run-tests.output"]

[steps.fix]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "A test fails every time (its output is below). Find out why and fix the code or the test, whichever is wrong, then run the checks; address what they say if they ran already."
context = ["run-tests.output", "checks.results"]

[steps.checks]
kind = "checks"

[steps.result-check]
kind = "gate"
show = ["diff", "triage.answer", "checks.results"]
ask = "Keep this?"

[edges]
workspace = "run-tests"
run-tests = "triage"
triage = { flaky = "quarantine", real = "fix", clean = "done" }
quarantine = "result-check"
fix = "checks"
checks = { passed = "result-check", failed = "fix" }
result-check = { continued = "done", sent-back = "fix", stopped = "done" }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 3 }

[after]
workspace = "delete-unchanged"
`

const DOCUMENT_CHANGES = `name = "Document what changed"
description = "A developer makes the change until the checks pass, a docs writer updates the documentation for what the diff changed, QA checks the docs match the diff, and you look."

[inputs]
task = "What to build or change"

[start]
step = "implement"

[steps.implement]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "{{task}}"

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "implement"
prompt = "Address what failed, and run the checks again."
context = ["checks.results"]

[steps.docs]
kind = "turn"
persona = "docs-writer"
loadout = 2
prompt = "Update the documentation for what this change does, and for anything the review below says the docs get wrong."
context = ["task", "implement.answer", "review.findings"]

[steps.review]
kind = "review"
persona = "qa-engineer"
loadout = 2
prompt = "Do the docs match the diff? Report each place where the documentation says something the code doesn't do, or leaves out something it does."

[steps.ship-check]
kind = "gate"
show = ["diff", "checks.results", "review.findings", "docs.answer"]
ask = "The docs match the change. Is this ready to ship?"

[edges]
implement = "checks"
checks = { passed = "docs", failed = "fix" }
fix = "checks"
docs = "review"
review = { clean = "ship-check", findings = "docs" }
ship-check = { continued = "done", sent-back = "docs", stopped = "done" }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 3, minutes = 45 }
iteration = "same-tab"

[loops.docs-match]
over = ["docs", "review"]
at_most = { iterations = 2 }

[after]
workspace = "keep"
`

const WORTH_BUILDING = `name = "Is this feature worth building?"
description = "A researcher writes a report on the idea; then three rounds: two reviewers on different models read it alone, the researcher writes their consensus and revises the report; then you read the report and the consensus."

[inputs]
idea = "The idea to research"

[start]
step = "structure"

[steps.structure]
kind = "turn"
persona = "researcher"
loadout = 1
prompt = "Research this idea and write the report: {{idea}}"

[steps.review-a]
kind = "review"
persona = "research-reviewer"
loadout = 2
prompt = "Review the research report, docs/research/<slug>/report.md in the diff below, for soundness."

[steps.review-b]
kind = "review"
persona = "research-reviewer"
loadout = 3
prompt = "Review the research report, docs/research/<slug>/report.md in the diff below, for soundness."

[steps.consensus]
kind = "turn"
persona = "researcher"
loadout = 2
prompt = "Two reviewers read the report on their own; their reviews are below. Write their consensus to docs/research/<slug>/consensus.md, beside the report: the points they agree on, each disagreement with each side's reason, and the changes the next revision of the report must make. Replace what the file said last round. Don't change the report itself."
context = ["review-a.answer", "review-b.answer"]

[steps.revise]
kind = "turn"
same_tab = "structure"
prompt = "Revise the report in place as the consensus below says, and say in it what changed."
context = ["consensus.answer"]

[steps.show]
kind = "gate"
show = ["docs/research/*/report.md", "docs/research/*/consensus.md"]
ask = "Here is the report, after three rounds of review. Continue to finish, or send it back with a note for more rounds."

[edges]
structure = "review-a"
review-a = "review-b"
review-b = "consensus"
consensus = "revise"
revise = "review-a"
show = { continued = "done", sent-back = "revise", stopped = "done" }

[loops.rounds]
over = ["review-a", "review-b", "consensus", "revise"]
times = 3
then = "show"
at_most = { iterations = 3, minutes = 180 }

[after]
workspace = "keep"
`

const IDEA_TO_FEATURE = `name = "From an idea to a feature"
description = "A product manager writes the requirements and a UX designer the design, each until you are happy with it; a developer builds it until the checks pass; you look; QA reviews it against both until you are happy with that too."

[inputs]
idea = "The idea to turn into a feature"

[start]
step = "requirements"

[steps.requirements]
kind = "turn"
persona = "product-manager"
loadout = 2
prompt = "Write the requirements for this idea: {{idea}}"

[steps.requirements-check]
kind = "gate"
show = ["docs/features/*/requirements.md"]
ask = "Should we iterate on the requirements? Send them back with a note to iterate, or continue to the design."

[steps.design]
kind = "turn"
persona = "ux-designer"
loadout = 2
prompt = "Turn the requirements in docs/features/<slug>/requirements.md (the folder the product manager made for this idea) into the design specification."

[steps.design-check]
kind = "gate"
show = ["docs/features/*/design.md"]
ask = "Should we iterate on the design? Send it back with a note to iterate, or continue to building it."

[steps.implement]
kind = "turn"
persona = "developer"
loadout = 1
prompt = "Build the feature specified in docs/features/<slug>/requirements.md and docs/features/<slug>/design.md (the folder made for this idea). Read both first."

[steps.checks]
kind = "checks"

[steps.fix]
kind = "turn"
same_tab = "implement"
prompt = "Address what failed or what you were sent back for, and run the checks again."
context = ["checks.results"]

[steps.build-check]
kind = "gate"
show = ["diff", "checks.results"]
ask = "The checks pass. Hand it to QA?"

[steps.qa]
kind = "review"
persona = "qa-engineer"
loadout = 2
prompt = "Review the change against the requirements and the design in docs/features/<slug>/ (requirements.md and design.md): report what they ask for that it doesn't do, and anything it does wrong."
context = ["checks.results"]

[steps.qa-check]
kind = "gate"
show = ["qa.findings", "diff", "checks.results"]
ask = "Should we iterate on QA's findings? Send them back with a note to have them addressed, or continue to finish."

[steps.address]
kind = "turn"
same_tab = "implement"
prompt = "Address QA's findings below, and what you were sent back for."
context = ["qa.findings"]

[steps.recheck]
kind = "checks"

[edges]
requirements = "requirements-check"
requirements-check = { continued = "design", sent-back = "requirements", stopped = "done" }
design = "design-check"
design-check = { continued = "implement", sent-back = "design", stopped = "done" }
implement = "checks"
checks = { passed = "build-check", failed = "fix" }
fix = "checks"
build-check = { continued = "qa", sent-back = "fix", stopped = "done" }
qa = "qa-check"
qa-check = { continued = "done", sent-back = "address", stopped = "done" }
address = "recheck"
recheck = { passed = "qa", failed = "address" }

[loops.requirements-rounds]
over = ["requirements", "requirements-check"]
at_most = { iterations = 3 }

[loops.design-rounds]
over = ["design", "design-check"]
at_most = { iterations = 3 }

[loops.fix-until-green]
over = ["checks", "fix"]
at_most = { iterations = 3, minutes = 45 }
iteration = "same-tab"

[loops.qa-rounds]
over = ["qa", "qa-check", "address", "recheck"]
at_most = { iterations = 3 }

[after]
workspace = "keep"
`

export const FLOW_STARTERS: readonly FlowStarter[] = [
  { id: 'fix-until-green', toml: FIX_UNTIL_GREEN },
  { id: 'research-then-implement', toml: RESEARCH_THEN_IMPLEMENT },
  { id: 'test-first', toml: TEST_FIRST },
  { id: 'issue-to-draft-pr', toml: ISSUE_TO_DRAFT_PR },
  { id: 'second-opinion', toml: SECOND_OPINION },
  { id: 'two-reviewers', toml: TWO_REVIEWERS },
  { id: 'keep-branch-fresh', toml: KEEP_FRESH },
  { id: 'flaky-test-triage', toml: FLAKY_TRIAGE },
  { id: 'document-what-changed', toml: DOCUMENT_CHANGES },
  { id: 'worth-building', toml: WORTH_BUILDING },
  { id: 'idea-to-feature', toml: IDEA_TO_FEATURE }
]
