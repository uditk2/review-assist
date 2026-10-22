---
name: intent-document
description: Write the Intent Document for the current branch with Review Assist, which turns this coding session into a reviewable account of the change (what was asked, assumed, tried and tested) and checks it against the diff before writing it. Use when the user asks for an Intent Document, wants their change explained for review before opening a pull request, or asks to run Review Assist.
---

# Write the Intent Document for this branch

Review Assist needs Claude Code on the user's own machine: its server reads the local git
repository and the coding sessions saved on this computer. If you are in a claude.ai chat,
tell the user that and stop.

1. **Settle consent first.** Call `get_generation_guide`. If `consent_state` is `unknown`,
   put its `consent_prompt` to the user exactly as written, with all three options, and
   record their answer with `set_consent`. If it is `disabled`, stop and tell them how to
   turn it back on. No session can be read until this is settled.
2. **Pick the base.** The change is the current branch against its base, usually
   `origin/main`. If that is not clear from the repository, ask the user.
3. **Start both roles in one message.** Dispatch `review-assist:intent-author` and
   `review-assist:intent-reviewer` with the Task tool in the same message, and give each the
   repository's absolute path and the base. They work in parallel and meet through the
   server, so do not relay questions or answers between them.
4. **Report back.** When the reviewer finishes, tell the user where the document was
   written (`.intent/<branch>.json`), anything the reviewer could not settle, and that the
   document belongs in the same commit or pull request as the change.

Running it again on the same branch reuses the same run, so questions already answered are
not asked again.
