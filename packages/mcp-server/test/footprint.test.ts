/**
 * The footprint answers one question: who else wrote this file?
 *
 * It exists because the author is allowed to say "the transcript does not cover this", and
 * sometimes the reason is that a different session wrote the hunk. These pin the three
 * things that make the answer trustworthy: a path recorded by an agent is comparable to a
 * path in a diff, a file written through the shell is found at all, and the session that
 * produced a change outranks the one that merely worked nearby.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractPaths } from "../src/transcript/text.js";
import {
  scanSession,
  toRepoRelative,
  rankMatches,
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

  it("survives a repo path containing a space", () => {
    expect(toRepoRelative("/w/engagement apps/r/src/a.ts", "/w/engagement apps/r")).toBe("src/a.ts");
  });
});

describe("extractPaths", () => {
  it("finds a path past the 200-character summary cap", () => {
    // The reason this function exists. `oneLine` caps a command summary at 200 characters,
    // and a heredoc writes its file well after that — so a footprint built from summaries
    // finds nothing. Measured on this repository, spine.ts appears in 15 Bash calls and in
    // none of their summaries.
    const cmd = `python3 - <<'PY'\n${"# padding\n".repeat(40)}p="packages/mcp-server/src/spine.ts"\nopen(p,"w").write(s)\nPY`;
    expect(cmd.indexOf("packages/mcp-server/src/spine.ts")).toBeGreaterThan(200);
    expect(extractPaths(cmd)).toContain("packages/mcp-server/src/spine.ts");
  });

  it("finds the target of a redirect and of sed -i", () => {
    expect(extractPaths("cat > apps/viewer/index.html <<'EOF'")).toContain("apps/viewer/index.html");
    expect(extractPaths("sed -i '' s/a/b/ packages/schema/src/index.ts")).toContain(
      "packages/schema/src/index.ts"
    );
  });

  it("skips dependency paths and urls, which are never the change under review", () => {
    const got = extractPaths("npm i && curl https://x.dev/a.json && cat node_modules/zod/index.js");
    expect(got.some((p) => p.includes("node_modules/"))).toBe(false);
    expect(got.some((p) => p.startsWith("http"))).toBe(false);
  });

  it("returns nothing for a command that names no file", () => {
    expect(extractPaths("npm test -- --silent")).toEqual([]);
  });
});

describe("scanSession", () => {
  it("records an Edit as edited and a Bash path as mentioned", () => {
    // The two tiers are kept apart because an edit is evidence the file was written while a
    // mention may be a read, and because the strong signal is usually absent: in this
    // repository spine.ts has zero edit events across every session on disk.
    const p = write("mixed.jsonl", [
      use("Edit", { file_path: "/repo/src/a.ts" }),
      use("Bash", { command: "sed -n '1,20p' src/b.ts" }),
    ]);
    const fp = scanSession(p, REPO);
    expect(fp.edited).toEqual({ "src/a.ts": 1 });
    expect(fp.mentioned).toEqual({ "src/b.ts": 1 });
  });

  it("counts repeat contact with the same file", () => {
    const p = write("repeat.jsonl", [
      use("Edit", { file_path: "/repo/src/a.ts" }),
      use("Edit", { file_path: "/repo/src/a.ts" }),
    ]);
    expect(scanSession(p, REPO).edited).toEqual({ "src/a.ts": 2 });
  });

  it("drops files outside the repo", () => {
    const p = write("outside.jsonl", [
      use("Edit", { file_path: "/other/src/z.ts" }),
      use("Bash", { command: "cat /private/tmp/scratch/notes.md" }),
    ]);
    const fp = scanSession(p, REPO);
    expect(fp.edited).toEqual({});
    expect(fp.mentioned).toEqual({});
  });

  it("reads a Codex patch summary as an edit", () => {
    const p = write("codex.jsonl", [
      { payload: { type: "patch_apply_end", stdout: "Updated:\nM /repo/src/a.ts" } },
    ]);
    expect(scanSession(p, REPO).edited).toEqual({ "src/a.ts": 1 });
  });

  it("ignores a line it cannot parse rather than failing the scan", () => {
    const p = join(dir, "broken.jsonl");
    writeFileSync(p, `{"message":{bad json\n${JSON.stringify(use("Edit", { file_path: "/repo/src/a.ts" }))}\n`);
    expect(scanSession(p, REPO).edited).toEqual({ "src/a.ts": 1 });
  });
});

describe("rankMatches", () => {
  const fp = (edited: Record<string, number>, mentioned: Record<string, number>, mtime: number): SessionFootprint => ({
    size: 1,
    mtime,
    edited,
    mentioned,
  });

  it("puts full coverage of the change ahead of a busier session", () => {
    // Measured on commit 05c90a4 (ten files): the session committed the next day covers
    // 10/10 with no edit events, a later and busier session covers 8/10 with eleven. The
    // first is the one that made the change, so coverage has to outrank edit volume.
    const ranked = rankMatches(
      {
        "/s/busy.jsonl": fp({ "a.ts": 9, "b.ts": 9 }, {}, 2000),
        "/s/whole.jsonl": fp({}, { "a.ts": 1, "b.ts": 1, "c.ts": 1 }, 1000),
      },
      ["a.ts", "b.ts", "c.ts"]
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/whole.jsonl", "/s/busy.jsonl"]);
    expect(ranked[0].covered).toBe(3);
  });

  it("prefers an edit to a mention at equal coverage", () => {
    const ranked = rankMatches(
      {
        "/s/mentioned.jsonl": fp({}, { "a.ts": 50 }, 2000),
        "/s/edited.jsonl": fp({ "a.ts": 1 }, {}, 1000),
      },
      ["a.ts"]
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/edited.jsonl", "/s/mentioned.jsonl"]);
  });

  it("breaks a full tie on recency, the session that had the last word", () => {
    const ranked = rankMatches(
      { "/s/old.jsonl": fp({ "a.ts": 1 }, {}, 1000), "/s/new.jsonl": fp({ "a.ts": 1 }, {}, 2000) },
      ["a.ts"]
    );
    expect(ranked.map((m) => m.path)).toEqual(["/s/new.jsonl", "/s/old.jsonl"]);
  });

  it("omits a session that touched none of the files asked about", () => {
    const ranked = rankMatches({ "/s/other.jsonl": fp({ "z.ts": 4 }, {}, 1000) }, ["a.ts"]);
    expect(ranked).toEqual([]);
  });

  it("excludes the session the author has already read", () => {
    // The question is always "who ELSE wrote this". Returning the current session answers
    // it with the transcript that just came up empty.
    const footprints = {
      "/s/mine.jsonl": fp({ "a.ts": 5 }, {}, 2000),
      "/s/theirs.jsonl": fp({ "a.ts": 1 }, {}, 1000),
    };
    const ranked = rankMatches(footprints, ["a.ts"], { exclude: ["/s/mine.jsonl"] });
    expect(ranked.map((m) => m.path)).toEqual(["/s/theirs.jsonl"]);
  });

  it("reports only the files that were asked about", () => {
    const ranked = rankMatches({ "/s/a.jsonl": fp({ "a.ts": 1, "unrelated.ts": 9 }, {}, 1000) }, ["a.ts"]);
    expect(ranked[0].edited).toEqual({ "a.ts": 1 });
    expect(ranked[0].edits).toBe(1);
  });
});
