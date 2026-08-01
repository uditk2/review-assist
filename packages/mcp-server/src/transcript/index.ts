/**
 * The parser registry. Adding an agent is a file and one line here; nothing that consumes
 * entries has to know it happened.
 */

import { ClaudeCodeParser } from "./claude-code.js";
import { CodexParser } from "./codex.js";
import type { ParsedEntry, TranscriptParser } from "./types.js";
import { nothing } from "./types.js";

export const PARSERS: readonly TranscriptParser[] = [new ClaudeCodeParser(), new CodexParser()];

/** The parser that recognises this entry, or undefined for a shape none of them knows. */
export function parserFor(entry: Record<string, unknown>): TranscriptParser | undefined {
  return PARSERS.find((p) => p.handles(entry));
}

/** Parse an entry with whichever parser owns its shape. Unknown shapes yield nothing. */
export function parseEntry(entry: Record<string, unknown>): ParsedEntry {
  return parserFor(entry)?.parse(entry) ?? nothing();
}

export { ClaudeCodeParser } from "./claude-code.js";
export { CodexParser } from "./codex.js";
export { stripInjected, oneLine, FAILURE_SIGNAL } from "./text.js";
export type { ParsedEntry, ParsedEvent, ParsedTurn, TranscriptParser } from "./types.js";
