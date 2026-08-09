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

> **Breaking in 0.3.0** — `compute_diff` no longer returns the diff text. It returns the
> run handle, the numbered hunk index and the SHAs; the change itself now comes from
> `read_diff`, a page at a time. The two used to travel together, and on a 205,826-byte
> change that response reached 234,337 characters — past the client's tool-result cap, so
> it was spilled to a file whole and the twelve characters of `run_id` went with it,
> leaving a reviewer (which has no file access by design) unable to record a round or
> submit anything. No response grows with the size of the change any more. Upgrade the
> server and reinstall the role definitions; nothing about the Intent Document changes.

## Review Assist is two installs

This package is one half. Installed alone it will author and validate Intent Documents
locally, and that is all.

**1. This MCP server** — so your agent can author the document.

```bash
claude mcp add -s user review-assist -- npx -y review-assist-mcp   # Claude Code
codex mcp add review-assist -- npx -y review-assist-mcp            # Codex
```

Claude desktop app: [download the `.mcpb`](https://github.com/uditk2/review-assist/releases/latest/download/review-assist-mcp.mcpb) and open it. No terminal.

> **Using the VS Code extension, or a GUI-launched editor?** Register it without
> `npx`. GUI apps on macOS get only `/usr/bin:/bin:/usr/sbin:/sbin`, so a
> Homebrew/nvm `npx` is not on the path, and on Windows `npx` is a `.cmd` wrapper
> that fails silently without a TTY. Either way the server shows as *not connected*
> with no error. Invoking `node` directly avoids both:
>
> ```bash
> npm install -g review-assist-mcp
> claude mcp add -s user review-assist -- "$(which node)" "$(npm root -g)/review-assist-mcp/dist/index.js"
> ```
>
> Both `$(...)` expand on your machine, so this is correct for Homebrew, nvm, fnm,
> Volta and Linux alike. If you use nvm and later switch Node versions, re-run it.
>
> To avoid the global install, launch VS Code from a terminal with `code .` so it
> inherits your shell's `PATH`; `npx` then works. That is a habit rather than a
> setting — open the editor from the Dock and it silently stops connecting.
>
> This is a client-side issue rather than something specific to this server — every
> `npx`-based MCP server is affected the same way
> ([claude-code#25044](https://github.com/anthropics/claude-code/issues/25044)).

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
| `get_spine` | The session's whole conversation, paged. Follow `next_cursor` to the end; nothing is dropped to make a page fit. |
| `read_transcript` | A window of the full transcript around a spine index, for the tool output behind a claim. |
| `compute_diff` | Opens the run: handle, numbered hunk index, resolved SHAs. No diff text. |
| `read_diff` | The diff itself, paged by hunk. Follow `next_cursor`, or ask for `hunks`/`paths`. |
| `answer_questions` | The author's own answers, by `q_id`. Its only write, and the half of the interview the server can attest. |

Reviewer role:

| Tool | Purpose |
|---|---|
| `get_generation_guide` | Schema plus the authoring protocol. |
| `get_role_definitions` | Author and reviewer subagent definitions for your client. |
| `compute_diff` | Opens the run: handle, numbered hunk index, resolved SHAs. No diff text. |
| `read_diff` | The change, as a reviewer first meets it — a page at a time. |
| `record_interview_round` | The reviewer's questions, recorded before they are relayed. Each comes back with a `q_id`; the author answers by that id, so the server hears both sides rather than the reviewer's account of both. |
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
