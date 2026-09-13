# Fannie Mae reference material — rules for working here

Codex merges `AGENTS.md` files by directory, so this one loads automatically for any work under
`docs/fannie-mae/`. It exists because of an asymmetry worth stating plainly.

## Why this file exists

Claude Code runs a `SessionStart` hook (`.claude/settings.json` → `scripts/selling-guide-session-hook.cjs`)
that materialises the Selling Guide corpus before a session begins, and `.claude/skills/` carries
domain skills that load on matching work. **Codex loads none of that.** So a compliance rail that is
mechanical for one agent has been, until now, entirely absent for the other. This file is the manual
equivalent. It does not achieve parity; it makes the gap visible and gives you the command.

## Before answering any Fannie Mae question

The full rules are in the repository root [`CLAUDE.md`](../../CLAUDE.md), "Compliance first" — that
file is binding on every agent regardless of which one reads it automatically. The short form:

1. **Materialise the corpus once per checkout.** The Guide text is gitignored (this repo is public
   and the Guide is Fannie Mae's copyrighted work), so it will not be in a fresh clone:

   ```
   pip3 install pymupdf pymupdf4llm
   python3 scripts/extract-selling-guide.py
   ```

   It recovers the PDF from this repository's own git history, SHA-256 verified, with no network.
   If it cannot find a PDF it says where it looked and stops. **That is an honest gap, not a licence
   to answer from memory.**

2. **Read the markdown rendering, cite the PDF page.** The Guide states most real thresholds in
   tables, and the plain-text rendering flattens them into unlabelled runs of words. The markdown
   rendering reconstructs them. Any threshold or matrix cell that decides money or eligibility is
   verified against the PDF page.

3. **`section-index.tsv` is tracked**, so `grep -n "B3-6-05" docs/fannie-mae/selling-guide/section-index.tsv`
   locates any section with no setup at all.

4. **Use `grep -F` for phrases containing `$`.** BSD grep reads it as an anchor and reports zero
   matches on text that is verbatim there. This has cost real sessions.

## Never

- **Never invent** a MISMO field name, enumeration, XML container path, edit code or Special Feature
  Code. If it cannot be verified in the local references, stop and flag it.
- **Never answer a Fannie Mae policy question from memory.** Same rule for NMLS licensing
  ([`docs/nmls/`](../nmls/)) and Regulation Z ([`docs/reg-z/`](../reg-z/)).
- **Never hand-edit** anything the extractor generates. The Selling Guide Steward regenerates the
  tracked fact layer; everything else here is a reference binary kept at its original filename for
  provenance, spaces included, so quote paths in shell.

## Hierarchy

The Fannie Mae *Selling Guide* and *Servicing Guide* are the official policy statements and control
over job aids in any discrepancy. When sources disagree or a requirement is ambiguous, escalate to
the founder rather than picking an interpretation. The Selling Guide is checkable in-repo; the
Servicing Guide is **not present** — say so rather than reasoning around it.

The online Loan Delivery job aid returns 403 from this environment. Probe if you like; report the
block, never guess past it.
