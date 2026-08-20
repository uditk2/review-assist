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

const HEAD_2 = "a024854f8ff71d0a3c1b9e77d2f4a8c6e0b15d93";

/** The record itself, for the common case where the open-time signals do not matter. */
const open = (key: { repo: string; baseSha: string; headSha: string; branch?: string }) =>
  runs.openRun(key).run;

describe("computeRunId", () => {
  it("is stable for the same change, so two isolated roles derive the same handle", () => {
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    const b = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    expect(a).toBe(b);
    expect(a).toHaveLength(12);
  });

  it("survives the branch moving, because the head is state and not identity", () => {
    // Committing the Intent Document is itself a commit. While the head was in the hash
    // this rotated the handle, and the interview recorded under the old one became
    // unreachable at the exact moment the guide told the reviewer to fix and resubmit.
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    const b = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    expect(b).toBe(a);
  });

  it("separates repos in the same workspace — the case that caused the loop", () => {
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    const b = runs.computeRunId({ repo: REPO_B, baseSha: BASE });
    expect(a).not.toBe(b);
  });

  it("separates two branches off different bases in one repo", () => {
    const a = runs.computeRunId({ repo: REPO_A, baseSha: BASE });
    const b = runs.computeRunId({ repo: REPO_A, baseSha: HEAD });
    expect(a).not.toBe(b);
  });
});

describe("openRun", () => {
  it("is idempotent: the author and the reviewer opening the same change get one run", () => {
    const first = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
    const second = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    expect(second.run_id).toBe(first.run_id);
    expect(second.created_at).toBe(first.created_at);
    expect(second.branch).toBe("feat/ads-manager");
    expect(readdirSync(runs.runsDir())).toHaveLength(1);
  });

  it("survives a process boundary — state is on disk, not in a Map", async () => {
    const opened = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(opened.run_id, [{ question: "What did the user ask for?", answer: "…" }]);
    const reloaded = runs.getRun(opened.run_id);
    expect(Object.keys(reloaded!.rounds)).toHaveLength(1);
  });

  it("moves an existing run to the new head instead of minting a second one", () => {
    const first = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const moved = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD_2 });
    expect(moved.run.run_id).toBe(first.run_id);
    expect(moved.run.head_sha).toBe(HEAD_2);
    expect(moved.head_changed).toBe(true);
    expect(moved.previous_head).toBe(HEAD);
    expect(moved.run.head_history).toEqual([HEAD]);
    // One file per branch. The observed symptom was four or five per repo.
    expect(readdirSync(runs.runsDir())).toHaveLength(1);
  });

  it("reports no head change when the branch has not moved", () => {
    open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const again = runs.openRun({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    expect(again.head_changed).toBe(false);
    expect(again.previous_head).toBeUndefined();
    expect(again.run.head_history).toBeUndefined();
  });

  it("does not blank a branch name it already has when none is supplied", () => {
    open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
    // Detached HEAD resolves to no branch; the submit path writes .intent/<branch>.json.
    const moved = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD_2 });
    expect(moved.branch).toBe("feat/ads-manager");
  });
});

/**
 * The regression this whole fix exists for. Every step is one the guide tells the roles to
 * take, and the sequence used to end with the author's answers landing nowhere.
 */
describe("the correction cycle", () => {
  it("keeps the interview when the head moves under it", () => {
    const opened = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(opened.run_id, [{ question: "What was tried and abandoned?" }]);
    const { q_id } = runs.runRounds(runs.getRun(opened.run_id)!)[0];

    // The reviewer submits, the document is committed, and the head moves.
    const moved = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD_2 });
    expect(moved.run_id).toBe(opened.run_id);

    // The author answers by the id it was relayed BEFORE the commit.
    const res = runs.recordAnswers(moved.run_id, [{ q_id, answer: "two schemas, one dropped" }]);
    expect(res?.unknown).toEqual([]);
    expect(runs.summarizeRun(runs.getRun(moved.run_id)!).author_attested).toBe(1);
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
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
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
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "first" }]);
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "second" }]);
    const rounds = runs.runRounds(runs.getRun(run.run_id)!);
    expect(rounds).toHaveLength(1);
    expect(rounds[0].answer).toBe("second");
  });

  it("treats whitespace and case variants of a question as the same round", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "What was tried and abandoned?", answer: "a" }]);
    runs.recordRounds(run.run_id, [{ question: "  what   was tried and ABANDONED?  ", answer: "b" }]);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!).rounds).toBe(1);
  });

  it("counts unresolved rounds for meta.interview", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [
      { question: "Q1", answer: "a", resolved: true },
      { question: "Q2", answer: "the transcript does not cover this", resolved: false },
    ]);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!)).toEqual({
      rounds: 2,
      questions_asked: 2,
      unresolved: 1,
      author_attested: 0,
      unanswered: 0,
    });
  });

  it("returns undefined for an unknown run, so the caller can answer with the open ones", () => {
    expect(runs.recordRounds("deadbeef1234", [{ question: "Q", answer: "a" }])).toBeUndefined();
  });

  it("does not leak rounds between repos in one workspace", () => {
    const a = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const b = open({ repo: REPO_B, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(a.run_id, [{ question: "Q", answer: "for A" }]);
    expect(runs.summarizeRun(runs.getRun(a.run_id)!).rounds).toBe(1);
    expect(runs.summarizeRun(runs.getRun(b.run_id)!).rounds).toBe(0);
  });

  it("records a question with no answer, which is how the interview starts", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "What was tried?" }]);
    const [round] = runs.runRounds(runs.getRun(run.run_id)!);
    expect(round.q_id).toMatch(/^[0-9a-f]{16}$/);
    expect(round.answer).toBe("");
    expect(round.answered_by).toBeUndefined();
    expect(runs.summarizeRun(runs.getRun(run.run_id)!).unanswered).toBe(1);
  });
});

/**
 * The interview is worth attesting only if the server heard the author. These pin the one
 * property that makes `meta.interview` more than self-report: an answer counts as attested
 * when the author role wrote it, and never otherwise.
 */
describe("recordAnswers", () => {
  const ask = (question: string) => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question }]);
    return { run_id: run.run_id, q_id: runs.runRounds(runs.getRun(run.run_id)!)[0].q_id };
  };

  it("attests an answer the author wrote itself", () => {
    const { run_id, q_id } = ask("What did the user ask for?");
    runs.recordAnswers(run_id, [{ q_id, answer: '"add an ads manager"' }]);
    const summary = runs.summarizeRun(runs.getRun(run_id)!);
    expect(summary.author_attested).toBe(1);
    expect(summary.unanswered).toBe(0);
    expect(runs.runRounds(runs.getRun(run_id)!)[0].answered_by).toBe("author");
  });

  it("does not attest an answer the reviewer transcribed", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "reviewer's account of it" }]);
    const summary = runs.summarizeRun(runs.getRun(run.run_id)!);
    expect(summary.rounds).toBe(1);
    expect(summary.author_attested).toBe(0);
    expect(runs.runRounds(runs.getRun(run.run_id)!)[0].answered_by).toBe("reviewer");
  });

  it("lets the author's answer win over the reviewer's transcription of it", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question: "Q", answer: "roughly what I was told" }]);
    const { q_id } = runs.runRounds(runs.getRun(run.run_id)!)[0];
    runs.recordAnswers(run.run_id, [{ q_id, answer: "what I actually said" }]);
    const [round] = runs.runRounds(runs.getRun(run.run_id)!);
    expect(round.answer).toBe("what I actually said");
    expect(round.answered_by).toBe("author");
  });

  it("does not erase an author answer when the reviewer re-records the question", () => {
    // The reviewer re-posting its batch is a free retry by design; it must not silently
    // blank the attestation the author already gave.
    const { run_id, q_id } = ask("Q");
    runs.recordAnswers(run_id, [{ q_id, answer: "the author's words" }]);
    runs.recordRounds(run_id, [{ question: "Q" }]);
    const [round] = runs.runRounds(runs.getRun(run_id)!);
    expect(round.answer).toBe("the author's words");
    expect(round.answered_by).toBe("author");
    expect(runs.summarizeRun(runs.getRun(run_id)!).author_attested).toBe(1);
  });

  it("names an unknown q_id rather than dropping the answer silently", () => {
    const { run_id } = ask("Q");
    const res = runs.recordAnswers(run_id, [{ q_id: "0000000000000000", answer: "a" }]);
    expect(res?.unknown).toEqual(["0000000000000000"]);
    expect(runs.summarizeRun(runs.getRun(run_id)!).author_attested).toBe(0);
  });

  it("records a non-answer as unresolved, which is a real answer", () => {
    const { run_id, q_id } = ask("What was tried and abandoned?");
    runs.recordAnswers(run_id, [
      { q_id, answer: "the transcript does not cover this", resolved: false },
    ]);
    const summary = runs.summarizeRun(runs.getRun(run_id)!);
    expect(summary.unresolved).toBe(1);
    expect(summary.author_attested).toBe(1);
  });

  it("returns undefined for an unknown run", () => {
    expect(runs.recordAnswers("deadbeef1234", [{ q_id: "x", answer: "a" }])).toBeUndefined();
  });
});

describe("closeRun", () => {
  it("removes the run once its document is written", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.closeRun(run.run_id);
    expect(runs.getRun(run.run_id)).toBeUndefined();
    expect(runs.listOpenRuns()).toHaveLength(0);
  });
});
