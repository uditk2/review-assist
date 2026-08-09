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
 * never rule out: an answer the author simply did not find.
 *
 * What it keeps and why:
 *
 * - BOTH SIDES of the conversation. Roughly two thirds of the prose is the agent, and it
 *   has to be: half a negotiation is the agent's side, "yes, do that" means nothing
 *   without the proposal it answers, and the findings that become `trials` are almost
 *   always the agent reporting something. Of 23 trials in seven real documents, only 6
 *   were user redirects.
 * - Structured questions with the answer chosen. Scope decisions arrive as tool calls, not
 *   prose — one document cites a trial rejected "by the user's structured scope answer".
 * - Commands and edits as one-liners: what ran and what was touched, without the output
 *   that makes it enormous.
 * - Plan revisions, where the session kept a todo list. Deltas rather than snapshots: one
 *   session revised its list 31 times across 84 items, and "dropped: Map exact reuse
 *   interfaces" is an approach being abandoned. Corroboration only — the list appears in
 *   9 of 41 sessions and lags the conversation that sets it.
 * - GAPS, but sparingly. Items carry their own indices, so a turn at 2 followed by one at
 *   9 already says 3-8 were elided; marking every run produced 193 markers in a 992-entry
 *   session. Only a gap holding a failure, or long enough to be a phase of work, is named.
 *
 * Nothing is dropped to make it fit. An earlier version deleted every assistant turn once
 * the spine passed 600 KB, which is the worst possible thing to lose: two thirds of the
 * prose is the agent's, and 17 of 23 trials in seven real documents came from its side.
 * The response is bounded by PAGING instead — `pageSpine` below, cut on item boundaries,
 * the same shape `read_diff` uses — so a large session costs more calls, not less material.
 *
 * This module assembles. It does not know what a transcript looks like — `./transcript`
 * owns that, one parser per agent, so a session from Claude Code and one from Codex arrive
 * here in the same shape.
 */

import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { parseEntry } from "./transcript/index.js";
import type { ParsedEntry } from "./transcript/index.js";

/** A turn someone actually wrote. */
export interface SpineTurn {
  kind: "user" | "assistant";
  /** Index into the full transcript, for `read_transcript`. */
  index: number;
  text: string;
  /**
   * Present only when a page carries part of this turn rather than all of it: the
   * 1-based inclusive character range held here, out of `text_chars`.
   */
  chars?: [number, number];
  text_chars?: number;
}

/** A one-line trace of something done rather than said. */
export interface SpineEvent {
  kind: "question" | "command" | "edit" | "plan";
  index: number;
  summary: string;
  /** For `question`: the answer chosen, which is the decision itself. */
  answer?: string;
}

/** A stretch of elided machinery worth mentioning. */
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
  note: string;
}

/** Below this an elided run is left to the indices; above it, it is a phase worth naming. */
const GAP_WORTH_REPORTING = 40;

function readEntries(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => {
      try {
        return JSON.parse(l) as Record<string, unknown>;
      } catch {
        return {};
      }
    });
}

/** Accumulates runs of elided entries and emits only the ones worth a marker. */
class GapCollector {
  private open: SpineGap | null = null;

  note(index: number, failures: number): void {
    this.open ??= { kind: "gap", from: index, to: index, entries: 0, failures: 0 };
    this.open.to = index;
    this.open.entries += 1;
    this.open.failures += failures;
  }

  flush(into: SpineItem[]): void {
    const g = this.open;
    this.open = null;
    if (g && (g.failures > 0 || g.entries >= GAP_WORTH_REPORTING)) into.push(g);
  }
}

/** Turns successive todo snapshots into the plan as agreed, then only what changed. */
class PlanTracker {
  private current: string[] | null = null;

  revision(index: number, snapshot: string[]): SpineEvent | null {
    if (snapshot.length === 0) return null;
    if (this.current === null) {
      this.current = snapshot;
      return { kind: "plan", index, summary: `plan agreed: ${snapshot.join(" | ")}` };
    }
    const before = new Set(this.current);
    const after = new Set(snapshot);
    const added = snapshot.filter((t) => !before.has(t));
    const dropped = this.current.filter((t) => !after.has(t));
    this.current = snapshot;
    // A status flipping to done is progress, not a change of plan.
    if (added.length === 0 && dropped.length === 0) return null;
    const parts = [
      added.length ? `added: ${added.join(" | ")}` : "",
      dropped.length ? `dropped: ${dropped.join(" | ")}` : "",
    ].filter(Boolean);
    return { kind: "plan", index, summary: `plan revised — ${parts.join("; ")}` };
  }
}

/** Everything one entry contributes, in order. */
function itemsFor(index: number, parsed: ParsedEntry, plans: PlanTracker): SpineItem[] {
  const out: SpineItem[] = [];
  if (parsed.turn) out.push({ kind: parsed.turn.role, index, text: parsed.turn.text });
  if (parsed.question) out.push({ kind: "question", index, summary: parsed.question });
  if (parsed.plan) {
    const revision = plans.revision(index, parsed.plan);
    if (revision) out.push(revision);
  }
  for (const e of parsed.events) out.push({ kind: e.kind, index, summary: e.summary });
  return out;
}

export function buildSpine(path: string): Spine {
  const entries = readEntries(path);

  const items: SpineItem[] = [];
  const gaps = new GapCollector();
  const plans = new PlanTracker();
  let awaitingAnswer: SpineEvent | null = null;

  entries.forEach((entry, index) => {
    const parsed = parseEntry(entry);

    // The answer to a question the agent asked lands in a later entry.
    if (awaitingAnswer && parsed.answer !== undefined) {
      awaitingAnswer.answer = parsed.answer.replace(/\s+/g, " ").trim().slice(0, 400);
      awaitingAnswer = null;
    }

    const produced = itemsFor(index, parsed, plans);
    if (produced.length === 0) {
      gaps.note(index, parsed.failure ? 1 : 0);
      return;
    }
    gaps.flush(items);
    items.push(...produced);
    const question = produced.find((i) => i.kind === "question") as SpineEvent | undefined;
    if (question) awaitingAnswer = question;
    if (parsed.failure) gaps.note(index, 1);
  });
  gaps.flush(items);

  return {
    path,
    session: basename(path).replace(/\.jsonl$/, ""),
    total_entries: entries.length,
    raw_bytes: statSync(path).size,
    spine_bytes: JSON.stringify(items).length,
    items,
    note:
      "This is the session's whole conversation, served in pages. Every item carries its `index` into the full " +
      "transcript. A jump between indices means machinery was elided there; read_transcript around an index to see the " +
      "tool output behind a claim, which is where the evidence for a measurement usually lives. `gap` items mark only " +
      "the stretches worth noticing: one containing a failure, or a long phase of work. `plan` items are the agreed " +
      "plan and every later revision to it — a revision is often an approach being abandoned.",
  };
}

/* ------------------------------------------------------------------ *
 * Paging
 *
 * Same contract as `read_diff`: call with no cursor, keep passing back `next_cursor`
 * until there is none, and you have read everything. Pages cut on ITEM boundaries, so a
 * turn never arrives halved and unattributable — except for the one turn too large to
 * fit a page alone, which is sliced by character and labelled with the characters it
 * carries, because a pager that can only cut between items would never serve it at all.
 * ------------------------------------------------------------------ */

/** Bytes of spine content a page carries unless the caller says otherwise. */
export const DEFAULT_SPINE_PAGE_BYTES = 20_000;

/** Rough JSON cost of an item's own keys, so the budget counts the wire, not the text. */
const PER_ITEM_OVERHEAD = 80;

export interface SpinePage {
  items: SpineItem[];
  returned: number;
  /** Items in the spine not yet fully served, counting a partly-served one. */
  remaining: number;
  total: number;
  /** Pass back as `cursor` to continue. Absent means the spine is exhausted. */
  next_cursor?: string;
}

export interface SpinePageOptions {
  /** Where to resume: `"42"`, or `"42:4000"` inside an oversized turn. */
  cursor?: string;
  maxBytes?: number;
}

/** What a string costs once it is JSON, not what it costs as text. */
function wireLen(s: string): number {
  return JSON.stringify(s).length - 2; // less the quotes JSON.stringify adds
}

/** `"42"` -> {at:42, offset:0}; `"42:4000"` -> {at:42, offset:4000}. */
export function parseSpineCursor(cursor?: string): { at: number; offset: number } {
  if (!cursor) return { at: 0, offset: 0 };
  const [head, rest] = cursor.split(":", 2);
  const at = Number(head);
  const offset = rest === undefined ? 0 : Number(rest);
  if (!Number.isInteger(at) || at < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Malformed cursor "${cursor}". Expected "<item>" or "<item>:<char-offset>".`);
  }
  return { at, offset };
}

/** Only turns carry unbounded text; events and gaps are bounded by construction. */
function isSliceable(item: SpineItem): item is SpineTurn {
  return item.kind === "user" || item.kind === "assistant";
}

function sliceTurn(turn: SpineTurn, from: number, to: number): SpineItem {
  const partial = from > 0 || to < turn.text.length;
  return partial
    ? { ...turn, text: turn.text.slice(from, to), chars: [from + 1, to], text_chars: turn.text.length }
    : turn;
}

export function pageSpine(items: SpineItem[], opts: SpinePageOptions = {}): SpinePage {
  const budget = opts.maxBytes ?? DEFAULT_SPINE_PAGE_BYTES;
  const { at: start, offset: startOffset } = parseSpineCursor(opts.cursor);
  if (start > items.length) {
    throw new Error(`Cursor "${opts.cursor}" points past the end of a ${items.length}-item spine.`);
  }

  const out: SpineItem[] = [];
  let spent = 0;
  let offset = startOffset;
  let next: string | undefined;

  for (let i = start; i < items.length; i++) {
    const item = items[i];
    const room = budget - spent - PER_ITEM_OVERHEAD;

    if (!isSliceable(item)) {
      const cost = JSON.stringify(item).length;
      // An unsliceable item that cannot fit an empty page still goes out: forward
      // progress matters more than the ceiling, and events are small by construction.
      if (cost > room && out.length > 0) {
        next = String(i);
        break;
      }
      out.push(item);
      spent += cost + PER_ITEM_OVERHEAD;
      continue;
    }

    const rest = item.text.slice(offset);
    if (wireLen(rest) <= room) {
      out.push(sliceTurn(item, offset, item.text.length));
      spent += wireLen(rest) + PER_ITEM_OVERHEAD;
      offset = 0;
      continue;
    }

    // Something is already on the page, so stop cleanly on this boundary.
    if (out.length > 0) {
      next = offset > 0 ? `${i}:${offset}` : String(i);
      break;
    }

    // Nothing on the page yet and this turn will not fit alone. Slice it, or the caller
    // asks for a page forever and never receives one. At least one character goes out.
    const take = Math.max(1, fitChars(rest, room));
    const end = offset + take;
    out.push(sliceTurn(item, offset, end));
    next = end >= item.text.length ? (i + 1 < items.length ? String(i + 1) : undefined) : `${i}:${end}`;
    break;
  }

  const page: SpinePage = {
    items: out,
    returned: out.length,
    remaining: next ? items.length - parseSpineCursor(next).at : 0,
    total: items.length,
  };
  if (next) page.next_cursor = next;
  return page;
}

/** How many leading characters of `s` fit in `budget` once JSON-encoded. */
function fitChars(s: string, budget: number): number {
  let used = 0;
  let n = 0;
  for (const ch of s) {
    const add = wireLen(ch);
    if (used + add > budget) break;
    used += add;
    n += ch.length; // surrogate pairs advance the string index by two
  }
  return n;
}
