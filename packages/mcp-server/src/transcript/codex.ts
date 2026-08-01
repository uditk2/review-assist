/**
 * Codex transcripts: `{timestamp, type, payload}`, one JSON object per line.
 *
 * Prose appears twice — once as `event_msg/user_message` or `event_msg/agent_message`,
 * once as a parallel `response_item/message`. This reads the event form: it is the plain
 * string the human or agent produced, where the response_item form carries the client's
 * injected blocks and would double-count every turn.
 *
 * Reasoning looks recoverable and is not. `response_item/reasoning` holds
 * `encrypted_content` — 329 KB of ciphertext in one measured session. What is in the clear
 * is `event_msg/agent_reasoning`: short headings the agent wrote about its own next move.
 * Those are carried as assistant prose, because that is what they are.
 */

import { basename } from "node:path";
import { FAILURE_SIGNAL, oneLine, stripInjected } from "./text.js";
import type { ParsedEntry, ParsedEvent, TranscriptParser } from "./types.js";
import { nothing } from "./types.js";

/** Codex `exec` calls arrive as a JS snippet; the shell command is inside it. */
function execCommand(input: unknown): string {
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? "");
  const m = /cmd:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const cmd = m ? m[1].replace(/\\"/g, '"').replace(/\\n/g, " ") : raw;
  return oneLine(cmd);
}

/** Codex prints the files it touched when a patch lands. */
function patchedFiles(stdout: unknown): string[] {
  if (typeof stdout !== "string") return [];
  return Array.from(stdout.matchAll(/^[ADM]\s+(.+)$/gm)).map((m) => basename(m[1].trim()));
}

export class CodexParser implements TranscriptParser {
  readonly agent = "codex" as const;

  handles(entry: Record<string, unknown>): boolean {
    return entry.payload !== undefined && entry.message === undefined;
  }

  parse(entry: Record<string, unknown>): ParsedEntry {
    const payload = (entry.payload ?? {}) as Record<string, unknown>;
    const kind = String(payload.type ?? "");
    const failure = FAILURE_SIGNAL.test(JSON.stringify(entry).slice(0, 8000));

    if (kind === "user_message" && typeof payload.message === "string") {
      const text = stripInjected(payload.message);
      return text ? { turn: { role: "user", text }, events: [], failure } : nothing(failure);
    }

    if (kind === "agent_message" || kind === "agent_reasoning") {
      const text = String(payload.message ?? payload.text ?? "").trim();
      return text ? { turn: { role: "assistant", text }, events: [], failure } : nothing(failure);
    }

    if (kind === "custom_tool_call" || kind === "function_call") {
      const summary =
        kind === "custom_tool_call"
          ? execCommand(payload.input)
          : oneLine(`${String(payload.name ?? "")} ${String(payload.arguments ?? "")}`);
      const events: ParsedEvent[] = summary ? [{ kind: "command", summary }] : [];
      return { events, failure };
    }

    if (kind === "patch_apply_end") {
      const events: ParsedEvent[] = patchedFiles(payload.stdout).map((f) => ({ kind: "edit", summary: f }));
      return { events, failure };
    }

    return nothing(failure);
  }
}
