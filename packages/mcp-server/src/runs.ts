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

import type { Meta } from "@review-assist/schema";
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

/**
 * Submitted runs are reaped sooner. A run whose document is written is probably finished —
 * but "probably" is the whole point: it is kept so a finding spotted after the fact can be
 * fixed and resubmitted against the same attested interview. A week is long enough for
 * that and short enough that finished work does not accumulate.
 *
 * Measured from the last touch, not from the submit, so a run that is still being worked
 * on keeps extending its own life.
 */
const MAX_SUBMITTED_RUN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
  answered_by?: "author" | "reviewer" | "user";
  /**
   * Put on the run by `openRun` rather than by the reviewer. The standing questions do
   * not depend on the diff, so seeding them is what lets the author answer before the
   * reviewer has read anything. An unanswered seeded question is not part of the
   * interview and `summarizeRun` does not count it.
   */
  seeded?: boolean;
  /**
   * Hunk ids this question is about, e.g. `["H4"]`.
   *
   * Recorded by the reviewer when it composes the question, because that is the only
   * moment anyone knows: the reviewer found the thin spot by reading a hunk. It cannot be
   * recovered afterwards — of 188 diff-provoked questions already on disk, 73 name a hunk
   * in their prose and the rest name none at all.
   *
   * What it buys is the link in `evaluated`: a reviewer who arrives holding the same
   * question lands on the code that settles it instead of a paragraph about it.
   */
  anchors?: string[];
  /**
   * How this question ENDED, when the developer themselves closed it.
   *
   * The interview already had a stopping rule — `MAX_BATCHES` — but it governs the
   * conversation, not the question. A halt is not a verdict: everything still open fell
   * into one undifferentiated bucket, so a secret blast radius nobody had considered
   * rendered exactly like "why did you pick this name".
   *
   * Measured across 32 runs, 279 diff-provoked rounds: 183 answered, 67 never answered at
   * all, 15 declined as not covered, 14 answered but left open. The 67 and the 15 are the
   * most valuable findings the system produces — an unanswered question about a code risk
   * means the risk was never considered — and they were the least distinguishable.
   *
   * So a question the developer closes says HOW:
   *
   * - `accepted_partial` — they know and are shipping anyway. A risk taken knowingly, not
   *   a gap. The reviewer should read it as a decision.
   * - `escalated` — they deliberately want a human reviewer's eyes on it. A request for
   *   attention, which is a different message from the one above.
   *
   * Absent means nobody closed it, and `unresolvedRounds` reports that as `unanswered`:
   * the weakest thing to publish, and the only true silence.
   */
  disposition?: "accepted_partial" | "escalated";
  at: string;
}

/** What the reviewer saw in one hunk, recorded as it read. */
export interface HunkNote {
  /** The hunk's `what`: one line, in the reviewer's own words. */
  note: string;
  /** The id it had when noted, so drift is visible rather than silent. */
  id_when_noted: string;
  path: string;
  at: string;
}

/** One plan item, and the hunks the reviewer judged to carry it. */
export interface PlanItemMapping {
  /** The plan item, in the author's words. */
  item: string;
  /** Content keys of the hunks carrying it. */
  keys: string[];
  /** The ids those hunks had when mapped, so drift is visible. */
  ids_when_mapped: string[];
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
  /** When a document was last written from this run. Absent until one is. */
  submitted_at?: string;
  /** Where that document went. */
  document_path?: string;
  /** Last time anything was written to this run. What the sweep measures. */
  updated_at?: string;
  /** Keyed by question hash, so re-recording a question replaces it. */
  rounds: Record<string, InterviewRound>;
  /**
   * One line per hunk, written while the diff is being READ rather than after.
   *
   * The largest single cost in a distillation is the reviewer drafting between interview
   * batches: measured over 15 runs, 303, 330, 544, 592 and 916 seconds, in every
   * multi-batch run. Almost all of it is the reviewer reconstructing an account of each
   * hunk it already formed once, because it held that account in context while paging and
   * emitted `tour[].what` only at the end. Written down as it reads, drafting afterwards is
   * `why`, rationale, assumptions and verification — the parts that genuinely need the
   * whole picture.
   *
   * KEYED BY HUNK CONTENT, not by hunk id. A hunk id is positional within one diff, so a
   * single commit renumbers every id from H1 and an id-keyed ledger would be silently
   * wrong: the note for H5 attached to whatever is H5 now. Content survives — the hunk
   * moves, renumbers, and its note follows it. Head drift already costs the reviewer its
   * anchors; it should not also cost the reading.
   */
  hunk_notes?: Record<string, HunkNote>;
  /**
   * The reviewer's own mapping of the author's plan items onto hunks.
   *
   * Recorded rather than held in context, for the reason the hunk ledger exists: what the
   * reviewer keeps in its head it has to rebuild later. With this stored the server can
   * compute the two halves of the plan/hunk delta — a hunk in no plan item, a plan item
   * with no hunk — which is what batch one should be asking about. Today batch one is a
   * union of the baseline set, the house rules and everything the diff provoked, which is
   * why the count runs 18 to 34, and question count is what drives the author's single
   * 14.4K-token answer call.
   *
   * The mapping stays the REVIEWER's. The author gives the plan and never the mapping: it
   * has not read the diff, and the assignment is the reviewer's independent read of the
   * change, which is the thing the role split exists to protect.
   *
   * Keyed by hunk content like the notes, so a commit that renumbers the diff does not
   * silently re-point a plan item at different code.
   */
  plan_map?: PlanItemMapping[];
  /**
   * How many batches of NEW questions the reviewer has recorded. Not the same as the
   * number of `record_interview_round` calls: re-recording a question the run already
   * holds is a free retry and does not spend a batch.
   *
   * Counted because the two-batch cap is the one protocol rule the server only asked
   * for. Three observed runs opened a third round after the author had already handed
   * back, which nothing can answer, and each burned an hour of the reviewer polling for
   * a reply that had nowhere to come from.
   */
  batches?: number;
}

/** The interview is capped at this many batches of new questions. */
export const MAX_BATCHES = 2;

export interface RunKey {
  repo: string;
  baseSha: string;
  headSha: string;
  /**
   * The branch this work sits on, taken from the repository's CHECKOUT rather than from
   * whatever ref the caller named as `head`. Part of the identity — see `computeRunId`.
   */
  branch?: string;
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
  /**
   * Answers the DEVELOPER gave, when neither the transcript nor the code could settle the
   * question. Counted apart from `author_attested` because it is a different and stronger
   * kind of authority, and because a reader deserves to know how much of a document rests
   * on a human's word rather than on a record of what happened.
   */
  developer_attested: number;
  /** Seeded questions the author has not answered yet. What it still owes. */
  standing_unanswered: number;
  /** Questions recorded with no answer from either side yet. */
  unanswered: number;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * The run's identity: the repository, what this work branched FROM, and which branch it is.
 * Derived only from what the change IS, so two agents that never speak arrive at the same
 * value — and deliberately not from where the branch has got to, so that value survives a
 * commit.
 *
 * Each of the three components earns its place, and the two that are NOT here matter too:
 *
 * - `base_sha` separates successive changes on one long-lived branch. Without it every
 *   change ever distilled on `main` would share one run and one rounds map.
 * - `branch` separates concurrent branches cut from the SAME base. Two branches off one
 *   commit have identical base SHAs however far they diverge, so without this they collide:
 *   one shared rounds map, and a `branch` field — which names `.intent/<branch>.json` —
 *   flipping to whichever role opened the run last. The head used to prevent that as a side
 *   effect; taking the head out to survive commits took the separation with it.
 * - `head_sha` is deliberately absent: it rotated the id on every commit, which is the
 *   regression this module's docblock opens with.
 *
 * The branch MUST be resolved from the repository's checkout, not from the `head` argument
 * a caller happens to pass. `git rev-parse --abbrev-ref <sha>` returns empty rather than a
 * name, so a reviewer naming an explicit SHA and an author naming HEAD would otherwise
 * derive different ids and silently stop sharing a run.
 *
 * Detached HEAD has no branch and contributes an empty component, so two detached
 * distillations off one base still collide. Rare enough to leave, but not silent: it is
 * written down here rather than discovered later.
 */
export function computeRunId({
  repo,
  baseSha,
  branch,
}: Pick<RunKey, "repo" | "baseSha" | "branch">): string {
  return sha256(`${resolve(repo)}|${baseSha}|${branch ?? ""}`).slice(0, 12);
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
 * Idempotent by construction: the id is a hash of the repo, the base and the branch, so
 * calling this twice — once from the author, once from the reviewer — yields one record,
 * not two. That holds only while both roles resolve the branch the same way; see
 * `computeRunId` on why it comes from the checkout.
 *
 * When the head has moved, the rounds are carried over UNCHANGED and the move is reported
 * back. Those are the two halves of the same decision: an interview is about the work, and
 * survives a commit; an anchor is about a diff, and does not. The caller is the only place
 * that can act on the second, so it is told rather than guessed at here.
 */
/**
 * The questions that are known before anyone reads anything.
 *
 * They are the reason the two roles used to run one after the other. The author's only
 * write is `answer_questions`, which takes q_ids, and q_ids only existed once the
 * reviewer had paged the whole diff and composed a batch. So the author sat idle through
 * the reviewer's read, then the reviewer sat idle through the author's, and the two
 * independent reads added up instead of overlapping. Measured across 15 runs, that phase
 * is 670s of a 1400s median.
 *
 * None of these depend on the diff: four are about the session, and the plan is about
 * what was agreed before any code moved. So `openRun` puts them on the run at open, both
 * roles derive the same q_ids from the same constant text (`questionKey` is a content
 * hash), and the author can answer the moment it has read the spine.
 *
 * What is NOT here is anything needing the hunk index. "Which hunks are incidental" is
 * asked by file, because the author would otherwise have to page the diff to answer it,
 * which is the reviewer's pass and puts the serialization straight back. Assigning hunk
 * ids to plan items stays the reviewer's job, as it always was.
 *
 * The wording is canonical here rather than in `agents/_roles/questions.md`, because the
 * id is a hash of the text: prose that drifts from this by a word produces a question the
 * author cannot answer by id. The role file describes what each one guards.
 */
export const STANDING_QUESTIONS: readonly string[] = [
  "PLAN: what did you and the user agree to do before the work began, what did you learn while doing it that changed that, and what was the plan as it ended? Trace each difference to the learning or the user turn that caused it, and quote the words. If the session had no plan worth the name, say so rather than inventing one.",
  "What did the user actually ask for, in their own words? Verbatim quotes only, from the session that made this diff. Not the commit message, branch name, PR title, or the prompt that launched this distillation. No quote means an empty answer, not a paraphrase.",
  "What was tried and abandoned? For each: what the candidate was, and why it died. If the transcript shows none, say that explicitly, because silence reads as 'nothing was tried'.",
  "What does this change assume about the world that the diff cannot show? For each assumption: what breaks if it is wrong, and how someone would check it.",
  "Which changes here are genuinely incidental rather than behaviour changes? Name them by file. Also name any file that looks like churn but is not, because that is the one a reviewer will skip.",
  "What was actually run, and what was not? Give the commands. Be specific about what was never exercised: that half is the one authors go quiet about.",
];

/**
 * Put any missing standing question on the run. Additive and idempotent: a question
 * already there keeps its answer, so backfilling an in-flight run cannot erase an
 * attestation, and a re-open cannot duplicate one.
 */
function seedStandingQuestions(run: RunRecord): boolean {
  const at = new Date().toISOString();
  let added = false;
  for (const question of STANDING_QUESTIONS) {
    const q_id = questionKey(question);
    if (run.rounds[q_id]) continue;
    run.rounds[q_id] = { q_id, question, answer: "", resolved: false, seeded: true, at };
    added = true;
  }
  return added;
}

export function openRun(key: RunKey): OpenRunResult {
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
    // Defensive only, now that the branch is part of the identity: a record reached by this
    // id was opened under this same branch, so this cannot overwrite one branch's name with
    // another's. It still guards the record against being blanked by a caller that omits it.
    if (key.branch) existing.branch = key.branch;
    // Backfill, so a run opened before the standing set existed gets it too.
    seedStandingQuestions(existing);
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
  seedStandingQuestions(run);
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
  rounds: { question: string; answer?: string; resolved?: boolean; anchors?: string[] }[]
): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  // A batch is spent only by questions this run has never held. A reviewer re-recording
  // one it already asked is retrying, which the guide promises costs nothing.
  if (rounds.some((r) => !run.rounds[questionKey(r.question)])) {
    run.batches = (run.batches ?? 0) + 1;
  }
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
      // A standing question the reviewer re-posts is still standing. Dropping the flag
      // here would let an unanswered one count as an interview round it never was.
      ...(prior?.seeded ? { seeded: true } : {}),
      ...(r.anchors?.length || prior?.anchors?.length
        ? { anchors: r.anchors?.length ? r.anchors : prior?.anchors }
        : {}),
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
  answers: {
    q_id: string;
    answer: string;
    resolved?: boolean;
    /**
     * `developer` marks an answer the human gave when neither transcript nor code could
     * settle the question. It is the strongest attestation the system has: the author
     * attests what the transcript SAYS, the developer attests what they INTENDED.
     */
    from?: "author" | "developer";
    disposition?: "accepted_partial" | "escalated";
  }[]
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
    // A disposition is how a question ENDED without being settled, so it never resolves
    // one. Treating it as resolved would hide the finding it exists to carry.
    round.resolved = a.disposition ? false : (a.resolved ?? true);
    round.answered_by = a.from === "developer" ? "user" : "author";
    if (a.disposition) round.disposition = a.disposition;
    round.at = at;
  }
  writeRun(run);
  return { run, unknown: Array.from(new Set(unknown)) };
}

/**
 * What the server stamps into `meta.interview`. Counts questions, not calls.
 *
 * A seeded question nobody answered is not a round. It was put on the run by the server
 * at open, so counting it would report an interview to every reader of the document
 * whether or not one happened — and `rounds: 0` on a single-pass generation with no
 * author is precisely the signal this figure exists to give. A seeded question the author
 * answered IS a round: the answer is the interview, not the asking.
 */
export function summarizeRun(run: RunRecord): InterviewSummary {
  const all = Object.values(run.rounds);
  const rounds = all.filter((r) => !r.seeded || r.answer.length > 0);
  return {
    rounds: rounds.length,
    questions_asked: rounds.length,
    unresolved: rounds.filter((r) => !r.resolved).length,
    author_attested: rounds.filter((r) => r.answered_by === "author").length,
    developer_attested: rounds.filter((r) => r.answered_by === "user").length,
    unanswered: rounds.filter((r) => r.answer.length === 0).length,
    standing_unanswered: all.filter((r) => r.seeded && r.answer.length === 0).length,
  };
}

/**
 * A hunk's identity for the ledger: its own text, whitespace-normalized.
 *
 * The header is deliberately excluded. `@@ -1,2 +1,3 @@` changes whenever anything above
 * the hunk shifts, so including it would make the key as fragile as the id it replaces:
 * the same change, one commit later, hashing differently and losing its note.
 */
export function hunkKey(hunkText: string): string {
  const body = hunkText
    .split("\n")
    .filter((l) => !l.startsWith("@@"))
    .join("\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return sha256(body).slice(0, 16);
}

/**
 * Record what the reviewer saw in a hunk. Re-noting the same hunk replaces the note: a
 * second look at a hunk is a correction, not a second hunk.
 */
export function recordHunkNotes(
  runId: string,
  notes: { key: string; note: string; id: string; path: string }[]
): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  run.hunk_notes = run.hunk_notes ?? {};
  for (const n of notes) {
    run.hunk_notes[n.key] = { note: n.note, id_when_noted: n.id, path: n.path, at };
  }
  writeRun(run);
  return run;
}

/**
 * Record the reviewer's plan-to-hunk mapping, replacing any previous one.
 *
 * Replaced wholesale rather than merged: a second mapping is the reviewer's considered
 * view after reading more, and a half-updated mapping would produce a delta that is wrong
 * in both directions at once.
 */
export function recordPlanMapping(
  runId: string,
  items: { item: string; keys: string[]; ids: string[] }[]
): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  const at = new Date().toISOString();
  run.plan_map = items.map((i) => ({ item: i.item, keys: i.keys, ids_when_mapped: i.ids, at }));
  writeRun(run);
  return run;
}

export interface PlanDelta {
  /** Hunks needing coverage that no plan item claims: discovered en route, or churn? */
  unclaimed: { key: string; note?: string }[];
  /** Plan items no hunk carries: dropped, or landed elsewhere? */
  unlanded: string[];
  /** Items mapped to hunks that are no longer in the diff. */
  stale: string[];
}

/**
 * Where the plan and the change disagree — which is the only place batch one has to ask.
 *
 * `unclaimed` and `unlanded` are the two questions worth a round trip, and each is a
 * genuine fork rather than a fishing expedition: a hunk no plan item claims is either
 * something found en route, often the most valuable stop in the document, or it is churn,
 * and only the author knows which. A plan item nothing carries was either dropped or it
 * landed somewhere the reviewer did not recognise.
 *
 * Agreement needs no question. A hunk that sits under the plan item that predicted it is
 * explained, and asking about it spends the author's one answer call on a confirmation.
 */
export function planDelta(run: RunRecord, presentKeys: Set<string>): PlanDelta {
  const map = run.plan_map ?? [];
  const claimed = new Set(map.flatMap((m) => m.keys));
  const notes = hunkNotes(run);
  return {
    unclaimed: Array.from(presentKeys)
      .filter((k) => !claimed.has(k))
      .map((k) => ({ key: k, ...(notes[k] ? { note: notes[k].note } : {}) })),
    unlanded: map.filter((m) => m.keys.length === 0).map((m) => m.item),
    stale: map.filter((m) => m.keys.length > 0 && m.keys.every((k) => !presentKeys.has(k))).map((m) => m.item),
  };
}

/**
 * Whether a document already at `path` is somebody ELSE's work rather than this run's.
 *
 * Guards the overwrite that happened: distilling on `main` replaced `.intent/main.json`, and
 * the file destroyed was complete — 16 of 16 questions attested, nothing unanswered — with a
 * one-sided document from an interview whose author had not answered. Nothing warned, and
 * only git got it back.
 *
 * THE TEST IS WHICH RUN WROTE IT, not which commit it describes. Comparing head SHAs looked
 * right and broke the correction cycle the guide promises: commit the document, fix a
 * finding, the branch moves because committing the document moved it, `compute_diff` again,
 * resubmit. The committed file then holds the old head while the run holds the new one, so a
 * head comparison refuses the very flow reviewer.md tells the reviewer to use — and the
 * advice it offers ("put this change on its own branch") is useless when it already is,
 * which would send every post-commit correction straight to `overwrite: true`.
 *
 * Ancestry was the other candidate and is wrong in the opposite direction: it allows the
 * drift case, but on a long-lived branch two distillations at successive points leave the
 * earlier head an ancestor of the later, so it waves through precisely the overwrite this
 * exists to stop.
 *
 * `document_path` is exact. A run records the file it wrote, so a resubmit from the same run
 * is a correction however far the branch has moved, and a file written by another run — or
 * committed by a person — is not this run's to replace.
 *
 * Anything unparseable counts as no clash: a file this cannot read is not evidence of work
 * worth protecting, and failing a submit over it would be worse than the overwrite.
 */
export function existingDocumentClash(
  path: string,
  range: { base_sha: string; head_sha: string },
  opts: { writtenByThisRun?: string } = {}
): { head_sha: string; base_sha?: string; interview?: string } | undefined {
  if (!existsSync(path)) return undefined;
  if (opts.writtenByThisRun && resolve(opts.writtenByThisRun) === resolve(path)) return undefined;
  try {
    const prior = JSON.parse(readFileSync(path, "utf8")) as {
      meta?: { commit_range?: { base_sha?: string; head_sha?: string }; interview?: unknown };
    };
    const priorHead = prior.meta?.commit_range?.head_sha;
    const priorBase = prior.meta?.commit_range?.base_sha;
    if (typeof priorHead !== "string") return undefined;
    // BOTH ends, because the comment said "commit range" while the code tested one. A
    // document with this head and a different base came from a different run and describes a
    // different change, and testing head alone let that one write silently — the only
    // direction this guard could fail open.
    const sameRange = priorHead === range.head_sha && priorBase === range.base_sha;
    if (sameRange) return undefined;
    return {
      head_sha: priorHead,
      ...(typeof priorBase === "string" ? { base_sha: priorBase } : {}),
      ...(prior.meta?.interview !== undefined ? { interview: summarizeForRefusal(prior.meta.interview) } : {}),
    };
  } catch {
    return undefined;
  }
}

/**
 * The prior document's interview, as a short string safe to echo.
 *
 * `.intent/*.json` is repository content and a fork's pull request can edit it, so this is
 * untrusted input of unbounded size being quoted back into a response. Every other response
 * in this server is bounded — `read_diff`, `get_spine`, `get_answers` all page — because a
 * 234KB response once spilled to disk and took a `run_id` with it. A refusal is the last
 * place to reintroduce that.
 *
 * It only has to convey how much would be lost, so the counts are read defensively and
 * anything else is dropped.
 */
function summarizeForRefusal(interview: unknown): string {
  if (!interview || typeof interview !== "object") return "(no interview recorded)";
  const iv = interview as Record<string, unknown>;
  const num = (k: string) => (typeof iv[k] === "number" ? String(iv[k]) : "?");
  return `rounds ${num("rounds")}, author_attested ${num("author_attested")}, unanswered ${num("unanswered")}`;
}

/** The notes on this run, by content key. */
export function hunkNotes(run: RunRecord): Record<string, HunkNote> {
  return run.hunk_notes ?? {};
}

/**
 * The questions a human reviewer might arrive holding, already answered.
 *
 * This is the lookup table behind the document's `evaluated` section, and the selection is
 * the whole idea. A question that has been answered and grounded is no longer a question:
 * putting it on the front page costs a reader time to conclude there is nothing to do,
 * and there is no limit to how many such questions an interview can produce. But thrown
 * away it is worse than useless, because a reviewer will spend minutes re-deriving an
 * answer somebody already has.
 *
 * So it is kept, out of the reading path, to be consulted on arrival at the same question.
 *
 * Two filters, both structural:
 *
 * - `seeded` is OUT. The standing six ask for the plan, the verbatim asks, the trials, the
 *   assumptions, the incidental files and what was run — and their answers already ARE the
 *   document's own fields. Measured across 32 runs on disk: 84 resolved standing answers,
 *   not one of which names a hunk. Including them would say everything twice.
 * - Unanswered and unresolved are OUT. An open question belongs on the front page as a
 *   live finding, which is the opposite of this section's purpose.
 *
 * What is left is the diff-provoked set: 188 across those 32 runs, 5.9 per document, and
 * they read exactly like a reviewer's own questions — whether a dispatch input is
 * restricted to a known list, whether the deployed Compose version supports a flag that
 * was used, whether a duplicated pinned SHA was meant to have a single source.
 */
export function evaluatedRounds(run: RunRecord): InterviewRound[] {
  return Object.values(run.rounds)
    .filter((r) => !r.seeded && r.resolved && r.answer.trim().length > 0)
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** How a question ended when it was never settled. */
export type Disposition = "accepted_partial" | "escalated" | "unanswered";

export interface UnresolvedRound {
  question: string;
  disposition: Disposition;
  /** Whatever was said about it: the developer's reason, or the author's non-answer. */
  note?: string;
  anchors?: string[];
}

/**
 * The questions that never got settled, each carrying HOW it ended.
 *
 * This is the half of the stopping rule that was missing. `MAX_BATCHES` says when to stop
 * asking; this says what each stopped question means, and the three outcomes are not the
 * same thing to a human reviewer:
 *
 * - `accepted_partial` — the developer knows and is shipping anyway. A decision.
 * - `escalated` — the developer wants a reviewer's eyes here. A request.
 * - `unanswered` — nobody engaged with it at all. The weakest, and the most common: 67 of
 *   279 diff-provoked rounds across 32 runs got no reply of any kind.
 *
 * Unanswered does NOT mean unimportant, and this is the inversion the old flat list hid.
 * The silent questions measured here include "env_file injects the ENTIRE backend env (DB
 * password, LLM API keys, JWT secret)" and "uses newrelic/infrastructure:latest while two
 * comments state pinned behaviour". An unanswered question about a code risk means the risk
 * was never considered, which makes it a STRONGER finding than one that got an answer.
 *
 * Seeded questions are excluded for the same reason they are excluded from `evaluated`:
 * they guard fields, and an unanswered one is reported by `standing_unanswered` already.
 */
export function unresolvedRounds(run: RunRecord): UnresolvedRound[] {
  return Object.values(run.rounds)
    .filter((r) => !r.seeded && !(r.resolved && r.answer.trim().length > 0))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
    .map((r) => {
      const note = r.answer.trim();
      return {
        question: r.question,
        disposition: r.disposition ?? "unanswered",
        ...(note ? { note } : {}),
        ...(r.anchors?.length ? { anchors: r.anchors } : {}),
      };
    });
}

/**
 * Would this call spend a batch, and has the run any batch left to spend?
 *
 * Asked BEFORE recording, so a refusal costs the reviewer nothing and leaves the run
 * exactly as it was. `fresh` is the questions the run has never held: if it is empty the
 * call is a retry and is always allowed, whatever the count.
 */
export function batchCheck(
  run: RunRecord,
  questions: string[]
): { fresh: string[]; batches_used: number; allowed: boolean } {
  const fresh = questions.filter((q) => !run.rounds[questionKey(q)]);
  const used = run.batches ?? 0;
  return { fresh, batches_used: used, allowed: fresh.length === 0 || used < MAX_BATCHES };
}

/** Exactly what `meta.interview` accepts. Type-only, so the bundle is unchanged. */
export type AttestedInterview = NonNullable<Meta["interview"]>;

/**
 * The summary narrowed to the fields the document may carry.
 *
 * `InterviewSummary` is the server's own bookkeeping and is free to grow; `meta.interview`
 * is a schema block with `additionalProperties: false`. Those two facts are compatible
 * only while something separates them, and nothing did: adding `standing_unanswered` to
 * the summary stamped a sixth key into every document, and because the stamp happens
 * before validation, every submit failed at once — the server's own attestation making
 * its own schema unsatisfiable. Naming the fields here keeps the document's contract at
 * the point of the write, so the next field added to the summary stays internal. The
 * return type is the schema's, so adding one without widening the schema is a type error
 * rather than a runtime failure discovered by a reviewer mid-distillation.
 */
export function attestedInterview(summary: InterviewSummary): AttestedInterview {
  return {
    rounds: summary.rounds,
    questions_asked: summary.questions_asked,
    unresolved: summary.unresolved,
    author_attested: summary.author_attested,
    developer_attested: summary.developer_attested,
    unanswered: summary.unanswered,
  };
}

/** Rounds in the order they were first recorded, for callers that want the content. */
export function runRounds(run: RunRecord): InterviewRound[] {
  return Object.values(run.rounds).sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Record that a document was written from this run, and KEEP the run.
 *
 * Submit used to call `closeRun` here. That destroyed the interview at the one moment it
 * was most likely to be needed again: the guide tells a reviewer to fix findings and
 * resubmit, and committing the document is itself a commit, so the ordinary correction
 * cycle ran straight into a deleted run. Worse than an error — `openRun` recreates a
 * record for an id it cannot find, so the next `answer_questions` landed on a fresh, empty
 * run under the same handle and came back `unknown_q_ids`, `rounds: 0`, silently.
 *
 * Keeping it costs one file per branch for a week (see MAX_SUBMITTED_RUN_AGE_MS). Closing
 * it cost the whole resubmit path.
 */
export function markSubmitted(runId: string, documentPath: string): RunRecord | undefined {
  const run = readRun(runId);
  if (!run) return undefined;
  run.submitted_at = new Date().toISOString();
  run.document_path = documentPath;
  writeRun(run);
  return run;
}

/**
 * Delete a run outright. The sweep's tool, and available for an explicit discard — NOT
 * called on submit; see `markSubmitted` for why.
 */
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

/**
 * A run follows one branch. One untouched for a month is abandoned; one whose document was
 * already written is kept a week, long enough to resubmit against the same interview.
 */
function sweepStaleRuns(): void {
  if (!existsSync(RUNS_DIR)) return;
  const now = Date.now();
  for (const run of listOpenRuns()) {
    const maxAge = run.submitted_at ? MAX_SUBMITTED_RUN_AGE_MS : MAX_RUN_AGE_MS;
    if (Date.parse(lastTouched(run)) < now - maxAge) closeRun(run.run_id);
  }
}

export function runsDir(): string {
  return RUNS_DIR;
}
