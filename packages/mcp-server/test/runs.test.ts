/**
 * Runs are the fix for a specific, observed failure: a reviewer recorded seven
 * interview questions three times over — twenty-one calls — because each batch was
 * filed under a key the submit never read. These tests pin the two properties that
 * make that unreachable: the handle is derived from the change, and recording is an
 * upsert.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// REVIEW_ASSIST_HOME is read when the module loads, so it must be set before the
// import — otherwise the suite writes into the developer's real ~/.review-assist.
const HOME = mkdtempSync(join(tmpdir(), "review-assist-runs-"));
process.env.REVIEW_ASSIST_HOME = HOME;

type RunsModule = typeof import("../src/runs.js");
let runs: RunsModule;

const REPO_A = "/tmp/workspace/airo-backend";
const REPO_B = "/tmp/workspace/seerly-front";
const BASE = "667d2003ba62b89b89a3957929799ab96be90e5e";
const HEAD = "928771bbc7306ad54b4fea420177f73e4edbfc2b";

beforeAll(async () => {
  runs = await import("../src/runs.js");
});

beforeEach(() => {
  for (const f of existsSync(runs.runsDir()) ? readdirSync(runs.runsDir()) : []) {
    rmSync(join(runs.runsDir(), f), { force: true });
  }
});

describe("computeRunId", () => {
  it("is stable for the same change, so two isolated roles derive the same handle", () => {
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const b = runs.computeRunId({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("changes when the branch moves, so a stale document cannot submit against a new head", () => {
    const before = runs.computeRunId({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const after = runs.computeRunId({ repo: REPO_A, baseSha: BASE, headSha: "a024854f8ff71d0aaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(after).not.toBe(before);
  });

  it("separates repos in the same workspace — the case that caused the loop", () => {
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const b = runs.computeRunId({ repo: REPO_B, baseSha: BASE, headSha: HEAD });
    expect(a).not.toBe(b);
  });
});

describe("openRun", () => {
  it("is idempotent: the author and the reviewer opening the same change get one run", () => {
    const first = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
    const second = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    expect(second.run_id).toBe(first.run_id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.branch).toBe("feat/ads-manager");
    expect(readdirSync(runs.runsDir())).toHaveLength(1);
  });

  it("survives a process boundary — state is on disk, not in a Map", async () => {
    const opened = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(opened.run_id, [{ question: "What did the user ask for?", answer: "…" }]);
    const reloaded = runs.getRun(opened.run_id);
    expect(Object.keys(reloaded!.rounds)).toHaveLength(1);
  });
});

describe("recordRounds", () => {
  const BASELINE = [
    "What did the user actually ask for, in their words?",
    "Was this the problem from the start, or did it change shape?",
    "What was tried and abandoned during this session?",
    "What does this change assume about the world that the diff cannot show?",
    "Which hunks are genuinely incidental (vs core)?",
    "What was run, and what was not?",
    "Was the two-endpoint split an architectural preference, or forced?",
  ];

  it("collapses the observed 21-call retry into 7 rounds", () => {
    const run = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    // Three passes, exactly as the airo-backend reviewer did after each failed submit.
    for (let pass = 0; pass < 3; pass++) {
      runs.recordRounds(
        run.run_id,
        BASELINE.map((q) => ({ question: q, answer: `answer, pass ${pass}` }))
      );
    }
    const summary = runs.summarizeRun(runs.getRun(run.run_id)!);
    expect(summary.rounds).toBe(7);
    expect(summary.questions_asked).toBe(7);
  });

  it("keeps the latest answer when a question is re-recorded", () => {
    const run = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "first" }]);
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "second" }]);
    const rounds = runs.runRounds(runs.getRun(run.run_id)!);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].answer).toBe("second");
  });

  it("treats whitespace and case variants of a question as the same round", () => {
    const run = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "What was tried and abandoned?", answer: "a" }]);
    runs.recordRounds(run.run_id, [{ question: "  what   was tried and ABANDONED?  ", answer: "b" }]);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!).rounds).toBe(1);
  });

  it("counts unresolved rounds for meta.interview", () => {
    const run = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [
      { question: "Q1", answer: "a", resolved: true },
      { question: "Q2", answer: "the transcript does not cover this", resolved: false },
    ]);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!)).toEqual({
      rounds: 2,
      questions_asked: 2,
      unresolved: 1,
    });
  });

  it("returns undefined for an unknown run, so the caller can answer with the open ones", () => {
    expect(runs.recordRounds("deadbeef1234", [{ question: "Q", answer: "a" }])).toBeUndefined();
  });

  it("does not leak rounds between repos in one workspace", () => {
    const a = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const b = runs.openRun({ repo: REPO_B, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(a.run_id, [{ question: "Q", answer: "for A" }]);
    expect(runs.summarizeRun(runs.getRun(a.run_id)!).rounds).toBe(1);
    expect(runs.summarizeRun(runs.getRun(b.run_id)!).rounds).toBe(0);
  });
});

describe("closeRun", () => {
  it("removes the run once its document is written", () => {
    const run = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.closeRun(run.run_id);
    expect(runs.getRun(run.run_id)).toBeUndefined();
    expect(runs.listOpenRuns()).toHaveLength(0);
  });
});
