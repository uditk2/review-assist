/**
 * Who wrote this hunk, in two steps.
 *
 * STEP 1 narrows to the sessions that named the hunk's files; STEP 2 decides which of them
 * actually wrote its lines. These pin what makes each step trustworthy: step 1 must not
 * claim another repository's file, must find a file written through the shell at all, and
 * must rank whole coverage first; step 2 must tell writing from reading, which is the only
 * thing that separates the session that made a change from the three that merely read it.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPaths } from "../src/transcript/text.js";
import {
  addedLines,
  narrow,
  scanSession,
  toRepoRelative,
  whoWrote,
  type SessionFootprint,
} from "../src/footprint.js";

const dir = mkdtempSync(join(tmpdir(), "review-assist-footprint-"));
const REPO = "/repo";
const write = (name: string, entries: unknown[]) => {
  const p = join(dir, name);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
};
const use = (name: string, input: unknown) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});
const got = (text: string) => ({
  type: "user",
  message: { role: "user", content: [{ type: "tool_result", content: text }] },
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("toRepoRelative", () => {
  it("relativizes an absolute path inside the repo", () => {
    expect(toRepoRelative("/repo/src/a.ts", REPO)).toBe("src/a.ts");
  });

  it("drops an absolute path outside the repo rather than guessing", () => {
    // A real edit to somewhere else: another checkout, a scratchpad, a dotfile. Keeping it
    // would let one repo's session claim another repo's file.
    expect(toRepoRelative("/elsewhere/src/a.ts", REPO)).toBeNull();
    expect(toRepoRelative("/private/tmp/scratch/x.mjs", REPO)).toBeNull();
  });

  it("keeps a relative path, normalized", () => {
    expect(toRepoRelative("src/a.ts", REPO)).toBe("src/a.ts");
    expect(toRepoRelative("./src/a.ts", REPO)).toBe("src/a.ts");
  });

  it("refuses a relative path when the session did not run in this repo", () => {
    // Session discovery reaches sessions whose cwd is an ancestor directory holding several
    // checkouts, and those edit sibling repos with paths like `src/index.ts`.
    expect(toRepoRelative("src/a.ts", REPO, { allowRelative: false })).toBeNull();
  });

  it("survives a repo path containing a space", () => {
    expect(toRepoRelative("/w/engagement apps/r/src/a.ts", "/w/engagement apps/r")).toBe("src/a.ts");
  });
});

describe("extractPaths", () => {
  it("finds a path past the 200-character summary cap", () => {
    // The reason this exists. `oneLine` caps a command summary at 200 characters and a
    // heredoc writes its file well after that, so a footprint built from summaries finds
    // nothing: spine.ts appears in 15 Bash calls here and in none of their summaries.
    const cmd = "python3 - <<PY\n" + "# padding\n".repeat(40) + 'p="packages/mcp-server/src/spine.ts"\nPY';
    expect(cmd.indexOf("packages/mcp-server/src/spine.ts")).toBeGreaterThan(200);
    expect(extractPaths(cmd)).toContain("packages/mcp-server/src/spine.ts");
  });

  it("finds the target of a redirect and of sed -i", () => {
    expect(extractPaths("cat > apps/viewer/index.html <<EOF")).toContain("apps/viewer/index.html");
    expect(extractPaths("sed -i '' s/a/b/ packages/schema/src/index.ts")).toContain(
      "packages/schema/src/index.ts"
    );
  });

  it("keeps an absolute path absolute, so the repo filter can reject it", () => {
    // Stripping the leading slash turned an out-of-repo path into a plausible relative one
    // that then passed the repo check. Scratchpads polluted every footprint.
    expect(extractPaths("cat /private/tmp/scratch/notes.md")).toContain("/private/tmp/scratch/notes.md");
  });

  it("skips dependency paths and urls, which are never the change under review", () => {
    const paths = extractPaths("npm i && curl https://x.dev/a.json && cat node_modules/zod/index.js");
    expect(paths.some((p) => p.includes("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("http"))).toBe(false);
  });

  it("returns nothing for a command that names no file", () => {
    expect(extractPaths("npm test -- --silent")).toEqual([]);
  });
});

describe("scanSession (step 1)", () => {
  it("counts an Edit and a Bash path the same way", () => {
    // Step 1 does not rank an Edit above a shell mention, and cannot afford to: spine.ts
    // has zero Edit-tool writes across every session on disk, because the work here is done
    // through heredocs. Both mean "this session named the file"; step 2 decides who wrote.
    const p = write("mixed.jsonl", [
      use("Edit", { file_path: "/repo/src/a.ts" }),
      use("Bash", { command: "sed -n '1,20p' src/b.ts" }),
    ]);
    expect(scanSession(p, REPO).touched).toEqual({ "src/a.ts": 1, "src/b.ts": 1 });
  });

  it("counts repeat contact with the same file", () => {
    const p = write("repeat.jsonl", [
      use("Edit", { file_path: "/repo/src/a.ts" }),
      use("Edit", { file_path: "/repo/src/a.ts" }),
    ]);
    expect(scanSession(p, REPO).touched).toEqual({ "src/a.ts": 2 });
  });

  it("drops files outside the repo", () => {
    const p = write("outside.jsonl", [
      use("Edit", { file_path: "/other/src/z.ts" }),
      use("Bash", { command: "cat /private/tmp/scratch/notes.md" }),
    ]);
    expect(scanSession(p, REPO).touched).toEqual({});
  });

  it("reads a Codex patch summary as contact with the file", () => {
    const p = write("codex.jsonl", [
      { payload: { type: "patch_apply_end", stdout: "Updated:\nM /repo/src/a.ts" } },
    ]);
    expect(scanSession(p, REPO).touched).toEqual({ "src/a.ts": 1 });
  });

  it("ignores a line it cannot parse rather than failing the scan", () => {
    const p = join(dir, "broken.jsonl");
    writeFileSync(p, '{"message":{bad json\n' + JSON.stringify(use("Edit", { file_path: "/repo/src/a.ts" })) + "\n");
    expect(scanSession(p, REPO).touched).toEqual({ "src/a.ts": 1 });
  });
});

describe("narrow (step 1 ranking)", () => {
  const fp = (touched: Record<string, number>, mtime: number): SessionFootprint => ({
    size: 1,
    mtime,
    touched,
  });

  it("puts full coverage of the change ahead of a busier session", () => {
    // Measured on commit 05c90a4 (ten files): the session committed the next day covers
    // 10/10 while a later, busier session covers 8/10. The first made the change, so
    // coverage has to outrank volume.
    const ranked = narrow(
      {
        "/s/busy.jsonl": fp({ "a.ts": 9, "b.ts": 9 }, 2000),
        "/s/whole.jsonl": fp({ "a.ts": 1, "b.ts": 1, "c.ts": 1 }, 1000),
      },
      ["a.ts", "b.ts", "c.ts"]
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/whole.jsonl", "/s/busy.jsonl"]);
    expect(ranked[0].covered).toBe(3);
  });

  it("breaks a coverage tie on recency, the session that had the last word", () => {
    const ranked = narrow(
      { "/s/old.jsonl": fp({ "a.ts": 1 }, 1000), "/s/new.jsonl": fp({ "a.ts": 1 }, 2000) },
      ["a.ts"]
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/new.jsonl", "/s/old.jsonl"]);
  });

  it("omits a session that touched none of the files asked about", () => {
    expect(narrow({ "/s/other.jsonl": fp({ "z.ts": 4 }, 1000) }, ["a.ts"])).toEqual([]);
  });

  it("excludes the session the author has already read", () => {
    // The question is always "who ELSE wrote this". Returning the current session answers
    // it with the transcript that just came up empty.
    const ranked = narrow(
      { "/s/mine.jsonl": fp({ "a.ts": 5 }, 2000), "/s/theirs.jsonl": fp({ "a.ts": 1 }, 1000) },
      ["a.ts"],
      { exclude: ["/s/mine.jsonl"] }
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/theirs.jsonl"]);
  });
});

describe("addedLines", () => {
  const long = (s: string) => s.padEnd(48, "-");

  it("keeps added lines and drops removed ones", () => {
    // A removed line existed before the change, so every session that ever read the file
    // contains it. Matching on one would attribute the hunk to all of them.
    const hunk = "@@ -1,2 +1,2 @@\n-" + long("const old = 1;") + "\n+" + long("const neu = 2;");
    expect(addedLines(hunk)).toEqual([long("const neu = 2;")]);
  });

  it("drops lines too short to identify a hunk", () => {
    expect(addedLines("@@ -1 +1 @@\n+});\n+\n+let x = 1;")).toEqual([]);
  });

  it("never mistakes the +++ file header for an added line", () => {
    expect(addedLines("+++ b/" + long("packages/some/path.ts"))).toEqual([]);
  });

  it("caps how many lines one query matches on", () => {
    const body = Array.from({ length: 50 }, (_, i) => "+" + long("line " + i + " of hunk;")).join("\n");
    expect(addedLines(body, 5)).toHaveLength(5);
  });
});

describe("whoWrote (step 2)", () => {
  const LINE = "const seededStandingQuestionsAreNotPartOfABatch = true;";

  it("counts a line in a tool INPUT as authored", () => {
    const p = write("wrote.jsonl", [use("Write", { file_path: "/repo/src/a.ts", content: LINE })]);
    expect(whoWrote(p, [LINE])).toEqual({ authored: 1, observed: 0 });
  });

  it("counts the same line in tool OUTPUT as only observed", () => {
    // The whole discriminator. Measured on commit 05c90a4, three sessions matched 19 to 23
    // of its added lines purely this way, having only ever read the file.
    const p = write("read.jsonl", [got(LINE)]);
    expect(whoWrote(p, [LINE])).toEqual({ authored: 0, observed: 1 });
  });

  it("finds a line written inside a heredoc, not just through the Edit tool", () => {
    // Why step 2 does not rely on Edit-tool fields: in this repository the writes happen
    // in shell scripts, where the content sits in the command string.
    const cmd = "python3 - <<PY\n" + "# padding\n".repeat(30) + "out.write(" + JSON.stringify(LINE) + ")\nPY";
    const p = write("heredoc.jsonl", [use("Bash", { command: cmd })]);
    expect(whoWrote(p, [LINE]).authored).toBe(1);
  });

  it("matches a line containing a quote, which the transcript stores escaped", () => {
    // A raw substring search over the JSONL misses exactly these: a first attempt found
    // three of four probe lines and missed the one with a quoted import.
    const quoted = 'import type { Meta } from "@review-assist/schema";';
    const p = write("quoted.jsonl", [use("Write", { file_path: "/repo/src/a.ts", content: quoted })]);
    expect(whoWrote(p, [quoted])).toEqual({ authored: 1, observed: 0 });
  });

  it("credits a write over a later read of the same line", () => {
    const p = write("both.jsonl", [
      use("Write", { file_path: "/repo/src/a.ts", content: LINE }),
      got(LINE),
    ]);
    expect(whoWrote(p, [LINE])).toEqual({ authored: 1, observed: 0 });
  });

  it("counts each line once however often it recurs", () => {
    const p = write("repeats.jsonl", [
      use("Write", { file_path: "/repo/src/a.ts", content: LINE }),
      use("Edit", { file_path: "/repo/src/a.ts", new_string: LINE }),
    ]);
    expect(whoWrote(p, [LINE])).toEqual({ authored: 1, observed: 0 });
  });

  it("reads a Codex call input as authored and its stdout as observed", () => {
    const wrote = write("cx-wrote.jsonl", [{ payload: { type: "custom_tool_call", input: LINE } }]);
    const read = write("cx-read.jsonl", [{ payload: { type: "patch_apply_end", stdout: LINE } }]);
    expect(whoWrote(wrote, [LINE]).authored).toBe(1);
    expect(whoWrote(read, [LINE])).toEqual({ authored: 0, observed: 1 });
  });

  it("returns nothing when there are no lines to match", () => {
    const p = write("empty.jsonl", [use("Write", { file_path: "/repo/src/a.ts", content: LINE })]);
    expect(whoWrote(p, [])).toEqual({ authored: 0, observed: 0 });
  });
});
