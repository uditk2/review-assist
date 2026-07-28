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
    <img src="mcp-distillation.svg" alt="Review Assist MCP distillation detail. The coding agent orchestrates separate Author and Intent Reviewer subagents. They do not run inside the MCP Server. Each subagent calls a role-scoped MCP tool surface: the Author has transcript tools but no submission tools, while the Intent Reviewer has interview, submission, and consent tools but no transcript tools. The Reviewer sends questions to the Author and receives transcript-grounded evidence. Repository consent and local validation gate writing the Intent Document." width="1000">
  </a>
</p>

The coding agent orchestrates the **Author** and **Intent Reviewer** as separate local
subagents. They do not live inside the MCP Server. Each connects to a role-scoped server
session; `REVIEW_ASSIST_ROLE` makes the split structural by not registering tools that
belong to the other role. The Reviewer asks the questions; the Author supplies
transcript-grounded evidence.

`submit_document` first applies repository consent (`always`, `once`, or `never`). On
allow, interview attestation and the five local checks are sibling gates: schema,
coverage, staleness, cross-references, and secret redaction. Only then is the Intent
Document written. The MCP server never calls a model, and the transcript stays local.

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
