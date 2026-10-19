/**
 * Consent decides whether a repository's sessions may be read, not only whether its
 * document may be written, so it has to hold in every process that reads them.
 *
 * Under Codex each role runs its own server process. A "just this time" held in the
 * reviewer's memory never reached the author, which is harmless while consent is checked
 * only at submit (the reviewer's own call) and fatal once reading is gated too: the author
 * would be refused for a change the user had just allowed. So "once" is recorded on the
 * run, which every process reads, and these tests stand in for the second process by never
 * putting the grant in this one's memory.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Both modules resolve REVIEW_ASSIST_HOME when they load, so it is set before the import;
// otherwise the suite would read and write the developer's real ~/.review-assist.
const HOME = mkdtempSync(join(tmpdir(), "review-assist-consent-"));
process.env.REVIEW_ASSIST_HOME = HOME;

let consent: typeof import("../src/consent.js");
let runs: typeof import("../src/runs.js");

beforeAll(async () => {
  consent = await import("../src/consent.js");
  runs = await import("../src/runs.js");
});

afterAll(() => rmSync(HOME, { recursive: true, force: true }));

const repo = (name: string) => join(HOME, "repos", name);
const LONG_AGO = "2000-01-01T00:00:00.000Z";

describe("consent across processes", () => {
  it("is unknown until the user answers, and unknown allows nothing", () => {
    expect(consent.consentFor(repo("fresh"))).toBe("unknown");
    expect(consent.consentAllows("unknown")).toBe(false);
    expect(consent.consentAllows("disabled")).toBe(false);
  });

  it("counts a run's \"once\" in a process that never heard it given", () => {
    expect(consent.consentFor(repo("other-process"), new Date().toISOString())).toBe("once");
    expect(consent.consentAllows("once")).toBe(true);
  });

  it("lets a later \"never\" override an earlier \"once\"", () => {
    consent.setConsent(repo("changed-mind"), "never");
    expect(consent.consentFor(repo("changed-mind"), LONG_AGO)).toBe("disabled");
  });

  it("lets a \"once\" given after a \"never\" stand for its run", () => {
    consent.setConsent(repo("relented"), "never");
    expect(consent.consentFor(repo("relented"), new Date(Date.now() + 1000).toISOString())).toBe("once");
  });

  it("records \"once\" on the run, where every process reads it", () => {
    const { run } = runs.openRun({ repo: repo("on-the-run"), baseSha: "a".repeat(40), headSha: "b".repeat(40), branch: "feat" });
    expect(run.consent_once_at).toBeUndefined();
    runs.grantConsentOnce(run.run_id);
    const reread = runs.getRun(run.run_id)!;
    expect(reread.consent_once_at).toBeTruthy();
    expect(consent.consentFor(reread.repo, reread.consent_once_at)).toBe("once");
  });
});
