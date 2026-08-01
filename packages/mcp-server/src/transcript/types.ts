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

export interface TranscriptParser {
  readonly agent: "claude-code" | "codex";
  /** Does this parser recognise the entry's shape? */
  handles(entry: Record<string, unknown>): boolean;
  parse(entry: Record<string, unknown>): ParsedEntry;
}

export const EMPTY: ParsedEntry = Object.freeze({ events: [], failure: false });

/** Nothing of interest in this entry. */
export function nothing(failure = false): ParsedEntry {
  return { events: [], failure };
}
