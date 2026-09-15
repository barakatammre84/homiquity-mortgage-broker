#!/usr/bin/env node
/**
 * ONE-OFF companion to scripts/selling-guide-recon.cjs — answers exactly one question:
 *
 *   Q7. Is selling-guide.fanniemae.com server-rendered, or does it need JavaScript?
 *
 * This decides the shape of any monitor we build. If a plain `fetch` returns the policy
 * text, the watcher stays a dependency-free node script like every other guard in this
 * repo. If it returns an empty app shell, monitoring needs a headless browser in CI —
 * a materially heavier, slower and more brittle thing — and we would want to know that
 * BEFORE designing extraction, not after.
 *
 * Method: take the SAME url the plain probe already fetched, render it in headless
 * Chromium, and compare visible-text volume. A rendered page much larger than the raw
 * one means the content arrives via JS.
 *
 * Disposable, like its sibling. Deleted once the question is answered.
 *
 * Requires playwright-core and a Chromium build; the workflow installs both and runs
 * this step with continue-on-error, so a browser that will not install cannot cost us
 * the plain-fetch recon that is the main prize.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const OUT = process.env.RECON_OUT || path.join(os.tmpdir(), "sg-recon");
const URL_UNDER_TEST =
  process.env.RECON_RENDER_URL ||
  "https://selling-guide.fanniemae.com/sel/b3-6-05/monthly-debt-obligations";
const RAW_FILE = process.env.RECON_RENDER_RAW || "section-b3-6-05.html";

const UA =
  "HomiquityCorpusRecon/1.0 (+https://github.com/barakatammre84/homiquity; " +
  "one-off Selling Guide corpus freshness probe; contact via repo issues)";

/** Same reduction the watcher's strip() does, so the two numbers are comparable. */
function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function main() {
  const rawPath = path.join(OUT, RAW_FILE);
  let rawLen = null;
  if (fs.existsSync(rawPath)) {
    rawLen = visibleText(fs.readFileSync(rawPath, "utf8")).length;
    console.log(`plain fetch : ${rawLen} chars of visible text (${RAW_FILE})`);
  } else {
    console.log(`plain fetch : ${RAW_FILE} absent — the plain probe did not reach this URL`);
  }

  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  try {
    const context = await browser.newContext({ userAgent: UA });
    const page = await context.newPage();
    const response = await page.goto(URL_UNDER_TEST, {
      waitUntil: "networkidle",
      timeout: 60000,
    });
    const rendered = await page.evaluate(() => (document.body ? document.body.innerText : ""));
    const html = await page.content();
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "section-b3-6-05.rendered.html"), html);

    const renderedLen = rendered.replace(/\s+/g, " ").trim().length;
    console.log(`rendered    : ${renderedLen} chars of visible text (HTTP ${response && response.status()})`);
    console.log(`final url   : ${page.url()}`);

    let verdict;
    if (rawLen === null) {
      verdict = "INCONCLUSIVE — no plain-fetch body to compare against";
    } else if (rawLen === 0) {
      verdict = "CLIENT-RENDERED — the plain fetch had no text at all";
    } else {
      const ratio = renderedLen / rawLen;
      verdict =
        ratio > 1.5
          ? `CLIENT-RENDERED — rendered is ${ratio.toFixed(1)}× the raw text; a monitor needs a browser`
          : `SERVER-RENDERED — rendered is ${ratio.toFixed(2)}× the raw text; plain fetch is enough`;
    }
    console.log(`\nQ7 verdict  : ${verdict}`);

    fs.writeFileSync(
      path.join(OUT, "render-check.json"),
      `${JSON.stringify(
        {
          $comment: "Q7 — is the Selling Guide HTML edition server-rendered or client-rendered?",
          url: URL_UNDER_TEST,
          finalUrl: page.url(),
          httpStatus: response && response.status(),
          plainFetchTextChars: rawLen,
          renderedTextChars: renderedLen,
          verdict,
        },
        null,
        1,
      )}\n`,
    );
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`render check failed: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
