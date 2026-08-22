import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { validate } from "../src/index.js";
import { parseUnifiedDiff, newRange } from "../src/diff.js";
import { renderMarkdown, orderTour } from "../src/render.js";
import type { IntentDocument } from "@review-assist/schema";

const exampleUrl = new URL("../../schema/src/example.json", import.meta.url);
const example = JSON.parse(readFileSync(fileURLToPath(exampleUrl), "utf8")) as IntentDocument;

/** A unified diff whose hunks line up with the example document's anchors. */
const matchingDiff = `diff --git a/internal/auth/cache.go b/internal/auth/cache.go
--- /dev/null
+++ b/internal/auth/cache.go
@@ -0,0 +1,38 @@
+package auth
+// 38 new lines
diff --git a/internal/auth/redis_cache.go b/internal/auth/redis_cache.go
--- /dev/null
+++ b/internal/auth/redis_cache.go
@@ -0,0 +1,74 @@
+package auth
+// redis impl
diff --git a/internal/handlers/logout.go b/internal/handlers/logout.go
--- a/internal/handlers/logout.go
+++ b/internal/handlers/logout.go
@@ -21,4 +21,11 @@ func Logout() {
+	cache.Delete(token)
diff --git a/internal/auth/middleware.go b/internal/auth/middleware.go
--- a/internal/auth/middleware.go
+++ b/internal/auth/middleware.go
@@ -55,9 +55,9 @@ func mw() {
-	validateSession()
+	revalidateSession()
diff --git a/internal/handlers/checkout.go b/internal/handlers/checkout.go
--- a/internal/handlers/checkout.go
+++ b/internal/handlers/checkout.go
@@ -102,2 +102,2 @@ func co() {
-	validateSession()
+	revalidateSession()
`;

describe("diff parser", () => {
  it("parses files and hunk ranges", () => {
    const files = parseUnifiedDiff(matchingDiff);
    expect(files.map((f) => f.path)).toEqual([
      "internal/auth/cache.go",
      "internal/auth/redis_cache.go",
      "internal/handlers/logout.go",
      "internal/auth/middleware.go",
      "internal/handlers/checkout.go",
    ]);
    const logout = files.find((f) => f.path === "internal/handlers/logout.go")!;
    expect(newRange(logout.hunks[0])).toEqual([21, 31]);
    expect(logout.hunks[0].substantive).toBe(true);
  });

  it("handles deletions by keeping the pre-image path", () => {
    const del = `diff --git a/old.txt b/old.txt
--- a/old.txt
+++ /dev/null
@@ -1,3 +0,0 @@
-gone
`;
    const files = parseUnifiedDiff(del);
    expect(files[0].path).toBe("old.txt");
  });

  it("marks whitespace-only hunks as non-substantive", () => {
    const ws = `diff --git a/a.txt b/a.txt
--- a/a.txt
+++ b/a.txt
@@ -1,1 +1,2 @@
 keep
+
`;
    const files = parseUnifiedDiff(ws);
    expect(files[0].hunks[0].substantive).toBe(false);
  });
});

describe("validate — schema", () => {
  it("accepts the example document", () => {
    const report = validate(example);
    expect(report.findings.filter((f) => f.severity === "error")).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("rejects a document missing required sections", () => {
    const bad = { schema_version: "0.1", meta: {} };
    const report = validate(bad);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === "schema")).toBe(true);
  });

  it("rejects an unknown schema version", () => {
    const report = validate({ ...example, schema_version: "9.9" });
    expect(report.ok).toBe(false);
  });
});

describe("validate — staleness", () => {
  it("passes when head sha matches (prefix)", () => {
    const report = validate(example, { headSha: "4b8d0a3f9c1e" });
    expect(report.findings.some((f) => f.check === "staleness")).toBe(false);
  });

  it("fails when head sha differs", () => {
    const report = validate(example, { headSha: "deadbeef1234" });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === "staleness")).toBe(true);
  });
});

describe("validate — coverage", () => {
  it("reports full coverage when anchors match the diff", () => {
    const report = validate(example, { diff: matchingDiff });
    expect(report.coverage?.unexplained).toEqual([]);
    expect(report.coverage?.dangling).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("flags an unexplained substantive hunk", () => {
    const extra = matchingDiff + `diff --git a/internal/secret/backdoor.go b/internal/secret/backdoor.go
--- /dev/null
+++ b/internal/secret/backdoor.go
@@ -0,0 +1,5 @@
+package secret
+func Backdoor() {}
`;
    const report = validate(example, { diff: extra });
    expect(report.ok).toBe(false);
    expect(report.coverage?.unexplained.some((u) => u.path.includes("backdoor"))).toBe(true);
  });

  it("flags a dangling anchor as a warning (not a hard fail)", () => {
    // Diff omits the logout file that T3 anchors to.
    const partial = matchingDiff
      .split("diff --git a/internal/handlers/logout.go")[0];
    const report = validate(example, { diff: partial });
    // Missing hunks become unexplained→ok false, but dangling anchors are warnings.
    expect(report.coverage?.dangling.length).toBeGreaterThan(0);
    expect(report.coverage?.dangling.some((d) => d.path.includes("logout"))).toBe(true);
    // Dangling anchors are warnings, not the reason for failure.
    expect(report.findings.some((f) => f.check === "coverage" && f.severity === "warning")).toBe(true);
  });

  it("excludes .intent/ files from coverage (a document needn't explain itself)", () => {
    const withDoc = matchingDiff + `diff --git a/.intent/feature-x.json b/.intent/feature-x.json
--- /dev/null
+++ b/.intent/feature-x.json
@@ -0,0 +1,3 @@
+{
+  "schema_version": "0.1"
+}
`;
    const report = validate(example, { diff: withDoc });
    expect(report.ok).toBe(true);
    expect(report.coverage?.unexplained.some((u) => u.path.startsWith(".intent/"))).toBe(false);
  });

  it("ignores whitespace-only unexplained hunks unless --strict", () => {
    const wsExtra = matchingDiff + `diff --git a/format.go b/format.go
--- a/format.go
+++ b/format.go
@@ -10,0 +11,1 @@
+
`;
    expect(validate(example, { diff: wsExtra }).ok).toBe(true);
    expect(validate(example, { diff: wsExtra, strictCoverage: true }).ok).toBe(false);
  });
});

describe("validate — cross refs", () => {
  it("fails on assumption depending on a nonexistent tour stop", () => {
    const doc = structuredClone(example);
    doc.assumptions[0].depends = ["T999"];
    const report = validate(doc);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === "cross_refs")).toBe(true);
  });

  it("fails on a parent cycle / self-parent", () => {
    const doc = structuredClone(example);
    doc.tour[0].parent = doc.tour[0].id;
    expect(validate(doc).ok).toBe(false);
  });

  it("fails on duplicate tour ids", () => {
    const doc = structuredClone(example);
    doc.tour[1].id = doc.tour[0].id;
    expect(validate(doc).ok).toBe(false);
  });
});

describe("validate — redaction", () => {
  it("fails when a secret leaks into a field", () => {
    const doc = structuredClone(example);
    doc.problem.statement += " AKIAIOSFODNN7EXAMPLE";
    const report = validate(doc);
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === "redaction")).toBe(true);
  });

  it("catches connection strings with inline credentials", () => {
    const doc = structuredClone(example);
    doc.approach.adopted.summary += " redis://user:hunter2@cache.internal:6379";
    expect(validate(doc).ok).toBe(false);
  });
});

describe("render", () => {
  it("orders the tour depth-first by parent", () => {
    const ordered = orderTour(example.tour);
    const ids = ordered.map((t) => t.id);
    // T1 (root) → T2 (child) → T3 (grandchild), T4 (root) somewhere after its own subtree.
    expect(ids.indexOf("T1")).toBeLessThan(ids.indexOf("T2"));
    expect(ids.indexOf("T2")).toBeLessThan(ids.indexOf("T3"));
    expect(ids).toContain("T4");
    expect(ids.length).toBe(example.tour.length);
  });

  it("produces markdown containing the problem, assumptions, and tour", () => {
    const md = renderMarkdown(example, { viewerUrl: "https://viewer.example/#x" });
    expect(md).toContain("Intent Document");
    expect(md).toContain("Assumptions");
    expect(md).toContain("A1");
    expect(md).toContain("Guided tour");
    expect(md).toContain("Open guided review");
    expect(md).toContain("Not verified");
  });
});

/**
 * The server stamps meta.interview from summarizeRun, and the schema is
 * additionalProperties:false — so the two must agree field for field. They did not: adding
 * author_attested and unanswered to the summary made EVERY submit fail validation, on a
 * document that was otherwise correct. Caught by a reviewer reading the diff cold, which is
 * later than it should have been. This is the check that makes the coupling explicit.
 */
describe("meta.interview and the run summary agree", () => {
  it("accepts every field the server stamps", () => {
    const doc = JSON.parse(
      readFileSync(".intent/fix-deterministic-distillation.json", "utf8")
    );
    doc.meta.interview = {
      rounds: 20,
      questions_asked: 20,
      unresolved: 0,
      author_attested: 20,
      unanswered: 0,
    };
    const report = validate(doc, { diff: "", headSha: doc.meta.commit_range.head_sha });
    expect(report.findings.filter((f) => JSON.stringify(f).includes("interview"))).toEqual([]);
  });
});


/**
 * An anchor into the intent document's own file used to be reported as dangling, because
 * the coverage loop skipped that file before anchor matching ever ran. The id came from
 * `compute_diff`'s own hunk index, so the warning accused the server's own output of being
 * a stale hand-copied anchor. Excluding `.intent/` from COVERAGE is right; excluding it
 * from MATCHING was the defect.
 */
describe("anchors into the intent document's own file", () => {
  const diff = [
    "diff --git a/.intent/main.json b/.intent/main.json",
    "--- /dev/null",
    "+++ b/.intent/main.json",
    "@@ -0,0 +1,3 @@",
    "+{",
    '+  "schema_version": "0.1"',
    "+}",
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,3 @@",
    " const a = 1;",
    "+const b = 2;",
    " export { a };",
    "",
  ].join("\n");

  const anchoredAt = (path: string, new_start: number, new_lines: number) => ({
    path,
    hunk: { old_start: 0, old_lines: 0, new_start, new_lines },
  });

  /** The example document with its tour replaced by one stop carrying these anchors. */
  const coverageOf = (d: string, anchors: ReturnType<typeof anchoredAt>[]) => {
    const doc = JSON.parse(JSON.stringify(example));
    doc.tour = [
      {
        id: "T1",
        title: "Only stop",
        role: "core",
        what: "changes",
        why: "reason",
        anchors,
        provenance: "from_transcript",
      },
    ];
    doc.verification.added_tests = [];
    return validate(doc, { diff: d }).coverage!;
  };

  it("does not report an anchor into .intent/ as dangling", () => {
    const report = coverageOf(diff, [
      anchoredAt(".intent/main.json", 1, 3),
      anchoredAt("src/a.ts", 1, 3),
    ]);
    expect(report.dangling).toEqual([]);
  });
});
