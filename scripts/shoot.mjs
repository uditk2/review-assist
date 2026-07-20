import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pw;

const base = "http://localhost:8787/#acme/checkout-service/pull/42";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 960 }, deviceScaleFactor: 2 });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto(base, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const covBadge = (await page.textContent("header .tag"))?.trim();
const hasAssumptions = await page.locator("h2:has-text('Assumptions')").count();
const hasTrials = await page.locator("summary:has-text('Rejected alternatives')").count();
await page.screenshot({ path: "scripts/out-front.png", fullPage: true });

await page.click("button:has-text('Start walkthrough')");
await page.waitForTimeout(200);
// Walkthrough stop T2 in the left rail
await page.click("nav button:has(.id-chip:text-is('T2'))");
await page.waitForTimeout(250);
const hasNote = await page.locator(".note:has-text('Reviewer note')").count();
const addLines = await page.locator(".diff-line.is-add").count();
await page.screenshot({ path: "scripts/out-tour.png", fullPage: true });

console.log(JSON.stringify({
  coverageBadge: covBadge,
  assumptionsSection: hasAssumptions > 0,
  trialsSection: hasTrials > 0,
  reviewerNoteOnT2: hasNote > 0,
  addLinesRendered: addLines,
  consoleErrors: errors,
}, null, 2));

await browser.close();
if (errors.length) { console.error("CONSOLE ERRORS PRESENT"); process.exit(1); }
