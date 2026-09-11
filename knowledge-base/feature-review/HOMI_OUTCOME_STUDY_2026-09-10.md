# Homi outcome study — operating protocol

**Status:** instrumentation pilot ready; comparison study not registered

**Decision owner:** founder, with privacy/compliance review before enrollment

## What this study must answer

Does Homi help a complicated borrower complete a correct mortgage file with fewer actions and less
waiting, without increasing incorrect claims, failed turns, unnecessary document requests or loan
officer work?

Availability is not the outcome. A successful model call, a tool call or a higher readiness score
is useful operating evidence, but none proves that the borrower finished faster because Homi was
present.

Better's public standard is concrete and time-bound: it advertises a pre-approval in as little as
three minutes and, for eligible borrowers who complete the required tasks, an underwriting
determination within 24 hours.[1][2] Better also tells self-employed borrowers to expect two years
of personal and applicable business returns, 1099s, a year-to-date profit and loss statement,
business statements and proof of the business.[3] Homiquity should match the continuity and speed,
then test its advantage on completing that more complicated evidence set correctly.

NIST's AI Risk Management Framework requires documented, repeatable evaluation in conditions
similar to deployment, measurement uncertainty, comparison to benchmarks, human oversight and
clear limits on generalization.[4] Research on online controlled experiments likewise treats
assignment, statistical power and sample size as design inputs rather than conclusions chosen
after results are visible.[5]

## Evidence that exists now

Homi outcome events contain no borrower message text or document contents. A current Homi turn
records success/failure, bounded latency, exact-repeat detection, server-truth and server-action
tool names, actual saved-field count, and completion before and after from the server file. A Homi
request for a person creates or reuses a real loan-team task.

The staff report is an observational operating report. It must always show
`canClaimReducedFriction: false` until a comparison study is registered and completed.

The 2026-09-10 re-audit fixed three ways that report could overstate the evidence:

1. The 10-borrower floor now counts only borrowers with a current-format turn containing both
   server snapshots. Borrowers represented only by failures or old event formats cannot satisfy it.
2. Staff and unknown-role turns are excluded from borrower evidence and reported separately.
3. Old event rows no longer enter the current exact-repeat rate.
4. A secure staff message can satisfy only one Homi handoff and only when sent while that task is
   open. A message after task completion cannot retroactively become its response.

The UI calls this a post-request staff message, because message timing alone does not prove the
message answered the request. Phone calls and work outside secure Messages remain invisible.

## Stage A — instrumentation pilot

Collect at least 30 current-format turns from at least 10 borrowers who each have a valid before and
after server snapshot. Use this sample only to answer:

- Are successful and failed turns recorded without message or document contents?
- What share of turns have both server snapshots?
- Do saved-field counts and completion deltas reconcile on sampled files?
- Do exact-repeat, degraded, lint-replacement and latency measures behave as defined?
- Does every sampled human-help task match the real task and at most one post-request staff message?
- Which work happens by phone or outside secure Messages, and how will it be recorded or excluded?

Passing Stage A means the instrumentation is usable. It does not establish a treatment effect or a
market-comparative claim.

## Stage B — recommended comparison design

Use a prospective randomized encouragement study at the borrower-account level. Every eligible
borrower keeps the current on-demand Homi launcher and access to the loan team. The treatment adds
one context-specific invitation to use Homi for the next incomplete complex-file action; the control
keeps the current self-service experience without that proactive invitation. This preserves access
while testing whether timely Homi guidance changes behavior.

Register these fields in code and review them before the first eligible borrower is assigned:

| Field | Required definition |
|---|---|
| Registration | immutable study ID, protocol version, registration timestamp and activation commit |
| Unit | borrower account; one stable assignment across devices and applications during the study |
| Population | new client-role borrowers after activation; exclude staff, demo, synthetic and pre-existing files |
| Treatment | exact invitation placement, wording, eligibility trigger and maximum frequency |
| Control | current self-service experience with on-demand Homi and human help still available |
| Primary outcome | percentage of assigned borrowers completing the pre-registered complex-file evidence milestone within seven days |
| Effort outcomes | borrower actions and elapsed time to the milestone; repeated questions; avoidable re-uploads |
| Service outcomes | turn success and p95 latency; Homi handoffs; one-to-one post-request staff-message timing; staff touches |
| Safety outcomes | incorrect-status reports, compliance replacements, complaints, inappropriate approval language and manual overrides |
| Analysis | intention-to-treat by assigned cohort; report missing data, crossover and confidence intervals |
| Sample | calculated before enrollment from the Stage A baseline, minimum useful effect, power and error rate |
| Stop rules | pause for a safety regression, sample-ratio mismatch, instrumentation failure or materially worse completion |

The outcome milestone must be one the server can prove from current application fields, accepted
documents and approved workpapers. It cannot be a model-authored status or a click on the Homi
launcher.

## Decision still needed before Stage B

Approve or revise the recommended treatment: **keep Homi available to everyone, and add proactive,
contextual invitations only to the treatment cohort**. Withholding Homi or human help entirely is
not recommended. After that decision, engineering can add durable assignment, exposure events, the
shared milestone event and the pre-registered analysis without changing the hypothesis after data
collection begins.

## Claim boundary

Until Stage B is registered, powered, completed and independently reviewed, Homiquity may say that
Homi is live, reads bounded server evidence, saves borrower-approved fields, routes human help and
is operationally measured. It may not say that Homi reduces friction, improves completion or is
better than another mortgage assistant.

[1]: https://better.com/content/how-to-get-a-mortgage-approval
[2]: https://better.com/with/one-day-mortgage-terms
[3]: https://better.com/content/mortgage-for-self-employed-gig-workers
[4]: https://airc.nist.gov/airmf-resources/airmf/5-sec-core/
[5]: https://link.springer.com/article/10.1007/s10618-008-0114-1
