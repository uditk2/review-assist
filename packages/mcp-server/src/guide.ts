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
Call \`get_role_definitions\` FIRST. It returns author and reviewer definitions built for
your client, plus how to spin them up — for Claude Code they install as subagents whose
\`tools:\` allowlist enforces the split, so the roles cannot bleed into one another.

Run this as two roles in separate contexts, so the depleted main session pays nothing.
The split is the point: the author holds the transcript and cannot submit; the reviewer
submits and never sees the transcript. Anything the reviewer knows about intent, it had
to ask for. Playing both roles yourself produces a document that validates and still
quietly sources \`user_asks\` from the commit message:

1. **Author role** — hydrate from the FULL session transcript (call \`list_transcripts\` with \`base\` (candidates come back ranked by how much
   they touch the changed files); pick the one whose \`first_user\` matches how THIS session
   began — NOT just the newest — then \`read_transcript\` to page through it; the on-disk transcript contains
   material that was compacted out of live context). Reconstruct: the real problem,
   how the ask evolved, requirements discovered, alternatives tried and abandoned,
   and the reasoning behind each group of changes.

2. **Reviewer role** — start from the diff (call \`compute_diff\`). Form an independent
   read, then interrogate the author role on thin spots: any tour stop whose "why" is
   vague, any change not obviously tied to the problem. For EACH round, call
   \`record_interview_round\` (your question, the author role's answer, resolved?) — the server
   counts them and stamps \`meta.interview\` itself. Fold answers back into the fields. Do NOT keep the Q&A as a transcript — its only traces are (a) better-filled
   fields and (b) genuinely unresolved items, which become \`open_questions\`.

Cap the interview at a few rounds. The document must converge. Do NOT hand-fill
\`meta.interview\` — the server stamps it from your \`record_interview_round\` calls, so it
reflects the real interview (a single-pass generation with no reviewer will show rounds: 0).

## Content rules
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
- **Verification**: record what was actually run, and be honest in \`not_verified\`.
- **Diagrams (optional)**: when a picture beats prose — architecture, a sequence of calls,
  a data-flow — add entries to \`diagrams\` ({ title, mermaid, caption? }). Use plain-ASCII
  Mermaid (sequenceDiagram / flowchart / etc.); avoid characters like \`&\`, \`×\`, or braces in
  labels. They render in the PR description (GitHub-native) and the guided viewer.
- **Redaction**: never put secrets, tokens, internal credentials, or raw keys in any
  field. The validator will hard-fail them, but do not rely on it.

## Which repository
If the server runs at a container level spanning multiple repos, pass \`repo\` (the
absolute path of the git repository you changed) to EVERY tool call — \`compute_diff\`
and \`submit_document\`. The document is written to \`<repo>/.intent/<branch>.json\`.

## Anchoring
Each anchor is { path, hunk: { old_start, old_lines, new_start, new_lines } } on the
new side of the diff, pinned to the head SHA from \`compute_diff\`. Use the hunk line
numbers from the diff exactly.

## Submitting (consent gate)
Call \`submit_document\` with the candidate JSON. If it returns validation findings,
FIX them and resubmit — do not argue with the validator.

The FIRST submit for a repo may return \`consent_required: true\` instead of writing.
Review Assist is installed globally but must be opted in per repository. When you see
this, present the \`prompt\` and \`options\` to the user verbatim and let THEM choose —
do not decide for them. Then call \`set_consent\` with their \`decision\` (always | once |
never) and the same \`repo\`, and call \`submit_document\` again. If the repo is disabled
(\`skipped: true, reason: "disabled"\`), stop — do not write anything; tell the user how
to re-enable it (\`manage_consent\` / the \`consent\` CLI).

On success the response includes \`pr_description\` — a ready-made Markdown PR body
(problem, approach, any diagrams, assumptions to check). When you open the PR, use it as
the body (e.g. \`gh pr create --body-file\`). The guided-review link is added automatically
by the app once the PR opens, so do not fabricate one.

Then it writes the document to the intent path and you are done.
`;
