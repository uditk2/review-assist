/**
 * One contract, one parser per agent.
 *
 * Review Assist reads sessions from Claude Code and Codex, and their transcripts share
 * nothing: Claude Code writes `{message:{role, content:[…]}}`, Codex writes
 * `{type, payload}` with a separate vocabulary for prose, shell work and edits. Code that
 * guesses at both in one pass silently half-works — the spine returned a single item for
 * 831 Codex entries, and `list_transcripts` showed an empty preview for every Codex
 * session, because each had its own partial idea of where a user turn lives.
 *
 * So the shape of a transcript is known in exactly one place per agent, behind this
 * interface. Callers depend on `ParsedEntry` and never on a format. Supporting a third
 * agent is a new file and a registry line; nothing that consumes entries changes.
 */

/** Prose someone actually wrote. */
export interface ParsedTurn {
  role: "user" | "assistant";
  text: string;
}

/** A one-line trace of something done rather than said. */
export interface ParsedEvent {
  kind: "command" | "edit";
  summary: string;
  /**
   * For `edit`: the file's path exactly as the transcript recorded it — absolute from
   * Claude Code's `file_path`, either form from Codex's patch summary. `summary` stays the
   * basename because it is read as prose; this is the only field a caller may compare
   * against a diff, and a caller must handle both forms.
   *
   * Parsers do not resolve it. They cannot: an entry says nothing about which repository
   * it belongs to, and this interface is deliberately free of that knowledge. Whoever
   * knows the repo root relativizes it.
   */
  path?: string;
  /**
   * For `command`: every path-like token in the UNTRUNCATED command, which is where a
   * Bash-driven session records the files it wrote. `summary` is capped at 200 characters
   * and the writes routinely sit past that cap, so this is not derivable from it.
   */
  paths?: string[];
}

/**
 * One transcript entry, in terms a consumer can use.
 *
 * Deliberately free of cross-entry state. A question's answer arrives in a later entry and
 * a plan is only interesting against the previous snapshot, so both are reported raw and
 * correlated by the caller. Parsers describe entries; they do not assemble narratives.
 */
export interface ParsedEntry {
  turn?: ParsedTurn;
  events: ParsedEvent[];
  /** A structured question put to the user. Its answer lands in a later entry. */
  question?: string;
  /** An answer to a question asked earlier, if this entry carries one. */
  answer?: string;
  /** The todo list as it stood here. The caller diffs it against the last to find changes. */
  plan?: string[];
  /** Whether this entry reports something failing. */
  failure: boolean;
}

/**
 * One entry's text, split by direction.
 *
 * The distinction is the whole basis of attributing a hunk to a session: a session that
 * WROTE a line put it in a tool's input, and a session that merely read the file got the
 * same line back in a tool's output. Measured on commit 05c90a4, the session that made it
 * matched 16 of 25 added lines on the authored side and 0 on the observed side, while
 * three other sessions matched 19 to 23 lines on the observed side and 0 authored. Without
 * the split they are indistinguishable.
 */
export interface EntryAttribution {
  /** Text this entry wrote: tool inputs, patch bodies, heredocs. */
  authored: string;
  /** Text this entry read back: tool output, file contents, command stdout. */
  observed: string;
}

export interface TranscriptParser {
  readonly agent: "claude-code" | "codex";
  /** Does this parser recognise the entry's shape? */
  handles(entry: Record<string, unknown>): boolean;
  parse(entry: Record<string, unknown>): ParsedEntry;
  /**
   * Which text this entry wrote and which it read back.
   *
   * Separate from `parse` rather than a field on `ParsedEntry`, because only attribution
   * needs it and the text is large: the spine parses every entry in a session and would
   * otherwise carry a copy of every tool result it exists to elide.
   */
  attribution(entry: Record<string, unknown>): EntryAttribution;
}

export const NO_ATTRIBUTION: EntryAttribution = Object.freeze({ authored: "", observed: "" });

export const EMPTY: ParsedEntry = Object.freeze({ events: [], failure: false });

/** Nothing of interest in this entry. */
export function nothing(failure = false): ParsedEntry {
  return { events: [], failure };
}
