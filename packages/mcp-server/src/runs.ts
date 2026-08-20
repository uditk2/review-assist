/**
 * Distillation runs — the unit the interview belongs to.
 *
 * The interview used to be an in-memory Map keyed by repo path, with the repo
 * argument OPTIONAL on `record_interview_round` and always supplied on
 * `submit_document`. In a workspace holding several repos those two resolve to
 * different keys: the server's cwd is the workspace root, the submit names the repo.
 * Every round was filed under the workspace and the submit found none, so
 * `require_interview` rejected, and the reviewer re-ran the whole interview and
 * re-emitted the document. Observed: 21 record calls for 7 questions, four submits of
 * the same 20,696 characters, five of the reviewer's eight and a half minutes.
 *
 * Two changes make that unreachable rather than unlikely.
 *
 * 1. The handle is content-addressed: sha256(repo | base_sha). The author and the
 *    reviewer derive the SAME run id independently, from `compute_diff` alone, which
 *    matters because the two roles are deliberately forbidden from talking to each
 *    other. A reviewer resumed hours later recomputes it rather than remembering it.
 *
 *    head_sha was in that hash and is not any more. It made the id rotate on EVERY
 *    commit, which is not a stale run but a new one: the interview recorded against the
 *    old id became unreachable, and — because `openRun` recreates a record for an id it
 *    cannot find — the author's next `answer_questions` landed on a fresh, empty run
 *    bearing the same handle and came back `unknown_q_ids`, `rounds: 0`. Nothing errored.
 *    Committing the Intent Document is itself a commit, so the correction cycle the guide
 *    promises ("fix the findings and resubmit") destroyed the attestation it was meant to
 *    preserve, and left a run file behind per commit — four or five per repo, observed.
 *
 *    So the head is STATE on the run, not identity. `openRun` moves it forward and keeps
 *    the prior value in `head_history`; staleness is reported as `head_changed` on the
 *    call that observes it, which is strictly louder than an id that silently stopped
 *    matching. The one thing that must not be lost when the head moves is the interview,
 *    and the one thing that must not survive it is an anchor — hunk ids are reassigned by
 *    the new diff, so the caller is told to re-anchor.
 *
 * 2. Rounds are keyed by a hash of the question, so recording is an upsert. Retrying
 *    an interview cannot inflate the count, which is what makes `meta.interview`
 *    worth attesting: it reports distinct questions asked, not tool calls made.
 *
 * Storage is per-user and OUTSIDE any repository — `~/.review-assist/runs/`, beside
 * the consent file, honouring REVIEW_ASSIST_HOME. Deliberately not `<repo>/.intent/`:
 * that directory is committed with the code, and interview scratch state has no
 * business in a pull request. On disk rather than in memory because the failure it
 * has to survive is real — this machine runs nine review-assist processes, each with
 * its own memory, and one reviewer resumed eleven hours later across a restart.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const RUNS_DIR = join(
  process.env.REVIEW_ASSIST_HOME ?? join(homedir(), ".review-assist"),
  "runs"
);

/**
 * Runs untouched for this long are swept on open.
 *
 * Measured from `updated_at`, not `created_at`. It could be creation time while the id
 * carried the head, because a run was born and abandoned within one commit; now a single
 * run follows a branch from its first `compute_diff` to its merge, and a branch worked on
 * over a month is a live run, not an abandoned one.
 */
const MAX_RUN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface InterviewRound {
  /** Hash of the normalised question. Relayed to the author, which answers by it. */
  q_id: string;
  question: string;
  /** Empty until someone answers. A question may be recorded before it is. */
  answer: string;
  resolved: boolean;
  /**
   * Which role put the answer here.
   *
   * The reviewer transcribing an answer it received is normal and stays allowed; the
   * point is that the server can now tell that case apart from an answer the author
   * wrote itself. Only `author` is attestation — everything else is one role's account
   * of a conversation the server never witnessed.
   */
  answered_by?: "author" | "reviewer";
  at: string;
}

export interface RunRecord {
  version: 1;
  run_id: string;
  repo: string;
  base_sha: string;
  /** The head this run is currently pointed at. Moves as the branch does. */
  head_sha: string;
  /** Every head this run has previously been pointed at, oldest first. */
  head_history?: string[];
  branch?: string;
  created_at: string;
  /** Last time anything was written to this run. What the sweep measures. */
  updated_at?: string;
  /** Keyed by question hash, so re-recording a question replaces it. */
  rounds: Record<string, InterviewRound>;
}

export interface RunKey {
  repo: string;
  baseSha: string;
  headSha: string;
}

/** What `openRun` observed, as distinct from what it stored. */
export interface OpenRunResult {
  run: RunRecord;
  /** The branch moved since this run was last opened. Anchors are stale; rounds are not. */
  head_changed: boolean;
  /** The head it moved from, when it moved. */
  previous_head?: string;
}

export interface InterviewSummary {
  rounds: number;
  questions_asked: number;
  unresolved: number;
  /** Answers the author role wrote itself. The only figure the server can vouch for. */
  author_attested: number;
  /** Questions recorded with no answer from either side yet. */
  unanswered: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The run's identity: the repository and what this work branched FROM. Derived only from
 * what the change is, so two agents that never speak arrive at the same value — and
 * deliberately not from where the branch has got to, so that value survives a commit.
 */
export function computeRunId({ repo, baseSha }: Pick<RunKey, "repo" | "baseSha">): string {
  return sha256(`${resolve(repo)}|${baseSha}`).slice(0, 12);
}

/**
 * Identity of a question, for upsert. Normalised so a reviewer that re-asks the same
 * thing with different capitalisation or wrapping updates the round instead of adding
 * a duplicate — the retry path this whole module exists to make harmless.
 */
function questionKey(question: string): string {
  return sha256(question.trim().toLowerCase().replace(/\s+/g, " ")).slice(0, 16);
}

function runPath(runId: string): string {
  return join(RUNS_DIR, `${runId}.json`);
}

function readRun(runId: string): RunRecord | undefined {
  try {
    const raw = JSON.parse(readFileSync(runPath(runId), "utf8"));
    if (raw && typeof raw === "object" && raw.run_id === runId) return raw as RunRecord;
  } catch {
    /* missing or corrupt: treat as absent rather than crash the distillation */
  }
  return undefined;
}

function writeRun(run: RunRecord): void {
  mkdirSync(RUNS_DIR, { recursive: true });
  run.updated_at = new Date().toISOString();
  writeFileSync(runPath(run.run_id), JSON.stringify(run, null, 2) + "\n", "utf8");
}

/**
 * Open the run for a change, or return the one already open for it — moved forward to
 * the head just observed.
 *
 * Idempotent by construction: the id is a hash of the repo and the base, so calling this
 * twice — once from the author, once from the reviewer — yields one record, not two.
 *
 * When the head has moved, the rounds are carried over UNCHANGED and the move is reported
 * back. Those are the two halves of the same decision: an interview is about the work, and
 * survives a commit; an anchor is about a diff, and does not. The caller is the only place
 * that can act on the second, so it is told rather than guessed at here.
 */
export function openRun(key: RunKey & { branch?: string }): OpenRunResult {
  sweepStaleRuns();
  const runId = computeRunId(key);
  const existing = readRun(runId);

  if (existing) {
    const previous_head = existing.head_sha;
    const head_changed = previous_head !== key.headSha;
    if (head_changed) {
      existing.head_history = [...(existing.head_history ?? []), previous_head];
      existing.head_sha = key.headSha;
    }
    // A branch rename (or a detached HEAD resolving to nothing) must not blank a name the
    // run already has — the submit writes .intent/<branch>.json from it.
    if (key.branch) existing.branch = key.branch;
    writeRun(existing);
    return { run: existing, head_changed, previous_head: head_changed ? previous_head : undefined };
  }

  const run: RunRecord = {
    version: 1,
    run_id: runId,
    repo: resolve(key.repo),
    base_sha: key.baseSha,
    head_sha: key.headSha,
    branch: key.branch,
    created_at: new Date().toISOString(),
    rounds: {},
  };
  writeRun(run);
  return { run, head_changed: false };
}

export function getRun(runId: string): RunRecord | undefined {
  return readRun(runId);
}

/**
 * Upsert the reviewer's rounds into a run. Returns the run, or undefined when the id is
 * unknown — the caller turns that into an error listing the open runs, so a wrong handle
 * costs one corrective call rather than a silent loss.
 *
 * `answer` is optional because the reviewer records its questions BEFORE the author has
 * replied: the q_ids that come back are what the author answers by. An answer supplied
 * here is kept, but marked `reviewer`, because the server has only ever heard one side of
 * it. Re-recording a question preserves an answer already on it rather than blanking it —
 * otherwise a reviewer re-posting its batch would silently erase the author's attestation.
 */
export function recordRounds(
  runId: string,
  rounds: { question: string; answer?: string; resolved?: boolean }[]
): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  for (const r of rounds) {
    const q_id = questionKey(r.question);
    const prior = run.rounds[q_id];
    const answer = r.answer ?? prior?.answer ?? "";
    run.rounds[q_id] = {
      q_id,
      question: r.question,
      answer,
      resolved: r.resolved ?? prior?.resolved ?? answer.length > 0,
      answered_by: r.answer ? "reviewer" : prior?.answered_by,
      at,
    };
  }
  writeRun(run);
  return run;
}

/**
 * Attach the author's own answers, by q_id. This is the half the server can vouch for:
 * the role that read the transcript wrote these, in its own tool call, rather than the
 * reviewer reporting what it says it was told.
 *
 * An author answer always wins over a reviewer-transcribed one for the same question.
 * Unknown ids are returned rather than dropped, so a mis-relayed id is one corrective
 * call instead of an answer that quietly went nowhere.
 */
export function recordAnswers(
  runId: string,
  answers: { q_id: string; answer: string; resolved?: boolean }[]
): { run: RunRecord; unknown: string[] } | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  const unknown: string[] = [];
  for (const a of answers) {
    const round = run.rounds[a.q_id];
    if (!round) {
      unknown.push(a.q_id);
      continue;
    }
    round.answer = a.answer;
    round.resolved = a.resolved ?? true;
    round.answered_by = "author";
    round.at = at;
  }
  writeRun(run);
  return { run, unknown: Array.from(new Set(unknown)) };
}

/** What the server stamps into `meta.interview`. Counts questions, not calls. */
export function summarizeRun(run: RunRecord): InterviewSummary {
  const rounds = Object.values(run.rounds);
  return {
    rounds: rounds.length,
    questions_asked: rounds.length,
    unresolved: rounds.filter((r) => !r.resolved).length,
    author_attested: rounds.filter((r) => r.answered_by === "author").length,
    unanswered: rounds.filter((r) => r.answer.length === 0).length,
  };
}

/** Rounds in the order they were first recorded, for callers that want the content. */
export function runRounds(run: RunRecord): InterviewRound[] {
  return Object.values(run.rounds).sort((a, b) => a.at.localeCompare(b.at));
}

/** Drop a run once its document is written. */
export function closeRun(runId: string): void {
  try {
    rmSync(runPath(runId), { force: true });
  } catch {
    /* best effort: a leftover run file is swept later and harms nothing */
  }
}

/**
 * Open runs, newest first. Used to answer an unknown run_id with something actionable
 * instead of "not found".
 */
export function listOpenRuns(): RunRecord[] {
  if (!existsSync(RUNS_DIR)) return [];
  const runs: RunRecord[] = [];
  for (const name of readdirSync(RUNS_DIR)) {
    if (!name.endsWith(".json")) continue;
    const run = readRun(name.slice(0, -5));
    if (run) runs.push(run);
  }
  return runs.sort((a, b) => lastTouched(b).localeCompare(lastTouched(a)));
}

/** When this run was last written. Falls back for records predating `updated_at`. */
function lastTouched(run: RunRecord): string {
  return run.updated_at ?? run.created_at;
}

/** A run follows one branch; one untouched for a month is abandoned. */
function sweepStaleRuns(): void {
  if (!existsSync(RUNS_DIR)) return;
  const cutoff = Date.now() - MAX_RUN_AGE_MS;
  for (const run of listOpenRuns()) {
    if (Date.parse(lastTouched(run)) < cutoff) closeRun(run.run_id);
  }
}

export function runsDir(): string {
  return RUNS_DIR;
}
