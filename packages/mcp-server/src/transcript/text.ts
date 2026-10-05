/** Text handling both parsers need, kept in one place so they cannot disagree. */

/**
 * Remove the client scaffolding that opens a user turn — an `<ide_opened_file>` block, a
 * `<recommended_plugins>` list, a `<system-reminder>`.
 *
 * Tag-agnostic on purpose: any tag-wrapped block that OPENS the turn is the client
 * talking, not the developer. Codex leads every session with the same plugins block, so
 * without this every Codex session's opening turn looks identical and the previews that
 * exist to tell them apart are worthless.
 */
export function stripInjected(text: string): string {
  let t = text;
  for (let i = 0; i < 8; i++) {
    const next = t
      .replace(/^\s*<([a-z0-9_-]+)>[\s\S]*?<\/\1>\s*/i, "")
      .replace(/^\s*<[a-z0-9_-]+\/>\s*/i, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/** Collapse whitespace and cap, for a one-line event summary. */
export function oneLine(s: string, max = 200): string {
  return s.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * Path-like tokens in a shell command, for matching a session against a diff.
 *
 * Necessary because `oneLine` caps a command summary at 200 characters and the work in a
 * Bash-driven session happens past that cap: measured on this repository,
 * `packages/mcp-server/src/spine.ts` appears in 15 Bash tool calls and in NONE of their
 * truncated summaries. A footprint built from summaries finds nothing.
 *
 * Deliberately permissive. Over-extraction is harmless — a token that is not a real file
 * simply never matches a diff path — while a miss makes a session invisible to the author
 * looking for who wrote a hunk. So this keeps anything shaped like a relative path with an
 * extension, and leaves validation to the caller that knows the repository.
 *
 * It does NOT try to tell writing from reading. In a heredoc the path is bound to a
 * variable and used lines later (`p="x.ts"` … `open(p,"w")`), so no adjacency rule
 * recovers the difference. A caller gets "this command mentioned this file" and nothing
 * stronger.
 */
export function extractPaths(command: string): string[] {
  const out = new Set<string>();
  for (const m of command.matchAll(/[A-Za-z0-9_.@~-]*(?:\/[A-Za-z0-9_.@~-]+)+\.[A-Za-z0-9]{1,8}\b/g)) {
    // Only a `./` or `~/` prefix is normalized away. Stripping a bare leading slash would
    // turn an absolute path OUTSIDE the repository into a plausible relative one, and the
    // caller that filters by repo root would then keep it: a scratchpad file or another
    // checkout, recorded as if it belonged to this change.
    const raw = m[0].replace(/^[.~]+\//, "");
    if (raw.includes("node_modules/") || raw.startsWith("http")) continue;
    out.add(raw);
  }
  return Array.from(out);
}

/** Does this raw line look like something failed? Used to mark a gap worth opening. */
export const FAILURE_SIGNAL = /\b(FAIL|failed|Error:|error TS|Traceback|exit code: [1-9])/;
