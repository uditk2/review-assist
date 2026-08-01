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
  /** Set when the conversation alone was too large and only user turns were kept. */
  degraded?: "user_turns_only";
  note: string;
}

export interface SpineOptions {
  /**
   * Above this, drop assistant prose and keep user turns plus events. One session in the
   * 41 measured needed it — 20.6 MB raw — and its user prose alone fits comfortably, so
   * the fallback needs no further machinery.
   */
  maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 600_000; // ~150k tokens
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

export function buildSpine(path: string, opts: SpineOptions = {}): Spine {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
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
    total_entries: entries.length,
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
