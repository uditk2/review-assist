
## Baseline questions

Ask these every time, before whatever the diff itself provokes. Send all six to the
author in ONE exchange and record them as ONE `record_interview_round` call. They are
independent and known in advance; asking them serially buys nothing but round-trips.

Each guards a field that is easy to fill with a confident guess, and each has been
filled wrongly in practice. Ask the author; do not answer them from the diff yourself.
The sourcing rules above say what you may do with each answer.

1. **What did the user actually ask for, in their words?** — guards `problem.user_asks`.
   Verbatim quotes only, from the session that made this diff.
2. **Was this the problem from the start, or did it change shape?** — guards
   `problem.origin` and `evolution`.
3. **What was tried and abandoned?** — guards `approach.trials`, the one thing a
   diff-only reviewer can never recover.
4. **What does this change assume about the world that the diff cannot show?** — guards
   `assumptions`. For each: what breaks if it is wrong, and how someone would check.
5. **Which hunks are genuinely incidental?** — guards `tour[].role`. Ask before batching
   anything into an incidental stop; renames and churn hide behaviour changes.
6. **What was run, and what was not?** — guards `verification`.

An answer of "the transcript does not cover this" is a real answer. Record it with
`resolved: false` and carry it into `open_questions` — do not ask it again.
