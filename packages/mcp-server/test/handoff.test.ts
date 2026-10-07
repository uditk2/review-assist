/**
 * Telling a working author from an absent one.
 *
 * The reviewer waits on the run and the server says when to stop, because the author is a
 * subagent that does not idle: if it has finished it has already returned. Three runs polled
 * 2122, 1998 and 1668 times discovering that, which is why the signal exists.
 *
 * It was decided on ANSWERS alone, and that was wrong in the case it most needed to be right.
 * Measured: the reviewer polled 33 times over 148s, was told to stop, reported "the author
 * role never ran", and submitted a one-sided document with 11 unanswered questions — while
 * the author ran 9m52s and returned all 17 answers attested. An answer is nearly the LAST
 * thing the author produces; before it come transcript ranking, five spine pages of a
 * 2143-entry session, and 21 recorded contexts.
 *
 * The error also gets likelier as the reviewer gets faster, since a three-hunk diff is read
 * in seconds and can spend eight polls before the author's first page.
 */

import { describe, it, expect } from "vitest";
import { Handoff, STALL_POLLS, STALL_MS, STALL_MS_AFTER_ACTIVITY, patienceFor } from "../src/handoff.js";

/** A controllable clock: a stall measured in minutes is otherwise untestable by waiting. */
function at(start = 1_000_000) {
  let t = start;
  return { tick: (ms: number) => (t += ms), handoff: new Handoff(() => t) };
}

const RUN = "r1";
/** Poll `n` times with nothing changing, returning the last verdict. */
const pollTimes = (h: Handoff, n: number, answered = 0, unanswered = 3) => {
  let v = h.notePoll(RUN, answered, unanswered);
  for (let i = 1; i < n; i++) v = h.notePoll(RUN, answered, unanswered);
  return v;
};

describe("an author that has never called the run", () => {
  it("is declared gone once the short patience is spent", () => {
    // The case the warning was built for: nothing is in flight, so waiting buys nothing.
    const { handoff, tick } = at();
    let v = pollTimes(handoff, STALL_POLLS);
    expect(v.stalled).toBe(false); // polls alone must not end it
    tick(STALL_MS);
    v = handoff.notePoll(RUN, 0, 3);
    expect(v.author_seen).toBe(false);
    expect(v.stalled).toBe(true);
  });

  it("is not declared gone on poll count alone, however many", () => {
    // A reviewer with a tiny diff burns polls in seconds. That says nothing about the author.
    const { handoff } = at();
    expect(pollTimes(handoff, 50).stalled).toBe(false);
  });
});

describe("an author that is demonstrably working", () => {
  it("survives the silence that used to end the wait", () => {
    // The exact failure: 148s and 33 polls, with the author mid-read.
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN); // picked a transcript
    tick(148_000);
    const v = pollTimes(handoff, 33);
    expect(v.author_seen).toBe(true);
    expect(v.stalled).toBe(false);
  });

  it("survives a nine-minute read, which is what the real one took", () => {
    const { handoff, tick } = at();
    // Heartbeats as it goes: a context recorded every spine page.
    for (let page = 0; page < 5; page++) {
      handoff.noteAuthorActivity(RUN);
      tick(110_000);
      expect(pollTimes(handoff, 10).stalled).toBe(false);
    }
    expect(handoff.notePoll(RUN, 0, 3).stalled).toBe(false);
  });

  it("is eventually declared gone, so a crashed author cannot hang the reviewer", () => {
    // Past the patience for THIS many outstanding questions, not past the flat base: the
    // base alone no longer ends the wait, because the answer batch legitimately exceeds it.
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN);
    tick(patienceFor(3) + 1);
    expect(pollTimes(handoff, STALL_POLLS).stalled).toBe(true);
  });

  it("measures silence from the LAST call, not the first", () => {
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN);
    tick(STALL_MS_AFTER_ACTIVITY - 1_000);
    handoff.noteAuthorActivity(RUN); // still alive
    tick(60_000);
    expect(pollTimes(handoff, STALL_POLLS).stalled).toBe(false);
  });
});

describe("a new answer", () => {
  it("resets the watch outright", () => {
    const { handoff, tick } = at();
    tick(STALL_MS * 10);
    pollTimes(handoff, STALL_POLLS * 2);
    const v = handoff.notePoll(RUN, 1, 2); // one answer arrived
    expect(v.polls).toBe(1);
    expect(v.stalled_ms).toBe(0);
    expect(v.stalled).toBe(false);
  });
});

describe("nothing left to wait for", () => {
  it("never reports stalled when every question is answered", () => {
    // Being told to stop polling when there is nothing outstanding would read as a fault.
    const { handoff, tick } = at();
    tick(STALL_MS * 100);
    expect(pollTimes(handoff, STALL_POLLS * 3, 0, 0).stalled).toBe(false);
  });
});

describe("runs are independent", () => {
  it("does not let one run's author vouch for another's", () => {
    const { handoff, tick } = at();
    handoff.noteAuthorActivity("busy");
    // The watch on a run starts at its FIRST poll, so the wait has to actually elapse.
    let v = handoff.notePoll("idle", 0, 1);
    tick(STALL_MS);
    for (let i = 1; i < STALL_POLLS; i++) v = handoff.notePoll("idle", 0, 1);
    expect(v.author_seen).toBe(false);
    expect(v.stalled).toBe(true);
    // And the busy run's heartbeat is still its own.
    expect(handoff.notePoll("busy", 0, 1).author_seen).toBe(true);
  });
});

/**
 * What the reviewer is waiting for includes the STANDING set.
 *
 * `summarizeRun` drops unanswered seeded questions from `rounds`, so its `unanswered` is 0
 * for any run whose only outstanding questions are the standing six — which is every run
 * before the reviewer records a batch. Passing that figure in made the whole watch inert in
 * exactly the window the reviewer spends waiting for the standing answers, and the response
 * said "all of them are answered" while six were not.
 *
 * `notePoll` takes the real outstanding count, so these pin that it behaves on that number
 * rather than on how the count was derived.
 */
describe("the outstanding count", () => {
  it("engages the watch when only standing questions are outstanding", () => {
    const { handoff, tick } = at();
    let v = handoff.notePoll(RUN, 0, 6); // six standing, nothing else
    tick(STALL_MS);
    for (let i = 1; i < STALL_POLLS; i++) v = handoff.notePoll(RUN, 0, 6);
    expect(v.stalled).toBe(true);
  });

  it("still waits on those when the author is demonstrably working", () => {
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN);
    tick(148_000);
    expect(pollTimes(handoff, 33, 0, 6).stalled).toBe(false);
  });
});

/**
 * Patience has to cover the answer batch, which is the gap that actually matters.
 *
 * The flat seven minutes was sized against a run that took 9m52s END TO END, which is not
 * the largest gap between two author calls. The author answers a whole batch in ONE call, so
 * from the server's side there is no contact from the moment it starts composing until the
 * answers land — and that stretch grows with the number of questions asked.
 *
 * Measured by living through it: a reviewer asked 17 on top of the standing 6, the author
 * went quiet for 426s composing 23 answers, crossed the flat 420s, and was declared gone.
 * The same false negative, one step on, and punishing the thorough reviewer: more questions
 * meant a longer batch meant a likelier cliff.
 */
describe("patience for the answer batch", () => {
  it("covers the 426s gap that misfired, for the batch that caused it", () => {
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN); // last call before it starts composing
    tick(426_000);
    expect(pollTimes(handoff, 40, 0, 23).stalled).toBe(false);
  });

  it("grows with the number of questions outstanding", () => {
    expect(patienceFor(23)).toBeGreaterThan(patienceFor(6));
    expect(patienceFor(6)).toBeGreaterThan(STALL_MS_AFTER_ACTIVITY - 1);
  });

  it("still gives up eventually, so a crashed author cannot hang the reviewer", () => {
    const { handoff, tick } = at();
    handoff.noteAuthorActivity(RUN);
    tick(patienceFor(23) + 1);
    expect(pollTimes(handoff, STALL_POLLS, 0, 23).stalled).toBe(true);
  });

  it("does not extend patience for an author never seen", () => {
    // Nothing is composing, so there is nothing to be patient for however many questions.
    const { handoff, tick } = at();
    let v = handoff.notePoll(RUN, 0, 23);
    tick(STALL_MS);
    for (let i = 1; i < STALL_POLLS; i++) v = handoff.notePoll(RUN, 0, 23);
    expect(v.stalled).toBe(true);
  });
});
