/**
 * Telling a working author from an absent one.
 *
 * The two roles meet only on the run: the reviewer calls `get_answers` and waits. That wait
 * needs an end, because the author is a subagent and does not idle — if it has finished it
 * has already returned, and no amount of polling will produce an answer. Three observed runs
 * polled 2122, 1998 and 1668 times discovering that.
 *
 * So the server tells the reviewer when to stop. The first version decided on ANSWERS alone:
 * no new answer for 60s, or eight consecutive polls, meant the author had gone. That was
 * wrong in the one case it most needed to be right.
 *
 * Measured, on the run that provoked this module: the reviewer polled 33 times over 148s,
 * was told to stop, reported "the author role never ran", and submitted a one-sided document
 * with 11 unanswered questions. The author ran for 9 minutes 52 seconds and returned all 17
 * answers attested. Nothing had failed except the signal.
 *
 * The reason is that an answer is almost the LAST thing the author produces. Before it:
 * ranking candidate transcripts, paging a spine — five pages of a 2143-entry session — and
 * recording 21 contexts. Minutes of unmistakable work, none of it an answer.
 *
 * The direction of the error matters. A reviewer reading a three-hunk diff is done in
 * seconds and can spend eight polls while the author is still on its first page, so the
 * faster the diff read becomes the more likely this misfires — which means the work done to
 * make the reviewer quick made this worse, not better.
 *
 * Hence two signals rather than one. Any author CALL on the run is a heartbeat, and silence
 * is measured from that. How much silence counts depends on whether the author was ever
 * seen: never seen is the case the warning was built for (an author that was never
 * dispatched, where saying so quickly saves a pointless wait), while one that has been seen
 * gets the benefit of the doubt for long enough to read a large session.
 *
 * In memory on purpose: this is a property of one waiting reviewer's conversation with this
 * server process, not of the run, and persisting it would mean a disk write per poll.
 */

/**
 * Polls with no progress before the response may stop encouraging the wait.
 *
 * Two, not eight, now that a waiting call is held for up to ANSWER_WAIT_MS. Eight was sized
 * for a reviewer calling every 10 to 20 seconds, a couple of minutes; eight HELD calls are
 * about seven, which is how long an author that was never dispatched took to report. With
 * held calls about 53s apart (measured live), silence passes STALL_MS between the second
 * and third, so the verdict lands on the third call, about two and a half minutes in.
 */
export const STALL_POLLS = 2;

/**
 * Silence that counts as the author having returned, when it has NEVER called this run.
 *
 * Short on purpose: nothing is in flight, so there is nothing to be patient for.
 */
export const STALL_MS = 60_000;

/**
 * Base silence allowed once the author HAS called this run.
 *
 * Generous because the gap between its calls is set by how long the session is, not by
 * whether it is healthy: one page of a large spine, or a cold context index, is minutes of
 * legitimate quiet.
 */
export const STALL_MS_AFTER_ACTIVITY = 420_000;

/**
 * Extra patience per outstanding question.
 *
 * The flat 420_000 was sized against the wrong quantity. It was justified by one run taking
 * 9m52s END TO END, which is not the largest gap between two of the author's calls — and the
 * gap that actually matters is the answer batch itself. The author answers a whole batch in
 * ONE call, so from the server's side there is no contact at all from the moment it starts
 * composing until the answers land, and that stretch grows with the number of questions.
 *
 * Measured by living through it: a reviewer asked 17 questions on top of the standing 6, the
 * author went quiet for 426s composing 23 answers, crossed the flat 420s, and was declared
 * gone — the same false negative this module exists to remove, one step further on.
 *
 * The perverse direction is the point. A thorough reviewer asks more, which makes the batch
 * longer, which makes the cliff likelier: being careful was punished. So patience scales
 * with what is actually being waited for.
 */
export const STALL_MS_PER_QUESTION = 45_000;

/** How long to stay patient with an author known to be working on `outstanding` questions. */
export function patienceFor(outstanding: number): number {
  return STALL_MS_AFTER_ACTIVITY + STALL_MS_PER_QUESTION * Math.max(0, outstanding);
}

/**
 * How long a waiting `get_answers` call is held before it returns with nothing new.
 *
 * The reviewer has no clock and no way to sleep, so left alone it calls `get_answers` again
 * the moment its turn ends: every 10 to 20 seconds, each call a tool round trip and a reread
 * of the same "still waiting". Holding the call on the server turns that into about one call
 * a minute, and the call returns as soon as an answer lands, so a fast author is not slowed.
 *
 * 50s rather than 60 because 60s is where clients cut a tool call off: Codex's default
 * `tool_timeout_sec`, and the MCP SDK's default request timeout some hosts use. With the
 * reviewer's own turn on top, 50s held is still roughly a minute between calls.
 * REVIEW_ASSIST_ANSWER_WAIT_MS overrides it; 0 answers immediately.
 */
export const ANSWER_WAIT_MS = 50_000;

/** How often a held call rereads the run. The answers arrive from another call, on disk. */
export const ANSWER_WAIT_TICK_MS = 2_000;

export function answerWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.REVIEW_ASSIST_ANSWER_WAIT_MS;
  if (raw === undefined || raw.trim() === "") return ANSWER_WAIT_MS;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : ANSWER_WAIT_MS;
}

export interface AnswerProgress {
  /** Changes whenever any answer is added or replaced, not only when the count moves. */
  answers: string;
  outstanding: number;
}

/**
 * Wait until an answer lands or changes, nothing is outstanding, the run disappears, the caller
 * cancels, or `waitMs` passes, whichever comes first. `read` rereads the run each tick.
 *
 * Returns how long it held. The stall verdict is unchanged by this: it is measured in time,
 * and a held call simply lets that time pass in one call instead of five.
 */
export async function holdForAnswer(
  read: () => AnswerProgress | undefined,
  opts: { waitMs: number; tickMs?: number; signal?: AbortSignal; now?: () => number; sleep?: (ms: number) => Promise<void> }
): Promise<number> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const tick = opts.tickMs ?? ANSWER_WAIT_TICK_MS;
  const start = read();
  const began = now();
  if (!start || start.outstanding === 0 || opts.waitMs <= 0) return 0;
  const deadline = began + opts.waitMs;
  while (now() < deadline && !opts.signal?.aborted) {
    await sleep(Math.min(tick, deadline - now()));
    const cur = read();
    if (!cur || cur.answers !== start.answers || cur.outstanding === 0) break;
  }
  return now() - began;
}

interface PollState {
  answered: number;
  polls: number;
  since: number;
}

export interface PollVerdict {
  polls: number;
  /** How long there has been no NEW answer. */
  stalled_ms: number;
  /** Whether any author call has ever been seen on this run. */
  author_seen: boolean;
  /** How long since the last author call. `Infinity` when never seen. */
  author_quiet_ms: number;
  /** Whether the reviewer should stop waiting. */
  stalled: boolean;
}

/**
 * One server process's view of the handoff. A class rather than module state so a test can
 * have its own, and so the clock is injectable — a stall measured in minutes is otherwise
 * untestable except by waiting minutes.
 */
export class Handoff {
  private polls = new Map<string, PollState>();
  private lastAuthorCall = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** Called by every author-side tool that knows its run: the heartbeat. */
  noteAuthorActivity(runId: string): void {
    this.lastAuthorCall.set(runId, this.now());
  }

  /**
   * Record a reviewer poll and say whether to keep waiting.
   *
   * `unanswered` is how many questions still have no answer; with none, nothing is being
   * waited for and the verdict is never stalled.
   */
  notePoll(runId: string, answered: number, unanswered: number): PollVerdict {
    const now = this.now();
    const seenAt = this.lastAuthorCall.get(runId);
    const author_seen = seenAt !== undefined;
    const author_quiet_ms = seenAt === undefined ? Infinity : now - seenAt;

    const prior = this.polls.get(runId);
    // A new answer resets the watch outright: the author is alive and writing, and waiting
    // for it is exactly the right thing to do.
    if (!prior || prior.answered !== answered) {
      this.polls.set(runId, { answered, polls: 1, since: now });
      return { polls: 1, stalled_ms: 0, author_seen, author_quiet_ms, stalled: false };
    }
    prior.polls += 1;
    const stalled_ms = now - prior.since;

    // Poll COUNT alone can no longer end the wait; it only gates it. What ends the wait is
    // silence from the author, and how much depends on whether it was ever there.
    const patience = author_seen ? patienceFor(unanswered) : STALL_MS;
    const quiet = author_seen ? author_quiet_ms : stalled_ms;
    const stalled = unanswered > 0 && prior.polls >= STALL_POLLS && quiet >= patience;

    return { polls: prior.polls, stalled_ms, author_seen, author_quiet_ms, stalled };
  }
}
