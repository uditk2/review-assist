/**
 * Per-repository consent for Review Assist.
 *
 * Review Assist is installed once (globally), but it must not silently operate on
 * every repository. The same decision covers both things it does there: reading the
 * repository's coding sessions, and writing the Intent Document. Each session-reading tool
 * and submit_document check it. Decisions are stored per-user, centrally:
 *
 *   ~/.review-assist/consent.json   (override dir with REVIEW_ASSIST_HOME)
 *
 * States: "enabled" (always) and "disabled" (never) are persisted; "once" (just this
 * time) lives in memory for the life of the server process, and on the run when one is
 * named, so that every agent working on that change sees it. That second home matters
 * under Codex, where each role runs its own server process: a "once" held only in the
 * reviewer's memory would leave the author refused.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename } from "node:path";

const CONSENT_DIR =
  process.env.REVIEW_ASSIST_HOME ?? join(homedir(), ".review-assist");
const CONSENT_FILE = join(CONSENT_DIR, "consent.json");

export type ConsentState = "enabled" | "disabled";
export type ConsentDecision = "always" | "once" | "never";
export type ConsentResult = ConsentState | "once" | "unknown";

type Record_ = { state: ConsentState; at: string; name: string };
type Store = { version: number; repos: Record<string, Record_> };

// "Just this time" — allowed for the life of this server process only, never written.
const sessionAllow = new Set<string>();

function load(): Store {
  try {
    if (existsSync(CONSENT_FILE)) {
      const raw = JSON.parse(readFileSync(CONSENT_FILE, "utf8"));
      if (raw && typeof raw === "object" && raw.repos) return raw as Store;
    }
  } catch {
    /* corrupt/unreadable — treat as empty rather than crash the flow */
  }
  return { version: 1, repos: {} };
}

function save(store: Store): void {
  mkdirSync(CONSENT_DIR, { recursive: true });
  writeFileSync(CONSENT_FILE, JSON.stringify(store, null, 2) + "\n", "utf8");
}

/** Current decision for a repo: enabled | disabled | once (session) | unknown. */
export function getConsent(repo: string): ConsentResult {
  return consentFor(repo);
}

/**
 * The decision for a repo, counting a "once" recorded on a run (`onceAt`, when it was
 * given). A run's "once" stands unless the user persisted a decision AFTER it: someone who
 * says "never" mid-distillation means never, from then on.
 */
export function consentFor(repo: string, onceAt?: string): ConsentResult {
  const key = resolve(repo);
  if (sessionAllow.has(key)) return "once";
  const rec = load().repos[key];
  if (onceAt && (!rec || rec.at < onceAt)) return "once";
  return rec ? rec.state : "unknown";
}

/** Whether this decision lets Review Assist read the repo's sessions and write its document. */
export function consentAllows(c: ConsentResult): boolean {
  return c === "enabled" || c === "once";
}

/** Record a decision. "once" is session-only; "always"/"never" persist. */
export function setConsent(repo: string, decision: ConsentDecision): void {
  const key = resolve(repo);
  if (decision === "once") {
    sessionAllow.add(key);
    return;
  }
  const store = load();
  store.repos[key] = {
    state: decision === "always" ? "enabled" : "disabled",
    at: new Date().toISOString(),
    name: basename(key),
  };
  save(store);
}

/** Remove a repo from the list entirely (so it is asked about again). */
export function resetConsent(repo: string): boolean {
  const key = resolve(repo);
  const had = sessionAllow.delete(key);
  const store = load();
  if (store.repos[key]) {
    delete store.repos[key];
    save(store);
    return true;
  }
  return had;
}

/** All persisted decisions. */
export function listConsent(): { repo: string; state: ConsentState; at: string }[] {
  const store = load();
  return Object.entries(store.repos).map(([repo, r]) => ({
    repo,
    state: r.state,
    at: r.at,
  }));
}

export function consentFilePath(): string {
  return CONSENT_FILE;
}
