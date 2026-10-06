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

/** Polls with no progress before the response may stop encouraging the wait. */
export const STALL_POLLS = 8;

/**
 * Silence that counts as the author having returned, when it has NEVER called this run.
 *
 * Short on purpose: nothing is in flight, so there is nothing to be patient for.
 */
export const STALL_MS = 60_000;

/**
 * And the silence required once the author HAS called this run.
 *
 * Generous because the gap between its calls is set by how long the session is, not by
 * whether it is healthy: one page of a large spine, or a cold context index, is minutes of
 * legitimate quiet. The run that provoked this took 9m52s end to end, so a minute of
 * silence means nothing at all.
 */
export const STALL_MS_AFTER_ACTIVITY = 420_000;

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
    const patience = author_seen ? STALL_MS_AFTER_ACTIVITY : STALL_MS;
    const quiet = author_seen ? author_quiet_ms : stalled_ms;
    const stalled = unanswered > 0 && prior.polls >= STALL_POLLS && quiet >= patience;

    return { polls: prior.polls, stalled_ms, author_seen, author_quiet_ms, stalled };
  }
}
