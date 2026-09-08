/**
 * `.reviewer/` is the repository's own instruction folder for the reviewer role.
 *
 * The reviewer has no filesystem tools, so everything below is about what the SERVER hands
 * it: an absent folder must be an ordinary answer rather than an error, the listing must be
 * stable enough to cite, and a repo cannot blow the response budget by committing a large
 * folder: the reviewer that loses its `run_id` to a spilled result cannot submit anything.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readReviewerInstructions,
  summarizeReviewerInstructions,
  REVIEWER_DIR,
} from "../src/reviewer-instructions.js";

const scratch = mkdtempSync(join(tmpdir(), "review-assist-reviewer-"));
const repo = join(scratch, "repo");
const dir = join(repo, REVIEWER_DIR);

beforeEach(() => {
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("a repository with no house rules", () => {
  it("reports absence rather than failing", () => {
    const r = readReviewerInstructions(repo);
    expect(r.present).toBe(false);
    expect(r.sections).toEqual([]);
    expect(r.files).toEqual([]);
  });

  it("summarizes as absent, so compute_diff says nothing about it", () => {
    expect(summarizeReviewerInstructions(repo)).toEqual({ present: false, files: 0, bytes: 0 });
  });

  it("treats an empty folder as absent too, since nothing to relay is nothing to mention", () => {
    mkdirSync(dir, { recursive: true });
    expect(summarizeReviewerInstructions(repo).present).toBe(false);
  });

  it("agrees with the summary about an empty folder, so the two never contradict", () => {
    // They disagreed: the summary asked whether there was anything readable, the reader
    // asked only whether the directory existed. compute_diff then said absent while the
    // tool answered present with zero sections and a how_to_use line pointing at nothing.
    mkdirSync(dir, { recursive: true });
    const r = readReviewerInstructions(repo);
    expect(r.present).toBe(false);
    expect(r.present).toBe(summarizeReviewerInstructions(repo).present);
  });

  it("is absent when the folder holds nothing it can read, and still lists what is there", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "checklist.yaml"), "- ask about proration\n");
    const r = readReviewerInstructions(repo);
    expect(r.present).toBe(false);
    expect(r.files.map((f) => f.path)).toEqual(["checklist.yaml"]);
    expect(r.omitted).toEqual(["checklist.yaml"]);
  });
});

describe("reading the folder", () => {
  beforeEach(() => {
    mkdirSync(join(dir, "areas"), { recursive: true });
    writeFileSync(join(dir, "README.md"), "# House rules\nAsk about the migration.\n");
    writeFileSync(join(dir, "security.md"), "Ask who can reach the new endpoint.\n");
    writeFileSync(join(dir, "areas", "billing.md"), "Ask about proration.\n");
  });

  it("serves every readable file, folders included", () => {
    const r = readReviewerInstructions(repo);
    expect(r.present).toBe(true);
    expect(r.sections.map((s) => s.path)).toEqual(["README.md", "security.md", "areas/billing.md"]);
    expect(r.sections[0].content).toContain("Ask about the migration.");
  });

  it("orders files before folders and alphabetically within each, so a citation is stable", () => {
    writeFileSync(join(dir, "aaa.md"), "first alphabetically\n");
    const paths = readReviewerInstructions(repo).sections.map((s) => s.path);
    expect(paths).toEqual(["README.md", "aaa.md", "security.md", "areas/billing.md"]);
  });

  it("serves a named subset, for a reviewer going back for one omitted file", () => {
    const r = readReviewerInstructions(repo, { files: ["areas/billing.md"] });
    expect(r.sections.map((s) => s.path)).toEqual(["areas/billing.md"]);
    expect(r.omitted).toContain("security.md");
  });

  it("accepts the path a reviewer would naturally type, with the folder prefix on it", () => {
    const r = readReviewerInstructions(repo, { files: [".reviewer/security.md"] });
    expect(r.sections.map((s) => s.path)).toEqual(["security.md"]);
  });

  it("lists a non-markdown file but does not read it", () => {
    writeFileSync(join(dir, "checklist.yaml"), "- ask about proration\n");
    const r = readReviewerInstructions(repo);
    expect(r.files.find((f) => f.path === "checklist.yaml")!.readable).toBe(false);
    expect(r.omitted).toContain("checklist.yaml");
    expect(r.sections.map((s) => s.path)).not.toContain("checklist.yaml");
  });

  it("gives an extensionless file no extension, rather than its last character", () => {
    // `slice(lastIndexOf("."))` is `slice(-1)` when there is no dot, so `readme` was typed
    // as extension "e": listed, never read, never ranked first.
    writeFileSync(join(dir, "notes"), "ask about the cache\n");
    const r = readReviewerInstructions(repo);
    expect(r.files.find((f) => f.path === "notes")!.readable).toBe(false);
    expect(r.sections.map((s) => s.path)).not.toContain("notes");
  });

  it("skips dotfiles, so an editor's stray file is not relayed as a house rule", () => {
    writeFileSync(join(dir, ".DS_Store"), "junk");
    expect(readReviewerInstructions(repo).files.map((f) => f.path)).not.toContain(".DS_Store");
  });
});

describe("bounding the response", () => {
  beforeEach(() => mkdirSync(dir, { recursive: true }));

  it("stops at the byte budget and names what it left, rather than truncating silently", () => {
    writeFileSync(join(dir, "a.md"), "a".repeat(3_000));
    writeFileSync(join(dir, "b.md"), "b".repeat(3_000));
    const r = readReviewerInstructions(repo, { maxBytes: 3_000 });
    expect(r.sections.map((s) => s.path)).toEqual(["a.md"]);
    expect(r.omitted).toEqual(["b.md"]);
    expect(r.total_bytes).toBe(6_000);
  });

  it("cuts an oversized single file and says so", () => {
    writeFileSync(join(dir, "a.md"), "a".repeat(10_000));
    const r = readReviewerInstructions(repo, { maxBytes: 4_000 });
    expect(r.sections[0].content.length).toBe(4_000);
    expect(r.sections[0].truncated).toBe(true);
  });
});
