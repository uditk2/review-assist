/**
 * One contract, two formats.
 *
 * Code that guessed at both shapes in one pass silently half-worked: the spine reduced 831
 * Codex entries to a single gap item, and every Codex candidate in list_transcripts showed
 * an empty preview. These tests hold each parser to the same interface and pin the two
 * places the formats disagree most — where prose lives, and what is recoverable.
 */

import { describe, it, expect } from "vitest";
import { ClaudeCodeParser, CodexParser, PARSERS, parserFor, parseEntry } from "../src/transcript/index.js";
import type { TranscriptParser } from "../src/transcript/index.js";

const claude = new ClaudeCodeParser();
const codex = new CodexParser();

const cc = (content: unknown, role = "assistant") => ({ type: role, message: { role, content } });
const cx = (payload: unknown) => ({ timestamp: "t", type: "event_msg", payload });

describe("the registry", () => {
  it("routes each entry to the parser that owns its shape", () => {
    expect(parserFor(cc([{ type: "text", text: "hi" }]))?.agent).toBe("claude-code");
    expect(parserFor(cx({ type: "user_message", message: "hi" }))?.agent).toBe("codex");
  });

  it("yields nothing for a shape no parser claims, rather than guessing", () => {
    expect(parserFor({ something: "else" })).toBeUndefined();
    expect(parseEntry({ something: "else" })).toEqual({ events: [], failure: false });
  });

  it("holds every parser to the same contract", () => {
    for (const p of PARSERS as TranscriptParser[]) {
      expect(typeof p.handles).toBe("function");
      expect(typeof p.parse).toBe("function");
      expect(p.parse({}).events).toEqual([]);
    }
  });

  it("does not let one parser claim the other's entries", () => {
    expect(claude.handles(cx({ type: "user_message", message: "hi" }))).toBe(false);
    expect(codex.handles(cc([{ type: "text", text: "hi" }]))).toBe(false);
  });
});

describe("ClaudeCodeParser", () => {
  it("takes prose from text blocks and strips the client's scaffolding", () => {
    const e = cc([{ type: "text", text: "<ide_opened_file>noise</ide_opened_file> Add an ads manager." }], "user");
    expect(claude.parse(e).turn).toEqual({ role: "user", text: "Add an ads manager." });
  });

  it("ignores thinking blocks, which are written with their content stripped", () => {
    const e = cc([{ type: "thinking", thinking: "", signature: "abc" }]);
    expect(claude.parse(e).turn).toBeUndefined();
  });

  it("reads a question with its options, since the decision is which was taken", () => {
    const e = cc([
      { type: "tool_use", name: "AskUserQuestion", input: { questions: [{ question: "Scope?", options: [{ label: "a" }, { label: "b" }] }] } },
    ]);
    expect(claude.parse(e).question).toBe("Scope? [a | b]");
  });

  it("reports the todo list raw, leaving the diff to the caller", () => {
    const e = cc([{ type: "tool_use", name: "TodoWrite", input: { todos: [{ status: "pending", content: "one" }] } }]);
    expect(claude.parse(e).plan).toEqual(["one"]);
  });

  it("reduces shell and edits to one line each", () => {
    const bash = claude.parse(cc([{ type: "tool_use", name: "Bash", input: { command: "npm test   --silent" } }]));
    const edit = claude.parse(cc([{ type: "tool_use", name: "Edit", input: { file_path: "/repo/src/a.ts" } }]));
    expect(bash.events).toEqual([{ kind: "command", summary: "npm test --silent" }]);
    expect(edit.events).toEqual([{ kind: "edit", summary: "a.ts" }]);
  });

  it("treats a tool_result turn as transport, not as something the user said", () => {
    const e = cc([{ type: "tool_result", content: "exit code: 0" }], "user");
    const p = claude.parse(e);
    expect(p.turn).toBeUndefined();
    expect(p.answer).toBe("exit code: 0");
  });

  it("flags a failing result so the gap around it is worth opening", () => {
    expect(claude.parse(cc([{ type: "tool_result", content: "error TS2305: nope" }], "user")).failure).toBe(true);
  });
});

describe("CodexParser", () => {
  it("takes prose from the event surface, which is what the human typed", () => {
    const e = cx({ type: "user_message", message: "<recommended_plugins>noise</recommended_plugins> Fix the diagram." });
    expect(codex.parse(e).turn).toEqual({ role: "user", text: "Fix the diagram." });
  });

  it("keeps agent_reasoning as the agent's own words", () => {
    // Codex's response_item/reasoning holds encrypted_content and is unrecoverable; these
    // short headings are the only reasoning in the clear.
    const e = cx({ type: "agent_reasoning", text: "**Planning non-intrusive SVG update**" });
    expect(codex.parse(e).turn).toEqual({ role: "assistant", text: "**Planning non-intrusive SVG update**" });
  });

  it("digs the shell command out of the JS snippet an exec call arrives as", () => {
    const e = cx({ type: "custom_tool_call", name: "exec", input: 'const r = await tools.exec_command({cmd:"rg --files -g \'!*node_modules*\'","workdir":"/x"});' });
    expect(codex.parse(e).events).toEqual([{ kind: "command", summary: "rg --files -g '!*node_modules*'" }]);
  });

  it("reads touched files out of the patch summary Codex prints", () => {
    const e = cx({ type: "patch_apply_end", stdout: "Success. Updated the following files:\nA /repo/docs/architecture.svg\nD /repo/docs/old.svg" });
    expect(codex.parse(e).events).toEqual([
      { kind: "edit", summary: "architecture.svg" },
      { kind: "edit", summary: "old.svg" },
    ]);
  });

  it("passes over the bookkeeping that makes up most of a Codex session", () => {
    for (const t of ["token_count", "task_started", "world_state", "turn_context", "reasoning"]) {
      expect(codex.parse(cx({ type: t })).turn).toBeUndefined();
      expect(codex.parse(cx({ type: t })).events).toEqual([]);
    }
  });
});
