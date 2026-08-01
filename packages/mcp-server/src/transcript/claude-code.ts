/**
 * Claude Code transcripts: `{type, message:{role, content:[…]}}`, one JSON object per line.
 *
 * Content blocks are `text`, `thinking`, `tool_use` and `tool_result`. Only `text` carries
 * prose — `thinking` blocks are written with their content stripped
 * (`{"type":"thinking","thinking":"","signature":"…"}`), so an agent's private reasoning
 * about why an approach fails is not on disk and cannot be recovered here or anywhere.
 */

import { basename } from "node:path";
import { FAILURE_SIGNAL, oneLine, stripInjected } from "./text.js";
import type { ParsedEntry, ParsedEvent, TranscriptParser } from "./types.js";
import { nothing } from "./types.js";

type Block = Record<string, unknown>;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

function blocksOf(message: Record<string, unknown> | undefined): Block[] {
  const c = message?.content;
  return Array.isArray(c) ? (c.filter((b) => b && typeof b === "object") as Block[]) : [];
}

function proseOf(message: Record<string, unknown> | undefined): string {
  const c = message?.content;
  if (typeof c === "string") return c.trim();
  return blocksOf(message)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

/** A tool_result is the transport for a tool's output — and for an answer to a question. */
function toolResultText(message: Record<string, unknown> | undefined): string | undefined {
  for (const b of blocksOf(message)) {
    if (b.type !== "tool_result") continue;
    const c = b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((x) =>
          x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string"
            ? (x as { text: string }).text
            : ""
        )
        .join(" ");
    }
    return "";
  }
  return undefined;
}

/** The choices offered alongside the question, since the decision is which one was taken. */
function questionSummary(input: Record<string, unknown>): string {
  const qs = Array.isArray(input.questions) ? input.questions : [];
  const rendered = qs
    .map((q) => {
      const o = q as { question?: string; options?: { label?: string }[] };
      const opts = (o.options ?? []).map((x) => x.label).filter(Boolean).join(" | ");
      return opts ? `${o.question ?? ""} [${opts}]` : (o.question ?? "");
    })
    .filter(Boolean)
    .join("  ");
  return rendered || "(asked the user to choose)";
}

function todoContents(input: Record<string, unknown>): string[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos
    .map((t) => {
      const o = t as { content?: unknown; activeForm?: unknown };
      return String(o.content ?? o.activeForm ?? "").trim();
    })
    .filter(Boolean);
}

export class ClaudeCodeParser implements TranscriptParser {
  readonly agent = "claude-code" as const;

  handles(entry: Record<string, unknown>): boolean {
    return entry.message !== undefined;
  }

  parse(entry: Record<string, unknown>): ParsedEntry {
    const message = entry.message as Record<string, unknown> | undefined;
    const role = String(message?.role ?? entry.type ?? "");
    const answer = toolResultText(message);
    const failure = answer !== undefined && FAILURE_SIGNAL.test(JSON.stringify(entry).slice(0, 8000));

    const events: ParsedEvent[] = [];
    let question: string | undefined;
    let plan: string[] | undefined;

    for (const b of blocksOf(message)) {
      if (b.type !== "tool_use") continue;
      const name = String(b.name ?? "");
      const input = (b.input ?? {}) as Record<string, unknown>;
      if (name === "AskUserQuestion") question = questionSummary(input);
      else if (name === "TodoWrite") plan = todoContents(input);
      else if (name === "Bash") {
        const cmd = oneLine(String(input.command ?? ""));
        if (cmd) events.push({ kind: "command", summary: cmd });
      } else if (EDIT_TOOLS.has(name)) {
        const p = String(input.file_path ?? input.notebook_path ?? "");
        if (p) events.push({ kind: "edit", summary: basename(p) });
      }
    }

    // A turn carrying a tool_result is transport, not speech: the user did not write it.
    const isTransport = answer !== undefined;
    const text =
      role === "user" && !isTransport
        ? stripInjected(proseOf(message))
        : role === "assistant"
          ? proseOf(message)
          : "";

    if (!text && events.length === 0 && !question && !plan && answer === undefined) {
      return nothing(failure);
    }
    return {
      turn: text ? { role: role === "user" ? "user" : "assistant", text } : undefined,
      events,
      question,
      answer,
      plan,
      failure,
    };
  }
}
