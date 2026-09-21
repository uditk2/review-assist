# Distillation latency — where the time goes, and the plan

Measured over the 15 runs on disk in `~/.review-assist/runs/`, `created_at` to
`submitted_at`. Not estimated.

## Baseline

| Phase | Median | What happens in it |
|---|---|---|
| Run open to first answers landing | **670s (48%)** | Reviewer pages the whole diff and writes questions; author picks a transcript, pages the spine, answers 25 questions |
| Batch one answered to batch two answered | 250s | Reviewer drafts the document, then follows up |
| Last answer to submit | 305s | Drafting finished, validated, written |
| **Total** | **1400s** | Range 389s to 2242s |

The largest single in-run gap, in every multi-batch run, is the reviewer drafting
between batches: 303s, 330s, 544s, 592s, 916s.

Volume on the critical path, all of it serial:

- author answers: median **57.8 KB across 25 questions**, about **14.4K output tokens in
  one call**
- reviewer questions: 8.7 KB
- document: 6 to 60 KB

Spine extraction is a deterministic parse and costs nothing. The cost is generated
tokens on a chain where nothing overlaps.

## The four changes

### 1. Unblock parallel roles (doing first)

The two roles read independent things: the author needs only the transcript, the reviewer
only the diff. They run serially anyway, because the author cannot write anything until
the reviewer has recorded questions and handed back `q_id`s. That serialization is the
670s phase.

The fix is to seed the run with the questions that are known before the diff is read:

- the plan question (what was agreed, what was learned, how it ended)
- the five baseline questions in `agents/_roles/questions.md`

They do not depend on the diff, and `questionKey` is a content hash, so both roles derive
identical `q_id`s without talking to each other. The author answers them the moment it has
read the spine. The reviewer reads them off the run whenever its own diff pass finishes.

Effect: the 670s phase collapses to `max(spine read + standing answers, diff read)`, and
the reviewer's batch one loses the five baseline questions it no longer has to compose.

### 2. Write the per-hunk `what` during the diff read

Today the reviewer pages the diff, holds its account of each hunk in context, and emits
`tour[].what` at the very end. That is the 303 to 916s drafting gap.

Instead, emit one line per hunk id as the read happens, persisted on the run. Drafting
afterwards is only `why`, rationale, assumptions and verification. Persisting it keyed by
hunk content (not hunk id) also survives head drift, which currently costs a full
re-anchor.

### 3. Derive questions from the plan/hunk delta

Batch one today is a union: five baseline, plus house rules, plus everything the diff
provoked. That union is why the count is 18 to 34, and question count is what drives the
14.4K-token answer call.

With (1) and (2) done, the reviewer holds a per-hunk ledger and the author's plan with its
hunk mapping. Ask only where they disagree:

- a hunk in no plan item: discovered en route, or churn?
- a plan item with no hunk: dropped, or landed elsewhere?
- a hunk whose behaviour contradicts its plan item's stated goal
- plus the house rules
- plus follow-ups only where a standing answer came back thin

Expected: 25 questions down to about 12.

### 4. Shrink the tail

Several runs collapsed to a single batch already, and one shows a resubmit cycle after
head drift. Worth revisiting once (1) to (3) land, since the tail is mostly drafting that
(2) removes.

## Expected effect

| Change | Saving |
|---|---|
| 1. Parallel roles | 300 to 500s |
| 2. Per-hunk `what` during the read | 200 to 600s |
| 3. Delta-driven questions | 150 to 300s |

Plausible combined: 23 minutes down to 10 to 13.

## Invariant to preserve

The reviewer must still form its own account of the diff before it sees the author's
grouping. Today's boundary is right: the author gives the plan, the reviewer assigns hunk
ids to it. Running (1) and (2) concurrently preserves that, because neither role has seen
the other's output yet. A handoff where the author hands over a finished tour does not.
