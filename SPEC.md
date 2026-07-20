# Intent Document Specification — Draft v0.1

An open format for AI change-intent. Produced from an agent coding session by a two-agent
(author/reviewer) distillation pipeline; validated mechanically against the diff; rendered
as a guided review experience on top of the pull request.

**Status:** draft for discussion · **Schema version:** `0.1`

---

## 1. Design principles

1. **Session-derived, not diff-inferred.** Every claim traces back to something that
   happened in the authoring session (or to the code itself). This is the property
   diff-only tools cannot replicate.
2. **Mechanically anchored.** Every guided-tour stop points at concrete diff hunks pinned
   to a commit SHA. The union of anchors must cover the diff; anything uncovered is
   flagged as *unexplained change*.
3. **Assumptions before code.** The cheapest thing to review and the most expensive thing
   to get wrong is surfaced first.
4. **Honest about confidence.** Fields carry provenance markers; what the interview could
   not resolve is listed as an open question, never smoothed over.
5. **The document is a curated artifact, never the raw session.** Redaction is a
   first-class generation step.

## 2. Document lifecycle

```
authoring session (Claude Code / Cursor / …)
        │  JSONL transcript on disk
        ▼
distillation pipeline (triggered by skill, session-end hook, or CI)
  ├─ author agent    — hydrated from full transcript
  ├─ reviewer agent  — starts from the diff, investigates, interviews the author
  │    (bounded dialogue; answers are folded into fields, not kept as a transcript)
  ▼
intent document  →  validator (schema, coverage, staleness, redaction lint)
        │  committed to the PR branch: .intent/<pr-or-branch>.json
        ▼
renderers: browser extension (guided UX) · markdown fallback (PR description/comment)
```

A document describes exactly one commit range. New pushes regenerate or append a new
document version; the validator fails CI if the committed document is stale.

## 3. Sections

### 3.1 `meta`
Identification and staleness anchoring.

| Field | Type | Notes |
|---|---|---|
| `schema_version` | string | `"0.1"` |
| `id` | string | ULID for this document instance |
| `repo` | string | `owner/name` |
| `commit_range` | object | `{ base_sha, head_sha }` — everything anchors to `head_sha` |
| `session` | object | `{ agent, model, session_ids[], started_at, ended_at }` |
| `generated_by` | object | pipeline name + version |
| `generated_at` | string | ISO 8601 |
| `interview` | object | `{ rounds, questions_asked, unresolved }` — dialogue stats only |

### 3.2 `problem`
Why the session happened.

| Field | Type | Notes |
|---|---|---|
| `statement` | string | The concrete problem, formulated post-hoc from the whole session |
| `origin` | enum | `stated_upfront` \| `emerged_during_session` |
| `evolution` | array?, only when emerged | ordered `{ at, formulation }` snapshots showing drift |
| `user_asks` | array | verbatim quotes of the human's key requests (evidence anchors) |
| `out_of_scope` | array | things explicitly deferred or declined during the session |

> Rationale: when the ask drifted, the drift itself is reviewer-relevant — scope creep and
> half-migrated decisions hide there. Verbatim quotes let the reviewer judge the agent's
> framing without trusting its paraphrase.

### 3.3 `assumptions`
The front page of the review. Each entry:

| Field | Type | Notes |
|---|---|---|
| `id` | string | `A1`, `A2`, … |
| `assumption` | string | e.g. "user IDs are immutable" |
| `impact_if_wrong` | string | blast radius in one sentence |
| `depends` | array | tour-stop ids / anchor refs relying on this assumption |
| `how_to_verify` | string | what a human could check to confirm or kill it |
| `confidence` | enum | `confirmed_by_user` \| `grounded_in_code` \| `unverified` |

Companion list `open_questions[]`: `{ id, question, context, raised_by }` — everything the
interview could not resolve, including spots where the author agent admitted guessing.

### 3.4 `approach`
Why this way.

| Field | Type | Notes |
|---|---|---|
| `requirements` | array | constraints discovered or stated, each with a `source` (quote/ref) |
| `trials` | array | `{ what, outcome, why_abandoned }` — rejected alternatives get equal billing |
| `adopted` | object | `{ summary, rationale }` — rationale must reference requirements/trials |

### 3.5 `tour`
The guided walk. Ordered stops; narrative order, not file order.

| Field | Type | Notes |
|---|---|---|
| `id` | string | `T1`, `T2`, … |
| `title` | string | one line |
| `role` | enum | `core` \| `supporting` \| `incidental` |
| `what` | string | what this change does |
| `why` | string | why it exists — traced to problem/approach/assumption ids |
| `anchors` | array | `{ path, hunk: { old_start, old_lines, new_start, new_lines } }` pinned to `head_sha` |
| `parent` | string? | stop id — encodes the thread-and-branches structure as a tree |
| `provenance` | enum | `from_transcript` \| `confirmed_in_interview` \| `inferred_from_code` |
| `attention` | string? | optional "look hardest here" note (edge cases, known risk) |

`incidental` stops may batch many small anchors (renames, formatter churn) so mechanical
noise is covered without bloating the tour — and without tripping the coverage check.

### 3.6 `verification`
What was actually exercised.

| Field | Type | Notes |
|---|---|---|
| `performed` | array | `{ kind: test\|manual\|build\|lint\|typecheck, description, result, evidence? }` |
| `added_tests` | array | anchors to test hunks + what each covers |
| `not_verified` | array | honest gaps — paths, branches, scenarios with no coverage |

## 4. Validator checks (CI: `review-assist validate`)

1. **Schema** — document parses and conforms to `0.1`.
2. **Staleness** — `commit_range.head_sha` matches the PR head; otherwise fail with
   "document describes an older version".
3. **Coverage** — union of all `tour[].anchors` vs the actual diff hunks; report
   `unexplained[]` (in diff, not in doc) and `dangling[]` (in doc, not in diff).
   Configurable threshold; default: any unexplained non-whitespace hunk fails.
4. **Cross-references** — `assumptions[].depends`, `tour[].why` refs, `parent` ids resolve.
5. **Redaction lint** — secret patterns (keys, tokens, connection strings) in any free-text
   field fail hard.

The validator is deterministic code. The agents write; the validator gatekeeps.

## 5. Renderer contract (browser extension)

- **Front page:** `problem` (+ evolution when present), `out_of_scope`, `assumptions`
  with per-assumption acknowledge/challenge controls, `open_questions`, `approach`
  summary with trials. Goal: the reviewer can reject the framing in two minutes without
  reading a line of code.
- **Guided tour:** stops in narrative order; selecting a stop scrolls/highlights its
  anchored hunks in the native GitHub diff. `attention` notes surfaced inline.
  Keyboard next/prev. `incidental` stops collapsed by default.
- **Coverage overlay:** unexplained hunks visibly badged — never hidden.
- **Verification panel:** performed checks and, prominently, `not_verified`.
- **Zero-install fallback:** the pipeline also posts a markdown rendering of sections
  3.2–3.6 as the PR description/comment, so the document has value with no extension.

## 6. Deployment & distribution (FROZEN)

Two components, one principle: enforcement runs in the user's CI; experience runs in a
stateless, self-hostable App. No browser extension.

### 6.1 GitHub Action — `review-assist` action (enforcement + fallback)
- Runs `review-assist validate` on every PR push: schema, staleness (head SHA), coverage,
  cross-refs, redaction lint. Failing check = missing/stale/non-covering document.
- Posts the markdown fallback rendering (sections problem → verification) as a PR
  comment, plus an "Open guided review →" link into the App.
- Runs entirely on the user's runners; costs us nothing; works even without the App.
- Distributed via GitHub Marketplace (Actions listing).

### 6.2 GitHub App — guided review viewer (experience)
- One-time install per repo/org by an admin; reviewers sign in with GitHub once.
  This is the chosen friction budget: no per-reviewer installs of any kind.
- Renders the guided walkthrough on its own web UI (an App cannot modify GitHub's
  native diff view): front page (problem / assumptions / approach), anchored tour with
  side-by-side hunks, coverage overlay, verification panel.
- **Normative statelessness constraints:**
  - MAY fetch, per request: the `.intent/` document, the PR diff/metadata, and the
    minimum file context needed to render anchored hunks.
  - MUST NOT persist repo content, diffs, or documents at rest. Permitted state:
    installation records, user sessions, and (optional, off by default) anonymous
    usage counters.
  - No webhooks required in v1 — render on demand.
  - **Runtime & caching (frozen):** reference deployment is Cloudflare Workers. The
    viewer SPA renders client-side; the Worker is an auth broker + thin GitHub API
    proxy only. Static assets MAY be edge-cached aggressively. Responses containing
    repo content (documents, diffs, file context) MUST be served
    `Cache-Control: private, no-store` and MUST NOT enter any shared/edge cache —
    a shared cache entry is content at rest and an access-control bypass. Permitted
    optimizations: ETag/conditional requests against GitHub; optionally, public-repo
    renders keyed by immutable commit SHA (post-v1).
- **Open source and self-hostable:** single stateless container + the operator's own
  GitHub App registration. Hosted instance is a convenience, not a requirement.
- Distributed via GitHub Marketplace (Apps listing).

### 6.3 Explicitly rejected alternatives (recorded for posterity)
- **Browser extension** overlaying the native diff: per-reviewer install friction;
  DOM fragility. Rejected despite its in-place rendering advantage.
- **Pure-static viewer on GitHub Pages:** zero-infra and strongest privacy story, but
  private-repo auth is blocked by GitHub's OAuth endpoints lacking CORS (PAT-paste or a
  proxy required) — unacceptable reviewer friction. The stateless-renderer design from
  this option is retained inside the App.

## 7. Open design questions

1. One document per PR with versions, or one per push? (Current lean: regenerate per
   push; validator pins to head SHA.)
2. Anchor durability across force-pushes — re-anchor by content hash of the hunk?
3. How much of `problem.user_asks` is safe to quote by default in public repos —
   opt-in redaction level per repo?
4. Interview round cap — fixed (e.g. 3) or budget-based?
5. Format name. Working title: **Intent Document** (`.intent/`).
6. App auth scopes — minimum viable set (contents:read, pull_requests:read + user OAuth);
   verify nothing broader creeps in.
7. Hosted-instance economics — at what usage does the free-tier stateless container need
   real infrastructure, and does a paid hosted tier fund it?
