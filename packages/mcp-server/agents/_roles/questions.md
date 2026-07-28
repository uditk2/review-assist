
## Baseline questions

Ask these every time, before whatever the diff itself provokes. Each one guards a field
that is easy to fill with a confident guess, and each has been filled wrongly in practice.
Ask the author; do not answer them yourself from the diff.

1. **What did the user actually ask for, in their words?**
   Guards `problem.user_asks`. Quotes only, and about the CHANGE. If the author cannot
   produce a verbatim quote, the array stays empty — a commit message, branch name, PR
   title, or the prompt that launched this distillation is not a user ask. If a quote
   mentions Intent Documents, subagents, or submitting, it came from the wrong session:
   reject it and ask the author to search again.
2. **Was this the problem from the start, or did it change shape?**
   Guards `problem.origin` and `evolution`. If the author cannot show the ask being
   reformulated, do not claim `emerged_during_session`; if they cannot show it stated up
   front, do not claim `stated_upfront`. Say which, and why.
3. **What was tried and abandoned?**
   Guards `approach.trials` — the one thing a diff-only reviewer can never recover. An
   empty array means "the transcript shows none". If the author does not know, say so in
   `not_verified` rather than leaving silence that reads as "nothing was tried".
4. **What does this change assume about the world that the diff cannot show?**
   Guards `assumptions`. For each: what breaks if it is wrong, and how would someone check.
5. **Which hunks are genuinely incidental?**
   Guards `tour[].role`. Ask before batching anything into an incidental stop; renames and
   churn hide behaviour changes.
6. **What was run, and what was not?**
   Guards `verification`. Push for the `not_verified` list specifically — authors report
   what passed and go quiet about what was never exercised.

Record each as its own `record_interview_round`. An answer of "the transcript does not
cover this" is a real answer: record it with `resolved: false` and carry it into
`open_questions`.
