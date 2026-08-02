/**
 * Locating a session is a different problem from reading one, and it varies by
 * environment rather than by format. These pin the registry's contract and the one
 * environment that has no home on this machine at all.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SOURCES, findSessions, encodeRepoDir, exportedSessionsDir } from "../src/transcript/sources.js";
import { importSession, listImported, forgetImported } from "../src/transcript/export.js";

const scratch = mkdtempSync(join(tmpdir(), "review-assist-src-"));
const repo = join(scratch, "my-repo");
mkdirSync(repo, { recursive: true });
process.env.REVIEW_ASSIST_HOME = join(scratch, "home");
process.env.CLAUDE_CONFIG_DIR = join(scratch, "claude");
process.env.CODEX_HOME = join(scratch, "codex");

const container = join(scratch, "container-export.jsonl");
writeFileSync(container, JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "first ask" }] } }) + "\n");

beforeEach(() => rmSync(exportedSessionsDir(repo), { recursive: true, force: true }));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("the source registry", () => {
  it("covers each environment exactly once", () => {
    expect(SOURCES.map((s) => s.env)).toEqual(["claude-code", "codex", "cowork-local", "exported"]);
  });

  it("asks every source and returns nothing when none has anything", () => {
    expect(findSessions(repo)).toEqual([]);
  });
});

describe("importing a session with no home on this machine", () => {
  it("files it where the exported source will find it", () => {
    const res = importSession({ repo, from: container, sessionId: "cse-abc" });
    expect(res.stored_path).toBe(join(exportedSessionsDir(repo), "cse-abc.jsonl"));
    expect(res.overwrote).toBe(false);
    // The env comes from the source that found it, not from parsing the path.
    expect(findSessions(repo).map((x) => [x.path, x.env])).toEqual([[res.stored_path, "exported"]]);
  });

  it("overwrites on re-import, because a live session keeps growing", () => {
    importSession({ repo, from: container, sessionId: "cse-abc" });
    const grown = join(scratch, "grown.jsonl");
    writeFileSync(grown, readFileSync(container, "utf8") + JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "later ask" }] } }) + "\n");
    const second = importSession({ repo, from: grown, sessionId: "cse-abc" });

    expect(second.overwrote).toBe(true);
    expect(listImported(repo)).toHaveLength(1);
    expect(readFileSync(second.stored_path, "utf8")).toContain("later ask");
  });

  it("keeps repos apart", () => {
    const other = join(scratch, "other-repo");
    mkdirSync(other, { recursive: true });
    importSession({ repo, from: container, sessionId: "cse-abc" });
    expect(findSessions(other)).toEqual([]);
    expect(encodeRepoDir(repo)).not.toBe(encodeRepoDir(other));
  });

  it("refuses a source file that is not there", () => {
    expect(() => importSession({ repo, from: join(scratch, "nope.jsonl") })).toThrow(/no such file/);
  });

  it("names the store from the file when no id is given, and can forget it", () => {
    const res = importSession({ repo, from: container });
    expect(res.session_id).toBe("container-export");
    expect(forgetImported(repo, "container-export")).toBe(true);
    expect(existsSync(res.stored_path)).toBe(false);
  });
});
