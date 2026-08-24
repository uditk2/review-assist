/**
 * The generation guide handed to the calling agent.
 *
 * The MCP server does not itself call a model. It hands the agent (a) the schema,
 * (b) the deterministic diff, (c) transcript access, and (d) this protocol — then
 * gatekeeps the result. Generation is the agent's job; enforcement is the server's.
 */

export const GENERATION_GUIDE = `# How to author an Intent Document

You are producing an Intent Document: a curated, reviewable explanation of a code
change, distilled from the authoring session. Follow this protocol.

## Two-agent distillation
Call \`get_role_definitions\` with \`install: true\` FIRST. The server detects your client
from the MCP handshake and writes the two role definitions where that client reads them
(user scope, e.g. \`~/.claude/agents/\`), then tells you how to dispatch them. Do NOT write
those files yourself and do NOT shell out to install them — the server already knows the
environment and you do not have to re-derive it. For Claude Code they land as subagents
whose \`tools:\` allowlist enforces the split, so the roles cannot bleed into one another.

Run this as two roles in separate contexts, so the depleted main session pays nothing.
The split is the point: the author holds the transcript and cannot submit; the reviewer
submits and never sees the transcript. Anything the reviewer knows about intent, it had
to ask for. Playing both roles yourself produces a document that validates and still
quietly sources \`user_asks\` from the commit message:

1. **Author role** — call \`list_transcripts\` with \`base\` (candidates come back ranked by how
   much they touch the changed files; parents only, since a subagent is never a session), pick
   the one whose \`first_user\` matches how THIS session began rather than the newest, then call
   \`get_spine\` on it. That returns the whole conversation — both sides, structured questions
   with their answers, commands and edits as one-liners — a page at a time: follow
   \`next_cursor\` to the end, and read every page before answering anything. Nothing is
   dropped to make a page fit, so the only way to lose material is to stop early. Read all
   of it; be selective in what you report, not in what you read. The on-disk record holds
   material compacted out of live context, which is the reason this role exists. Reconstruct
   the real problem, how the ask evolved, requirements discovered, alternatives tried and
   abandoned, and the reasoning behind each group of changes. Use \`read_transcript\` around a
   spine index only to recover the evidence behind a claim.

2. **Reviewer role** — start from the diff: \`compute_diff\` for the handle and the hunk
   index, then \`read_diff\` for the change itself, following \`next_cursor\` to the end.
   Form an independent read, then run the interview in exactly two batches:

   - **Batch one** — the baseline set plus every question the diff provoked, together in ONE
     \`record_interview_round\` call. You have already read the diff, so you already have
     these questions; holding any back only buys a round-trip. Record them BEFORE relaying:
     each comes back with a \`q_id\`. The author reads them off the run with
     \`get_questions\` and replies with \`answer_questions\` by those ids, so the server
     records the author's own words.
   - **Read the answers with \`get_answers\`.** They arrive in the author's own words, and
     that is what you write the document from. Do not paraphrase a relayed summary into a
     field when the verbatim answer is one call away, and never mark a stop
     \`provenance: from_transcript\` on the strength of a summary.
   - **Draft the whole document** from the answers, then read your own reasoning back. This
     is what finds the real gaps: an answer reads fine until you try to write
     \`approach.adopted.rationale\` out of it and find there is nothing there. Mark every
     place you asserted rather than sourced.
   - **Batch two** — everything the draft exposed, in one final call. Never re-ask what the
     author declined to answer.

   Rounds are keyed by question, so re-recording one replaces it: a retry costs nothing and
   cannot inflate the count. The server stamps \`meta.interview\` from them itself. Fold
   answers back into the fields. Do NOT keep the Q&A as a transcript — its only trace is
   better-filled fields.

   **Nothing but the \`run_id\` travels between the two roles.** The run IS the channel:
   the reviewer writes questions into it, the author reads them and writes answers back,
   and each side reads the other's half with \`get_questions\` / \`get_answers\`. Whoever
   dispatched you only has to say which run and whose turn it is — and even the id is
   derivable, since both roles get the same one from \`compute_diff\`. Hand-carrying
   question or answer TEXT between the roles is a sign something is wrong; the two runs
   that predate these tools cost 25,567 and 28,943 bytes of relayed prose.

Two batches is the cap, and the document must converge. Thin spots that survive the second
batch are findings, not a third round. Do NOT hand-fill \`meta.interview\` — the server
stamps it from the two roles' own calls, so it reflects the real interview (a single-pass
generation with no reviewer will show rounds: 0, and one where the reviewer wrote both
halves will show author_attested: 0).

## Content rules
- **Say it once.** The waste in these documents is not long sentences, it is the same
  point restated in \`problem.statement\`, then \`approach.adopted.summary\`, then a tour
  stop's \`why\`. Each field answers its own question and stops. Drop "This change…"
  preambles, drop prose that narrates what the diff already shows, and never pad a field
  you have nothing for — an empty array is a finding, filler is not.
- **Every field is a list of points.** A point is one phrase: one idea, no clause chains,
  no sentence where a phrase will do. The reader is a developer deciding, in about a
  minute, which hunks to open. How many points a field needs is set by the change — a
  large commit earns more points, not prose. Give \`how_to_verify\` the command, not a
  sentence about verifying.
- **Where the reasoning IS the value** — measured comparisons, why an alternative lost —
  it is still points, and it belongs in \`trials\`, one entry per alternative. That is the
  material a diff-only reviewer cannot recover; it is the last thing to cut and the first
  thing to keep out of \`adopted.rationale\` as a paragraph.
- **Problem**: state it concretely, post-hoc. If it emerged during the session, set
  origin=emerged_during_session. Quote the user's key asks verbatim in \`user_asks\`.
- **A constraint the user imposed goes to \`trials\` or \`requirements\`**, never to
  narrative about how the ask moved. It killed a candidate design — the candidate is
  \`what\`, the constraint is \`why_abandoned\`. It merely bounded the work — it is a
  requirement, with the user named in \`source\`.
- **Assumptions first**: surface anything the change assumes. For each, give the blast
  radius if wrong and how to verify it. This is the reviewer's front page.
- **Approach**: give rejected alternatives equal billing with the adopted one — this is
  the information a diff-only reviewer can never recover.
- **Guided tour**: order by the plan the author reconstructs — what was agreed, what was
  learned, what changed — and assign hunk ids to its items. A hunk matching no plan item is
  either something discovered while doing the work (frequently the best stop in the
  document) or incidental churn, and only the author can say which. Never order by file.
  Every substantive diff hunk MUST be covered by some stop's anchors. Batch mechanical
  churn into one role=incidental stop. Mark each stop's \`provenance\`.
  Write each stop for someone deciding whether to open that hunk: \`what\` gives the change
  in behaviour rather than the method names the anchors already point at, \`why\` leads
  with the fact a diff cannot show, and \`attention\` — one line naming the thing to check
  — is filled on every core stop. It renders as "Look here" and is the line reviewers
  actually skim.
- **Verification**: record what was actually run, and be honest in \`not_verified\`.
- **Diagrams (optional)**: when a picture beats prose — architecture, a sequence of calls,
  a data-flow — add entries to \`diagrams\` ({ title, mermaid, caption? }). Use plain-ASCII
  Mermaid (sequenceDiagram / flowchart / etc.); avoid characters like \`&\`, \`×\`, or braces in
  labels. They render in the PR description (GitHub-native) and the guided viewer.
- **Redaction**: never put secrets, tokens, internal credentials, or raw keys in any
  field. The validator will hard-fail them, but do not rely on it.

## The run handle
\`compute_diff\` OPENS the run and returns a \`run_id\`. Pass that \`run_id\` to \`read_diff\`,
\`record_interview_round\` and \`submit_document\`. Those three take no \`repo\` — the run
already knows it. Pass \`repo\` to \`compute_diff\` itself (the absolute path of the git
repository you changed) whenever the server spans more than one repo: its working
directory is the workspace, not your repo.

The id is a hash of repo + base + branch, so the author and the reviewer derive the same
handle independently without coordinating, and a role resumed later recomputes it by
calling \`compute_diff\` again. Never invent or shorten a \`run_id\`.

Base and branch are both in there for a reason. The base separates successive changes on a
long-lived branch like \`main\`; the branch separates two feature branches cut from the
same commit, which would otherwise share one run and one interview.

The head is NOT in that hash, which is what makes a correction cycle possible. Commit the
document, fix a finding, let the branch move — the run and the interview on it are still
there under the same handle, so nothing has to be re-asked. Call \`compute_diff\` again and
it moves the run to the new head, reporting \`head_changed\` with the head it moved from.

What does NOT survive a moved head is your anchors. The new head means a new diff, and the
diff is renumbered from H1, so every hunk id you were holding now means something else.
When you see \`head_changed\`, discard them and re-anchor from the ids that response
carries. This is the one part of a resubmit you have to redo.

The document is written to \`<repo>/.intent/<branch>.json\`. The run's own state lives
outside the repository and is never committed.

## Reading the diff
\`compute_diff\` returns no diff text. It returns the handle, the SHAs and the hunk index;
the bytes come from \`read_diff\`, one page at a time.

That split is not a convenience. The two travelled together until a 205,826-byte change
produced a 234,337-character response, the client spilled the whole thing to a file, and
the twelve characters of \`run_id\` went with it — leaving a reviewer, which has no file
access by design, unable to record a round or submit anything. No response may now grow
with the size of the change.

Call \`read_diff({ run_id })\` and keep passing back the \`next_cursor\` it returns until
there is none. That is the only way to know you have seen the whole change; a page you did
not fetch is a hunk no tour stop explains, and coverage will say so at submit. Pages break
on hunk boundaries, so you never receive half a change unlabelled — and a hunk too large
for one page (a newly added file is a single hunk) is split by line, told you which lines
it carries, and resumed with a cursor like \`H20:180\`.

A walk covers the hunks that need explaining. It does not spend pages on the ones marked
\`coverage_required: false\` — whitespace-only churn, and the intent document's own file,
which from a branch's second commit onward is your OWN previous output arriving as a
whole-file addition. They stay in the index with their line numbers; only their text is
skipped.

To go straight at something instead of paging to it, pass \`hunks: ["H3","H7"]\` or
\`paths: ["src/foo.ts"]\`. Naming an id also overrides the skip above — being specific is
the override, there is no flag for it. That is how a claim gets substantiated cheaply: the
index says where to look, and this fetches only that.

## Anchoring
\`compute_diff\` numbers every hunk — H1, H2, … in diff order — and returns each with its
path, line range and a \`preview\` of the first added line, enough to recognise it in the
pages \`read_diff\` returns, which carry the same ids. Anchor a tour stop by id:

    "anchors": ["H3", "H4"]

The server expands ids into the stored \`{ path, hunk }\` form, so the document on disk is
unchanged and the ids never leave the wire. Do NOT hand-copy line numbers; that is the one
part of this job that rewards transcription over judgement, and it is where anchors go
wrong. The long form is still accepted if you have a reason to use it.

Every hunk with \`coverage_required: true\` must appear in some stop. One hunk may serve two
stops — a single edit can carry two unrelated changes, and saying so is more honest than
picking one. Batch true churn into a role=incidental stop. On a coverage failure the server
replies with \`uncovered_hunk_ids\`, which you fix by adding those ids to a stop.

## Submitting (consent gate)
Call \`submit_document\` with the candidate JSON and the \`run_id\`. It derives repo, base
and head from the run, so the interview and the coverage check cannot disagree about
which change this is. If it returns validation findings, FIX them and resubmit — do not
argue with the validator. Warnings are advisory; only errors block.

Submitting does NOT end the run. The document is written and the run stays open with its
interview attached, so a finding spotted afterwards — including one found after the
document is committed — is fixed by editing and submitting again under the same
\`run_id\`, with nothing re-asked. If the branch moved in between, call \`compute_diff\`
first and re-anchor; the id is unchanged but the hunk ids are not.

Consent is per repository: Review Assist is installed globally but must be opted in for
each repo. \`compute_diff\` reports \`consent_state\` when it opens the run — if it is
\`unknown\`, settle it THEN, before writing anything. Present the \`prompt\` and \`options\`
verbatim and let the USER choose; do not decide for them. Then call \`set_consent\` with
their \`decision\` (always | once | never) and the repo. Discovering this at submit time
instead costs you the whole document, twice over. If the repo is disabled
(\`skipped: true, reason: "disabled"\`), stop — do not write anything; tell the user how
to re-enable it (\`manage_consent\` / the \`consent\` CLI).

On success the response includes \`pr_description\` — a ready-made Markdown PR body
(problem, approach, any diagrams, assumptions to check). When you open the PR, use it as
the body (e.g. \`gh pr create --body-file\`). The guided-review link is added automatically
by the app once the PR opens, so do not fabricate one.

Then it writes the document to the intent path and you are done.
`;
