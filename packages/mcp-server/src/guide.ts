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

## Two-agent distillation (recommended)
Run this as two roles in a fresh context, so the depleted main session pays nothing:

1. **Author role** — hydrate from the FULL session transcript (get its path from
   \`list_transcripts\`, then \`read_transcript\` to page through it; the on-disk transcript contains
   material that was compacted out of live context). Reconstruct: the real problem,
   how the ask evolved, requirements discovered, alternatives tried and abandoned,
   and the reasoning behind each group of changes.

2. **Reviewer role** — start from the diff (call \`compute_diff\`). Form an independent
   read, then interrogate the author role on thin spots: any tour stop whose "why" is
   vague, any change not obviously tied to the problem. Fold answers back into the
   fields. Do NOT keep the Q&A as a transcript — its only traces are (a) better-filled
   fields and (b) genuinely unresolved items, which become \`open_questions\`.

Cap the interview at a few rounds. The document must converge.

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

## Submitting
Call \`submit_document\` with the candidate JSON. If it returns validation findings,
FIX them and resubmit — do not argue with the validator. On success it writes the
document to the intent path and you are done.
`;
