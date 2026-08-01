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

/** Does this raw line look like something failed? Used to mark a gap worth opening. */
export const FAILURE_SIGNAL = /\b(FAIL|failed|Error:|error TS|Traceback|exit code: [1-9])/;
