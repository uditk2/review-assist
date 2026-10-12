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

/** `discussion` is what /api/discussion returns: reviews and PR-level comments already on the PR. */
async function open(doc: unknown, discussion: { reviews?: unknown[]; comments?: unknown[] } = {}) {
  const errors: string[] = [];
  const posts: { url: string; body: any }[] = [];
  const vc = new VirtualConsole();
  // jsdom has no layout or scrolling; "Not implemented" is it saying so, not a page failure.
  vc.on("jsdomError", (e) => { if (!/Not implemented/.test(e.message)) errors.push(e.message); });
  vc.on("error", (...a) => errors.push(a.join(" ")));

  const dom = new JSDOM(readFileSync(VIEWER + "index.html", "utf8"), {
    url: "https://x.invalid/#o/r/pull/7",
    runScripts: "dangerously",
    virtualConsole: vc,
    beforeParse(w: any) {
      w.fetch = async (u: unknown, init?: { method?: string; body?: string }) => {
        const url = String(u);
        if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "{}") });
        if (url.includes("/api/me")) return { ok: true, json: async () => ({ login: "dev" }) };
        if (url.includes("/api/document"))
          return { ok: true, json: async () => ({ document: doc, diff: DIFF, meta: { owner: "o", repo: "r", pull: 7, head_sha: "b".repeat(40), author: "octo" } }) };
        if (url.includes("/api/discussion")) return { ok: true, json: async () => ({ reviews: [], comments: [], ...discussion }) };
        if (url.includes("/api/review")) return { ok: true, json: async () => ({ review: { id: 1, state: "COMMENTED", html_url: "https://x.invalid/r" } }) };
        return { ok: false, json: async () => ({}) };
      };
      w.scrollTo = () => {};
    },
  });

  await new Promise((r) => setTimeout(r, 1200));
  const d = dom.window.document;
  const route = () => [...d.querySelectorAll(".route-rail .route-step")] as any[];
  const pause = () => new Promise((r) => setTimeout(r, 150));
  const click = async (el: Element | undefined | null) => {
    el!.dispatchEvent(new dom.window.Event("click"));
    await pause();
  };
  return {
    errors,
    posts,
    click,
    /** A button in main whose trimmed text is exactly `text`, the nth match. */
    button: (text: string, nth = 0) => [...d.querySelectorAll("main button")].filter((b) => (b.textContent ?? "").trim() === text)[nth],
    text: () => (d.querySelector("main")?.textContent ?? "").replace(/\s+/g, " "),
    doc: d,
    win: dom.window as any,
    route: (label: string) => route().find((b) => b.textContent.includes(label))!,
    routeLabels: () => route().map((b) => b.querySelector(".route-step-title")?.textContent ?? ""),
    buttons: () => [...d.querySelectorAll("main button")].map((b) => (b.textContent ?? "").trim()),
    press: async (ariaLabel: string) => {
      d.querySelector(`[aria-label="${ariaLabel}"]`)!.dispatchEvent(new dom.window.Event("click"));
      await pause();
    },
    goRoute: async (label: string) => {
      route().find((b) => b.textContent.includes(label))!.dispatchEvent(new dom.window.Event("click"));
      await pause();
    },
    go: async (title: string) => {
      route().find((b) => b.textContent.includes("Walk the change"))!.dispatchEvent(new dom.window.Event("click"));
      await pause();
      // The stop's own heading, not the whole page: the bar names the next stop too.
      const current = () => (d.querySelector("main h1")?.textContent ?? "");
      if (title === "Second stop" && !current().includes("Second stop")) {
        [...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Continue →")!.dispatchEvent(new dom.window.Event("click"));
        await pause();
      }
      if (title === "First stop" && !current().includes("First stop")) {
        [...d.querySelectorAll("button")].find((b) => b.textContent?.trim() === "Previous")!.dispatchEvent(new dom.window.Event("click"));
        await pause();
      }
    },
  };
}

describe("the guided walkthrough", () => {
  let page: Awaited<ReturnType<typeof open>>;
  beforeAll(async () => { page = await open(makeDoc()); });

  it("loads the document without a page error", () => {
    expect(page.errors).toEqual([]);
  });

  it("opens on the Overview, the first step of the route", () => {
    // Why the change exists comes before anything that asks for a judgement on it.
    expect(page.route("Overview").className).toContain("is-active");
    expect(page.text()).toContain("A problem.");
  });

  it("orders the route as a reviewer reads it", () => {
    // What was checked comes second: it sets how hard to look at everything after it.
    const labels = ["Overview", "Verification", "Risk cues", "Walk the change", "Open questions"];
    const positions = labels.map((l) => page.routeLabels().indexOf(l));
    expect(positions).toEqual([0, 1, 2, 3, 4]);
  });

  describe("the overview keeps what belongs to the whole change", () => {
    beforeAll(async () => { await page.goRoute("Overview"); });

    it("continues forward along the route, never back", () => {
      expect(page.text()).toContain("Next: Verification");
    });

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

  describe("the review route", () => {
    it("starts with a count of decision-changing cues", async () => {
      await page.goRoute("Risk cues");
      expect(page.route("Risk cues").querySelector(".tag-warn")?.textContent).toBe("4");
      expect(page.text()).toContain("Risk cue 1 of 4");
    });

    it("never prints an absent optional part as the text \"null\"", () => {
      // The cue card once used Element.append, which stringifies null children.
      expect(page.text()).not.toContain("null");
    });

    it("pages to the last cue, so the count never promises one it cannot show", async () => {
      for (let n = 1; n < 4; n++) await page.press("Next risk cue");
      expect(page.text()).toContain("Risk cue 4 of 4");
      expect(page.text()).toContain("GLOBAL unsettled");
      await page.press("Previous risk cue");
      expect(page.text()).toContain("Risk cue 3 of 4");
    });

    it("continues from the last cue to the first stop, so the walk skips nothing", async () => {
      await page.press("Next risk cue");
      expect(page.text()).toContain("Next: Walk the change");
      [...page.doc.querySelectorAll(".route-next button")].find((b: any) => b.textContent.trim() === "Continue →")!
        .dispatchEvent(new page.win.Event("click"));
      await new Promise((r) => setTimeout(r, 150));
      expect(page.doc.querySelector("main h1")?.textContent).toContain("First stop");
    });

    it("keeps every stop reachable through the walkthrough", async () => {
      await page.go("Second stop");
      expect(page.text()).toContain("Second stop");
    });

    it("hands the last stop over to the next route step", () => {
      expect(page.text()).toContain("Next: Open questions");
      expect(page.buttons()).toContain("Continue →");
    });
  });

  describe("the open questions step", () => {
    beforeAll(async () => { await page.goRoute("Open questions"); });

    it("lists every open question, and links a code-tied one to its stop", () => {
      expect(page.text()).toContain("ANCHORED question");
      expect(page.text()).toContain("See it at T1 · First stop");
    });

    it("keeps what was already answered beside the open ones, marked resolved", () => {
      expect(page.text()).toContain("Resolved during the session (1)");
      expect(page.text()).toContain("ALREADY ASKED here");
    });

    it("ends the route at the review decision", () => {
      expect(page.text()).toContain("Next: Submit review");
    });
  });

  describe("the verification step", () => {
    beforeAll(async () => { await page.goRoute("Verification"); });

    it("separates what was checked from what was not, then leads on to Risk cues", () => {
      expect(page.text()).toContain("GLOBAL unexercised");
      expect(page.text()).toContain("Next: Risk cues");
    });
  });

  describe("deciding on an item", () => {
    let p: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      p = await open(makeDoc());
      await p.goRoute("Open questions");
    });

    it("records a decision in one click, with nothing to write", async () => {
      await p.click(p.button("Known, close it"));
      expect(p.button("Known, close it")!.getAttribute("aria-pressed")).toBe("true");
      expect(p.text()).toContain("Saved. It posts with your review.");
    });

    it("counts the step as done once everything in it is decided", () => {
      const tag = p.route("Open questions").querySelector(".tag");
      expect(tag?.className).toContain("tag-ok");
    });

    it("clears the decision on a second click", async () => {
      await p.click(p.button("Known, close it"));
      expect(p.button("Known, close it")!.getAttribute("aria-pressed")).toBe("false");
      expect(p.route("Open questions").querySelector(".tag")?.textContent).toBe("1");
    });

    it("shows a decision wherever the item appears", async () => {
      await p.goRoute("Risk cues");
      await p.click(p.button("Blocks merge"));
      await p.go("First stop");
      const anchoredCard = [...p.doc.querySelectorAll("main .card")].find((c) => c.textContent?.includes("ANCHORED assumption"))!;
      const pressed = [...anchoredCard.querySelectorAll("button[aria-pressed='true']")].map((b) => b.textContent);
      expect(pressed).toEqual(["Blocks merge"]);
    });

    it("sends the decisions with the review, asks by @mention, and marks what was decided", async () => {
      await p.go("First stop");
      const q = [...p.doc.querySelectorAll("main .card")].find((c) => c.textContent?.includes("ANCHORED question"))!;
      await p.click([...q.querySelectorAll("button")].find((b) => b.textContent === "Ask the author"));
      await p.click([...p.doc.querySelectorAll(".route-rail button")].find((b) => b.textContent?.includes("Submit review")));
      const body = (p.doc.querySelector("main textarea") as HTMLTextAreaElement).value;
      expect(body).toContain("**Blocks merge**");
      expect(body).toContain("**Questions for @octo**");
      expect(body).toContain("**Q1** ANCHORED question");
      // A blocking decision suggests Request changes rather than Approve.
      expect(p.button("Request changes")!.className).toContain("btn-primary");
      await p.click(p.button("Send without a verdict"));
      const sent = p.posts.find((x) => x.url.includes("/api/review"))!.body;
      expect(sent.event).toBe("COMMENT");
      expect(sent.body).toMatch(/<!-- review-assist:decisions \{"A1":"block","Q1":"ask"\} -->$/);
    });
  });

  describe("decisions already on the pull request", () => {
    it("are read back from the review that carried them", async () => {
      const p = await open(makeDoc(), { reviews: [
        { id: 9, user: "alice", at: "2026-10-01T00:00:00Z", body: 'Looks fine.\n\n<!-- review-assist:decisions {"Q1":"accept"} -->' },
      ] });
      await p.goRoute("Open questions");
      expect(p.text()).toContain("Closed as known by @alice");
      expect(p.button("Known, close it")!.getAttribute("aria-pressed")).toBe("true");
    });
  });

  describe("diagrams", () => {
    let p: Awaited<ReturnType<typeof open>>;
    beforeAll(async () => {
      const doc = { ...makeDoc(), diagrams: [{ title: "THE FLOW", mermaid: "sequenceDiagram\n  A->>B: hi", caption: "WHAT IT SHOWS" }] };
      p = await open(doc, { comments: [
        { id: 3, user: "bob", at: "2026-10-02T00:00:00Z", body: "<!-- review-assist:diagram D1 -->\n**On diagram D1: THE FLOW**\n\nWHY THIS HOP" },
        { id: 4, user: "carol", at: "2026-10-02T00:00:00Z", body: "unrelated PR chatter" },
      ] });
      await p.goRoute("Diagrams");
    });

    it("get their own step, right after the Overview", () => {
      expect(p.routeLabels().slice(0, 3)).toEqual(["Overview", "Diagrams", "Verification"]);
    });

    it("say what the diagram shows and how to read it", () => {
      expect(p.text()).toContain("THE FLOW");
      expect(p.text()).toContain("WHAT IT SHOWS");
      expect(p.text()).toContain("Read it top to bottom");
    });

    it("show the diagram's own comments from the PR, and nothing else", () => {
      expect(p.text()).toContain("WHY THIS HOP");
      expect(p.text()).not.toContain("unrelated PR chatter");
      expect(p.text()).not.toContain("On diagram D1");
    });

    it("post a comment that reads back under the same diagram", async () => {
      await p.click(p.button("Comment on this diagram"));
      (p.doc.querySelector("main textarea") as HTMLTextAreaElement).value = "IS THIS HOP NEEDED";
      await p.click(p.button("Post to PR"));
      const sent = p.posts.find((x) => x.url.includes("/api/issue-comment"));
      expect(sent?.body.body).toContain("<!-- review-assist:diagram D1 -->");
      expect(sent?.body.body).toContain("IS THIS HOP NEEDED");
    });
  });

  it("leaves Diagrams out of the route when the document has none", () => {
    expect(page.routeLabels()).not.toContain("Diagrams");
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
