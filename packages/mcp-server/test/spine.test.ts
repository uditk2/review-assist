/**
 * The spine replaces navigating a transcript with reading one. These pin the properties
 * that make that safe: both sides of the conversation survive, every item can be traced
 * back to the full transcript, and what is dropped is dropped for a stated reason.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpine,
  pageSpine,
  type SpineItem,
  type SpineTurn,
  type SpineEvent,
  type SpineGap,
} from "../src/spine.js";

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

  it("keeps assistant prose whatever the size — paging bounds the response, not the material", () => {
    // The predecessor deleted every assistant turn past a byte ceiling, which is the worst
    // thing to lose: most trials come from the agent's side of the conversation.
    const s = buildSpine(path);
    const whole = JSON.stringify(s.items);
    let cursor: string | undefined;
    const seen: SpineItem[] = [];
    do {
      const page = pageSpine(s.items, { cursor, maxBytes: 2_000 });
      seen.push(...page.items);
      cursor = page.next_cursor;
    } while (cursor);
    expect(seen.some((i) => i.kind === "assistant")).toBe(true);
    expect(JSON.stringify(seen)).toBe(whole);
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

/**
 * Paging is what replaced dropping assistant prose, so these pin the property that made
 * the replacement worth making: following the cursor to the end yields every item, byte
 * for byte, at any page size.
 */
describe("pageSpine", () => {
  const drain = (items: SpineItem[], maxBytes: number) => {
    const seen: SpineItem[] = [];
    let cursor: string | undefined;
    let calls = 0;
    do {
      const page = pageSpine(items, { cursor, maxBytes });
      expect(page.returned).toBeGreaterThan(0); // never hand back an empty page
      seen.push(...page.items);
      cursor = page.next_cursor;
      if (++calls > 5_000) throw new Error("cursor did not converge");
    } while (cursor);
    return { seen, calls };
  };

  const turns = (texts: string[]): SpineItem[] =>
    texts.map((text, index) => ({ kind: "user" as const, index, text }));

  it("cuts on item boundaries when items fit", () => {
    const items = turns(["a".repeat(500), "b".repeat(500), "c".repeat(500)]);
    const first = pageSpine(items, { maxBytes: 1_400 });
    expect(first.returned).toBe(2);
    expect(first.next_cursor).toBe("2");
    expect(first.remaining).toBe(1);
    expect(first.total).toBe(3);
  });

  it("serves a turn too large for a whole page by slicing it, rather than deadlocking", () => {
    const items = turns(["x".repeat(10_000)]);
    const page = pageSpine(items, { maxBytes: 2_000 });
    expect(page.returned).toBe(1);
    const only = page.items[0] as SpineTurn;
    expect(only.text.length).toBeLessThan(10_000);
    expect(only.text_chars).toBe(10_000);
    expect(only.chars?.[0]).toBe(1);
    expect(page.next_cursor).toMatch(/^0:\d+$/);
  });

  it("reassembles to exactly the input, at every page size", () => {
    const items: SpineItem[] = [
      ...turns(["short", "y".repeat(9_000)]),
      { kind: "command", index: 2, summary: "npm test" },
      { kind: "gap", from: 3, to: 40, entries: 37, failures: 1 },
      ...turns(["tail"]),
    ];
    for (const budget of [200, 2_000, 20_000]) {
      const { seen } = drain(items, budget);
      const rejoined = seen.reduce<SpineItem[]>((acc, item) => {
        const prev = acc[acc.length - 1] as SpineTurn | undefined;
        const cur = item as SpineTurn;
        if (prev && cur.chars && prev.index === cur.index && prev.kind === cur.kind) {
          acc[acc.length - 1] = { ...prev, text: prev.text + cur.text };
          return acc;
        }
        acc.push(cur.chars ? { ...cur, text: cur.text } : item);
        return acc;
      }, []);
      const normalized = rejoined.map((i) => {
        const { chars: _c, text_chars: _t, ...rest } = i as SpineTurn;
        return rest;
      });
      expect(normalized).toEqual(items);
    }
  });

  it("refuses a malformed cursor rather than silently restarting", () => {
    expect(() => pageSpine(turns(["a"]), { cursor: "nonsense" })).toThrow(/Malformed cursor/);
    expect(() => pageSpine(turns(["a"]), { cursor: "9" })).toThrow(/past the end/);
  });
});
