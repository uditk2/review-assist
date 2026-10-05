/**
 * The session divided into what it was about, built up a pass at a time.
 *
 * Each block carries one context and two blocks can share one, which is what lets an
 * interleaved subject — A, then B, then back to A — keep or drop whole instead of keeping
 * one half and orphaning the other.
 *
 * The subtle part is the pair of watermarks. `scanned_through` is what anyone has looked
 * at; `closed_through` is the last entry of the last CLOSED block, and it is where the
 * next pass resumes. Closing a block at the end of a pass instead would mean the next pass
 * meets more of the same conversation and must either mint a second context for a subject
 * already labelled, or append to a block whose label was written from half the evidence.
 * Neither is recoverable, and neither is visible when it happens.
 */

import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "ra-contexts-home-"));
process.env.REVIEW_ASSIST_HOME = HOME;

import { readIndex, recordContexts, resumePoint, scoreContexts } from "../src/contexts.js";

const dir = mkdtempSync(join(tmpdir(), "ra-contexts-"));
const REPO = "/repo";
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  rmSync(HOME, { recursive: true, force: true });
});

const user = (t: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text: t }] } });
const edit = (p: string) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name: "Edit", input: { file_path: p } }] },
});

let n = 0;
/** A transcript of `entries`, written fresh so each test has its own session file. */
function session(entries: unknown[]): string {
  const p = join(dir, `s${++n}.jsonl`);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}
/** Append to an existing session, as a live one grows. */
function grow(p: string, entries: unknown[]): void {
  writeFileSync(p, readFileSync(p, "utf8") + entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

describe("resumePoint", () => {
  it("starts at the beginning when nothing is stored", () => {
    const p = session([user("a"), user("b")]);
    expect(resumePoint(p)).toEqual({ from: 0, last: 1, known: [], cold: true });
  });

  it("hands back the known labels, so a pass can rejoin a subject", () => {
    // Without these in front of it, a pass that meets subject A again cannot tell it is A.
    const p = session([user("a"), user("b"), user("c")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 2, contexts: [{ label: "about paging", blocks: [{ from: 0, to: 2 }] }] });
    const r = resumePoint(p);
    expect(r.known).toEqual([{ id: "C1", label: "about paging" }]);
    expect(r.cold).toBe(false);
  });
});

describe("the two watermarks", () => {
  it("resumes after the last CLOSED block, re-reading the open tail", () => {
    const p = session([user("a"), user("b"), user("c"), user("d")]);
    recordContexts(p, REPO, {
      from: 0,
      scanned_through: 3,
      contexts: [
        { label: "closed subject", blocks: [{ from: 0, to: 1 }] },
        { label: "still going", blocks: [{ from: 2, to: 3, open: true }] },
      ],
    });
    const i = readIndex(p);
    expect(i.scanned_through).toBe(3);
    expect(i.closed_through).toBe(1);
    expect(resumePoint(p).from).toBe(2);
  });

  it("resumes after everything when no block was left open", () => {
    const p = session([user("a"), user("b")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "done", blocks: [{ from: 0, to: 1 }] }] });
    expect(readIndex(p).closed_through).toBe(1);
    expect(resumePoint(p).from).toBe(2);
  });

  it("lets a second pass absorb the re-read tail into one block, not two", () => {
    // The whole reason the tail is re-read. The subject continued, so the block that was
    // open grows rather than being joined by a duplicate of itself.
    const p = session([user("plan the pager"), user("keep going")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "paging, under discussion", blocks: [{ from: 0, to: 1, open: true }] }] });
    expect(resumePoint(p).from).toBe(0);

    grow(p, [user("settled on item boundaries")]);
    recordContexts(p, REPO, {
      from: 0,
      scanned_through: 2,
      contexts: [{ id: "C1", label: "weighed three ways to page and settled on item boundaries", blocks: [{ from: 0, to: 2 }] }],
    });
    const i = readIndex(p);
    expect(i.contexts).toHaveLength(1);
    expect(i.contexts[0].blocks).toEqual([{ from: 0, to: 2 }]);
    expect(i.contexts[0].label).toContain("settled on item boundaries");
    expect(i.closed_through).toBe(2);
  });

  it("replaces rather than appends, so a re-read block is never stored twice", () => {
    const p = session([user("a"), user("b"), user("c")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 2, contexts: [{ label: "x", blocks: [{ from: 0, to: 0 }] }, { label: "y", blocks: [{ from: 1, to: 2, open: true }] }] });
    recordContexts(p, REPO, { from: 1, scanned_through: 2, contexts: [{ id: "C2", label: "y, now understood", blocks: [{ from: 1, to: 2 }] }] });
    const i = readIndex(p);
    expect(i.contexts.flatMap((c) => c.blocks)).toEqual([{ from: 0, to: 0 }, { from: 1, to: 2 }]);
  });

  it("drops a context whose re-read tail turned out to be a different subject", () => {
    // Re-reading exists so a pass can change its mind. If it reassigns the tail, the
    // provisional context that held it has nothing left and must not linger as a label.
    const p = session([user("a"), user("b")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "guessed wrong", blocks: [{ from: 0, to: 1, open: true }] }] });
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "actually about something else", blocks: [{ from: 0, to: 1 }] }] });
    const i = readIndex(p);
    expect(i.contexts).toHaveLength(1);
    expect(i.contexts[0].label).toBe("actually about something else");
  });
});

describe("a context spanning non-contiguous blocks", () => {
  it("keeps both halves of an interleaved subject under one id", () => {
    // A, B, back to A. Filtering per block would keep half of A and orphan the rest.
    const p = session([edit("/repo/src/a.ts"), edit("/repo/src/b.ts"), edit("/repo/src/a.ts")]);
    recordContexts(p, REPO, {
      from: 0,
      scanned_through: 2,
      contexts: [
        { label: "subject A", blocks: [{ from: 0, to: 0 }, { from: 2, to: 2 }] },
        { label: "subject B", blocks: [{ from: 1, to: 1 }] },
      ],
    });
    const a = readIndex(p).contexts.find((c) => c.label === "subject A")!;
    expect(a.blocks).toEqual([{ from: 0, to: 0 }, { from: 2, to: 2 }]);
    expect(a.files).toEqual(["src/a.ts"]);
  });
});

describe("files are derived, not reported", () => {
  it("collects every repo file the blocks touched", () => {
    // Deterministic from the transcript, so asking a model for it would be slower and
    // less reliable than computing it.
    const p = session([edit("/repo/src/a.ts"), edit("/repo/src/b.ts")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "both", blocks: [{ from: 0, to: 1 }] }] });
    expect(readIndex(p).contexts[0].files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("ignores files outside the repository", () => {
    const p = session([edit("/elsewhere/z.ts"), edit("/repo/src/a.ts")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 1, contexts: [{ label: "x", blocks: [{ from: 0, to: 1 }] }] });
    expect(readIndex(p).contexts[0].files).toEqual(["src/a.ts"]);
  });
});

describe("the index is discarded when the transcript was replaced", () => {
  it("rebuilds when the file shrank, because import_session overwrites", () => {
    // A live cloud session keeps growing, so a second export must replace the first — and
    // a replaced file can differ anywhere, including before the watermark.
    const p = session([user("a"), user("b"), user("c")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 2, contexts: [{ label: "x", blocks: [{ from: 0, to: 2 }] }] });
    expect(readIndex(p).contexts).toHaveLength(1);

    writeFileSync(p, JSON.stringify(user("different, and shorter")) + "\n");
    const i = readIndex(p);
    expect(i.contexts).toEqual([]);
    expect(i.scanned_through).toBe(-1);
    expect(resumePoint(p).cold).toBe(true);
  });

  it("keeps the index when the session merely grew", () => {
    const p = session([user("a")]);
    recordContexts(p, REPO, { from: 0, scanned_through: 0, contexts: [{ label: "x", blocks: [{ from: 0, to: 0 }] }] });
    grow(p, [user("b"), user("c")]);
    expect(readIndex(p).contexts).toHaveLength(1);
    expect(resumePoint(p).last).toBe(2);
  });
});

describe("scoreContexts", () => {
  const ctx = (id: string, label: string, files: string[]) => ({ id, label, files, blocks: [{ from: 0, to: 1 }] });

  it("separates files the diff changed from files it did not", () => {
    const [a, b] = scoreContexts(
      [ctx("C1", "shipped", ["src/a.ts", "src/gone.ts"]), ctx("C2", "elsewhere", ["other/x.ts"])],
      ["src/a.ts"]
    );
    expect(a.overlap).toEqual(["src/a.ts"]);
    expect(a.only_here).toEqual(["src/gone.ts"]);
    expect(b.overlap).toEqual([]);
  });

  it("reports a context with no overlap rather than discarding it", () => {
    // It may be the most valuable thing in the session: an approach tried on this code and
    // abandoned, which is what approach.trials carries. Only the label says which, so this
    // counts and the caller decides.
    const [only] = scoreContexts([ctx("C1", "tried and abandoned", ["src/gone.ts"])], ["src/a.ts"]);
    expect(only.label).toBe("tried and abandoned");
    expect(only.overlap).toEqual([]);
    expect(only.blocks).toHaveLength(1);
  });
});
