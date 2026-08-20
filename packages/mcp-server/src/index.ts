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
import {
  validate,
  renderPrDescription,
  indexHunks,
  pageDiff,
  summarizeFiles,
  DEFAULT_PAGE_BYTES,
  type IndexedHunk,
} from "@review-assist/validator";
import { intentDocSchema } from "@review-assist/schema";
import {
  getRoles,
  installRoles,
  sweepStaleRoleDefinitions,
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
  git,
} from "./git.js";
import { buildSpine, pageSpine } from "./spine.js";
import { importSession, listImported } from "./transcript/export.js";
import {
  openRun,
  getRun,
  recordRounds,
  recordAnswers,
  runRounds,
  summarizeRun,
  markSubmitted,
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

/**
 * Ceiling on the bytes a single tool result may carry.
 *
 * MCP does not tell a server what its client's tool-result cap is, so this is a guess —
 * but a guess made HERE is worth more than the client's certainty, because the server can
 * stop on a hunk boundary and hand back a cursor, and the client can only truncate or
 * spill the whole result to a file. The one time that difference mattered it cost the
 * flow: a 234,337-character `compute_diff` was spilled whole, and the `run_id` inside it
 * became unreachable to a reviewer with no file access.
 *
 * Override with REVIEW_ASSIST_MAX_RESULT_BYTES when a client is known to allow more.
 */
function maxResultBytes(): number {
  const v = Number(process.env.REVIEW_ASSIST_MAX_RESULT_BYTES);
  return Number.isFinite(v) && v >= 2_000 ? Math.floor(v) : DEFAULT_PAGE_BYTES;
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
  "compute_diff",
  "Call this first. Resolves the base/head SHAs, OPENS THE DISTILLATION RUN, and returns the " +
    "`run_id` every later call needs, the numbered hunk index, and `consent_state` — so you learn " +
    "whether this repo is opted in BEFORE you spend a document finding out. It does NOT return the " +
    "diff text: read that with `read_diff`, which pages it. Anchors use these hunk ids and pin to head_sha.",
  {
    base: z.string().describe("Base ref/branch/SHA, e.g. origin/main"),
    head: z.string().default("HEAD").describe("Head ref/SHA (default HEAD)"),
    repo: z.string().optional().describe("Absolute path of the repository to operate on. Required in multi-repo/container setups; defaults to REVIEW_ASSIST_REPO or cwd."),
  },
  async ({ base, head, repo }) => {
    try {
      const repoDir = repo ? resolve(repo) : REPO_DIR;
      const { diff, baseSha, headSha } = await computeDiff(repoDir, base, head ?? "HEAD");
      // From the CHECKOUT, not from `head`. The branch is part of the run's identity, and
      // `rev-parse --abbrev-ref <sha>` yields no name — so resolving it from a caller-named
      // SHA would give the author and the reviewer different ids for the same work.
      const branch = await currentBranch(repoDir, "HEAD");
      const { run, head_changed, previous_head } = openRun({ repo: repoDir, baseSha, headSha, branch });
      const recorded_rounds = Object.keys(run.rounds).length;
      const consent = getConsent(repoDir);
      const hunks = indexHunks(diff);
      const files = summarizeFiles(hunks);
      const budget = maxResultBytes();

      // `run_id` is serialized FIRST, before anything that grows with the change. The
      // envelope is bounded by construction now, so this is belt and braces — but a
      // client that truncates rather than spills keeps the handle, and the handle is the
      // one field whose loss ends the distillation.
      const envelope: Record<string, unknown> = {
        run_id: run.run_id,
        repo: run.repo,
        base_sha: baseSha,
        head_sha: headSha,
        branch,
        consent_state: consent,
        // The run outlives a commit; the hunk ids in it do not. Reported first because a
        // reviewer that misses this re-anchors nothing and ships stops pointing at the
        // wrong code — which is exactly what a silent id rotation used to cause.
        ...(head_changed
          ? {
              head_changed: true,
              previous_head,
              re_anchor:
                `This run has moved from ${previous_head} to ${headSha}. Your interview survived — ` +
                `${recorded_rounds} round(s) are still on it — but the diff was recomputed, so every ` +
                "hunk id below has been reassigned. Discard every anchor you were holding and take " +
                "the ids from THIS response.",
            }
          : {}),
        interview: { recorded_rounds },
        stats: {
          files: files.length,
          hunks: hunks.length,
          coverage_required: hunks.filter((h) => h.coverage_required).length,
          diff_bytes: diff.length,
        },
      };

      // The per-hunk index is small for a normal change and unbounded for a large one —
      // 66 hunks is a few kilobytes, 800 is not. Send it when it fits; otherwise fall back
      // to the file-level rollup, which is bounded by file count, and let `read_diff`
      // hand back per-hunk detail as it pages.
      if (JSON.stringify(hunks).length <= budget) {
        envelope.hunks = hunks;
      } else {
        envelope.files = files;
        envelope.hunks_omitted =
          "Too many hunks to list here. This is the file-level rollup; read_diff returns each " +
          "hunk's id, path and header as it pages, and accepts `paths` to work a file at a time.";
      }

      envelope.read_the_diff =
        `The diff is NOT in this response. Call read_diff({ run_id: "${run.run_id}" }) and keep ` +
        "calling it with the `next_cursor` it returns until there is none. To go straight at " +
        "something, pass `hunks: [\"H3\",\"H7\"]` or `paths: [\"src/foo.ts\"]` instead of a cursor.";
      envelope.anchors_note =
        "Anchor tour stops by hunk id — `\"anchors\": [\"H3\", \"H4\"]` — not by hand-copied line numbers. " +
        "The server expands them on submit, so the stored document is unchanged. Every hunk with " +
        "coverage_required=true must appear in some stop; one hunk may serve two stops.";
      envelope.next =
        consent === "unknown"
          ? "This repo is not opted in yet. Resolve consent NOW, before writing the document: present the choice to the user and call set_consent({ repo, decision }). Submitting first only wastes the document."
          : "Pass `run_id` to read_diff, record_interview_round and submit_document. Do not pass `repo` to those tools — the run already knows it.";

      return textResult(JSON.stringify(envelope));
    } catch (e) {
      return textResult(`compute_diff failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "read_diff",
  "Read the change itself, a page at a time. `compute_diff` gives you the run handle and the hunk " +
    "index; the bytes come from here, so no single response can grow with the size of the change. " +
    "Call it with just the `run_id` to start at H1, then keep passing the `next_cursor` it returns " +
    "until there is none — that is how you know you have seen the whole diff. To go straight at one " +
    "thing instead, pass `hunks` or `paths`. Pages break on hunk boundaries, so you never receive " +
    "half a change; a hunk too large for one page is split by line and labelled with the lines it carries.",
  {
    run_id: z.string().describe("Run handle from compute_diff. REQUIRED — the run knows the repo and the SHAs."),
    cursor: z
      .string()
      .optional()
      .describe('Where to resume: the `next_cursor` from the previous page ("H14", or "H20:180" inside an oversized hunk). Omit to start at the beginning of the selection.'),
    hunks: z
      .array(z.string())
      .optional()
      .describe('Serve only these hunk ids, e.g. ["H3","H7"]. Use this to substantiate one claim without reading the rest.'),
    paths: z
      .array(z.string())
      .optional()
      .describe("Serve only hunks in these files. Ignored when `hunks` is given."),
    max_bytes: z
      .number()
      .int()
      .min(2_000)
      .optional()
      .describe("Byte budget for this page's hunk text. Defaults to the server's own ceiling; raise it only if you know your client's cap is higher."),
  },
  async ({ run_id, cursor, hunks, paths, max_bytes }) => {
    const run = getRun(run_id);
    if (!run) return textResult(JSON.stringify(unknownRun(run_id), null, 2), true);
    try {
      // Recomputed from the run's own SHAs, exactly as submit_document does, rather than
      // cached against the run id. A cursor then cannot outlive the diff it points into.
      const { diff } = await computeDiff(run.repo, run.base_sha, run.head_sha);
      const page = pageDiff(diff, {
        cursor,
        ids: hunks,
        paths,
        maxBytes: max_bytes ?? maxResultBytes(),
      });
      return textResult(
        JSON.stringify({
          run_id,
          ...page,
          next: page.next_cursor
            ? `More to read. Call read_diff again with cursor: "${page.next_cursor}".`
            : "End of the selection — you have seen every hunk it covers.",
        })
      );
    } catch (e) {
      return textResult(`read_diff failed: ${(e as Error).message}`, true);
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
            "Choose the candidate whose `first_user` matches how THIS session began. Skip any with " +
            "`user_turns: 0` — no human spoke in it, so it is one agent driven by another and holds no " +
            "ask, no plan and no decision. The count is a floor taken from a bounded read, so treat it as " +
            "zero-or-not rather than as a total. `relevance` counts references to the changed files/branch; " +
            "ties break by recency. If none match, you may be in a different session than the change.",
        },
        null,
        2
      )
    );
  }
);

registerTool(
  "import_session",
  "File a session transcript into this repo's store so list_transcripts and get_spine can " +
    "find it. Needed when a session leaves nothing on this machine: a Cowork session running " +
    "in the CLOUD keeps its transcript inside the container it ran in, and the desktop app " +
    "holds only a composer draft and an evictable cache of a partial event stream. The " +
    "container writes the file somewhere reachable and calls this. Re-importing OVERWRITES: a " +
    "live session keeps growing, so a second export must replace the first rather than leave " +
    "two near-identical candidates for the ranking to choose between.",
  {
    repo: z.string().describe("Absolute path of the repository this session belongs to."),
    from: z.string().describe("Absolute path of the transcript to file (JSONL)."),
    session_id: z
      .string()
      .optional()
      .describe("Identifier to store it under. Defaults to the source file's name."),
  },
  async ({ repo, from, session_id }) => {
    try {
      const res = importSession({ repo: resolve(repo), from, sessionId: session_id });
      return textResult(
        JSON.stringify(
          { ...res, note: res.overwrote ? "Replaced an earlier export of this session." : "Stored.", imported: listImported(resolve(repo)).length },
          null,
          2
        )
      );
    } catch (e) {
      return textResult(`import_session failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "get_spine",
  "Author role: read a session's WHOLE conversation — every turn you and the agent exchanged, " +
    "each structured question with the answer chosen, and every command and file edit as one " +
    "line. This replaces searching. A session is a median 4.8% conversation and 95% tool output; " +
    "the spine is that 4.8%. Being complete, it removes the one thing retrieval can never rule " +
    "out — an answer you simply did not find. It is served a page at a time: call it with just " +
    "the `path`, then keep passing back the `next_cursor` it returns until there is none. That, " +
    "and nothing else, is how you know you have read the whole session. Nothing is ever dropped " +
    "to make a page fit. Every item carries an `index` into the full transcript: a jump between " +
    "indices means machinery was elided there, and read_transcript around an index recovers the " +
    "tool output behind a claim.",
  {
    path: z.string().describe("Transcript path (from list_transcripts)"),
    cursor: z
      .string()
      .optional()
      .describe('Where to resume: the `next_cursor` from the previous page ("87", or "87:4000" inside an oversized turn). Omit to start at the beginning.'),
    max_bytes: z
      .number()
      .int()
      .min(2_000)
      .optional()
      .describe("Byte budget for this page. Defaults to the server's own ceiling; raise it only if you know your client's cap is higher."),
  },
  async ({ path, cursor, max_bytes }) => {
    try {
      const spine = buildSpine(path);
      const page = pageSpine(spine.items, { cursor, maxBytes: max_bytes ?? maxResultBytes() });
      const { items: _all, ...header } = spine;
      return textResult(
        JSON.stringify({
          ...header,
          ...page,
          next: page.next_cursor
            ? `More of this session to read. Call get_spine again with the same path and cursor: "${page.next_cursor}".`
            : "End of the session — you have read the whole conversation.",
        })
      );
    } catch (e) {
      return textResult(`get_spine failed: ${(e as Error).message}`, true);
    }
  }
);

registerTool(
  "read_transcript",
  "Read a window of the FULL transcript — tool calls, results and all — around an index the " +
    "spine gave you. This is how a claim gets substantiated: the prose says what was decided, " +
    "the tool output holds the evidence. Not for hydration; get_spine does that in one call.",
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
    "under-justified spot. RECORD THE QUESTIONS FIRST, BEFORE you relay them: each comes back with a `q_id`, " +
    "and the author answers by that id with `answer_questions`, so the server hears the author's own words " +
    "rather than your account of them. Include the q_ids when you relay. `answer` is optional here and is " +
    "only for transcribing an answer you already hold — it is marked reviewer-sourced, and does not count as " +
    "attested. Send the baseline set and every diff-provoked question together in ONE call via `rounds`; " +
    "follow up at most once. Rounds are keyed by question, so re-recording one replaces it rather than " +
    "duplicating: retrying is free, cannot inflate the count, and never erases an answer already recorded.",
  {
    run_id: z
      .string()
      .describe("Run handle from compute_diff. REQUIRED — rounds belong to a run, not a directory."),
    rounds: z
      .array(
        z.object({
          question: z.string().describe("The reviewer's question about a thin spot"),
          answer: z
            .string()
            .optional()
            .describe("Optional. Only to transcribe an answer you already have; recorded as reviewer-sourced. Leave empty and let the author answer by q_id."),
          resolved: z.boolean().optional().describe("false -> the question stands unresolved"),
        })
      )
      .optional()
      .describe("One or more rounds. Send the whole batch at once."),
    // Single-round form, kept so a role definition loaded before this change still works.
    question: z.string().optional(),
    answer: z.string().optional(),
    resolved: z.boolean().optional(),
  },
  async ({ run_id, rounds, question, answer, resolved }) => {
    const batch = rounds?.length
      ? rounds
      : question
        ? [{ question, answer, resolved }]
        : [];
    if (batch.length === 0) {
      return textResult("record_interview_round: supply `rounds: [{question}]`.", true);
    }
    const run = recordRounds(run_id, batch);
    if (!run) return textResult(JSON.stringify(unknownRun(run_id), null, 2), true);
    const summary = summarizeRun(run);
    return textResult(
      JSON.stringify(
        {
          run_id,
          repo: run.repo,
          ...summary,
          questions: runRounds(run).map((r) => ({
            q_id: r.q_id,
            question: r.question,
            answered_by: r.answered_by ?? null,
          })),
          relay_these:
            "Give the author the run_id and each question WITH its q_id, and tell it to reply by calling " +
            "answer_questions. Answers it writes itself are the only ones the document can attest.",
        },
        null,
        2
      )
    );
  }
);

registerTool(
  "answer_questions",
  "Author role: answer the reviewer's questions, by `q_id`. This is how your answers reach the document as " +
    "YOUR words: the reviewer records the questions, relays them to you with their ids, and you write the " +
    "answers here. An answer the reviewer transcribes on your behalf still works, but is marked " +
    "reviewer-sourced and does not count as attested — so a document whose interview never happened is " +
    "visible as such rather than indistinguishable from one that did. Answer the whole batch in one call. " +
    'If the transcript does not cover something, say exactly that and set `resolved: false`; a recorded ' +
    "non-answer is worth more than an invented one.",
  {
    run_id: z
      .string()
      .describe("Run handle. Derive it yourself from compute_diff, or take the one the reviewer relayed — they are the same value."),
    answers: z
      .array(
        z.object({
          q_id: z.string().describe("The question's id, as relayed by the reviewer."),
          answer: z.string().describe("Your answer, from the transcript. Quote verbatim where the answer turns on what was said."),
          resolved: z
            .boolean()
            .default(true)
            .describe("false when the transcript does not cover it — a real answer, recorded as unresolved."),
        })
      )
      .min(1)
      .describe("The whole batch in one call."),
  },
  async ({ run_id, answers }) => {
    const res = recordAnswers(run_id, answers);
    if (!res) return textResult(JSON.stringify(unknownRun(run_id), null, 2), true);
    const { run, unknown } = res;
    return textResult(
      JSON.stringify(
        {
          run_id,
          repo: run.repo,
          ...summarizeRun(run),
          ...(unknown.length
            ? {
                unknown_q_ids: unknown,
                hint:
                  "These ids are not on this run. Ids come from the reviewer's record_interview_round for " +
                  "THIS run — re-read them from what was relayed rather than guessing. Nothing was stored for them.",
              }
            : {}),
        },
        null,
        2
      )
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


/**
 * Resolve `"H7"` anchors into the `{path, hunk}` the schema stores.
 *
 * The id is a wire format, nothing more: it exists between compute_diff and here, and
 * the document on disk looks exactly as it always did. That is deliberate — the whole
 * change costs no schema revision, no validator revision, and no viewer revision.
 *
 * Both forms are accepted, so a document written by hand (or by a role definition loaded
 * before this change) still validates. Returns the ids it could not resolve; the caller
 * refuses the submit rather than letting an unresolved string reach the schema, where it
 * would surface as an unrelated type error.
 */
function expandAnchors(doc: unknown, hunks: IndexedHunk[]): string[] {
  const byId = new Map(hunks.map((h) => [h.id.toUpperCase(), h]));
  const unknown: string[] = [];

  const resolve = (a: unknown): unknown => {
    const id =
      typeof a === "string"
        ? a
        : a && typeof a === "object" && typeof (a as { hunk_id?: unknown }).hunk_id === "string"
          ? ((a as { hunk_id: string }).hunk_id)
          : undefined;
    if (id === undefined) return a;
    const h = byId.get(id.trim().toUpperCase());
    if (!h) {
      unknown.push(id);
      return a;
    }
    return {
      path: h.path,
      hunk: {
        old_start: h.old_start,
        old_lines: h.old_lines,
        new_start: h.new_start,
        new_lines: h.new_lines,
      },
    };
  };

  const walk = (holder: unknown): void => {
    if (!holder || typeof holder !== "object") return;
    const h = holder as { anchors?: unknown };
    if (Array.isArray(h.anchors)) h.anchors = h.anchors.map(resolve);
  };

  if (!doc || typeof doc !== "object") return unknown;
  const d = doc as { tour?: unknown; verification?: { added_tests?: unknown } };
  if (Array.isArray(d.tour)) d.tour.forEach(walk);
  if (Array.isArray(d.verification?.added_tests)) d.verification.added_tests.forEach(walk);
  return Array.from(new Set(unknown));
}

/**
 * Name the uncovered hunks by id. "uncovered: H7, H12" is a fix the reviewer can apply by
 * adding two strings; "lines 45-51 of src/x.ts are not covered" is one it has to
 * translate back into an anchor first, which is where the transcription errors came from.
 */
function uncoveredIds(
  coverage: { unexplained: { path: string; hunk: { new_start: number } }[] } | undefined,
  hunks: IndexedHunk[]
): string[] {
  if (!coverage?.unexplained?.length) return [];
  return coverage.unexplained
    .map((u) => hunks.find((h: IndexedHunk) => h.path === u.path && h.new_start === u.hunk.new_start)?.id)
    .filter((id): id is string => Boolean(id));
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
            interview_preserved: summarizeRun(run),
            next:
              `Call compute_diff again for ${repoDir}. The run_id does NOT change — it stays ${run_id}, ` +
              "and your recorded interview stays on it, so there is nothing to re-ask. That call moves " +
              "the run to the new head and renumbers the hunks; re-anchor every stop against the ids it " +
              "returns, then resubmit.",
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

    // Hunk ids are resolved against a diff recomputed from the run's own SHAs, by the
    // same function that handed them out — so an id always means what it meant when the
    // reviewer wrote it down.
    const hunks = indexHunks(diff);
    const unknown = expandAnchors(doc, hunks);
    if (unknown.length) {
      return textResult(
        JSON.stringify(
          {
            ok: false,
            run_id,
            error: `Unknown hunk id(s): ${unknown.join(", ")}.`,
            valid_ids: hunks.map((h) => h.id),
            hint: "Ids come from compute_diff for THIS run. Re-read them there rather than guessing.",
          },
          null,
          2
        ),
        true
      );
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
            uncovered_hunk_ids: uncoveredIds(report.coverage, hunks),
          },
          null,
          2
        ),
        true
      );
    }

    // Captured BEFORE the write: whether a document has already been produced from this
    // run. That is the difference between a first submit and a correction, and the run
    // survives either way.
    const previously_submitted_at = run.submitted_at;

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
        // The run is kept, with its interview attached. Submitting is not the end of a
        // distillation: a finding spotted after the document lands is fixed by editing and
        // resubmitting, and that must not cost the attestation.
        markSubmitted(run_id, outPath);
      } catch (e) {
        return textResult(`document valid but write failed: ${(e as Error).message}`, true);
      }
    }

    return textResult(
      JSON.stringify(
        {
          ok: true,
          written,
          run_id,
          ...(previously_submitted_at ? { resubmit: true, previously_submitted_at } : {}),
          run_still_open:
            "This run and its interview are still open. If you spot a finding, fix the document and " +
            "submit again with the same run_id — nothing needs re-asking. If the branch has moved, call " +
            "compute_diff first and re-anchor: the id is unchanged but the hunk ids are not.",
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
    let removed: string[] | undefined;
    if (install) {
      try {
        removed = sweepStaleRoleDefinitions(bundle, projectScopeDirs());
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
                ? {
                    ...(removed?.length ? { removed_stale: removed } : {}),
                    ...(installed?.length
                      ? { installed }
                      : {
                          installed: [],
                          note: `${bundle.env} has no agent directory; use the definitions above as-is.`,
                        }),
                  }
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
 * Directories an older version might have dropped project-scoped definitions into:
 * where the server was started, and the repo it was pointed at. Definitions never
 * belong in either, so anything found there is swept.
 */
function projectScopeDirs(): string[] {
  return [process.cwd(), REPO_DIR];
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
    // Reconcile before writing. A project-scoped copy left by an older version takes
    // precedence over the user-scoped one in Claude Code, so installing without
    // removing it means the session keeps running the stale prompt while the server
    // reports success.
    const removed = sweepStaleRoleDefinitions(bundle, projectScopeDirs());
    for (const path of removed) {
      process.stderr.write(`review-assist: removed stale role definition -> ${path}\n`);
    }
    const changed = installRoles(bundle, { onlyIfChanged: true });
    if (changed.length || removed.length) {
      process.stderr.write(
        `review-assist: installed role definitions -> ${changed.join(", ") || "(unchanged)"}\n` +
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
