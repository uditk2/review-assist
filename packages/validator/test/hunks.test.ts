/**
 * Hunk ids exist so a tour stop can say "H7" instead of four line numbers a reviewer had
 * to copy by hand — 37 of them in one real document, with a wrong one costing a full
 * re-emission. The ids are assigned in exactly one place; these pin what that place does.
 */

import { describe, it, expect } from "vitest";
import { indexHunks, parseUnifiedDiff } from "../src/index.js";

const DIFF = `diff --git a/src/app.ts b/src/app.ts
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
diff --git a/.intent/feat-x.json b/.intent/feat-x.json
--- a/.intent/feat-x.json
+++ b/.intent/feat-x.json
@@ -1,1 +1,2 @@
+{ "schema_version": "0.1" }
diff --git a/spacer.txt b/spacer.txt
--- a/spacer.txt
+++ b/spacer.txt
@@ -9,1 +9,2 @@
+
`;

describe("indexHunks", () => {
  const hunks = indexHunks(DIFF);

  it("numbers every hunk in diff order, including ones no stop must explain", () => {
    // Positional numbering: counting hunks while reading the raw diff gives the same
    // answer as the index. Skipping the excluded ones would make the two disagree.
    expect(hunks.map((h) => h.id)).toEqual(["H1", "H2", "H3", "H4"]);
  });

  it("is stable across calls, so an id means the same thing at submit as at compute", () => {
    expect(indexHunks(DIFF).map((h) => `${h.id}:${h.path}:${h.new_start}`)).toEqual(
      hunks.map((h) => `${h.id}:${h.path}:${h.new_start}`)
    );
  });

  it("carries the line numbers the anchor needs", () => {
    expect(hunks[0]).toMatchObject({
      id: "H1",
      path: "src/app.ts",
      old_start: 45,
      old_lines: 7,
      new_start: 45,
      new_lines: 9,
    });
  });

  it("previews the first added line", () => {
    expect(hunks[1].preview).toBe("render() {}");
  });

  it("gives every substantive hunk a preview", () => {
    for (const h of hunks.filter((x) => x.substantive)) {
      expect(h.preview, `${h.id} (${h.path}) has no preview`).toBeTruthy();
    }
  });

  it("excludes the intent document's own file from coverage", () => {
    const intent = hunks.find((h) => h.path.startsWith(".intent/"))!;
    expect(intent.substantive).toBe(true);
    expect(intent.coverage_required).toBe(false);
  });

  it("excludes whitespace-only hunks from coverage", () => {
    const blank = hunks.find((h) => h.path === "spacer.txt")!;
    expect(blank.substantive).toBe(false);
    expect(blank.coverage_required).toBe(false);
  });

  it("marks real code changes as requiring coverage", () => {
    expect(hunks.filter((h) => h.coverage_required).map((h) => h.id)).toEqual(["H1", "H2"]);
  });

  it("leaves the existing parser's output unchanged", () => {
    expect(parseUnifiedDiff(DIFF).map((f) => f.path)).toEqual([
      "src/app.ts",
      ".intent/feat-x.json",
      "spacer.txt",
    ]);
  });
});
