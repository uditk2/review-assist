# Privacy: Review Assist plugin

Last updated 22 October 2026.

The Review Assist plugin runs entirely on your computer. It has no account and no server of
its own, and it makes no network calls, so its developer receives nothing from it.

## What it reads and keeps

It asks once per repository before reading anything there. With your consent it reads the
repository through git and the coding sessions recorded in it, and keeps its working state
under `~/.review-assist/` on your computer. The plugin's [README](README.md#what-it-reads-writes-and-sends)
lists every location it reads and writes.

- **Retention.** A run is deleted 30 days after it was last used, or 7 days after its
  document was written. Your consent decisions stay until you reset them. Delete
  `~/.review-assist/` to remove everything at once.
- **The Intent Document** is written into your repository. It is yours: it goes wherever you
  commit or push it, and nowhere else. It is checked for likely secrets before it is written.

## Your Claude session

What the plugin's tools return, including excerpts of your coding sessions, becomes part of
your Claude Code conversation, the same as any file Claude Code reads. Anthropic handles that
conversation under its own terms and privacy policy.

## Other Review Assist services

The Review Assist GitHub App and the reviewassist.dev website are separate from this plugin
and are not needed to use it. Installing the plugin does not install or contact either.

## Contact

Questions and requests: [open an issue](https://github.com/uditk2/review-assist/issues).
