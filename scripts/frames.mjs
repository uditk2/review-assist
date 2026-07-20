// Capture a sequence of viewer states as PNG frames for the README GIF.
import pw from "/home/claude/.npm-global/lib/node_modules/playwright/index.js";
const { chromium } = pw;
import { mkdirSync } from "node:fs";

mkdirSync("scripts/frames", { recursive: true });
const url = "http://localhost:8787/#acme/checkout-service/pull/42";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 780 }, deviceScaleFactor: 1.5 });
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForTimeout(500);

let n = 0;
const shot = async () => { await page.screenshot({ path: `scripts/frames/f${String(n++).padStart(2, "0")}.png` }); };

// Overview (top)
await shot();
// Overview scrolled to assumptions
await page.evaluate(() => document.querySelector("h2:nth-of-type(1)")?.scrollIntoView());
await page.evaluate(() => window.scrollTo(0, 620));
await page.waitForTimeout(150); await shot();
// Start walkthrough
await page.evaluate(() => window.scrollTo(0, 0));
await page.click("button:has-text('Start walkthrough')");
await page.waitForTimeout(200); await shot();
// Step through stops with keyboard
for (const _ of [1, 2, 3]) {
  await page.keyboard.press("j");
  await page.waitForTimeout(200);
  await shot();
}
// Verification
await page.click("nav button:has-text('Verification')");
await page.waitForTimeout(200); await shot();
// Back to a core stop to end on the diff
await page.click("nav button:has(.id-chip:text-is('T2'))");
await page.waitForTimeout(200); await shot();

console.log("frames:", n);
await browser.close();
