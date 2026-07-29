# review-assist-mcp

Turn an AI coding agent's session into a reviewable **Intent Document** — the problem it
was really solving, the assumptions it made, the approaches it rejected, and an anchored
walkthrough of every change — validated against the diff before it is written.

<p align="center">
  <img src="https://raw.githubusercontent.com/uditk2/review-assist/main/docs/mcp-distillation.png" alt="The coding agent spawns two role-locked subagents. The Author holds the session transcript and has no submission tools. The Intent Reviewer never sees the transcript and is the only role that can submit. The Reviewer asks questions, the Author answers from transcript evidence, and submit_document gates the write behind repository consent, interview attestation, and five local checks." width="820">
</p>

This server never calls a model. Generation is the calling agent's job; the server
supplies ground truth (the diff, the transcript), enforces the role split, and gatekeeps
the result.

## Review Assist is two installs

This package is one half. Installed alone it will author and validate Intent Documents
locally, and that is all.

**1. This MCP server** — so your agent can author the document.

```bash
claude mcp add -s user review-assist -- npx -y review-assist-mcp   # Claude Code
codex mcp add review-assist -- npx -y review-assist-mcp            # Codex
```

Claude desktop app: [download the `.mcpb`](https://github.com/uditk2/review-assist/releases/latest/download/review-assist-mcp.mcpb) and open it. No terminal.

**2. [The GitHub App](https://github.com/apps/review-assist-guided-review)** — so the
document becomes a guided review on the pull request.

One click, on the repositories you choose. It adds the coverage check, the summary
comment, and the "Open guided review" link. **There is no workflow file to add and no
runner minutes** — it is a GitHub App, not an Action.

Without it, the document still gets committed to `.intent/<branch>.json`; nobody just
sees it on the PR.

## The two-role split

The document is written by two agents that cannot reach each other's tools:

- **Author** holds the session transcript and cannot submit.
- **Intent Reviewer** never sees the transcript and is the only role that can submit.

Everything the Reviewer knows about intent, it had to ask for. This is enforced, not
advised: `REVIEW_ASSIST_ROLE` makes the server refuse to register the other role's tools,
so an author instance has no `submit_document` and a reviewer instance has no
`read_transcript`. Call `get_role_definitions` to install both as subagents for your
client.

## Tools

Author role:

| Tool | Purpose |
|---|---|
| `get_generation_guide` | Schema plus the authoring protocol. Call first. |
| `list_transcripts` | Find this session's transcript, ranked by how much it touches the changed files. |
| `search_transcript` | Retrieve only the passages bearing on one question. |
| `read_transcript` | Page through a transcript to hydrate a fresh context. |
| `compute_diff` | Deterministic `base...head` diff plus resolved SHAs. |

Reviewer role:

| Tool | Purpose |
|---|---|
| `get_generation_guide` | Schema plus the authoring protocol. |
| `get_role_definitions` | Author and reviewer subagent definitions for your client. |
| `compute_diff` | The change, as a reviewer first meets it. |
| `record_interview_round` | One question, the author's answer, whether it resolved. The server stamps `meta.interview` from these, so the interview is attested rather than self-reported. |
| `submit_document` | The gate. Validates, then writes `.intent/<branch>.json`. |
| `set_consent` / `manage_consent` | Per-repository opt in and out. |

## Consent and validation

The first `submit_document` in a repository returns `consent_required` instead of
writing, with a prompt for the user to answer: `always`, `once`, or `never`. Nothing is
written until they choose.

On allow, five deterministic checks run locally — schema, coverage (every substantive
diff hunk explained), staleness, cross-references, and secret redaction — plus the
interview attestation. Only then is the document written, and the response includes a
ready-made PR description.

## Notes

Read-only against git apart from writing `.intent/`. Transcripts never leave the machine;
only the distilled document does. Set `REVIEW_ASSIST_REPO`, or pass `repo` per call, when
the server spans multiple repositories.

Apache-2.0 · [github.com/uditk2/review-assist](https://github.com/uditk2/review-assist)
