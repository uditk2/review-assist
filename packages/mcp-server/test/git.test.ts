/**
 * Which files count as a session.
 *
 * findTranscripts used to return <session>/subagents/agent-*.jsonl as peers of their own
 * parent, so the author could be handed one seventh of a delegated session with nothing
 * saying what it belonged to. A subagent is never a session: it receives its prompt from
 * the parent with no human in the loop, so it can hold no user ask and no agreed plan.
 */

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findTranscripts } from "../src/git.js";

const home = mkdtempSync(join(tmpdir(), "review-assist-git-"));
const repo = mkdtempSync(join(tmpdir(), "review-assist-repo-"));
const projects = join(home, "projects", resolve(repo).replace(/[/\\]/g, "-"));
mkdirSync(join(projects, "session-a", "subagents", "workflows", "wf_1"), { recursive: true });
writeFileSync(join(projects, "session-a.jsonl"), "{}\n");
writeFileSync(join(projects, "session-b.jsonl"), "{}\n");
writeFileSync(join(projects, "session-a", "subagents", "agent-1.jsonl"), "{}\n");
writeFileSync(join(projects, "session-a", "subagents", "workflows", "wf_1", "agent-2.jsonl"), "{}\n");
process.env.CLAUDE_CONFIG_DIR = home;

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

describe("findTranscripts", () => {
  const found = findTranscripts(repo).map((p) => p.replace(projects + "/", ""));

  it("returns the parent sessions", () => {
    expect(found.sort()).toEqual(["session-a.jsonl", "session-b.jsonl"]);
  });

  it("never offers a subagent transcript as a session", () => {
    expect(found.some((p) => p.includes("subagents"))).toBe(false);
  });

  it("honours an explicit override without second-guessing it", () => {
    const direct = join(projects, "session-a.jsonl");
    expect(findTranscripts(repo, direct)).toEqual([direct]);
  });
});
