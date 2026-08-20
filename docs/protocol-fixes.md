# Protocol bugs — verdicts and status

Three bugs reported from three live distillations (airo-backend, seerly-front, and one
other). Verified against the source; one report was partly wrong and one was already fixed.

## Verdicts

**1. Attestation does not survive submit — CONFIRMED, worse than reported.**

Two independent causes, not one:

- `submit_document` called `closeRun` after a successful write.
- The run id was `sha256(repo | base | head)`, so it rotated on *every* commit — and
  committing the Intent Document is itself a commit.

Either way the run disappears, and `openRun` then recreates an empty record under the same
handle. The author's next `answer_questions` returns `unknown_q_ids` with `rounds: 0` and
no error. That is the reported symptom, exactly.

Correction to the report: a **validation failure does not** cost a re-attestation cycle.
That path returns before the write, so the run survives — the guide's "fix them and
resubmit" holds. What was one-shot was resubmitting *after a successful submit*.

Evidence on disk before the fix — `feat/ads-impl`, one base per repo:

| repo | run files | rounds |
|---|---|---|
| airo-backend | 4 | 21, 23, 26, 0 |
| seerly-front | 3 | 23, 24, 26 |

Each row is the same interview re-asked after the head moved.

**2. No reviewer tool returns the author's answer text — CONFIRMED, but it is a
documentation split rather than a missing feature.**

`record_interview_round` projects away the `answer` field it already holds, and no tool in
`ROLE_TOOLS.reviewer` returns it. The prose relay *is* the intended design — but it is
stated only in the author role definition ("Reply in prose too, so the reviewer can work"),
and nowhere in the reviewer definition or the generation guide. So reviewers read the
missing bodies as a server bug and stall. All three did.

**3. Hunk ids shift when the document is committed — HALF ALREADY FIXED.**

`coverage_required: false` for `.intent/` was already implemented. The renumbering is real:
`.intent/<branch>.json` sorts first in git's path order, so it lands as H1 and shifts
everything by one. Excluding it from *numbering* (as proposed) would break the documented
property that counting the raw diff reproduces the index.

## Done

**Fix 2 — run identity** (`fa39bfb`)

- Run id became `sha256(repo | base)`. The head is state on the record, not identity.
  (Superseded below: the branch was added to the key to fix a collision this introduced.)
- `openRun` moves an existing run to the observed head, keeps the prior value in
  `head_history`, and carries the rounds over untouched.
- The move is reported as `head_changed` / `previous_head` on the call that observes it,
  with an explicit instruction to re-anchor: an interview is about the work and survives a
  commit; an anchor is about a diff and does not.
- The submit-time drift error now says the `run_id` is unchanged and the interview
  survived, instead of handing over a new id.
- The sweep measures `updated_at`, not `created_at` — a run used to die with its commit and
  now follows a branch to its merge.
- Guide and reviewer role definition updated to match. 129 tests pass, including the
  regression: record rounds → head moves → author answers by the pre-move `q_id` →
  `unknown: []`, `author_attested: 1`.

**Fix 1 — the run survives its own document**

- `submit_document` no longer calls `closeRun`. It calls `markSubmitted`, which stamps
  `submitted_at` and `document_path` and keeps the record.
- The sweep is tiered: an unsubmitted run is reaped after 30 days untouched, a submitted one
  after 7. Both measured from last touch, so continued work extends the life of either.
- The submit response now reports `run_id`, `resubmit: true` with `previously_submitted_at`
  on a correction, and states that the run stays open.
- `closeRun` still exists — it is the sweep's tool and remains available for an explicit
  discard. It is simply not what submit does.
- Guide and reviewer definition updated. Tests: `markSubmitted` keeps the interview, the
  author can still answer after a document is written, and the tiered sweep is pinned.

**The `list_transcripts` space bug** (found by the author role during the Fix 2 distillation)

- Claude Code replaces more than path separators when flattening a cwd into a directory
  name: `.../engagement apps/review-assist` is filed under `...-engagement-apps-review-assist`.
  `encodeRepoDir` replaced only `/` and `\`, so the lookup built a path that did not exist.
- The failure was silent in the worst way — no error, no candidates, and the author role
  hydrating from an empty set instead of reporting that it could not see the session.
- Fixed by matching on a key insensitive to *which* characters were replaced (collapse runs
  of non-alphanumerics to one dash on both sides) rather than by reconstructing someone
  else's encoder, which would fail silently again on the next unpredicted character.
- Regression test verified to fail against the old lookup and pass against the new one.

**The same-base branch collision** (introduced by Fix 2, found by the reviewer)

- `run_id` is now `sha256(repo | base_sha | branch)`. Each component earns its place: the
  base separates successive changes on a long-lived branch like `main`, the branch separates
  concurrent branches cut from one commit, and the head stays out so commits do not rotate
  the id.
- Keying on branch alone was considered and rejected: every change ever distilled on `main`
  would then share one run and one rounds map.
- The branch is resolved from the repository's **checkout**, not from the `head` argument.
  `git rev-parse --abbrev-ref <sha>` returns empty rather than a name, so a reviewer naming
  an explicit SHA and an author naming HEAD would otherwise derive different ids and
  silently stop sharing a run.
- Known and left: a detached HEAD contributes an empty branch component, so two detached
  distillations off one base still collide. Written down in `computeRunId` rather than
  discovered later.
- Tests verified to fail without the branch component: two branches off one base get
  distinct ids, do not share an interview, and do not overwrite each other's `branch` field.

## Outstanding

**The weak test.** `computeRunId`'s "survives the branch moving" test asserts the same
expression twice and cannot fail as named. The real coverage is the correction-cycle test
and the one-file assertion; this one should be deleted or rewritten.

**Fix 3 — reviewer-visible answers.** Two parts: add `answer`/`resolved` to the projection
`record_interview_round` already returns, and add `get_answers({run_id})` for the reviewer
and author. Then state the answer path in the reviewer definition and the guide, which is
what actually stalled the three reviewers.

A shared file plus a notify trigger was considered and rejected: the run file already *is*
the shared state, and under Claude Code the two roles never run concurrently — the parent
blocks on one subagent before dispatching the other, so there is nobody listening when the
file changes. Monitor is also unavailable to these roles, since the rendered `tools:`
allowlist is exclusively `mcp__review-assist__*` and that allowlist is the role split. A
blocking `await_answers` is only worth building if the roles are ever run as concurrent
sessions.

**Fix 4 — hunk-id stability.** Exclude `.intent/` from the diff itself via a git pathspec in
`computeDiff` rather than from the numbering. One choke point covers `compute_diff`,
`read_diff` and `submit_document`; it removes the `coverage_required` special case instead
of adding one, and preserves countability because the diff the reviewer reads is the diff
that was numbered.
