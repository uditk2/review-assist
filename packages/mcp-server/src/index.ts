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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { validate } from "@review-assist/validator";
import { intentDocSchema } from "@review-assist/schema";
import { GENERATION_GUIDE } from "./guide.js";
import {
  computeDiff,
  resolveHeadSha,
  findTranscripts,
  listTranscriptCandidates,
  readTranscriptWindow,
  git,
} from "./git.js";

const REPO_DIR = resolve(process.env.REVIEW_ASSIST_REPO ?? process.cwd());

const server = new McpServer({
  name: "review-assist",
  version: "0.1.0",
});

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

server.tool(
  "get_generation_guide",
  "Return the Intent Document JSON Schema and the authoring protocol. Call this first.",
  {},
  async () => {
    const payload = {
      schema: intentDocSchema,
      guide: GENERATION_GUIDE,
      repo_dir: REPO_DIR,
    };
    return textResult(JSON.stringify(payload, null, 2));
  }
);

server.tool(
  "compute_diff",
  "Compute the PR's own unified diff (base...head) plus resolved SHAs. Anchors must use these hunk line numbers and pin to head_sha.",
  {
    base: z.string().describe("Base ref/branch/SHA, e.g. origin/main"),
    head: z.string().default("HEAD").describe("Head ref/SHA (default HEAD)"),
    repo: z.string().optional().describe("Absolute path of the repository to operate on. Required in multi-repo/container setups; defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ base, head, repo }) => {
    try {
      const repoDir = repo ? resolve(repo) : REPO_DIR;
      const { diff, baseSha, headSha } = await computeDiff(repoDir, base, head ?? "HEAD");
      return textResult(JSON.stringify({ base_sha: baseSha, head_sha: headSha, diff }, null, 2));
    } catch (e) {
      return textResult(`compute_diff failed: ${(e as Error).message}`, true);
    }
  }
);

server.tool(
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

server.tool(
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

// In-memory, per-repo interview log. The reviewer role records each round here; submit_document
// stamps meta.interview from these server-side counts (not the agent's self-report). This runs in
// the same process as the tools both roles call, so a sub-agent reviewer pass shares the state.
const interviewRounds = new Map<string, { question: string; answer: string; resolved: boolean }[]>();

server.tool(
  "record_interview_round",
  "Reviewer role: record ONE author\u21c4reviewer interview round — a question you raised about a thin/under-justified spot, the author role's answer, and whether it resolved. The server counts these and stamps meta.interview on submit, so the two-agent interview is server-attested rather than self-reported. Unresolved rounds should also surface as open_questions in the document.",
  {
    question: z.string().describe("The reviewer's question about a thin spot"),
    answer: z.string().describe("The author role's answer (fold it into the document fields)"),
    resolved: z.boolean().default(true).describe("Whether it resolved; false -> also add an open_question"),
    repo: z.string().optional().describe("Absolute path of the repository. Defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ question, answer, resolved, repo }) => {
    const key = resolve(repo ? resolve(repo) : REPO_DIR);
    const log = interviewRounds.get(key) ?? [];
    log.push({ question, answer, resolved: resolved ?? true });
    interviewRounds.set(key, log);
    return textResult(
      JSON.stringify({ recorded_rounds: log.length, unresolved: log.filter((r) => !r.resolved).length }, null, 2)
    );
  }
);

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

server.tool(
  "submit_document",
  "Validate a candidate Intent Document against the diff and head SHA. On pass, write it to .intent/<branch>.json. On failure, returns findings to fix and resubmit.",
  {
    document: z.union([z.record(z.string(), z.any()), z.string()]).describe("The candidate Intent Document — a JSON object, or a JSON string (which is parsed)."),
    base: z.string().describe("Base ref/branch/SHA used for the coverage check"),
    head: z.string().default("HEAD"),
    strict: z.boolean().default(false).describe("Fail coverage on any unexplained hunk"),
    write: z.boolean().default(true).describe("Write the document on success"),
    require_interview: z.boolean().default(false).describe("Reject unless at least one reviewer interview round was recorded (enforces the two-agent pass)."),
    repo: z.string().optional().describe("Absolute path of the repository to write the document into. Required in multi-repo/container setups; defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ document, base, head, strict, write, require_interview, repo }) => {
    const repoDir = repo ? resolve(repo) : REPO_DIR;
    // Some MCP clients serialize object args as a JSON string; accept object or string.
    let doc: unknown;
    try {
      doc = typeof document === "string" ? JSON.parse(document) : document;
    } catch (e) {
      return textResult(`submit_document: document was a string but not valid JSON: ${(e as Error).message}`, true);
    }

    // Server-attested interview: stamp meta.interview from rounds the reviewer recorded via
    // record_interview_round — authoritative, overriding any self-reported value.
    const ivKey = resolve(repoDir);
    const rounds = interviewRounds.get(ivKey) ?? [];
    const interview = {
      rounds: rounds.length,
      questions_asked: rounds.length,
      unresolved: rounds.filter((r) => !r.resolved).length,
    };
    if ((require_interview ?? false) && rounds.length === 0) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            error:
              "No reviewer interview rounds were recorded. Run the reviewer pass (call record_interview_round per round) before submitting, or set require_interview=false.",
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
    let headSha = "";
    try {
      const computed = await computeDiff(repoDir, base, head ?? "HEAD");
      diff = computed.diff;
      headSha = computed.headSha;
    } catch (e) {
      return textResult(`could not compute diff for validation: ${(e as Error).message}`, true);
    }

    const report = validate(doc, { diff, headSha, strictCoverage: strict ?? false });

    if (!report.ok) {
      return textResult(
        JSON.stringify(
          { ok: false, findings: report.findings, coverage: report.coverage },
          null,
          2
        ),
        true
      );
    }

    let written: string | null = null;
    if (write ?? true) {
      try {
        const branch = (await git(repoDir, ["rev-parse", "--abbrev-ref", head ?? "HEAD"]))
          .trim()
          .replace(/[/\\]/g, "-") || headSha.slice(0, 12);
        const outPath = join(repoDir, ".intent", `${branch}.json`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, JSON.stringify(doc, null, 2) + "\n", "utf8");
        written = outPath;
        interviewRounds.delete(ivKey);
      } catch (e) {
        return textResult(`document valid but write failed: ${(e as Error).message}`, true);
      }
    }

    return textResult(
      JSON.stringify(
        {
          ok: true,
          written,
          coverage: report.coverage,
          interview,
          note:
            rounds.length === 0
              ? "meta.interview.rounds is server-attested as 0 — no reviewer interview was recorded for this document."
              : undefined,
          warnings: report.findings,
        },
        null,
        2
      )
    );
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`review-assist MCP server running (repo: ${REPO_DIR})\n`);
}

main().catch((e) => {
  process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
  process.exit(1);
});
