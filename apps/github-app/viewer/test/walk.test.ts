/**
 * The walkthrough shows a reviewer what is uncertain AT THE STOP they are looking at.
 *
 * Before this, a stop gave what changed and why, and everything still uncertain sat in
 * four separate lists on another page — 54% of every document in `.intent/` was fields
 * with no link to the code at all, so the reader did the join by hand.
 *
 * Driven through jsdom against the real page, the same way the build's prerender step
 * drives it, because the thing worth testing is what a reviewer actually ends up seeing.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VIEWER = fileURLToPath(new URL("..", import.meta.url));

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
 const z = 3;
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -10,2 +10,3 @@
 const p = 1;
+const q = 2;
 const r = 3;
`;

const anchor = (id: string, path: string, start: number) => ({
  id,
  path,
  hunk: { old_start: start, old_lines: 2, new_start: start, new_lines: 3 },
});

/** `coreHasNothing` flips T2 to a core stop with no anchored findings. */
function makeDoc(coreHasNothing = false) {
  return {
    schema_version: "0.1",
    meta: {
      id: "x",
      repo: "o/r",
      commit_range: { base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
      generated_by: { pipeline: "p", version: "1" },
      generated_at: new Date().toISOString(),
    },
    problem: { statement: "A problem.", origin: "stated_upfront", user_asks: [] },
    assumptions: [
      { id: "A1", assumption: "ANCHORED assumption", impact_if_wrong: "breaks", confidence: "unverified", anchors: ["H1"] },
      { id: "A2", assumption: "GLOBAL assumption", impact_if_wrong: "breaks", confidence: "unverified" },
      { id: "A3", assumption: "SETTLED assumption", impact_if_wrong: "n/a", confidence: "grounded_in_code" },
    ],
    open_questions: [{ id: "Q1", question: "ANCHORED question", anchors: ["H1"] }],
    unresolved: [
      { question: "NOBODY ANSWERED this", disposition: "unanswered", anchors: ["H1"] },
      { question: "GLOBAL unsettled", disposition: "escalated" },
    ],
    evaluated: [{ question: "ALREADY ASKED here", answer: "- yes", anchors: ["H1"] }],
    approach: { adopted: { summary: "s", rationale: "r" }, trials: [] },
    tour: [
      { id: "T1", title: "First stop", role: "core", what: "- did a thing", why: "- because", attention: "CHECK THIS FIRST", anchors: [anchor("H1", "src/a.ts", 1)], provenance: "from_transcript" },
      { id: "T2", title: "Second stop", role: coreHasNothing ? "core" : "supporting", what: "- churn", why: "- tidy", anchors: [anchor("H2", "src/b.ts", 10)], provenance: "inferred_from_code" },
    ],
    verification: {
      performed: [],
      not_verified: ["GLOBAL unexercised", { text: "ANCHORED unexercised", anchors: ["H1"] }],
    },
  };
}

async function open(doc: unknown) {
  const errors: string[] = [];
  const vc = new VirtualConsole();
  // jsdom has no layout or scrolling; "Not implemented" is it saying so, not a page failure.
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(readFileSync(VIEWER + "index.html", "utf8"), {
    url: "https://x.invalid/#o/r/pull/7",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(w: any) {
      w.fetch = async (u: unknown) => {
        const url = String(u);
        if (url.includes("/api/me")) return { ok: true, json: async () => ({ login: "dev" }) };
        if (url.includes("/api/document"))
          return { ok: true, json: async () => ({ document: doc, diff: DIFF, meta: { owner: "o", repo: "r", pull: 7, head_sha: "b".repeat(40) } }) };
        return { ok: false, json: async () => ({}) };
      };
      w.scrollTo = () => {};
    },
  });

  await new Promise((r) => setTimeout(r, 1200));
  const d = dom.window.document;
  const stops = () => [...d.querySelectorAll(".rail .nav-link")] as any[];
  return {
    errors,
    text: () => (d.querySelector("main")?.textContent ?? "").replace(/\s+/g, " "),
    stop: (title: string) => stops().find((b) => b.textContent.includes(title))!,
    go: async (title: string) => {
      stops().find((b) => b.textContent.includes(title))!.dispatchEvent(new dom.window.Event("click"));
      await new Promise((r) => setTimeout(r, 150));
    },
  };
}

describe("the guided walkthrough", () => {
  let page: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { page = await open(makeDoc()); });

  it("loads the document without a page error", () => {
    expect(page.errors).toEqual([]);
  });

  describe("the overview keeps what belongs to the whole change", () => {
    it("shows an unanchored assumption and hides an anchored one", () => {
      // Nothing appears in both places: saying it twice is the waste this removes.
      expect(page.text()).toContain("GLOBAL assumption");
      expect(page.text()).not.toContain("ANCHORED assumption");
    });

    it("still hides a settled assumption entirely", () => {
      expect(page.text()).not.toContain("SETTLED assumption");
    });

    it("says how many items moved, so nothing looks dropped", () => {
      expect(page.text()).toContain("attached to walkthrough stops");
    });
  });

  describe("a stop gathers what is uncertain there", () => {
    beforeAll(async () => { await page.go("First stop"); });

    it("leads with what to check, ahead of What and Why", () => {
      // `attention` is the one line a reviewer with a minute reads, and it sat below the
      // two longest fields on the page.
      const t = page.text();
      expect(t.indexOf("CHECK THIS FIRST")).toBeGreaterThan(-1);
      expect(t.indexOf("CHECK THIS FIRST")).toBeLessThan(t.indexOf("did a thing"));
    });

    it("shows every kind of uncertainty anchored to this hunk", () => {
      const t = page.text();
      for (const probe of ["NOBODY ANSWERED this", "ANCHORED assumption", "ANCHORED question", "ANCHORED unexercised"]) {
        expect(t).toContain(probe);
      }
    });

    it("keeps settled questions as a lookup rather than reading", () => {
      expect(page.text()).toContain("ALREADY ASKED here");
    });

    it("does not drag the whole change's items into this stop", () => {
      const t = page.text();
      expect(t).not.toContain("GLOBAL assumption");
      expect(t).not.toContain("GLOBAL unsettled");
    });
  });

  describe("the walkthrough nav", () => {
    it("badges a core stop with how much is uncertain there", () => {
      expect(page.stop("First stop").querySelector(".tag-warn")?.textContent).toBe("4");
    });

    it("dims a supporting stop rather than hiding it", () => {
      // Every coverage-required hunk must land in some stop, so hiding one would leave a
      // reviewer unable to reach the code it explains.
      expect(page.stop("Second stop").className).toContain("opacity-60");
      expect(page.stop("Second stop")).toBeTruthy();
    });
  });

  describe("a stop with nothing flagged", () => {
    it("says so when it is core, because silence is information", async () => {
      const core = await open(makeDoc(true));
      await core.go("Second stop");
      expect(core.text()).toContain("Nothing flagged at this stop");
    });

    it("stays quiet when it is only supporting", async () => {
      await page.go("Second stop");
      expect(page.text()).not.toContain("Nothing flagged at this stop");
    });
  });
});
