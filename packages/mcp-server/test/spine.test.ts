/**
 * The spine replaces navigating a transcript with reading one. These pin the properties
 * that make that safe: both sides of the conversation survive, every item can be traced
 * back to the full transcript, and what is dropped is dropped for a stated reason.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpine, type SpineTurn, type SpineEvent, type SpineGap } from "../src/spine.js";

const dir = mkdtempSync(join(tmpdir(), "review-assist-spine-"));
const write = (name: string, entries: unknown[]) => {
  const p = join(dir, name);
  writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
};
const user = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "text", text }] } });
const asst = (text: string) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
const use = (name: string, input: unknown) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", name, input }] },
});
const result = (text: string) => ({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: text }] } });

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("buildSpine", () => {
  let path: string;
  beforeAll(() => {
    path = write("session.jsonl", [
      user("<ide_opened_file>noise</ide_opened_file> Add an ads manager."),
      { type: "assistant", message: { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "x" }] } },
      asst("A combined query drops campaigns with no activity."),
      use("Bash", { command: "npm test   --silent" }),
      result("exit code: 0"),
      use("Edit", { file_path: "/repo/src/google-ads-campaign.service.ts" }),
      result("ok"),
      use("AskUserQuestion", { questions: [{ question: "How much should it cover?", options: [{ label: "list only" }, { label: "list + metrics" }] }] }),
      result('the user answered: "list + metrics"'),
      use("Bash", { command: "npm run build" }),
      result("error TS2305: no exported member"),
      user("Keep it manual only."),
    ]);
  });

  it("keeps both sides — two thirds of the prose is the agent, and half a negotiation is its half", () => {
    const s = buildSpine(path);
    const turns = s.items.filter((i) => i.kind === "user" || i.kind === "assistant") as SpineTurn[];
    expect(turns.map((t) => t.kind)).toEqual(["user", "assistant", "user"]);
    expect(turns[1].text).toContain("drops campaigns with no activity");
  });

  it("strips the client scaffolding that opens a user turn, not the ask", () => {
    const first = buildSpine(path).items.find((i) => i.kind === "user") as SpineTurn;
    expect(first.text).toBe("Add an ads manager.");
  });

  it("carries an index for every item, so a claim can be traced to the transcript", () => {
    for (const i of buildSpine(path).items) {
      const at = i.kind === "gap" ? (i as SpineGap).from : (i as SpineTurn | SpineEvent).index;
      expect(Number.isInteger(at)).toBe(true);
    }
  });

  it("captures a structured scope decision with the answer, not just the question", () => {
    const q = buildSpine(path).items.find((i) => i.kind === "question") as SpineEvent;
    expect(q.summary).toContain("How much should it cover?");
    expect(q.summary).toContain("list + metrics");
    expect(q.answer).toContain("list + metrics");
  });

  it("reduces commands and edits to one line each", () => {
    const items = buildSpine(path).items;
    const cmd = items.find((i) => i.kind === "command") as SpineEvent;
    const edit = items.find((i) => i.kind === "edit") as SpineEvent;
    expect(cmd.summary).toBe("npm test --silent");
    expect(edit.summary).toBe("google-ads-campaign.service.ts");
  });

  it("reports a gap that contains a failure", () => {
    const gaps = buildSpine(path).items.filter((i) => i.kind === "gap") as SpineGap[];
    expect(gaps.some((g) => g.failures > 0)).toBe(true);
  });

  it("stays silent about short elisions, which the indices already show", () => {
    // Two turns with nothing but a successful tool result between them.
    const quiet = write("quiet.jsonl", [user("one"), result("exit code: 0"), user("two")]);
    expect(buildSpine(quiet).items.filter((i) => i.kind === "gap")).toHaveLength(0);
  });

  it("contributes nothing from thinking blocks, which are stored empty", () => {
    const s = buildSpine(path);
    expect(JSON.stringify(s.items)).not.toContain("signature");
    // The thinking-only entry produced no item at all.
    expect(s.items.some((i) => (i as SpineTurn).index === 1)).toBe(false);
  });

  it("drops assistant prose rather than truncating when the conversation is too large", () => {
    const s = buildSpine(path, { maxBytes: 200 });
    expect(s.degraded).toBe("user_turns_only");
    expect(s.items.some((i) => i.kind === "assistant")).toBe(false);
    expect(s.items.some((i) => i.kind === "user")).toBe(true);
    expect(s.note).toMatch(/exceeded the budget/);
  });

  it("records the plan as agreed, then only what changed about it", () => {
    // Snapshots would drown the signal — one real session revised its list 31 times. A
    // status flipping to done is progress; an item appearing or vanishing is a decision.
    const todo = (items: [string, string][]) => ({
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "TodoWrite", input: { todos: items.map(([status, content]) => ({ status, content })) } }],
      },
    });
    const p = write("plan.jsonl", [
      user("build the ads manager"),
      todo([["in_progress", "list campaigns"], ["pending", "pause and resume"]]),
      todo([["completed", "list campaigns"], ["in_progress", "pause and resume"]]),
      todo([["completed", "list campaigns"], ["pending", "restructure the sidebar"]]),
    ]);
    const plans = buildSpine(p).items.filter((i) => i.kind === "plan") as SpineEvent[];
    expect(plans).toHaveLength(2);
    expect(plans[0].summary).toBe("plan agreed: list campaigns | pause and resume");
    // Progress alone emitted nothing; the third snapshot changed scope, so it did.
    expect(plans[1].summary).toContain("added: restructure the sidebar");
    expect(plans[1].summary).toContain("dropped: pause and resume");
  });

  it("reports the whole transcript's size, so read_transcript offsets stay meaningful", () => {
    const s = buildSpine(path);
    expect(s.total_entries).toBe(12);
    expect(s.spine_bytes).toBeLessThan(s.raw_bytes);
  });
});
