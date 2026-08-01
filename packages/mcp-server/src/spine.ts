/**
 * The spine: a session's conversation, with everything else marked rather than dropped.
 *
 * The author used to navigate a transcript blind — paging windows and running ranked
 * searches over a corpus that is 95% machinery. Measured across 41 sessions in one
 * workspace: 85 MB of raw transcript, of which the conversation is a median 4.8%. One
 * author pulled 388 KB across 34 calls to build an incomplete picture of a session whose
 * entire conversation is 344 KB. Search was costing more than reading everything and
 * returning less.
 *
 * So it reads everything. The spine of 40 of those 41 sessions fits in a single call —
 * median 11,886 tokens — and being complete, it removes the failure mode retrieval can
 * never rule out: an answer the author simply never found.
 *
 * What it keeps and why:
 *
 * - BOTH SIDES of the conversation. Roughly two thirds of the prose is the agent, and it
 *   has to be: half a negotiation is the agent's side, "yes, do that" means nothing
 *   without the proposal it answers, and the findings that become `trials` are almost
 *   always the agent reporting something. Of 23 trials in seven real documents, only 6
 *   were user redirects.
 * - AskUserQuestion in full. Scope decisions arrive as structured tool calls, not prose —
 *   one document cites a trial rejected "by the user's structured scope answer".
 * - Commands and edits as one-liners. The trail of what ran and what was touched, without
 *   the output that makes it enormous.
 * - The plan, as revisions rather than snapshots. Where a session keeps a todo list, the
 *   DELTA is the part worth carrying: one session revised its list 31 times across 84
 *   distinct items, and the diffs show real scope moving — "dropped: Map exact reuse
 *   interfaces" is an approach being abandoned. Snapshots would drown that. Only additions
 *   and removals are emitted; a status flipping to done is progress, not a change of plan.
 *
 *   Corroboration, never the source. The list appears in 9 of 41 measured sessions, and
 *   even where it appears the plan it records is downstream of the conversation that set
 *   it: in the ads-manager session the only item ever added was "Typecheck/lint", while
 *   the trial its Intent Document records — a tab switcher superseded by the user asking
 *   for the sidebar restructured — never entered the list at all. An author that reads the
 *   plan events and stops has missed the plan.
 * - GAPS, marked with what was elided. A summary tells you what a model thought was
 *   there; a spine tells you what is there and where the rest is. `read_transcript`
 *   around a marked gap is how the author substantiates a claim whose evidence lives in
 *   tool output.
 *
 * Not kept: thinking. Claude Code persists the block and strips its content —
 * `{"type":"thinking","thinking":"","signature":"…"}` — so an agent's private reasoning
 * about why an approach fails is unrecoverable. Nothing here can change that.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

/** A turn someone actually wrote. */
export interface SpineTurn {
  kind: "user" | "assistant";
  /** Index into the full transcript, for `read_transcript`. */
  index: number;
  text: string;
}

/** A one-line trace of something done rather than said. */
export interface SpineEvent {
  kind: "question" | "command" | "edit" | "plan";
  index: number;
  summary: string;
  /** For `question`: the user's answer, which is the decision itself. */
  answer?: string;
}

/**
 * A stretch of elided machinery worth mentioning.
 *
 * Most elision needs no marker: consecutive items carry their own indices, so a turn at
 * 2 followed by one at 9 already says 3-8 were dropped. Emitting a marker for every such
 * run produced 193 of them in a 992-entry session, nearly half the spine, each saying
 * nothing the indices did not. A gap is only reported when it carries something the
 * indices cannot — a failure inside it, or a stretch long enough to be a phase of work.
 */
export interface SpineGap {
  kind: "gap";
  from: number;
  to: number;
  entries: number;
  failures: number;
}

export type SpineItem = SpineTurn | SpineEvent | SpineGap;

export interface Spine {
  path: string;
  session: string;
  /** Entries in the full transcript, so `read_transcript` offsets make sense. */
  total_entries: number;
  raw_bytes: number;
  spine_bytes: number;
  items: SpineItem[];
  /** Set when the conversation alone was too large and only user turns were kept. */
  degraded?: "user_turns_only";
  note: string;
}

export interface SpineOptions {
  /**
   * Above this, drop assistant prose and keep user turns plus events. One session in the
   * 41 measured needed it — 20.6 MB raw, 244k tokens of spine — and its user prose alone
   * is 61k tokens, so the fallback needs no further machinery.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 600_000; // ~150k tokens
/** Below this an elided run is left to the indices; above it, it is a phase worth naming. */
const GAP_WORTH_REPORTING = 40;
const FAILURE = /\b(FAIL|failed|Error:|error TS|Traceback|exit code: [1-9])/;

function parse(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function blocks(msg: Record<string, unknown> | undefined): Record<string, unknown>[] {
  const c = msg?.content;
  return Array.isArray(c) ? (c.filter((b) => b && typeof b === "object") as Record<string, unknown>[]) : [];
}

/** Visible prose only. `thinking` blocks are present but empty on disk. */
function proseOf(msg: Record<string, unknown> | undefined): string {
  const c = msg?.content;
  if (typeof c === "string") return c.trim();
  return blocks(msg)
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => (b.text as string).trim())
    .filter(Boolean)
    .join("\n\n");
}

function isToolResultCarrier(msg: Record<string, unknown> | undefined): boolean {
  return blocks(msg).some((b) => b.type === "tool_result");
}

/** The answer to an AskUserQuestion arrives in the following tool_result. */
function toolResultText(msg: Record<string, unknown> | undefined): string {
  for (const b of blocks(msg)) {
    if (b.type !== "tool_result") continue;
    const c = b.content;
    if (typeof c === "string") return c;
    if (Array.isArray(c)) {
      return c
        .map((x) => (x && typeof x === "object" && typeof (x as { text?: unknown }).text === "string" ? (x as { text: string }).text : ""))
        .join(" ");
    }
  }
  return "";
}

/**
 * Client scaffolding prepended to a user turn — an <ide_opened_file> block, a
 * <system-reminder>. Any tag-wrapped block that OPENS the turn is the client talking,
 * not the developer, and leaving it in makes every session's opening look identical.
 */
function stripInjected(text: string): string {
  let t = text;
  for (let i = 0; i < 8; i++) {
    const next = t.replace(/^\s*<([a-z0-9_-]+)>[\s\S]*?<\/\1>\s*/i, "").replace(/^\s*<[a-z0-9_-]+\/>\s*/i, "");
    if (next === t) break;
    t = next;
  }
  return t.trim();
}

/** Todo items as plain strings, for diffing one snapshot against the last. */
function todoContents(input: Record<string, unknown>): string[] {
  const todos = Array.isArray(input.todos) ? input.todos : [];
  return todos
    .map((t) => String((t as { content?: unknown; activeForm?: unknown }).content ?? (t as { activeForm?: unknown }).activeForm ?? "").trim())
    .filter(Boolean);
}

function eventFor(index: number, name: string, input: Record<string, unknown>): SpineEvent | null {
  if (name === "AskUserQuestion") {
    const qs = Array.isArray(input.questions) ? input.questions : [];
    const summary = qs
      .map((q) => {
        const o = q as { question?: string; options?: { label?: string }[] };
        const opts = (o.options ?? []).map((x) => x.label).filter(Boolean).join(" | ");
        return opts ? `${o.question ?? ""} [${opts}]` : (o.question ?? "");
      })
      .join("  ");
    return { kind: "question", index, summary: summary || "(asked the user to choose)" };
  }
  if (name === "Bash") {
    const cmd = String(input.command ?? "").replace(/\s+/g, " ").trim();
    return cmd ? { kind: "command", index, summary: cmd.slice(0, 200) } : null;
  }
  if (name === "TodoWrite") return null; // handled by planEvent, which needs the previous snapshot
  if (name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit") {
    const p = String(input.file_path ?? input.notebook_path ?? "");
    return p ? { kind: "edit", index, summary: basename(p) } : null;
  }
  return null;
}

export function buildSpine(path: string, opts: SpineOptions = {}): Spine {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const raw = readFileSync(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  const items: SpineItem[] = [];
  let gap: SpineGap | null = null;
  const flushGap = () => {
    if (gap && (gap.failures > 0 || gap.entries >= GAP_WORTH_REPORTING)) items.push(gap);
    gap = null;
  };
  const noteGap = (index: number, failures: number) => {
    gap ??= { kind: "gap", from: index, to: index, entries: 0, failures: 0 };
    gap.to = index;
    gap.entries += 1;
    gap.failures += failures;
  };

  let pendingQuestion: SpineEvent | null = null;
  let plan: string[] | null = null;

  /** The first list is the plan as agreed; later ones report only what changed. */
  const planEvent = (index: number, input: Record<string, unknown>): SpineEvent | null => {
    const now = todoContents(input);
    if (now.length === 0) return null;
    if (plan === null) {
      plan = now;
      return { kind: "plan", index, summary: `plan agreed: ${now.join(" | ")}` };
    }
    const before = new Set(plan);
    const after = new Set(now);
    const added = now.filter((t) => !before.has(t));
    const dropped = plan.filter((t) => !after.has(t));
    plan = now;
    if (added.length === 0 && dropped.length === 0) return null;
    const parts = [
      added.length ? `added: ${added.join(" | ")}` : "",
      dropped.length ? `dropped: ${dropped.join(" | ")}` : "",
    ].filter(Boolean);
    return { kind: "plan", index, summary: `plan revised — ${parts.join("; ")}` };
  };

  lines.forEach((line, index) => {
    const e = parse(line);
    if (!e) return void noteGap(index, 0);
    const msg = e.message as Record<string, unknown> | undefined;
    const role = (msg?.role ?? e.type) as string;

    // The answer to a question the agent asked lands in the next tool_result.
    if (pendingQuestion && isToolResultCarrier(msg)) {
      pendingQuestion.answer = toolResultText(msg).replace(/\s+/g, " ").trim().slice(0, 400);
      pendingQuestion = null;
    }

    const events: SpineEvent[] = [];
    for (const b of blocks(msg)) {
      if (b.type !== "tool_use") continue;
      const name = String(b.name ?? "");
      const input = (b.input ?? {}) as Record<string, unknown>;
      const ev = name === "TodoWrite" ? planEvent(index, input) : eventFor(index, name, input);
      if (ev) events.push(ev);
    }
    const failures = isToolResultCarrier(msg) && FAILURE.test(line.slice(0, 8000)) ? 1 : 0;

    const prose = role === "user" && !isToolResultCarrier(msg) ? stripInjected(proseOf(msg)) : role === "assistant" ? proseOf(msg) : "";

    if (!prose && events.length === 0) return void noteGap(index, failures);

    flushGap();
    if (prose) items.push({ kind: role === "user" ? "user" : "assistant", index, text: prose });
    for (const ev of events) {
      items.push(ev);
      if (ev.kind === "question") pendingQuestion = ev;
    }
    if (failures) noteGap(index, failures);
  });
  flushGap();

  const size = (list: SpineItem[]) => JSON.stringify(list).length;
  let degraded: Spine["degraded"];
  let final = items;
  if (size(final) > maxBytes) {
    final = items.filter((i) => i.kind !== "assistant");
    degraded = "user_turns_only";
  }

  return {
    path,
    session: basename(path).replace(/\.jsonl$/, ""),
    total_entries: lines.length,
    raw_bytes: statSync(path).size,
    spine_bytes: size(final),
    items: final,
    degraded,
    note:
      (degraded
        ? "The full conversation exceeded the budget, so assistant prose was dropped and only user turns and events remain. "
        : "This is the session's whole conversation. ") +
      "Every item carries its `index` into the full transcript. A jump between indices means machinery was elided there; " +
      "read_transcript around an index to see the tool output behind a claim, which is where the evidence for a measurement " +
      "usually lives. `gap` items mark only the stretches worth noticing: one containing a failure, or a long phase of work. " +
      "`plan` items are the agreed plan and every later revision to it — a revision is often an approach being abandoned.",
  };
}
