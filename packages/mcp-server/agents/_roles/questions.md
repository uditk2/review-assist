
## The baseline set

Send these in the same batch as your diff-provoked questions — one message to the author,
one `record_interview_round` call. They are independent and known in advance; asking them
serially buys nothing but round-trips.

Each guards a field that is easy to fill with a confident guess, and each has been filled
wrongly in practice. Ask the author; do not answer them from the diff yourself. The sourcing
rules above say what you may do with each answer.

1. **What did the user actually ask for, in their words?** — guards `problem.user_asks`.
   Verbatim quotes only, from the session that made this diff.
2. **What was tried and abandoned?** — guards `approach.trials`, the one thing a diff-only
   reviewer can never recover.
3. **What does this change assume about the world that the diff cannot show?** — guards
   `assumptions`. For each: what breaks if it is wrong, and how someone would check.
4. **Which hunks are genuinely incidental?** — guards `tour[].role`. Ask before batching
   anything into an incidental stop; renames and churn hide behaviour changes.
5. **What was run, and what was not?** — guards `verification`.

There is no question here about whether the problem was stated up front or changed shape.
The author hands you the plan as agreed, what was learned, and the plan as it ended, before
you ask anything — `problem.origin` and `evolution` come from that narrative, and asking for
it again as a yes/no invites a guess where you already have the account.

If the plan never arrives, ask for it as item 0 of the same batch. Do not spend a round on
it alone: you need it to group hunks, but you need the other answers regardless.

An answer of "the transcript does not cover this" is a real answer. Record it with
`resolved: false` and move on — it is not a follow-up.
