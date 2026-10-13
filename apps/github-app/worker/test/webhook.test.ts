import { describe, expect, it } from "vitest";
import { readDocument } from "../src/webhook.js";

const LINK = "https://reviewassist.dev/#o/r/pull/1";
const DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,1 +1,2 @@",
  " const a = 1;",
  "+const b = 2;",
  "",
].join("\n");
const anchored = {
  problem: { statement: "Add b." },
  tour: [{ id: "T1", anchors: [{ path: "src/a.ts", hunk: { old_start: 1, old_lines: 1, new_start: 1, new_lines: 2 } }] }],
};

describe("readDocument", () => {
  it("counts coverage and renders the review for a well-formed document", () => {
    const r = readDocument(false, anchored, DIFF, LINK);
    expect(r.state).toBe("found");
    expect(r.cov).toEqual({ total: 1, explained: 1 });
    expect(r.comment).toContain("1 of 1 changes explained");
    expect(r.prSection).not.toBeNull();
  });

  it("reports a missing document as missing", () => {
    const r = readDocument(true, null, null, LINK);
    expect(r.state).toBe("missing");
    expect(r.comment).toContain("No Intent Document was found");
  });

  it("reports JSON that did not parse as unreadable", () => {
    expect(readDocument(false, null, null, LINK).state).toBe("unreadable");
  });

  // These used to throw past the check and the comment, so the PR got neither.
  it.each([
    ["tour is an object", { ...anchored, tour: {} }],
    ["assumptions is an object", { ...anchored, assumptions: {} }],
    ["not_verified is a string", { ...anchored, verification: { not_verified: "x" } }],
    ["the document is an array", [anchored]],
  ])("reports a document whose %s as unreadable, not as a crash", (_, doc) => {
    const r = readDocument(false, doc, DIFF, LINK);
    expect(r.state).toBe("unreadable");
    expect(r.comment).toContain("not a readable Intent Document");
    expect(r.prSection).toBeNull();
  });
});
