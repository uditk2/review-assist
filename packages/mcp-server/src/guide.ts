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
   \`get_spine\` on it. That returns the whole conversation in one read: both sides, structured
   questions with their answers, commands and edits as one-liners. The on-disk record holds
   material compacted out of live context, which is the reason this role exists. Reconstruct
   the real problem, how the ask evolved, requirements discovered, alternatives tried and
   abandoned, and the reasoning behind each group of changes. Use \`read_transcript\` around a
   spine index only to recover the evidence behind a claim.

2. **Reviewer role** — start from the diff (call \`compute_diff\`). Form an independent
   read, then interrogate the author role on thin spots: any tour stop whose "why" is
   vague, any change not obviously tied to the problem. Record the rounds with
   \`record_interview_round\` — send the whole baseline set in ONE call via \`rounds\`, then
   one more call for whatever the diff itself provoked. Rounds are keyed by question, so
   re-recording one replaces it: a retry costs nothing and cannot inflate the count. The
   server stamps \`meta.interview\` from them itself. Fold answers back into the fields. Do NOT keep the Q&A as a transcript — its only traces are (a) better-filled
   fields and (b) genuinely unresolved items, which become \`open_questions\`.

Cap the interview at a few rounds. The document must converge. Do NOT hand-fill
\`meta.interview\` — the server stamps it from your \`record_interview_round\` calls, so it
reflects the real interview (a single-pass generation with no reviewer will show rounds: 0).

## Content rules
- **Say it once.** The waste in these documents is not long sentences, it is the same
  point restated in \`problem.statement\`, then \`approach.adopted.summary\`, then a tour
  stop's \`why\`. Each field answers its own question and stops. Drop "This change…"
  preambles, drop prose that narrates what the diff already shows, and never pad a field
  you have nothing for — an empty array is a finding, filler is not.
- **Length follows content.** Give \`how_to_verify\` the command, not a paragraph about
  verifying. But where the reasoning IS the value — measured comparisons, why an
  alternative lost — write it in full. That is the material a diff-only reviewer cannot
  recover, and it is the last thing to cut.
- **Problem**: state it concretely, post-hoc. If it emerged during the session, set
  origin=emerged_during_session and record the \`evolution\`. Quote the user's key asks
  verbatim in \`user_asks\`.
- **Assumptions first**: surface anything the change assumes. For each, give the blast
  radius if wrong and how to verify it. This is the reviewer's front page.
- **Approach**: give rejected alternatives equal billing with the adopted one — this is
  the information a diff-only reviewer can never recover.
- **Guided tour**: order by narrative (thread → branches via \`parent\`), NOT file order.
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
\`compute_diff\` OPENS the run and returns a \`run_id\`. Pass that \`run_id\` to
\`record_interview_round\` and to \`submit_document\`. Those two take no \`repo\` — the run
already knows it. Pass \`repo\` to \`compute_diff\` itself (the absolute path of the git
repository you changed) whenever the server spans more than one repo: its working
directory is the workspace, not your repo.

The id is a hash of repo + base + head, so the author and the reviewer derive the same
handle independently without coordinating, and a role resumed later recomputes it by
calling \`compute_diff\` again. Never invent, shorten, or carry over a \`run_id\`.

The document is written to \`<repo>/.intent/<branch>.json\`. The run's own state lives
outside the repository and is never committed.

## Anchoring
\`compute_diff\` numbers every hunk — H1, H2, … in diff order — and returns each with its
path, line range and a \`preview\` of the first added line, enough to recognise it in the
diff you were handed alongside. Anchor a tour stop by id:

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
