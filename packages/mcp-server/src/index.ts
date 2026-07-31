#!/usr/bin/env node
/**
 * review-assist MCP server.
 *
 * Exposes the tools an agent uses to author and submit an Intent Document:
 *   - get_generation_guide : schema + the two-agent authoring protocol
 *   - compute_diff         : deterministic PR diff + base/head SHAs (read-only git)
 *   - list_transcripts     : locate the session JSONL transcript(s) for the repo
 *   - read_transcript      : page through a transcript (hydrate a fresh distiller)
 *   - submit_document      : validate a candidate; on pass, write .intent/<branch>.json
 *
 * The server never calls a model. Generation is delegated to the calling agent via
 * the guide; the server computes ground truth (diff), provides source (transcript),
 * and gatekeeps the result (validator).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validate, renderPrDescription } from "@review-assist/validator";
import { intentDocSchema } from "@review-assist/schema";
import {
  getRoles,
  installRoles,
  KNOWN_ENVS,
  ROLE_TOOLS,
  activeRole,
  type RoleName,
} from "./roles.js";
import { GENERATION_GUIDE } from "./guide.js";
import {
  computeDiff,
  resolveHeadSha,
  findTranscripts,
  listTranscriptCandidates,
  readTranscriptWindow,
  searchTranscript,
  git,
} from "./git.js";
import {
  computeRunId,
  openRun,
  getRun,
  recordRounds,
  summarizeRun,
  closeRun,
  listOpenRuns,
} from "./runs.js";
import {
  getConsent,
  setConsent,
  resetConsent,
  listConsent,
  consentFilePath,
} from "./consent.js";

const REPO_DIR = resolve(process.env.REVIEW_ASSIST_REPO ?? process.cwd());

/** Single source of truth: package.json. Never write a version literal here — a
    hand-maintained copy silently drifts the moment `npm version` bumps the real one. */
export const SERVER_VERSION: string = createRequire(import.meta.url)("../package.json").version;

const server = new McpServer({
  name: "review-assist",
  version: SERVER_VERSION,
});

/**
 * Role gate. When REVIEW_ASSIST_ROLE is set, only that role's tools are registered — so
 * an author instance has no submit_document to call and a reviewer instance has no
 * read_transcript, whatever the agent driving it decides to try. This is the lock that
 * makes the two-agent split real rather than advisory; Claude Code's `tools:` allowlist
 * and Codex's per-agent mcp_servers both point at it.
 */
const ACTIVE_ROLE = activeRole();
const registerTool: typeof server.tool = ((name: string, ...rest: unknown[]) => {
  if (ACTIVE_ROLE && !ROLE_TOOLS[ACTIVE_ROLE].includes(name)) return;
  return (server.tool as (...a: unknown[]) => unknown)(name, ...rest);
}) as typeof server.tool;

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

registerTool(
  "get_generation_guide",
  "Return the Intent Document JSON Schema and the authoring protocol. Call this first.",
  {},
  async () => {
    const payload = {
      schema: intentDocSchema,
      guide: GENERATION_GUIDE,
      repo_dir: REPO_DIR,
      consent_state: getConsent(REPO_DIR),
    };
    return textResult(JSON.stringify(payload, null, 2));
  }
);


registerTool(
  "search_transcript",
  "Search a session transcript for the passages that answer a specific question. Use this " +
    "instead of paging: the reviewer asks about one thing, so retrieve only what bears on it. " +
    "Returns ranked excerpts with their entry index — follow up with read_transcript around an " +
    "index when you need the surrounding turns.",
  {
    path: z.string().describe("Transcript path (from list_transcripts)"),
    query: z
      .string()
      .describe("The reviewer's question, or the key terms from it — verbatim is fine."),
    limit: z.number().int().min(1).max(30).default(8),
    context_chars: z.number().int().min(120).max(4000).default(600),
  },
  async ({ path, query, limit, context_chars }) => {
    try {
      const res = searchTranscript(path, query, limit, context_chars);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }],
      };
    } catch (e) {
      return textResult(`search failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "compute_diff",
  "Compute the PR's own unified diff (base...head), resolve the SHAs, and OPEN THE DISTILLATION RUN. " +
    "Call this first: the returned `run_id` is the handle every later call needs, and the returned " +
    "`consent_state` tells you whether this repo is opted in BEFORE you spend a document finding out. " +
    "Anchors must use these hunk line numbers and pin to head_sha.",
  {
    base: z.string().describe("Base ref/branch/SHA, e.g. origin/main"),
    head: z.string().default("HEAD").describe("Head ref/SHA (default HEAD)"),
    repo: z.string().optional().describe("Absolute path of the repository to operate on. Required in multi-repo/container setups; defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ base, head, repo }) => {
    try {
      const repoDir = repo ? resolve(repo) : REPO_DIR;
      const { diff, baseSha, headSha } = await computeDiff(repoDir, base, head ?? "HEAD");
      const branch = await currentBranch(repoDir, head ?? "HEAD");
      const run = openRun({ repo: repoDir, baseSha, headSha, branch });
      const consent = getConsent(repoDir);
      return textResult(
        JSON.stringify(
          {
            run_id: run.run_id,
            repo: run.repo,
            base_sha: baseSha,
            head_sha: headSha,
            consent_state: consent,
            diff,
          },
          null,
          2
        )
      );
    } catch (e) {
      return textResult(`compute_diff failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "list_transcripts",
  "List candidate session transcripts for this repo — across BOTH Claude Code and Codex — ranked so you can pick THIS session's transcript even when several are close in time. Pass `base` (the change's base ref) so ranking scores each candidate by how much it references the changed files and branch. Each candidate includes `first_user`/`last_activity` previews: choose the one whose `first_user` matches how THIS session actually began; prefer higher `relevance`.",
  {
    path: z.string().optional().describe("Explicit transcript path override (skips discovery/ranking)"),
    base: z.string().optional().describe("Base ref/branch/SHA of the change — enables relevance ranking by changed files"),
    head: z.string().default("HEAD"),
    repo: z.string().optional().describe("Absolute path of the repository. Defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ path, base, head, repo }) => {
    const repoDir = repo ? resolve(repo) : REPO_DIR;
    let changedBasenames: string[] = [];
    if (base) {
      try {
        const { diff } = await computeDiff(repoDir, base, head ?? "HEAD");
        changedBasenames = extractChangedBasenames(diff);
      } catch {
        /* ranking is best-effort; fall back to recency */
      }
    }
    let branch: string | undefined;
    try {
      branch = (await git(repoDir, ["rev-parse", "--abbrev-ref", head ?? "HEAD"])).trim();
    } catch {
      /* ignore */
    }
    const candidates = listTranscriptCandidates(repoDir, { override: path, changedBasenames, branch });
    return textResult(
      JSON.stringify(
        {
          candidates,
          how_to_pick:
            "Choose the candidate whose `first_user` matches how THIS session began. `relevance` counts references to the changed files/branch; ties break by recency. If none match, you may be in a different session than the change.",
        },
        null,
        2
      )
    );
  }
);

registerTool(
  "read_transcript",
  "Read a window of a session transcript as lightweight entries. Page through long transcripts to hydrate a fresh distiller agent.",
  {
    path: z.string().describe("Transcript path (from list_transcripts)"),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(200).default(50),
  },
  async ({ path, offset, limit }) => {
    try {
      const win = readTranscriptWindow(path, offset ?? 0, limit ?? 50);
      return textResult(JSON.stringify(win, null, 2));
    } catch (e) {
      return textResult(`read_transcript failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "record_interview_round",
  "Reviewer role: record interview rounds against a RUN — each a question you raised about a thin or " +
    "under-justified spot, the author role's answer, and whether it resolved. Send the whole baseline set " +
    "in ONE call via `rounds`. Rounds are keyed by question, so re-recording one replaces it rather than " +
    "duplicating: retrying is free and the count stays honest. The server stamps meta.interview from these, " +
    "so the interview is server-attested rather than self-reported. Unresolved rounds should also surface " +
    "as open_questions in the document.",
  {
    run_id: z
      .string()
      .describe("Run handle from compute_diff. REQUIRED — rounds belong to a run, not a directory."),
    rounds: z
      .array(
        z.object({
          question: z.string().describe("The reviewer's question about a thin spot"),
          answer: z.string().describe("The author role's answer (fold it into the document fields)"),
          resolved: z.boolean().default(true).describe("false -> also add an open_question"),
        })
      )
      .optional()
      .describe("One or more rounds. Prefer sending the whole baseline set at once."),
    // Single-round form, kept so a role definition loaded before this change still works.
    question: z.string().optional(),
    answer: z.string().optional(),
    resolved: z.boolean().optional(),
  },
  async ({ run_id, rounds, question, answer, resolved }) => {
    const batch = rounds?.length
      ? rounds
      : question && answer
        ? [{ question, answer, resolved: resolved ?? true }]
        : [];
    if (batch.length === 0) {
      return textResult("record_interview_round: supply `rounds: [{question, answer, resolved}]`.", true);
    }
    const run = recordRounds(run_id, batch);
    if (!run) return textResult(JSON.stringify(unknownRun(run_id), null, 2), true);
    return textResult(
      JSON.stringify({ run_id, repo: run.repo, ...summarizeRun(run) }, null, 2)
    );
  }
);

/**
 * An unknown run_id is answered with the runs that DO exist. A wrong handle then costs
 * one corrective call instead of a guess; previously the equivalent mistake was silent
 * and only surfaced at submit, as an interview that appeared never to have happened.
 */
function unknownRun(runId: string) {
  return {
    ok: false,
    error: `Unknown run_id "${runId}". Open a run by calling compute_diff for the repository you changed.`,
    open_runs: listOpenRuns().map((r) => ({
      run_id: r.run_id,
      repo: r.repo,
      branch: r.branch,
      recorded_rounds: Object.keys(r.rounds).length,
    })),
  };
}

/** Branch name for a ref, or undefined when it cannot be resolved (detached HEAD). */
async function currentBranch(repoDir: string, ref: string): Promise<string | undefined> {
  try {
    const name = (await git(repoDir, ["rev-parse", "--abbrev-ref", ref])).trim();
    return name && name !== "HEAD" ? name : undefined;
  } catch {
    return undefined;
  }
}


/** Basenames of files touched by a unified diff (from the `+++ b/<path>` headers). */
function extractChangedBasenames(diff: string): string[] {
  const names = new Set<string>();
  for (const m of diff.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
    const path = m[1].trim();
    if (path && path !== "/dev/null") {
      const base = path.split("/").pop();
      if (base) names.add(base);
    }
  }
  return Array.from(names);
}

registerTool(
  "submit_document",
  "Validate a candidate Intent Document against the run's diff and head SHA. On pass, write it to " +
    ".intent/<branch>.json. Takes `run_id` from compute_diff — repo, base and head come from the run, so " +
    "the interview and the coverage check cannot disagree about which change this is. On failure, returns " +
    "findings to fix and resubmit.",
  {
    document: z.union([z.record(z.string(), z.any()), z.string()]).describe("The candidate Intent Document — a JSON object, or a JSON string (which is parsed)."),
    run_id: z.string().describe("Run handle from compute_diff. REQUIRED."),
    strict: z.boolean().default(false).describe("Fail coverage on any unexplained hunk"),
    write: z.boolean().default(true).describe("Write the document on success"),
    require_interview: z.boolean().default(false).describe("Reject unless at least one reviewer interview round was recorded (enforces the two-agent pass)."),
  },
  async ({ document, run_id, strict, write, require_interview }) => {
    const run = getRun(run_id);
    if (!run) return textResult(JSON.stringify(unknownRun(run_id), null, 2), true);
    const repoDir = run.repo;

    // Consent gate. compute_diff already reported this state when the run opened, so by
    // here it is normally settled; the check stays because the write below is the point
    // of no return and must not depend on the agent having read that field.
    const consent = getConsent(repoDir);
    if (consent === "disabled") {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            skipped: true,
            reason: "disabled",
            repo: repoDir,
            message: `Review Assist is turned off for this repository (you chose "Never"). Nothing was written. To turn it back on, run: npx review-assist-mcp consent enable "${repoDir}" — or call set_consent with decision "always".`,
          },
          null,
          2
        )
      );
    }
    if (consent === "unknown") {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            consent_required: true,
            repo: repoDir,
            prompt: `Enable Review Assist for this project? It will distill this change into an Intent Document written to ${repoDir}/.intent/.`,
            options: [
              { decision: "always", label: "Always — enable for this repo and don't ask again" },
              { decision: "once", label: "Just this time — do it now, ask again next session" },
              { decision: "never", label: "Never — turn it off for this repo (won't ask again)" },
            ],
            next: "Ask the user to pick one, then call set_consent({ repo, decision }), then call submit_document again with the same document and run_id.",
          },
          null,
          2
        )
      );
    }

    // Some MCP clients serialize object args as a JSON string; accept object or string.
    let doc: unknown;
    try {
      doc = typeof document === "string" ? JSON.parse(document) : document;
    } catch (e) {
      return textResult(`submit_document: document was a string but not valid JSON: ${(e as Error).message}`, true);
    }

    // Head drift. The run is identified by its head SHA, so a branch that moved since the
    // run opened is a DIFFERENT change — caught here, by name, instead of surfacing as a
    // staleness finding after the whole document has been re-emitted.
    let liveHead = "";
    try {
      liveHead = await resolveHeadSha(repoDir, "HEAD");
    } catch (e) {
      return textResult(`could not resolve HEAD for validation: ${(e as Error).message}`, true);
    }
    if (liveHead !== run.head_sha) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            error: "The branch moved after this run opened, so the document describes an older change.",
            run_head: run.head_sha,
            live_head: liveHead,
            next: `Call compute_diff again for ${repoDir} to open the run for the new head (run_id will be ${computeRunId(
              { repo: repoDir, baseSha: run.base_sha, headSha: liveHead }
            )}), re-anchor against the new diff, then resubmit.`,
          },
          null,
          2
        ),
        true
      );
    }

    // Server-attested interview: stamped from the rounds recorded against THIS run,
    // overriding any self-reported value. Rounds are keyed by question, so this counts
    // distinct questions asked rather than tool calls made.
    const interview = summarizeRun(run);
    if ((require_interview ?? false) && interview.rounds === 0) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            error:
              "No reviewer interview rounds were recorded for this run. Run the reviewer pass (call record_interview_round with this run_id) before submitting, or set require_interview=false.",
            run_id,
            repo: repoDir,
            meta_interview: interview,
          },
          null,
          2
        ),
        true
      );
    }
    if (doc && typeof doc === "object") {
      const d = doc as Record<string, unknown>;
      d.meta = d.meta && typeof d.meta === "object" ? d.meta : {};
      (d.meta as Record<string, unknown>).interview = interview;
    }

    let diff = "";
    try {
      diff = (await computeDiff(repoDir, run.base_sha, run.head_sha)).diff;
    } catch (e) {
      return textResult(`could not compute diff for validation: ${(e as Error).message}`, true);
    }

    const report = validate(doc, { diff, headSha: run.head_sha, strictCoverage: strict ?? false });

    if (!report.ok) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            run_id,
            findings: report.findings,
            coverage: report.coverage,
          },
          null,
          2
        ),
        true
      );
    }

    let written: string | null = null;
    if (write ?? true) {
      try {
        const branch =
          (run.branch ?? (await currentBranch(repoDir, "HEAD")) ?? "").replace(/[/\\]/g, "-") ||
          run.head_sha.slice(0, 12);
        const outPath = join(repoDir, ".intent", `${branch}.json`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
        written = outPath;
        closeRun(run_id);
      } catch (e) {
        return textResult(`document valid but write failed: ${(e as Error).message}`, true);
      }
    }

    return textResult(
      JSON.stringify(
        {
          ok: true,
          written,
          pr_description: renderPrDescription(doc as never),
          coverage: report.coverage,
          interview,
          note:
            interview.rounds === 0
              ? "meta.interview.rounds is server-attested as 0 — no reviewer interview was recorded for this run."
              : undefined,
          warnings: report.findings,
        },
        null,
        2
      )
    );
  }
);

registerTool(
  "set_consent",
  "Record the user's decision about whether Review Assist may operate in a repository. Call this only after the user has answered the consent prompt returned by submit_document.",
  {
    decision: z
      .enum(["always", "once", "never"])
      .describe("always = enable and remember; once = allow this session only; never = disable and remember"),
    repo: z
      .string()
      .optional()
      .describe("Absolute repo path; defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ decision, repo }) => {
    const repoDir = repo ? resolve(repo) : REPO_DIR;
    setConsent(repoDir, decision);
    const state =
      decision === "always" ? "enabled" : decision === "never" ? "disabled" : "enabled for this session only";
    return textResult(
      JSON.stringify({ ok: true, repo: repoDir, decision, state }, null, 2)
    );
  }
);

registerTool(
  "manage_consent",
  "List Review Assist's per-repo enable/disable decisions, or reset one repo — removing it from the list so it is asked about again.",
  {
    action: z.enum(["list", "reset"]),
    repo: z.string().optional().describe("Required for reset: absolute repo path (defaults to current repo)."),
  },
  async ({ action, repo }) => {
    if (action === "list") {
      return textResult(
        JSON.stringify({ ok: true, file: consentFilePath(), repos: listConsent() }, null, 2)
      );
    }
    const repoDir = repo ? resolve(repo) : REPO_DIR;
    const removed = resetConsent(repoDir);
    return textResult(
      JSON.stringify({ ok: true, action: "reset", repo: repoDir, removed }, null, 2)
    );
  }
);

registerTool(
  "get_role_definitions",
  "Return the author and reviewer role definitions for the two-agent distillation, " +
    "picked for the calling client (Claude Code, Codex, or a generic fallback) and " +
    "including how to spin them up. Spawn each role in its OWN context: the author holds " +
    "the transcript and cannot submit; the reviewer submits and never sees the transcript.",
  {
    env: z
      .enum(["claude", "codex", "generic"])
      .optional()
      .describe("Override the environment; default is detected from the MCP client handshake."),
    role: z
      .enum(["author", "reviewer"])
      .optional()
      .describe("Return just one role; default returns both."),
    install: z
      .boolean()
      .default(false)
      .describe(
        "Write the definitions where this client reads them (user scope, e.g. ~/.claude/agents). " +
          "Do this rather than placing the files yourself: the server knows the environment from " +
          "the handshake, so it writes the right format to the right place."
      ),
  },
  async ({ env, role, install }) => {
    const bundle = getRoles({
      env,
      role: role as RoleName | undefined,
      clientName: server.server.getClientVersion()?.name,
    });
    let installed: string[] | undefined;
    if (install) {
      try {
        installed = installRoles(bundle);
      } catch (e) {
        return textResult(`install failed: ${(e as Error).message}`, true);
      }
    }
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            {
              ...bundle,
              known_envs: KNOWN_ENVS,
              ...(install
                ? installed?.length
                  ? { installed }
                  : { installed: [], note: `${bundle.env} has no agent directory; use the definitions above as-is.` }
                : {}),
            },
            null,
            2
          ),
        },
      ],
    };
  }
);

/**
 * Print what would be installed, for every environment. Inspection only.
 *
 * There is deliberately no --write: the server installs these itself via
 * get_role_definitions({ install: true }), where it knows the client from the MCP
 * handshake. A second write path would be a second thing to keep correct.
 *
 * There is no --env either. Standalone there is no handshake to detect from, so the
 * flag was the only way to get anything but the generic definitions — and forgetting
 * it silently produced the wrong output. Printing every environment removes the
 * question.
 */
function runAgentsCli(): number {
  for (const env of KNOWN_ENVS) {
    const bundle = getRoles({ env });
    process.stdout.write(`\n=== ${env} ===\n`);
    process.stdout.write(
      bundle.install_dir
        ? `installs to: ${bundle.install_dir}/\n`
        : `no agent directory for this client; use the definitions below as-is\n`
    );
    process.stdout.write(`${bundle.how_to_run}\n`);
    for (const [name, r] of Object.entries(bundle.roles)) {
      process.stdout.write(`\n----- ${name} (${r.filename}) -----\n${r.definition}\n`);
    }
  }
  process.stdout.write(
    "\nThis command only prints. To install, ask your agent to call " +
      "get_role_definitions with install: true — it detects the client and writes the " +
      "right format to the right place.\n"
  );
  return 0;
}

function runConsentCli(argv: string[]): number {
  const [sub, repoArg] = argv;
  const target = repoArg ? resolve(repoArg) : process.cwd();
  switch (sub) {
    case "list": {
      const rows = listConsent();
      if (rows.length === 0) process.stdout.write("No repositories on record.\n");
      for (const r of rows) process.stdout.write(`${r.state === "enabled" ? "on " : "off"}  ${r.repo}\n`);
      process.stdout.write(`\n(${consentFilePath()})\n`);
      return 0;
    }
    case "enable":
      setConsent(target, "always");
      process.stdout.write(`enabled: ${target}\n`);
      return 0;
    case "disable":
      setConsent(target, "never");
      process.stdout.write(`disabled: ${target}\n`);
      return 0;
    case "reset": {
      const removed = resetConsent(target);
      process.stdout.write(`${removed ? "reset" : "not on record"}: ${target}\n`);
      return 0;
    }
    default:
      process.stdout.write(
        "usage: review-assist-mcp consent <list|enable|disable|reset> [repo-path]\n"
      );
      return sub ? 1 : 0;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "--version" || argv[0] === "-v") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    process.exit(0);
  }
  if (argv[0] === "consent") {
    process.exit(runConsentCli(argv.slice(1)));
  }
  if (argv[0] === "agents") {
    process.exit(runAgentsCli());
  }
  // Wait for the handshake before installing: connect() resolves as soon as the
  // transport is wired up, which is BEFORE the client sends `initialize`, so
  // getClientVersion() is still undefined there and the env resolves to `generic`.
  server.server.oninitialized = () => installRoleDefinitions();

  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `review-assist MCP server running (repo: ${REPO_DIR}${ACTIVE_ROLE ? `, role: ${ACTIVE_ROLE}` : ""})\n`
  );
}

/**
 * Install the role definitions as soon as we know the client, not when the agent
  // asks. Claude Code reads ~/.claude/agents/ once, at session start — so definitions
  // written during a tool call cannot be dispatched until the next session, and the
  // agent is left offering to "simulate" the split with general-purpose agents, which
  // drops the `tools:` allowlist that makes the split real.
  //
  // Writing at handshake means they land during the session start the user already
  // performs when adding the server, so no extra restart is needed. Idempotent: only
  // touches a file whose content differs, so a steady state writes nothing.
 */
function installRoleDefinitions(): void {
  if (ACTIVE_ROLE) return; // role-gated instances are spawned per-role; not their job
  try {
    const bundle = getRoles({ clientName: server.server.getClientVersion()?.name });
    const changed = installRoles(bundle, { onlyIfChanged: true });
    if (changed.length) {
      process.stderr.write(
        `review-assist: installed role definitions -> ${changed.join(", ")}\n` +
          `review-assist: restart this session once so they register as subagents\n`
      );
    }
  } catch (e) {
    // Never let this break startup; the agent can still call install explicitly.
    process.stderr.write(`review-assist: could not install role definitions: ${(e as Error).message}\n`);
  }
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
