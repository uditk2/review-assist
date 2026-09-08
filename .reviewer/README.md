# Reviewer instructions for this repository

Read by the reviewer role via `get_reviewer_instructions`, after it has paged the diff and
before it records round one. It is reference material: it adds questions and sharpens the
ones the diff provoked. It cannot add a schema field, relax the validator, or excuse a round
of the interview.

## What this folder is for

Everything here is an ADDITION to the questions the reviewer already asks. The baseline set
(what the user asked for verbatim, what was tried and abandoned, what the change assumes,
which hunks are incidental, what was and was not run) is the same in every repository and is
asked whatever this folder says. So is anything the diff itself provoked.

What belongs here is only what is true here: an invariant a past bug bought, a change that
must travel with something else, a directory whose churn is never incidental. Anything
recoverable from the diff does not belong; the reviewer has already read it. Neither does a
restatement of a baseline question, which only makes the folder look like the whole set.

## House rules

### Ask what a prompt change was observed to fix
Most of this repo's behaviour is prose: `packages/mcp-server/agents/_roles/*.md` and
`GENERATION_GUIDE` in `src/guide.ts` are the product, and a diff to them shows a wording
change with no way to tell a real fix from a preference. For every hunk in those files, ask
what the agent did before the change and what it does now. An answer that describes the new
wording rather than the old failure means the change is untested.

### A tool's description is part of the same prose
`registerTool` descriptions in `src/index.ts` are read by a model, not a human. Treat a
description edit as a prompt change and ask the same question.

### Ask which half of a duplicated fact moved
Several facts are deliberately stored once and rendered many times: `ROLE_TOOLS` generates
both the access list and the `tools:` allowlist, the role prose lives in `_roles/` and is
wrapped per environment, and the version comes from `package.json`. If a diff appears to
write one of these by hand, ask whether the generator was meant to change instead.

### Ask what a response's size is bounded by
No MCP tool result may grow with the size of the change; a spilled result once took the
`run_id` with it and stranded a reviewer that had no file access. For any new or edited tool
response, ask what bounds it and what the caller gets when the bound is hit.

### Never batch a change under `packages/schema` as incidental
A schema change is a compatibility event for documents already committed in other repos.
Ask about `schema_version` and about documents written before this change.

### Ask for the transcript evidence behind an interview claim
`meta.interview` attests that a real interview happened. If a diff touches how rounds,
answers or `answered_by` are recorded, ask specifically how an invented answer would still
be distinguishable afterwards.

### Ask what a consent-path change does to a repo that never opted in
Consent is per repository and the default is "not opted in". For anything under
`src/consent.ts` or any path that reads it, ask what happens on a repo with no decision
recorded.
