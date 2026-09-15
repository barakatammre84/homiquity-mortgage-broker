# Homiquity

Build a mortgage business run by one loan officer with an automated support team, as defined in
[CTO_ROADMAP.md](CTO_ROADMAP.md). Software executes routine work and coordinates the journey
from lead to close and follow-up; the officer advises borrowers and handles decisions and
exceptions. Reduce elapsed time, manual effort, errors and repeated borrower requests.

## Read only what the task needs

- Product direction: [CTO_ROADMAP.md](CTO_ROADMAP.md).
- Known implementation facts and unverified deployment state: [ACTIVE_CONTEXT.md](knowledge-base/ACTIVE_CONTEXT.md).
- Legal, eligibility or program questions: [primary sources](knowledge-base/compliance/SELLING_GUIDE_DECISION_RULE.md).
- Work already claimed: [REGISTER.md](knowledge-base/routines/REGISTER.md), after checking current open PRs.
- Code and its tests answer implementation questions. Technical references in the
  [index](knowledge-base/README.md) are navigation aids; verify them against the checkout.

## Claude and Codex work from the same queue

Use current GitHub issues and open PRs as the shared work queue. Pick the smallest change that
removes a manual step or delay, completes an automation, or fixes a defect blocking that outcome.
Before editing, briefly state the current gap, intended improvement and proof. For maintenance
or research, name the workflow protected or decision resolved. Follow the user's assigned scope.

Check the existing implementation first; reuse and repair it before adding another subsystem.
Do not start from an old worktree's charter: check current main and its shared instructions.
Carry forward only relevant changes into an up-to-date isolated branch, preserving others' work.
Verify the remote is `barakatammre84/homiquity`. GitHub folds case and still redirects the former
`homiquity-mortgage-broker` name, so `.../Homiquity` or an old-name remote is the same repository,
not the wrong one. Use `origin/main` explicitly; a cached `origin/HEAD` is not proof of GitHub's
default branch.

Record one implementation owner and file scope in REGISTER. When both agents work on a task,
one implements and the other reviews; either can fill either role. Parallel implementation uses
separate worktrees and non-overlapping files. Handoffs name the issue, branch, commit, checks
and remaining blocker. Continue the existing change rather than starting another plan.

At each run, check the other agent's open work and pending handoffs before choosing new work.
Review or unblock its ready change first when that advances the assigned outcome; otherwise
take a complementary, non-overlapping slice. Keep owner, next agent/action, commit, evidence and
blocker visible in the existing issue or PR. A handoff stays pending until the receiving agent
records its result against that commit. Never claim the other agent reviewed or ran something
without evidence. If it is unavailable, leave the handoff pending and continue independent work.

Clean duplicate logic, dead paths and obsolete instructions in the touched area after checking
callers and preserving supported behavior. Report when none needs changing. Put unrelated cleanup
in the shared queue; do not make a broad cleanup program a prerequisite to delivery.

Verify the promised outcome. For automation, show the executed action, evidence of completion,
and failure/retry behavior; a created task or drafted message alone does not prove execution.
Report the improvement, related cleanup, checks and remaining manual step or external dependency.

## Sources

Only an applicable primary source can support a legal or program requirement. Read the actual
provision and record its locator, effective date and applicability. A charter, research note,
agent memory, competitor workflow or another AI answer cannot establish that requirement.
Do not infer a prohibition from a source's silence. Mark an unsupported claim unverified and
investigate the affected decision; do not turn it into a permanent product restriction.

The source map separates Fannie policy, applicable law and actual lender requirements.
Apply each to the relevant role, program, jurisdiction and transaction date. A seller/servicer
requirement is not automatically a requirement for this broker. Conflicts need the actual
provisions and an applicability analysis, not an invented hierarchy between internal files.

## Working practices — internal engineering choices

- Locally, work in `~/Developer/homiquity` or its isolated worktrees; in cloud sessions, use
  the platform-provided checkout of the same repository. Use `claude/…` or `codex/…` branches
  from current `main`. Homiquity-Core is retired; Documents copies are recovery sources.
- Fetch and inspect status and open PRs before editing. Preserve other sessions' changes.
  Coordinate overlapping files, record your claim in REGISTER, and release it in the same PR.
- Set `git config core.hooksPath .githooks`. Use the existing dependencies unless the user
  authorizes a change. Do not run schema-push commands against a shared or production database;
  use reviewed migrations and the database runbook for schema work.
- Treat simulations as simulations. Preserve existing consent, disclosure, access, audit and
  loan-decision controls. Removing a document is not authorization to change runtime behavior.
  Change a control only in an explicitly scoped change supported by evidence and tests.
- Run `pnpm check`; run `pnpm test` for logic, and integration tests for endpoint changes.
  Run `pnpm checkup` before a PR. Report failures accurately. Security-sensitive changes
  need review before merge; use the existing security review guard to identify them.
- Verify UI behavior in a browser when it changes; report what was actually exercised.
  A static guard is not proof of behavior, accessibility, source meaning or legal compliance.
- Keep instructions short. Update these existing documents instead of adding another charter
  or roadmap. Register Markdown disposition in `knowledge-base/document-register.json`.
  Historical and retired material is excluded from normal searches; open it only for an
  explicit historical question. Never restore it as authority by copying its rules.
- Do not merge, deploy, send communications or file documents without task authorization.
  Report the change, validation, limitations and remaining work.
