/**
 * The pager exists because `compute_diff` used to return the whole diff beside the
 * `run_id`, and on a 205,826-byte change the client spilled the pair to disk and the
 * handle became unreachable. These pin the two properties that make paging a fix rather
 * than a smaller version of the same problem: every hunk is eventually reachable, and no
 * caller ever receives half of one without being told which half.
 */

import { describe, it, expect } from "vitest";
import { indexHunks, pageDiff, parseCursor, summarizeFiles, type HunkSlice } from "../src/index.js";

const SMALL = `diff --git a/src/app.ts b/src/app.ts
--- a/src/app.ts
+++ b/src/app.ts
@@ -45,7 +45,9 @@ export function projectNameLikePattern(
   const id = projectId.slice(0, 8);
-  return \`[smk:\${id}]%\`;
+  return \`%smk:\${id}%\`;
 }
@@ -120,3 +122,4 @@ class Widget {
+  render() {}
 }
diff --git a/src/other.ts b/src/other.ts
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,2 @@
+export const x = 1;
`;

/** One file whose single hunk is far larger than any page — a newly added file. */
function withGiantHunk(lineCount: number): string {
  const added = Array.from({ length: lineCount }, (_, i) => `+  const line${i} = ${i};`);
  return `${SMALL}diff --git a/src/big.ts b/src/big.ts
--- /dev/null
+++ b/src/big.ts
@@ -0,0 +1,${lineCount} @@
${added.join("\n")}
`;
}

/** Walk every page from the start, exactly as an agent following next_cursor would. */
function drain(diff: string, maxBytes: number, guard = 10_000): HunkSlice[] {
  const seen: HunkSlice[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < guard; n++) {
    const page = pageDiff(diff, { cursor, maxBytes });
    seen.push(...page.hunks);
    if (!page.next_cursor) return seen;
    expect(page.returned, "a page that reports more to come must carry something").toBeGreaterThan(0);
    cursor = page.next_cursor;
  }
  throw new Error("pager did not terminate");
}

/** Reassemble what the caller actually received, per hunk id, in arrival order. */
function reassemble(slices: HunkSlice[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of slices) out.set(s.id, (out.get(s.id) ?? "") + (out.has(s.id) ? "\n" : "") + s.text);
  return out;
}

/** The hunk text the pager should be able to hand back, straight from the index. */
function expectedTexts(diff: string): Map<string, string> {
  const lines = diff.split("\n");
  const out = new Map<string, string>();
  for (const h of indexHunks(diff)) {
    const body = lines.slice(h.span[0], h.span[1]);
    if (h.span[1] === lines.length && body.length > 1 && body[body.length - 1] === "") body.pop();
    out.set(h.id, body.join("\n"));
  }
  return out;
}

describe("pageDiff", () => {
  it("returns every hunk in one page when the whole diff fits", () => {
    const page = pageDiff(SMALL, { maxBytes: 100_000 });
    expect(page.hunks.map((h) => h.id)).toEqual(["H1", "H2", "H3"]);
    expect(page.next_cursor).toBeUndefined();
    expect(page.remaining).toBe(0);
    expect(page.total).toBe(3);
  });

  it("hands back each hunk's exact text, header included", () => {
    const page = pageDiff(SMALL, { maxBytes: 100_000 });
    const expected = expectedTexts(SMALL);
    for (const slice of page.hunks) expect(slice.text).toBe(expected.get(slice.id));
    expect(page.hunks[0].header).toBe(
      "@@ -45,7 +45,9 @@ export function projectNameLikePattern("
    );
  });

  it("breaks on a hunk boundary rather than mid-hunk, and says where to resume", () => {
    // Room for the first hunk but not the second: the second must not be cut, because a
    // fragment of a hunk has no header and no id the anchors could name.
    const page = pageDiff(SMALL, { maxBytes: 300 });
    expect(page.returned).toBe(1);
    expect(page.hunks[0].id).toBe("H1");
    expect(page.hunks[0].lines, "a whole hunk carries no line labelling").toBeUndefined();
    expect(page.next_cursor).toBe("H2");
    expect(page.remaining).toBe(2);
  });

  it("walks the whole diff across pages, losing nothing and repeating nothing", () => {
    const slices = drain(SMALL, 300);
    expect(slices.map((s) => s.id)).toEqual(["H1", "H2", "H3"]);
    const got = reassemble(slices);
    for (const [id, text] of expectedTexts(SMALL)) expect(got.get(id)).toBe(text);
  });

  it("slices a hunk that cannot fit a page at all, instead of deadlocking on it", () => {
    // The case that forces this: a newly added file is a single hunk. In the change that
    // prompted the split, one such hunk was 26,655 bytes on its own.
    const diff = withGiantHunk(400);
    const page = pageDiff(diff, { cursor: "H4", maxBytes: 2_000 });
    expect(page.returned).toBe(1);
    const slice = page.hunks[0];
    expect(slice.id).toBe("H4");
    expect(slice.lines?.[0]).toBe(1);
    expect(slice.hunk_lines).toBe(401); // the @@ header plus 400 added lines
    expect(slice.lines![1]).toBeLessThan(slice.hunk_lines!);
    expect(page.next_cursor).toBe(`H4:${slice.lines![1]}`);
  });

  it("repeats the hunk header on a continuation, so a later slice is still placeable", () => {
    const diff = withGiantHunk(400);
    const first = pageDiff(diff, { cursor: "H4", maxBytes: 2_000 });
    const second = pageDiff(diff, { cursor: first.next_cursor, maxBytes: 2_000 });
    expect(second.hunks[0].header).toBe(first.hunks[0].header);
    expect(second.hunks[0].lines![0]).toBe(first.hunks[0].lines![1] + 1);
  });

  it("reassembles an oversized hunk exactly, however small the pages are", () => {
    const diff = withGiantHunk(400);
    const got = reassemble(drain(diff, 2_000));
    for (const [id, text] of expectedTexts(diff)) expect(got.get(id)).toBe(text);
  });

  it("terminates and covers everything even at an absurdly small budget", () => {
    // The deadlock this guards against is silent: a pager that always refuses to cut
    // returns an empty page forever, and the agent retries rather than reporting.
    const diff = withGiantHunk(60);
    const got = reassemble(drain(diff, 500));
    expect([...got.keys()]).toEqual(["H1", "H2", "H3", "H4"]);
    for (const [id, text] of expectedTexts(diff)) expect(got.get(id)).toBe(text);
  });

  it("budgets the encoded size, not the raw text", () => {
    // Found by paging the real 205,432-character change: every newline and quote in a
    // diff doubles once it is JSON, so a budget counted in raw characters under-shot by
    // ~8% and the largest page came back at 21,645 against a ceiling of 20,000. A budget
    // that can be exceeded is not a budget — this is the whole point of the module.
    const noisy = `diff --git a/q.ts b/q.ts
--- a/q.ts
+++ b/q.ts
@@ -1,1 +1,${200} @@
${Array.from({ length: 200 }, (_, i) => `+  const s${i} = "a\\"quoted\\"\\tstring";`).join("\n")}
`;
    const budget = 3_000;
    let cursor: string | undefined;
    for (let n = 0; n < 100; n++) {
      const page = pageDiff(noisy, { cursor, maxBytes: budget });
      expect(JSON.stringify(page.hunks).length).toBeLessThanOrEqual(budget);
      if (!page.next_cursor) return;
      cursor = page.next_cursor;
    }
    throw new Error("pager did not terminate");
  });

  it("walks past hunks no stop has to explain", () => {
    // The .intent file is the reviewer's own previous document, arriving as 26,443
    // characters of whole-file addition from the second commit of a branch onward. It is
    // excluded from coverage, never anchored, and no prompt mentions it — and the reviewer
    // is told to read the diff cold, which its own last output is the opposite of.
    const withIntent = `${SMALL}diff --git a/.intent/feat-x.json b/.intent/feat-x.json
--- /dev/null
+++ b/.intent/feat-x.json
@@ -0,0 +1,2 @@
+{ "schema_version": "0.1" }
diff --git a/spacer.txt b/spacer.txt
--- a/spacer.txt
+++ b/spacer.txt
@@ -9,1 +9,2 @@
+
`;
    const indexed = indexHunks(withIntent);
    expect(indexed.map((h) => h.id)).toEqual(["H1", "H2", "H3", "H4", "H5"]);
    expect(indexed.filter((h) => !h.coverage_required).map((h) => h.id)).toEqual(["H4", "H5"]);

    const walked = drain(withIntent, 100_000);
    expect(walked.map((s) => s.id), "the walk covers only what must be explained").toEqual([
      "H1",
      "H2",
      "H3",
    ]);
  });

  it("still serves a skipped hunk when it is named outright", () => {
    // No flag: asking for an id IS the override. A caller that names H4 has been specific.
    const withIntent = `${SMALL}diff --git a/.intent/feat-x.json b/.intent/feat-x.json
--- /dev/null
+++ b/.intent/feat-x.json
@@ -0,0 +1,2 @@
+{ "schema_version": "0.1" }
`;
    const page = pageDiff(withIntent, { ids: ["H4"], maxBytes: 100_000 });
    expect(page.hunks.map((h) => h.id)).toEqual(["H4"]);
    expect(page.hunks[0].text).toContain('"schema_version"');
  });

  it("serves just the hunks asked for, so one claim can be checked without the rest", () => {
    const page = pageDiff(SMALL, { ids: ["H1", "H3"], maxBytes: 100_000 });
    expect(page.hunks.map((h) => h.id)).toEqual(["H1", "H3"]);
    expect(page.total).toBe(2);
  });

  it("serves a file at a time", () => {
    const page = pageDiff(SMALL, { paths: ["src/app.ts"], maxBytes: 100_000 });
    expect(page.hunks.map((h) => h.id)).toEqual(["H1", "H2"]);
  });

  it("says which ids and paths it did not recognise instead of dropping them", () => {
    expect(pageDiff(SMALL, { ids: ["H1", "H99"] }).unknown_ids).toEqual(["H99"]);
    expect(pageDiff(SMALL, { paths: ["nope.ts"] }).unknown_paths).toEqual(["nope.ts"]);
  });

  it("paging a selection stays inside it", () => {
    const slices = drain2(SMALL, ["H1", "H3"], 300);
    expect(slices.map((s) => s.id)).toEqual(["H1", "H3"]);
  });

  it("rejects a cursor it cannot honour rather than silently starting over", () => {
    expect(() => pageDiff(SMALL, { cursor: "nonsense" })).toThrow(/Malformed cursor/);
    expect(() => pageDiff(SMALL, { cursor: "H9" })).toThrow(/not in this selection/);
  });
});

/** drain(), but over a fixed id selection — the cursor must not escape it. */
function drain2(diff: string, ids: string[], maxBytes: number): HunkSlice[] {
  const seen: HunkSlice[] = [];
  let cursor: string | undefined;
  for (let n = 0; n < 1_000; n++) {
    const page = pageDiff(diff, { cursor, ids, maxBytes });
    seen.push(...page.hunks);
    if (!page.next_cursor) return seen;
    cursor = page.next_cursor;
  }
  throw new Error("pager did not terminate");
}

describe("parseCursor", () => {
  it("reads a plain hunk id and an offset into one", () => {
    expect(parseCursor("H12")).toEqual({ id: "H12", offset: 0 });
    expect(parseCursor("H12:180")).toEqual({ id: "H12", offset: 180 });
    expect(parseCursor(undefined)).toEqual({ offset: 0 });
  });

  it("refuses shapes it cannot act on", () => {
    expect(() => parseCursor("12")).toThrow();
    expect(() => parseCursor("H12:-1")).toThrow();
    expect(() => parseCursor("H12:abc")).toThrow();
  });
});

describe("summarizeFiles", () => {
  it("rolls hunks up per file with a range, for when the per-hunk index will not fit", () => {
    expect(summarizeFiles(indexHunks(SMALL))).toEqual([
      { path: "src/app.ts", hunks: "H1-H2", count: 2, required: 2 },
      { path: "src/other.ts", hunks: "H3", count: 1, required: 1 },
    ]);
  });
});
