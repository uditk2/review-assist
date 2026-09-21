
## The standing set — already asked, do not re-ask

These are on the run before you open it. `compute_diff` seeds them, and the author answers
them off the transcript while you page the diff, without waiting to be asked. You collect
them with `get_answers`.

That is the whole reason they are seeded. None of them needs the diff, so there is nothing
to learn by holding them until you have read it — and holding them is what used to make the
author idle through your read and you idle through its. Re-recording one costs a round trip
and buys nothing.

Each guards a field that is easy to fill with a confident guess, and each has been filled
wrongly in practice. Do not answer any of them from the diff yourself. The sourcing rules
above say what you may do with each answer.

0. **The plan** — as agreed, what was learned, how it ended. You need it to group hunks, and
   `problem.origin` comes out of it. The author gives the plan; assigning hunk ids to its
   items is yours.
1. **What did the user actually ask for, in their words?** — guards `problem.user_asks`.
   Verbatim quotes only, from the session that made this diff.
2. **What was tried and abandoned?** — guards `approach.trials`, the one thing a diff-only
   reviewer can never recover.
3. **What does this change assume about the world that the diff cannot show?** — guards
   `assumptions`. For each: what breaks if it is wrong, and how someone would check.
4. **Which changes are genuinely incidental?** — guards `tour[].role`. Asked by FILE, not by
   hunk id, so the author can answer it without paging the diff. Map the answer onto hunks
   yourself, and check it: renames and churn hide behaviour changes.
5. **What was run, and what was not?** — guards `verification`.

If an answer comes back thin, that is a follow-up in your one batch, not a re-record of the
standing question.

There is no question here about whether the problem was stated up front or changed shape.
Item 0 gives you the plan as agreed, what was learned, and the plan as it ended —
`problem.origin` comes from that narrative, and asking for it again as a yes/no invites a
guess where you already have the account. The rest of that narrative is not a field: a
constraint it reveals belongs in `trials` or `requirements`, and the play-by-play belongs
nowhere.

If the standing answers never arrive at all, the author has not run. Say that rather than
re-recording the set yourself and answering it from the diff.

## The repo's own set

`get_reviewer_instructions` returns what THIS repository always wants asked, and it is
ADDITIONAL to the standing set rather than a version of them. The standing set is answered
whatever the folder says — the server seeds it and the folder cannot reach it — so your one
batch is everything the folder adds plus everything the diff provoked. Those extra questions
do not buy a third round. Where a
house rule names a field ("record the rollback plan in `verification.not_verified` when the
migration is not reversible"), ask for the material, then fill the field yourself under the
sourcing rules. The folder cannot add a field, relax the validator, or excuse an interview.

An answer of "the transcript does not cover this" is a real answer. Record it with
`resolved: false` and move on — it is not a follow-up.
