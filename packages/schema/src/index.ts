/**
 * Shared TypeScript types for the Intent Document format v0.1.
 * The JSON Schema at ./intent-doc.schema.json is the normative source;
 * these types mirror it for ergonomic use in the validator, MCP server, and viewer.
 */

import schemaJson from "./intent-doc.schema.json" with { type: "json" };

/** The raw JSON Schema object, loaded for use by validators. */
export const intentDocSchema = schemaJson as Record<string, unknown>;

export const SCHEMA_VERSION = "0.1" as const;

export interface Anchor {
  /**
   * The hunk id this anchor was written as, e.g. "H3", kept through expansion.
   *
   * Optional only because documents written before it exists do not carry it. Without it a
   * stored stop held a path and line ranges and nothing else, so no other field that names
   * a hunk id could be joined to the stop covering it.
   */
  id?: string;
  path: string;
  hunk: {
    old_start: number;
    old_lines: number;
    new_start: number;
    new_lines: number;
  };
}

export interface IntentDocument {
  schema_version: "0.1";
  meta: Meta;
  problem: Problem;
  assumptions: Assumption[];
  open_questions?: OpenQuestion[];
  approach: Approach;
  tour: TourStop[];
  verification: Verification;
  diagrams?: Diagram[];
  /**
   * Questions already asked and answered during distillation, kept as a LOOKUP rather than
   * as reading. Stamped by the server from the run's recorded rounds, never written by an
   * agent. See `evaluatedRounds` in the MCP server for what qualifies and why.
   */
  evaluated?: EvaluatedQuestion[];
  /**
   * Questions the interview could not settle, each with how it ended. Stamped by the
   * server from the run's recorded rounds, never written by an agent.
   */
  unresolved?: UnresolvedQuestion[];
}

/** One settled question, and the hunks that settle it. */
export interface EvaluatedQuestion {
  question: string;
  answer: string;
  /** Hunk ids, e.g. ["H4"]. Absent when the reviewer recorded none. */
  anchors?: string[];
}

/**
 * One question the interview could not settle, with HOW it ended.
 *
 * `unanswered` is not the same as unimportant: an unanswered question about a code risk
 * means the risk was never considered, which makes it a stronger finding than one that
 * got an answer. See `unresolvedRounds` in the MCP server.
 */
export interface UnresolvedQuestion {
  question: string;
  disposition: "accepted_partial" | "escalated" | "unanswered";
  note?: string;
  anchors?: string[];
}

export interface Diagram {
  title: string;
  /** Mermaid diagram source — rendered by GitHub (PR description) and the viewer. */
  mermaid: string;
  caption?: string;
}

export interface Meta {
  id: string;
  repo: string;
  commit_range: { base_sha: string; head_sha: string };
  session: {
    agent: string;
    model: string;
    session_ids?: string[];
    started_at?: string;
    ended_at?: string;
  };
  generated_by: { pipeline: string; version: string };
  generated_at: string;
  interview?: {
    rounds?: number;
    questions_asked?: number;
    unresolved?: number;
    /** Answers the author role wrote itself, via `answer_questions`. */
    author_attested?: number;
    /** Answers the developer gave when neither transcript nor code could settle it. */
    developer_attested?: number;
    unanswered?: number;
  };
}

export interface Problem {
  statement: string;
  origin: "stated_upfront" | "emerged_during_session";
  user_asks: string[];
  out_of_scope?: string[];
}

export interface Assumption {
  id: string;
  /** Hunk ids this assumption bears on, so it can be shown at the stop it applies to. */
  anchors?: string[];
  assumption: string;
  impact_if_wrong: string;
  depends?: string[];
  how_to_verify?: string;
  confidence: "confirmed_by_user" | "grounded_in_code" | "unverified";
}

export interface OpenQuestion {
  id: string;
  question: string;
  context?: string;
  raised_by?: "reviewer_agent" | "author_agent" | "user";
  /** Hunk ids this question concerns, so it can be shown at the stop it applies to. */
  anchors?: string[];
}

export interface Approach {
  requirements: { text: string; source?: string }[];
  trials?: { what: string; outcome: string; why_abandoned: string }[];
  adopted: { summary: string; rationale: string };
}

export interface TourStop {
  id: string;
  title: string;
  role: "core" | "supporting" | "incidental";
  what: string;
  why: string;
  anchors: Anchor[];
  parent?: string | null;
  provenance: "from_transcript" | "confirmed_in_interview" | "inferred_from_code";
  attention?: string;
}

export interface Verification {
  performed: { kind: "test" | "manual" | "build" | "lint" | "typecheck"; description: string; result: string; evidence?: string }[];
  added_tests?: { covers: string; anchors: Anchor[] }[];
  /**
   * A plain string, or one carrying the hunk ids it concerns.
   *
   * A union rather than a clean break: this is PUBLISHED content. The GitHub App reads
   * `.intent/<branch>.json` off open pull requests, so changing the shape outright would
   * break documents already committed on live branches. Use `notVerifiedItems` to read it
   * rather than handling both forms at every call site.
   */
  not_verified?: (string | { text: string; anchors?: string[] })[];
}

/**
 * `verification.not_verified` as one shape, whatever the document wrote.
 *
 * The field is a union because it is published content: the GitHub App reads
 * `.intent/<branch>.json` off open pull requests, so the plain-string form cannot be
 * retired without breaking documents already committed on live branches. Every renderer
 * needs the same two pieces, so the normalizing happens once here rather than four times
 * — the same reason the access list and the tool allowlist are generated from one constant.
 */
export function notVerifiedItems(
  v: Verification | undefined
): { text: string; anchors: string[] }[] {
  return (v?.not_verified ?? []).map((n) =>
    typeof n === "string" ? { text: n, anchors: [] } : { text: n.text, anchors: n.anchors ?? [] }
  );
}
