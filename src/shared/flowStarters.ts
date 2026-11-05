// The flows Foreman ships (docs/loops-and-graphs.md, "Building one without writing a file"): listed as built-in on
// Automations, read-only there, and the "Start from" choices of a new personal flow. Their prompts are sent to agents,
// so they stay English like every agent prompt; the names shown in the app are translated from `id`.

export interface FlowStarter {
  id: 'fix-until-green' | 'research-then-implement'
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

export const FLOW_STARTERS: readonly FlowStarter[] = [
  { id: 'fix-until-green', toml: FIX_UNTIL_GREEN },
  { id: 'research-then-implement', toml: RESEARCH_THEN_IMPLEMENT }
]
