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
 * 1. The handle is content-addressed: sha256(repo | base_sha | head_sha). The author
 *    and the reviewer derive the SAME run id independently, from `compute_diff` alone,
 *    which matters because the two roles are deliberately forbidden from talking to
 *    each other. A reviewer resumed hours later recomputes it rather than remembering
 *    it. And because head_sha is in the hash, a branch that moved mid-session yields a
 *    different id — staleness surfaces when a round is recorded, not after the
 *    document has been written twice.
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

/** Runs older than this are swept on open; a distillation never spans days. */
const MAX_RUN_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface InterviewRound {
  question: string;
  answer: string;
  resolved: boolean;
  at: string;
}

export interface RunRecord {
  version: 1;
  run_id: string;
  repo: string;
  base_sha: string;
  head_sha: string;
  branch?: string;
  created_at: string;
  /** Keyed by question hash, so re-recording a question replaces it. */
  rounds: Record<string, InterviewRound>;
}

export interface RunKey {
  repo: string;
  baseSha: string;
  headSha: string;
}

export interface InterviewSummary {
  rounds: number;
  questions_asked: number;
  unresolved: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The run's identity. Derived only from what the change IS, so two agents that never
 * speak arrive at the same value.
 */
export function computeRunId({ repo, baseSha, headSha }: RunKey): string {
  return sha256(`${resolve(repo)}|${baseSha}|${headSha}`).slice(0, 12);
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
  writeFileSync(runPath(run.run_id), JSON.stringify(run, null, 2) + "\n", "utf8");
}

/**
 * Open the run for a change, or return the one already open for it.
 *
 * Idempotent by construction: the id is a hash of the change, so calling this twice —
 * once from the author, once from the reviewer — yields one record, not two.
 */
export function openRun(key: RunKey & { branch?: string }): RunRecord {
  sweepStaleRuns();
  const runId = computeRunId(key);
  const existing = readRun(runId);
  if (existing) return existing;
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
  return run;
}

export function getRun(runId: string): RunRecord | undefined {
  return readRun(runId);
}

/**
 * Upsert rounds into a run. Returns the run, or undefined when the id is unknown —
 * the caller turns that into an error listing the open runs, so a wrong handle costs
 * one corrective call rather than a silent loss.
 */
export function recordRounds(
  runId: string,
  rounds: { question: string; answer: string; resolved?: boolean }[]
): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  for (const r of rounds) {
    run.rounds[questionKey(r.question)] = {
      question: r.question,
      answer: r.answer,
      resolved: r.resolved ?? true,
      at,
    };
  }
  writeRun(run);
  return run;
}

/** What the server stamps into `meta.interview`. Counts questions, not calls. */
export function summarizeRun(run: RunRecord): InterviewSummary {
  const rounds = Object.values(run.rounds);
  return {
    rounds: rounds.length,
    questions_asked: rounds.length,
    unresolved: rounds.filter((r) => !r.resolved).length,
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
  return runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** A distillation takes minutes; anything older is abandoned. */
function sweepStaleRuns(): void {
  if (!existsSync(RUNS_DIR)) return;
  const cutoff = Date.now() - MAX_RUN_AGE_MS;
  for (const run of listOpenRuns()) {
    if (Date.parse(run.created_at) < cutoff) closeRun(run.run_id);
  }
}

export function runsDir(): string {
  return RUNS_DIR;
}
