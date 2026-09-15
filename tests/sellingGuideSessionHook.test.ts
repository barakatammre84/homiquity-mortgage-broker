import { describe, it, expect } from "vitest";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { directive, failureReason } = require("../scripts/selling-guide-session-hook.cjs");

// -----------------------------------------------------------------------------
// The SessionStart hook's directive — what a session with no corpus actually reads.
//
// The hook informs and never blocks (it always exits 0), so this text is the entire
// intervention: if it names a remedy that cannot work in the checkout it is printed
// into, the session spends its effort on the wrong command and still has no primary
// source. #819 recorded both ways that happened — the reason slot was filled from the
// LAST line of a multi-line extractor failure (the standing warning, which diagnoses
// nothing) and the remedy claimed the PDF recovers from git history "no network
// needed", which is false in the shallow clone every cloud session runs in.
// -----------------------------------------------------------------------------

/** The extractor's real 2026-09-14 failure in a shallow cloud checkout, verbatim. */
const EXTRACTOR_NO_PDF = [
  "Selling Guide PDF not found — the repo is public, so it is deliberately not",
  "committed at the tip. Tried, in order:",
  "  1. $SELLING_GUIDE_PDF          (unset)",
  "  2. /repo/docs/fannie-mae/selling-guide/Selling-Guide_08-05-2026.pdf  (missing)",
  "  3. recovery from git history   (git blob c984148cc830 not in this clone's history;",
  "     the blob lives in commit 978ec3839a69 — a shallow clone may need",
  "     `git fetch --unshallow` first)",
  "Point SELLING_GUIDE_PDF at your copy, or drop it at path 2, and re-run.",
  "Do NOT answer a Fannie policy question from memory instead.",
].join("\n");

describe("failureReason", () => {
  it("keeps the diagnosis the old .pop() discarded", () => {
    const reason = failureReason({ stderr: EXTRACTOR_NO_PDF, stdout: "" });
    expect(reason).toMatch(/git blob c984148cc830 not in this clone's history/);
    expect(reason).toMatch(/git fetch --unshallow/);
    expect(reason).toMatch(/Selling Guide PDF not found/);
  });

  it("does not reduce that failure to its last line", () => {
    // The regression itself: `.split("\n").pop()` returned only the standing warning.
    expect(EXTRACTOR_NO_PDF.split("\n").pop()).toBe(
      "Do NOT answer a Fannie policy question from memory instead.",
    );
    expect(failureReason({ stderr: EXTRACTOR_NO_PDF })).not.toBe(
      "Do NOT answer a Fannie policy question from memory instead.",
    );
  });

  it("drops the trailing warning the directive already carries", () => {
    const reason = failureReason({ stderr: EXTRACTOR_NO_PDF });
    expect(reason.split("\n").pop()).toMatch(/Point SELLING_GUIDE_PDF at your copy/);
    expect(reason).not.toMatch(/from memory instead/);
  });

  it("prefers stderr, falls back to stdout, and never returns nothing", () => {
    expect(failureReason({ stderr: "boom", stdout: "quiet" })).toBe("boom");
    expect(failureReason({ stderr: "   ", stdout: "from stdout" })).toBe("from stdout");
    expect(failureReason({ stderr: "", stdout: "" })).toBe("extractor failed");
    expect(failureReason({})).toBe("extractor failed");
    expect(failureReason(undefined)).toBe("extractor failed");
  });

  it("bounds a runaway failure so it cannot flood the session's context", () => {
    const flood = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const reason = failureReason({ stderr: flood });
    expect(reason.length).toBeLessThanOrEqual(900);
    expect(reason.split("\n").length).toBeLessThanOrEqual(13);
    expect(reason).toMatch(/\+388 more line\(s\)/);
  });

  it("keeps a single-line failure exactly as it was", () => {
    // The single-line exits (missing pymupdf, sha256 mismatch) already read correctly.
    expect(failureReason({ stderr: "pymupdf is required (pip3 install pymupdf==1.28.2)" })).toBe(
      "pymupdf is required (pip3 install pymupdf==1.28.2)",
    );
  });
});

describe("directive", () => {
  it("names the unshallow step in a shallow checkout and drops the false claim", () => {
    const text = directive("extraction failed", { shallow: true });
    expect(text).toMatch(/git fetch --unshallow --no-tags origin main/);
    expect(text).not.toMatch(/no network needed/);
    // The extract command still follows, after the step that makes it able to work.
    const order = text.indexOf("--unshallow") < text.indexOf("extract-selling-guide.py");
    expect(order).toBe(true);
  });

  it("keeps the git-history recovery in a full clone, where it is true", () => {
    const text = directive("extraction failed", { shallow: false });
    expect(text).toMatch(/recovers from this repo's own git history — no network needed/);
    expect(text).not.toMatch(/--unshallow/);
    expect(text).toMatch(/pip3 install pymupdf && python3 scripts\/extract-selling-guide\.py/);
  });

  it("indents every line of a multi-line reason into the block", () => {
    const text = directive(`extraction failed:\n${failureReason({ stderr: EXTRACTOR_NO_PDF })}`, {
      shallow: true,
    });
    const body = text.split("\n").slice(1, -2);
    expect(body.every((line: string) => line.startsWith("   "))).toBe(true);
    expect(text).toMatch(/git blob c984148cc830/);
  });

  it("always carries the corpus-first rule and the honest-gap instruction", () => {
    for (const shallow of [true, false]) {
      const text = directive("any reason", { shallow });
      expect(text).toMatch(/⛔ SELLING GUIDE CORPUS-FIRST/);
      expect(text).toMatch(/Do NOT answer a Fannie policy question from memory in the meantime/);
      expect(text).toMatch(/underwriting, income, eligibility/);
    }
  });
});
