# Staff Journey Walk — rotation ledger

Cross-run memory for the `staff-journey-walk` seat (daily 13:40, seated 2026-08-22). One desk per
run, **strict rotation S1 → S2 → S3 → S4 → S5 → S1**. A fresh session reads this file to know where
to resume. A `BLOCKED` run does not advance the rotation.

**Charter: `knowledge-base/feature-review/STAFF_JOURNEYS.md` WINS** over any summary in the
scheduler's task prompt. The run's PR updates the charter's status table **and** this ledger
together — the client lane's two ledgers already drift (#644 updated one and not the other).

## Rotation state

| next run walks | desk | seat · counterpart · file |
|---|---|---|
| **→ S1** | Loan officer — receives the file | `lo@test.com` · the borrower it invites · fresh `jst+<MMDD>lo@test.local` **through the invite link**; `jst+<MMDD>lo2` for the pool leg |

## Run history

| date | desk | server (commit · port) | sessions held | verdict | report |
|---|---|---|---|---|---|
| 2026-09-07 | **S1 — Loan officer, core-file leg** | `codex/end-to-end-journey` · :5021 | fictional complex borrower ⇄ `lo@test.com` | **WARN — the central application-to-officer path passes, but this was not the charter's full invite + pool + retirement walk.** Queue search/open, income/property provenance, document correction and letter/AUS/export/submission gates were driven in the browser. Rotation does not advance. | [2026-09-07-complex-borrower-lo-loop.md](../../feature-review/journey-walks/2026-09-07-complex-borrower-lo-loop.md) |

## Standing notes for the next walker

- **Own worktree at `origin/main`, own port 5003, and tear it down.** `PORT=5003 bash
  scripts/dev-up.sh`, verify with `lsof -a -p <pid> -d cwd`, and `… down` at the end. Never
  `preview_start {name}` — it boots the shared primary checkout.
- **Sessions are sequential** (one cookie jar): `POST /api/auth/logout` → assert `/api/auth/user`
  is 401 → log in as the counterpart. The user endpoint is `/api/auth/user`; `/api/auth/me` is 404.
  **Verified 2026-08-22 before the first run**: a cookie set in one pane tab was read verbatim in a
  second tab — the jar is per pane, not per tab.
- **Seeded staff seats are correct here** (role rewritten on login; your subject is the fresh file).
  Record the queue count `N` at login; a delta you did not cause is a concurrent run, not the product.
- **Minted invite links are `https://localhost:<port>/…` locally** (`PUBLIC_BASE_URL` unset) —
  rewrite to `http://` and say so.
- **Never click the Intelligence tab** on `/staff-dashboard` (F-0820-20 unmounts the whole app).
- **S4's expected verdict is `DEAD-ENDED (by design)`** — mint the `roadmap` finding once, then cite
  it; be short when nothing under `closer`/`funded`/`closing*`/`advance-stage` changed since.
