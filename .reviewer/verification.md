# What "verified" means here

`verification.not_verified` is the field authors fill most optimistically, and this repo has
two things that look verified and are not.

## A rebuilt server is not a reloaded one
The MCP server is a bundle. `npm run build` makes a change live for a NEW client session;
agents already running keep the old one. Ask whether the author restarted, or only rebuilt.

## Prompt changes are not covered by the test suite
`npm test` covers the validator, the run store, the transcript sources and role
installation. It does not run an agent. A change to role prose or to the generation guide is
verified only by a distillation actually performed after it, so ask which one, and take
"the tests pass" as a non-answer for those files.

## The viewer is verified in a browser or not at all
Changes under `apps/github-app/viewer/` render untrusted repo content. Ask whether the page
was opened, and with what document.
