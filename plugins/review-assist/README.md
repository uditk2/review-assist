# Review Assist

Turn the coding session behind a branch into an **Intent Document**: a short, reviewable
account of the change. It records what you asked for, what was assumed, what was tried and
dropped, and what was tested, and it is checked against the diff before it is written. A
reviewer reads it next to the pull request instead of reconstructing your reasoning from
the diff.

## Use it

Ask Claude to "write the Intent Document for this branch", or run
`/review-assist:intent-document`. Claude starts two agents that work in parallel:

- **review-assist:intent-author** reads your coding session and answers questions about it.
  It cannot write the document.
- **review-assist:intent-reviewer** reads the diff cold, asks the author what the diff
  cannot show, and writes the document. It never sees your session.

The result is `.intent/<branch>.json` in your repository, and a ready-made pull request
description. Commit the document with the change.

Optional: the [Review Assist GitHub App](https://github.com/apps/review-assist-guided-review)
turns the document into a guided review on the pull request.

## Requirements

- Claude Code on your own machine. The plugin's server runs locally, so in a claude.ai chat
  it does nothing.
- Node.js 18 or later on your `PATH`, and git.

## What it reads, writes and sends

Review Assist asks once per repository before it does anything there: always, just this
time, or never. Until you answer, no session is read and nothing is written.

| | What | When |
| --- | --- | --- |
| Reads | The repository, through `git`, read-only | During a run |
| Reads | Coding sessions recorded in the repository or a folder above it: Claude Code's `~/.claude/projects`, the Claude desktop app's local agent sessions, and Codex's `~/.codex/sessions`. To find them it reads the start of other session files. | During a run, after you consent |
| Reads | The repository's `.reviewer/` folder of review rules, if it has one | During a run |
| Writes | `.intent/<branch>.json` in the repository | When the document passes validation, after you consent |
| Writes | Its working state under `~/.review-assist/`: your consent decisions, each run's questions and answers, an index of what each session was about and which files it touched, and any session you import | During a run |
| Sends | Nothing. The server makes no network calls; its only subprocess is `git`. | Never |

What the tools return becomes part of your Claude Code conversation, like any file Claude
Code reads. The plugin does not write to `~/.claude/agents`: its two agents ship inside it.

A run is deleted from `~/.review-assist/runs` 30 days after it was last used, or 7 days
after its document was written. Delete `~/.review-assist/` to remove everything at once.

## Coming from an older install

If you added Review Assist before with `claude mcp add`, remove that registration and its
two agent files, or Claude will see two copies of each agent:

```bash
claude mcp remove -s user review-assist
rm ~/.claude/agents/intent-author.md ~/.claude/agents/intent-reviewer.md
```

Ask Claude to call `get_role_definitions` to see whether any are still there.

## More

- [Privacy](PRIVACY.md), [terms](TERMS.md), licensed under [Apache-2.0](LICENSE).
- Source, issues and the Intent Document format:
  [github.com/uditk2/review-assist](https://github.com/uditk2/review-assist)
