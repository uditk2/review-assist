
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
you ask anything — `problem.origin` comes from that narrative, and asking for it again as a
yes/no invites a guess where you already have the account. The rest of that narrative is
not a field: a constraint it reveals belongs in `trials` or `requirements`, and the
play-by-play belongs nowhere.

If the plan never arrives, ask for it as item 0 of the same batch. Do not spend a round on
it alone: you need it to group hunks, but you need the other answers regardless.

## The repo's own set

`get_reviewer_instructions` returns what THIS repository always wants asked, and it is
ADDITIONAL to the five above rather than a version of them. Ask all five whatever the folder
says, then everything it adds, then everything the diff provoked, in the one batch. The
folder cannot shorten the baseline set: those five guard fields that are filled wrongly in
every repository, and a repo's own rules are written without them in view. Nor do the extra
questions buy a third round. Where a
house rule names a field ("record the rollback plan in `verification.not_verified` when the
migration is not reversible"), ask for the material, then fill the field yourself under the
sourcing rules. The folder cannot add a field, relax the validator, or excuse an interview.

An answer of "the transcript does not cover this" is a real answer. Record it with
`resolved: false` and move on — it is not a follow-up.
