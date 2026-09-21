# Architecture

The system view stays at the container level: three systems and two external actors.

<p align="center">
  <a href="architecture.svg">
    <img src="architecture.svg" alt="Review Assist container architecture. An external Developer implements the change through the developer machine and grants repository consent. The developer machine creates an Intent Document and commits it with the code to one GitHub pull request. GitHub sends pull-request events to webhook automation inside the Review Assist Application. The application posts automation results as its bot identity. An external Human Reviewer opens the guided-review link and writes comments and a verdict through their own GitHub identity. GitHub owns all durable review state." width="1050">
  </a>
</p>

_Click either diagram for its full-size version._

## System boundaries

| Boundary | Responsibility |
|---|---|
| **Developer** | External actor who implements the change through the coding agent and grants repository consent. |
| **Developer machine** | Produce the change and its Intent Document without sending the coding transcript elsewhere. |
| **GitHub** | Store the pull request, committed document, diff, checks, comments, PR description, and review verdict. |
| **Review Assist Application** | Run webhook automation, serve the guided-review experience, and proxy authenticated GitHub reads and writes. |
| **Human reviewer** | External actor who follows the guided link and reviews using their own GitHub identity. |

The primary flows are:

1. The Developer implements the change through the local coding agent and grants
   repository consent.
2. The local MCP mechanism writes `.intent/<branch>.json`; it is committed with the
   implementation into the pull request.
3. GitHub calls `POST /api/webhook` on `opened`, `synchronize`, and `reopened` events.
4. The webhook reads the document and diff, recomputes coverage, and posts the Check
   Run, sticky summary, and managed PR-description block as the Review Assist bot.
5. The Human Reviewer opens the guided link. The application reads and writes GitHub using that
   reviewer's signed-in user token; comments and the verdict remain on the pull request.

## MCP distillation detail

Tool access is a component-level concern, so it is kept in a separate view.

<p align="center">
  <a href="mcp-distillation.svg">
    <img src="mcp-distillation.svg" alt="A component-level view of the local two-agent distillation, all of it on the developer's machine. The orchestrating coding agent spawns two role-locked subagents and holds the three setup tools that belong to neither role: get_role_definitions, import_session and manage_consent. REVIEW_ASSIST_ROLE decides which tools the server registers, so the other role's tools are absent rather than merely disallowed. The Author holds this session's transcript and is registered eight tools: get_generation_guide, list_transcripts, get_spine, read_transcript, compute_diff, read_diff, get_questions and answer_questions. The Intent Reviewer reads the diff cold with no transcript tools and no file-reading tools, and is registered eight of its own: get_generation_guide, compute_diff, read_diff, get_reviewer_instructions, record_interview_round, get_answers, submit_document and set_consent. compute_diff opens the run and returns the run_id, the numbered hunk index, the SHAs, the consent state and whether a .reviewer folder exists; it returns no diff text, which read_diff pages. The two role sessions are separate processes, and the run file at ~/.review-assist/runs/&lt;run_id&gt;.json is the only thing they share: the reviewer records questions and gets a q_id for each, the author answers by q_id, and the reviewer reads those answers back in the author's own words. The repository's .reviewer folder carries its own house rules, served to the reviewer by get_reviewer_instructions after the diff and before round one; it adds questions but cannot relax a check. submit_document is the reviewer's call alone and gates the write behind repository consent, head drift, anchor resolution, interview attestation and the validator's five checks, then writes .intent/&lt;branch&gt;.json. The run leaves two outputs: the Intent Document for the human who will review the pull request, and the reviewer's closing message for the session that can still fix the code." width="1000">
  </a>
</p>

The coding agent orchestrates the **Author** and **Intent Reviewer** as separate local
subagents. They do not live inside the MCP Server. Each connects to a role-scoped server
session; `REVIEW_ASSIST_ROLE` makes the split structural by not registering tools that
belong to the other role. `compute_diff` only opens the run and returns its handle and
hunk index; `read_diff` pages the change itself, so no response grows with the size of a
change.

The two roles start together rather than one after the other. Their reads are independent
(the Author needs only the transcript, the Reviewer only the diff), but the Author's one
write takes `q_id`s, and those used to exist only once the Reviewer had paged the whole
diff. So the Author sat idle through the Reviewer's read and the Reviewer through the
Author's: measured over 15 runs, that phase was 670s of a 1400s median. `compute_diff` now
seeds the STANDING questions on the run at open (the plan, and the five that guard fields a
diff cannot fill), so the Author answers them off the spine unprompted while the Reviewer
reads. Both roles derive the same `q_id`s without speaking, because the id is a hash of the
question text. A seeded question nobody answered is not counted as an interview round, so
`rounds: 0` still means no Author ever ran. What is deliberately NOT seeded is anything
needing the hunk index: the incidental question is asked by file, and assigning hunk ids to
plan items stays the Reviewer's own read of the change.

The interview is two-sided and server-attested, not a prose relay: the Reviewer's
`record_interview_round` hands back a `q_id` per question, the Author reads and answers
them by id (`get_questions` / `answer_questions`), and the Reviewer reads the answers back
in the Author's own words (`get_answers`). An answer the Reviewer merely transcribes on
the Author's behalf is recorded too, but marked reviewer-sourced rather than attested.
`get_role_definitions`, `manage_consent`, and `import_session` belong to neither role —
they set up the split and the consent list themselves, and are called by the orchestrating
agent rather than the Author or Reviewer.

The Reviewer's questions come from three places: the standing set seeded on the run, the
diff it just read, and the repository's own `.reviewer/` folder, served by
`get_reviewer_instructions`. Only the last two are its to record; re-asking the standing set
is the one way the split costs a round trip instead of saving one. That folder is the only repository content the Reviewer reads
besides the diff. It has no filesystem tools, because reaching the transcript is exactly
what the split forbids, so house rules arrive through a bounded tool like everything else.
It is granted to the Reviewer alone: house rules are questions, and the Author's job is to
answer them. The content is untrusted (a fork's pull request can edit it), so both the tool
description and the role prompt frame it as reference material that adds questions and
cannot override the protocol, the schema, or the sourcing rules. `.reviewer/` stays inside
the coverage denominator: unlike `.intent/`, a change to the house rules is an ordinary
change that the document should explain.

`submit_document` first applies repository consent (`always`, `once`, or `never`). On
allow, interview attestation and the five local checks are sibling gates: schema,
coverage, staleness, cross-references, and secret redaction. Only then is the Intent
Document written. The MCP server never calls a model, and the transcript stays local.

The run leaves two things behind, not one. The Intent Document is for the human who will
review the pull request, and it arrives after the fact. The Reviewer's closing message
back to whoever dispatched it is the other, and the only channel that reaches the session
while the code can still be changed: questions the Author could not answer, everything in
`verification.not_verified`, and any defect reading the diff cold exposed. The Reviewer
carries this alone, because the Author answers questions rather than judging the change.

## Application interfaces

The webhook, guided-review web experience, OAuth broker, and API are capabilities of the
same Review Assist Application service.

| Group | Routes |
|---|---|
| Automation | `POST /api/webhook` |
| Auth | `GET /api/login`, `GET /api/callback`, `GET /api/logout`, `GET /api/me` |
| Read | `GET /api/document`, `GET /api/comments` |
| Write | `POST /api/comments`, `POST /api/comments/reply`, `POST /api/issue-comment`, `POST /api/review` |

The webhook recomputes **coverage only**; schema, staleness, cross-reference, and
redaction validation are local `submit_document` checks.

## Identity and state

- The short-lived **installation token** posts automation output as the Review Assist
  bot.
- The **signed-in reviewer's token** posts comments, replies, and the verdict as that
  human.
- GitHub is the durable source of truth. Review Assist has no application database; an
  encrypted HTTP-only cookie holds the reviewer session, and repository responses are
  `private, no-store`.

Regenerate both diagrams with `npm run docs:architecture`.
