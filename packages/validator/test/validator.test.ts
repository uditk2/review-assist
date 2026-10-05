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
    expect(md).toContain("Guided tour");
    expect(md).toContain("Open guided review");
    expect(md).toContain("Not verified");
  });
});

/**
 * The front page is the LIVE set.
 *
 * Measured across the eleven documents in `.intent/`: 68 assumptions, of which 30 are
 * `grounded_in_code` and 10 `confirmed_by_user`. Those 40 are settled, and they are mostly
 * the agent scoping the DOCUMENT rather than describing the code — "Cloudflare is a
 * deployment detail and should not appear in this view" is not something anyone reviews.
 * Rendering them cost the reader time to conclude there was nothing to do, and `confidence`
 * as an italic aside was not enough to tell them apart.
 */
describe("renderMarkdown shows only what is still live", () => {
  const settled = example.assumptions.find((a) => a.confidence !== "unverified")!;
  const live = example.assumptions.find((a) => a.confidence === "unverified")!;

  it("keeps an unverified assumption and drops a settled one", () => {
    const md = renderMarkdown(example);
    expect(md).toContain(live.assumption);
    expect(md).not.toContain(settled.assumption);
  });

  it("drops the whole assumptions section when every one is settled", () => {
    const doc = structuredClone(example);
    for (const a of doc.assumptions) a.confidence = "grounded_in_code";
    const md = renderMarkdown(doc);
    expect(md).not.toContain("review these first");
  });

  it("stops labelling confidence, because everything shown is unverified", () => {
    // The label existed to tell settled from unsettled in one list. With one list there is
    // nothing to tell apart, and the label was how the settled ones justified being there.
    expect(renderMarkdown(example)).not.toContain("grounded in code");
  });

  it("gives what was never exercised its own section near the top", () => {
    // It used to be the last thing before the footer while settled assumptions led the
    // document. Authors report what passed and go quiet about this half, so it leads now.
    const md = renderMarkdown(example);
    const notVerified = md.indexOf("Not verified");
    const tour = md.indexOf("Guided tour");
    expect(notVerified).toBeGreaterThan(-1);
    expect(notVerified).toBeLessThan(tour);
  });
});

/**
 * `evaluated` is a lookup, not reading: an answered, grounded question is no longer a
 * question, so it must not spend the reader's minute — but discarded it is worse than
 * useless, because a reviewer will re-derive an answer somebody already has.
 */
describe("renderMarkdown renders the evaluated lookup", () => {
  const withEvaluated = () => {
    const doc = structuredClone(example);
    (doc as IntentDocument).evaluated = [
      { question: "Can a service outside DEPLOY_ORDER be dispatched?", answer: "- No, the input is type: choice.", anchors: ["H4"] },
      { question: "Was the Compose version on the VM checked?", answer: "- Yes, v5.1 supports --wait." },
    ];
    return doc;
  };

  it("collapses it behind a disclosure rather than putting it in the reading path", () => {
    const md = renderMarkdown(withEvaluated());
    expect(md).toContain("<details>");
    expect(md).toContain("Already evaluated (2)");
  });

  it("carries the question, the answer and the hunk that settles it", () => {
    const md = renderMarkdown(withEvaluated());
    expect(md).toContain("Can a service outside DEPLOY_ORDER be dispatched?");
    expect(md).toContain("No, the input is type: choice.");
    expect(md).toContain("(H4)");
  });

  it("omits the section entirely when the interview settled nothing", () => {
    const doc = structuredClone(example);
    delete (doc as IntentDocument).evaluated;
    expect(renderMarkdown(doc)).not.toContain("Already evaluated");
  });

  it("accepts an entry with no anchors, since old runs recorded none", () => {
    const md = renderMarkdown(withEvaluated());
    expect(md).toContain("Was the Compose version on the VM checked?");
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

/**
 * `unanswered` has to read as the STRONGEST finding, which inverts how this used to render.
 *
 * Measured across 32 runs, 67 of 279 diff-provoked questions got no reply of any kind, and
 * they include "env_file injects the ENTIRE backend env (DB password, LLM API keys, JWT
 * secret)" and "uses :latest while two comments state pinned behaviour". An unanswered
 * question about a code risk means the risk was never considered. A flat list of open
 * questions made that indistinguishable from an unanswered "why did you pick this name".
 */
describe("renderMarkdown weights the dispositions", () => {
  const withUnresolved = () => {
    const doc = structuredClone(example) as IntentDocument;
    doc.unresolved = [
      { question: "Is the unpinned image tag intentional?", disposition: "accepted_partial", note: "- Known. Pinning comes with the registry move." },
      { question: "Does env_file leak the whole backend env?", disposition: "unanswered", anchors: ["H3"] },
      { question: "Can two concurrent deletes interleave?", disposition: "escalated" },
    ];
    return doc;
  };

  it("puts what nobody answered first, ahead of decisions already taken", () => {
    const md = renderMarkdown(withUnresolved());
    const never = md.indexOf("Does env_file leak");
    const escalated = md.indexOf("Can two concurrent deletes");
    const accepted = md.indexOf("Is the unpinned image tag");
    expect(never).toBeLessThan(escalated);
    expect(escalated).toBeLessThan(accepted);
  });

  it("says which of the three happened, in words a reader can tell apart", () => {
    const md = renderMarkdown(withUnresolved());
    expect(md).toContain("Never answered — nobody considered this.");
    expect(md).toContain("The developer asked for your eyes here.");
    expect(md).toContain("Known and shipped anyway.");
  });

  it("carries the developer's reason and the hunk it concerns", () => {
    const md = renderMarkdown(withUnresolved());
    expect(md).toContain("Pinning comes with the registry move");
    expect(md).toContain("(H3)");
  });

  it("omits the section when the interview settled everything", () => {
    const doc = structuredClone(example) as IntentDocument;
    delete doc.unresolved;
    expect(renderMarkdown(doc)).not.toContain("Raised and not settled");
  });
});
