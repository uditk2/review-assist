/**
 * Runs are the fix for a specific, observed failure: a reviewer recorded seven
 * interview questions three times over — twenty-one calls — because each batch was
 * filed under a key the submit never read. These tests pin the two properties that
 * make that unreachable: the handle is derived from the change, and recording is an
 * upsert.
 */

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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
    // Both roles resolve the branch the same way, from the checkout — see computeRunId.
    const first = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
    const second = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
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

  it("keeps the branch name across a head move", () => {
    open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/ads-manager" });
    const moved = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD_2, branch: "feat/ads-manager" });
    // The submit path writes .intent/<branch>.json from this field.
    expect(moved.branch).toBe("feat/ads-manager");
  });
});

/**
 * Two branches cut from one commit have identical base SHAs however far they diverge. While
 * the head was in the id it separated them as a side effect; taking it out to survive
 * commits took that separation with it, and they silently shared a rounds map and fought
 * over the `branch` field that names the output document.
 */
describe("two branches off one base", () => {
  it("get different run ids", () => {
    const alpha = runs.computeRunId({ repo: REPO_A, baseSha: BASE, branch: "feat/alpha" });
    const beta = runs.computeRunId({ repo: REPO_A, baseSha: BASE, branch: "feat/beta" });
    expect(alpha).not.toBe(beta);
  });

  it("do not share an interview, and do not overwrite each other's branch name", () => {
    const alpha = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "feat/alpha" });
    runs.recordRounds(alpha.run_id, [{ question: "Why two queries?" }]);

    const beta = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD_2, branch: "feat/beta" });

    expect(beta.run_id).not.toBe(alpha.run_id);
    expect(runs.summarizeRun(runs.getRun(beta.run_id)!).rounds).toBe(0);
    expect(runs.getRun(alpha.run_id)!.branch).toBe("feat/alpha");
    expect(runs.getRun(beta.run_id)!.branch).toBe("feat/beta");
    expect(readdirSync(runs.runsDir())).toHaveLength(2);
  });

  it("still separates successive changes on one long-lived branch", () => {
    // Why base_sha stays in the id: otherwise every change ever distilled on main would
    // share one run and one rounds map.
    const first = runs.computeRunId({ repo: REPO_A, baseSha: BASE, branch: "main" });
    const second = runs.computeRunId({ repo: REPO_A, baseSha: HEAD, branch: "main" });
    expect(first).not.toBe(second);
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

/**
 * The round-trip the two read tools serve. Neither role can see the other's context, so the
 * run file is the only channel between them; these pin that everything each side needs is
 * actually on it, rather than living in the orchestrator's chat history.
 */
describe("the run as the channel between the roles", () => {
  it("carries the reviewer's questions to the author and the author's answers back", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "main" });

    // Reviewer's half.
    runs.recordRounds(run.run_id, [
      { question: "Why two queries?" },
      { question: "What was tried and abandoned?" },
    ]);

    // What get_questions serves the author: the wording and the ids, nothing hand-carried.
    const asked = runs.runRounds(runs.getRun(run.run_id)!);
    expect(asked.map((r) => r.question)).toEqual(["Why two queries?", "What was tried and abandoned?"]);
    expect(asked.every((r) => /^[0-9a-f]{16}$/.test(r.q_id))).toBe(true);
    expect(asked.every((r) => r.answer === "")).toBe(true);

    // Author's half, keyed by the ids it just read.
    runs.recordAnswers(run.run_id, [
      { q_id: asked[0].q_id, answer: "a combined query drops the whole row" },
      { q_id: asked[1].q_id, answer: "the transcript does not cover this", resolved: false },
    ]);

    // What get_answers serves the reviewer: the author's own words, attributed.
    const answered = runs.runRounds(runs.getRun(run.run_id)!);
    expect(answered.map((r) => r.answer)).toEqual([
      "a combined query drops the whole row",
      "the transcript does not cover this",
    ]);
    expect(answered.every((r) => r.answered_by === "author")).toBe(true);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!)).toEqual({
      rounds: 2,
      questions_asked: 2,
      unresolved: 1,
      author_attested: 2,
      unanswered: 0,
    });
  });

  it("tells the author what it still owes, and the reviewer what is still missing", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD, branch: "main" });
    runs.recordRounds(run.run_id, [{ question: "Q1" }, { question: "Q2" }]);
    const [q1] = runs.runRounds(runs.getRun(run.run_id)!);
    runs.recordAnswers(run.run_id, [{ q_id: q1.q_id, answer: "answered" }]);

    // get_questions({only_unanswered: true}) / get_answers both filter on this.
    const rounds = runs.runRounds(runs.getRun(run.run_id)!);
    expect(rounds.filter((r) => r.answer.length === 0).map((r) => r.question)).toEqual(["Q2"]);
    expect(runs.summarizeRun(runs.getRun(run.run_id)!).unanswered).toBe(1);
  });
});

describe("closeRun", () => {
  it("removes a run outright, for the sweep and for an explicit discard", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.closeRun(run.run_id);
    expect(runs.getRun(run.run_id)).toBeUndefined();
    expect(runs.listOpenRuns()).toHaveLength(0);
  });
});

/**
 * Submit used to call `closeRun`, which destroyed the interview at the one moment the
 * guide tells a reviewer it will need it again — "if it returns validation findings, FIX
 * them and resubmit". These pin the run surviving its own document.
 */
describe("markSubmitted", () => {
  const ask = (question: string) => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    runs.recordRounds(run.run_id, [{ question }]);
    return { run_id: run.run_id, q_id: runs.runRounds(runs.getRun(run.run_id)!)[0].q_id };
  };

  it("keeps the run, and its interview, after the document is written", () => {
    const { run_id, q_id } = ask("What was tried and abandoned?");
    runs.recordAnswers(run_id, [{ q_id, answer: "two schemas, one dropped" }]);

    const submitted = runs.markSubmitted(run_id, "/repo/.intent/main.json");
    expect(submitted?.submitted_at).toBeTruthy();
    expect(submitted?.document_path).toBe("/repo/.intent/main.json");

    // The whole point: the attestation is still reachable under the same handle.
    const after = runs.getRun(run_id);
    expect(after).toBeDefined();
    expect(runs.summarizeRun(after!).author_attested).toBe(1);
  });

  it("lets the author keep answering after a document has been written", () => {
    // The correction cycle: submit, spot a finding, ask one more thing, resubmit.
    const { run_id } = ask("Q1");
    runs.markSubmitted(run_id, "/repo/.intent/main.json");
    runs.recordRounds(run_id, [{ question: "Q2, raised by the draft" }]);
    const q2 = runs.runRounds(runs.getRun(run_id)!).find((r) => r.question.startsWith("Q2"))!;
    const res = runs.recordAnswers(run_id, [{ q_id: q2.q_id, answer: "answered post-submit" }]);
    expect(res?.unknown).toEqual([]);
    expect(runs.summarizeRun(runs.getRun(run_id)!).rounds).toBe(2);
  });

  it("returns undefined for an unknown run", () => {
    expect(runs.markSubmitted("deadbeef1234", "/tmp/x.json")).toBeUndefined();
  });
});

/**
 * The sweep is the reason keeping the run is affordable: a submitted run is reaped on a
 * short clock, so "do not delete on submit" does not mean "accumulate forever".
 */
describe("sweeping", () => {
  const backdate = (runId: string, daysAgo: number, submitted: boolean) => {
    const path = join(runs.runsDir(), `${runId}.json`);
    const rec = JSON.parse(readFileSync(path, "utf8"));
    const stamp = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
    rec.updated_at = stamp;
    if (submitted) rec.submitted_at = stamp;
    writeFileSync(path, JSON.stringify(rec), "utf8");
  };

  it("reaps a submitted run after a week, but keeps an unsubmitted one", () => {
    const submitted = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    const working = open({ repo: REPO_B, baseSha: BASE, headSha: HEAD });
    backdate(submitted.run_id, 10, true);
    backdate(working.run_id, 10, false);

    // openRun sweeps; a third repo is used so neither run under test is the one opening.
    open({ repo: "/tmp/workspace/third", baseSha: BASE, headSha: HEAD });

    expect(runs.getRun(submitted.run_id)).toBeUndefined();
    expect(runs.getRun(working.run_id)).toBeDefined();
  });

  it("keeps a submitted run that is still being worked on", () => {
    const run = open({ repo: REPO_A, baseSha: BASE, headSha: HEAD });
    backdate(run.run_id, 2, true);
    open({ repo: "/tmp/workspace/third", baseSha: BASE, headSha: HEAD });
    expect(runs.getRun(run.run_id)).toBeDefined();
  });
});
