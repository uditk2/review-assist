<h1 align="center">Review Assist</h1>

<p align="center">
  <strong>Review AI-written code as fast as agents write it.</strong><br>
  Turn a coding agent's session into a guided, verifiable pull-request review.
</p>

<p align="center">
  <a href="#install">Install</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#developing">Developing</a> ·
  <a href="#contributing">Contributing</a>
</p>

<p align="center">
  <img src="docs/walkthrough.gif" alt="Guided review walkthrough: overview, assumptions, anchored diff stops, verification" width="820">
</p>

---

AI agents write code faster than anyone can read diffs — and the context that makes
review fast (what was asked, what was assumed, what was tried and abandoned, what was
tested) is thrown away the moment the PR opens. Review Assist captures it at the source:
an agent's session becomes an **Intent Document**, a validator proves it actually covers
the diff, and a GitHub App renders it as a guided review on top of the pull request.

Fully open source, self-hostable, and **stores none of your code** — validation runs
against the diff on GitHub's side of the fence, and the viewer renders live in the
reviewer's browser.

## Install

Two one-time installs — the MCP server on the developer's side, the GitHub App on the repo's.

**1. Register the MCP server with your agent** (so it can author Intent Documents).

Claude Code:

```bash
claude mcp add -s user review-assist -- npx -y review-assist-mcp
```

Codex:

```bash
codex mcp add review-assist -- npx -y review-assist-mcp
```

Both write the same entry to the agent's own config — for Codex that's
`~/.codex/config.toml`, shared with the IDE extension. Check it landed with
`codex mcp list` (or `claude mcp list`).

Claude desktop app — one-click, no terminal:
[download the `.mcpb`](https://github.com/uditk2/review-assist/releases/latest/download/review-assist-mcp.mcpb)
and open it.

**2. [Install the GitHub App →](https://github.com/apps/review-assist-guided-review)**

One click. Read-only code + PR comments, no workflow files — it adds the automatic
check on every PR, the summary comment, and the guided-review viewer.

## How it works

<p align="center">
  <img src="docs/how-it-works.svg" alt="How it works, in three steps. 1 Code, on your machine: your agent writes the change and an Intent Document that explains it — the ask, the assumptions, a tour of the diff — committed alongside the code; the transcript never leaves the machine. 2 Validate, on GitHub with no code stored: a GitHub App proves the document covers the diff (schema, staleness, cross-refs, redaction), reports coverage such as 5 of 5 changes explained, and posts an Open guided review link on the pull request. 3 Review, in the reviewer's browser: check the assumptions first — flagging one posts it to the PR discussion — then take the anchored tour and approve or request changes; the verdict posts to the pull request as you, and merging stays on GitHub." width="620">
</p>

Full diagram and internals: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Developing

| Path | Component |
|---|---|
| [`packages/schema`](packages/schema) | The format — JSON Schema (draft 2020-12) + TypeScript types |
| [`packages/validator`](packages/validator) | `review-assist` CLI + library: the five checks and the Markdown renderer |
| [`packages/mcp-server`](packages/mcp-server) | MCP server that drives distillation and gatekeeps submissions |
| [`apps/github-app/worker`](apps/github-app/worker) | Stateless Cloudflare Worker: OAuth broker + thin GitHub proxy |
| [`apps/github-app/viewer`](apps/github-app/viewer) | Client-side guided-review viewer |
| [`SPEC.md`](SPEC.md) | The frozen design: the document's six sections and the five checks |

```bash
npm install
npm run build

# Validate and render the example Intent Document
node packages/validator/dist/cli.js validate packages/schema/src/example.json
node packages/validator/dist/cli.js render packages/schema/src/example.json

# Preview the guided viewer with mock data → http://localhost:8787/#acme/checkout-service/pull/42
node scripts/mockserver.mjs

# Tests
npx vitest run
```

Architecture and internals: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome. If the guided review reads wrong on one of your
pull requests, [open an issue](https://github.com/uditk2/review-assist/issues) with the
Intent Document and the diff that produced it — that pair is usually enough to reproduce.
Proposals to change the format itself are worth raising as an issue first, since
[`SPEC.md`](SPEC.md) is deliberately frozen and any change ripples through the validator,
the viewer, and every document already committed.

Before opening a pull request, run the checks under [Developing](#developing); CI runs the
same build, typecheck, tests, and example validation.

## License

[Apache-2.0](LICENSE).
