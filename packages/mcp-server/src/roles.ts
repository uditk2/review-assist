/**
 * Role definitions for the two-agent distillation.
 *
 * The guide *described* an author/reviewer split; this *is* it.
 *
 * Layout: the role prose lives once in `agents/_roles/`, and each environment supplies
 * a thin template under `agents/<env>/` that wraps it in whatever container that client
 * reads — YAML frontmatter for Claude Code, TOML for Codex, bare markdown otherwise.
 * Adding an environment is a folder plus one registry line; the prose never forks, so
 * the three copies cannot drift.
 *
 * Templates are authored as real files and inlined at build time (esbuild
 * `--loader:.md=text --loader:.toml=text`), so the single-file bundle and the .mcpb are
 * unchanged.
 *
 * On enforcement: the split only means something if the roles cannot reach each other's
 * tools. Claude Code can express that in the subagent `tools:` allowlist. Codex scopes
 * MCP access per *server*, not per tool — so the real lock is REVIEW_ASSIST_ROLE, read
 * by index.ts, which decides which tools get registered at all. Both templates set it;
 * the allowlist is then belt and braces.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import roleAuthor from "../agents/_roles/author.md";
import roleReviewer from "../agents/_roles/reviewer.md";
import roleQuestions from "../agents/_roles/questions.md";
import claudeAuthorTpl from "../agents/claude/author.tpl.md";
import claudeReviewerTpl from "../agents/claude/reviewer.tpl.md";
import codexAuthorTpl from "../agents/codex/author.tpl.toml";
import codexReviewerTpl from "../agents/codex/reviewer.tpl.toml";
import genericAuthorTpl from "../agents/generic/author.tpl.md";
import genericReviewerTpl from "../agents/generic/reviewer.tpl.md";

/**
 * Stamped into every definition the server writes, so a later sweep can tell its own
 * output from a file someone put there by hand. Placed by each template in that
 * client's comment syntax; the token itself is shared so one test recognises both.
 */
const MARKER = "review-assist-mcp: generated file — rewritten when the server connects";

/**
 * Signatures of definitions written before the marker existed. Both are inherent to a
 * generated file: the Claude template renders a `mcp__review-assist__` allowlist, the
 * Codex one pins REVIEW_ASSIST_ROLE. Neither appears in prose someone wrote themselves.
 */
const LEGACY_SIGNATURES = ["mcp__review-assist__", "REVIEW_ASSIST_ROLE"];

export type RoleEnv = "claude" | "codex" | "generic";
export type RoleName = "author" | "reviewer";

/** The reviewer carries the baseline question set; the author answers, so it does not. */
const BODY: Record<RoleName, string> = {
  author: roleAuthor,
  reviewer: roleReviewer.trimEnd() + "\n" + roleQuestions,
};

interface EnvEntry {
  templates: Record<RoleName, string>;
  /**
   * Where this client reads agent definitions from, relative to the user's home.
   *
   * User scope, not project scope: the rendered definitions contain nothing
   * repo-specific — for Claude only the tools allowlist is substituted — so writing
   * them per project would drop untracked files into every repository the tool runs
   * in, and only this repo's .gitignore knows to exclude them.
   */
  install_dir?: string;
  /** File name for an installed role definition. */
  filename: (role: RoleName) => string;
  how_to_run: string;
}

const REGISTRY: Record<RoleEnv, EnvEntry> = {
  claude: {
    templates: { author: claudeAuthorTpl, reviewer: claudeReviewerTpl },
    install_dir: ".claude/agents",
    filename: (r) => `intent-${r}.md`,
    how_to_run:
      "Call this tool again with `install: true` and the definitions are written to " +
      "~/.claude/agents/. Then dispatch them with the Task tool — author first, then reviewer, " +
      "relaying questions and answers between them. Each starts in its own context, and the " +
      "`tools:` allowlist keeps the roles apart.",
  },
  codex: {
    templates: { author: codexAuthorTpl, reviewer: codexReviewerTpl },
    install_dir: ".codex/agents",
    filename: (r) => `intent-${r}.toml`,
    how_to_run:
      "Call this tool again with `install: true` and the definitions are written to " +
      "~/.codex/agents/. Then ask Codex to delegate the author and reviewer parts to subagents; " +
      "`/agent` switches between the running threads. Each definition pins REVIEW_ASSIST_ROLE, so " +
      "the server itself withholds the other role's tools.",
  },
  generic: {
    templates: { author: genericAuthorTpl, reviewer: genericReviewerTpl },
    filename: (r) => `intent-${r}.md`,
    how_to_run:
      "Start two separate agent sessions against this server, one per role, and relay questions " +
      "and answers between them. Launch each with REVIEW_ASSIST_ROLE set (author | reviewer) so " +
      "the server withholds the other role's tools; what matters is that the reviewer never sees " +
      "the transcript.",
  },
};

/**
 * Fill a template. {{TOOLS}} is derived from ROLE_TOOLS rather than written by hand:
 * the two drifted the moment search_transcript was added, leaving the Claude author
 * unable to call the one tool the interview depends on.
 */
function render(tpl: string, role: RoleName): string {
  const allowlist = ROLE_TOOLS[role].map((t) => `mcp__review-assist__${t}`).join(", ");
  return tpl
    .replace("{{BODY}}", BODY[role].trim())
    .replace("{{TOOLS}}", allowlist)
    .replace("{{MARKER}}", MARKER);
}

/**
 * Resolve the environment from the MCP `initialize` handshake's clientInfo.name.
 * Callers may override; unknown clients fall back to `generic` rather than guessing.
 */
export function detectEnv(clientName?: string): RoleEnv {
  const n = (clientName ?? "").toLowerCase();
  if (n.includes("claude")) return "claude";
  if (n.includes("codex")) return "codex";
  return "generic";
}

export function isRoleEnv(v: string): v is RoleEnv {
  return v === "claude" || v === "codex" || v === "generic";
}

export interface RoleBundle {
  env: RoleEnv;
  detected_from: string;
  how_to_run: string;
  install_dir?: string;
  roles: Partial<Record<RoleName, { filename: string; definition: string }>>;
}

export function getRoles(opts: { env?: string; role?: RoleName; clientName?: string }): RoleBundle {
  const requested = opts.env?.toLowerCase();
  const env: RoleEnv = requested && isRoleEnv(requested) ? requested : detectEnv(opts.clientName);
  const entry = REGISTRY[env];
  const wanted: RoleName[] = opts.role ? [opts.role] : ["author", "reviewer"];

  const roles: RoleBundle["roles"] = {};
  for (const r of wanted) {
    roles[r] = { filename: entry.filename(r), definition: render(entry.templates[r], r) };
  }

  return {
    env,
    detected_from:
      requested && isRoleEnv(requested)
        ? "explicit env argument"
        : opts.clientName
          ? `MCP clientInfo.name = ${opts.clientName}`
          : "no client info; defaulted",
    how_to_run: entry.how_to_run,
    install_dir: entry.install_dir ? join(homedir(), entry.install_dir) : undefined,
    roles,
  };
}

/**
 * Write the rendered definitions where the client will find them.
 *
 * The server already knows the environment from the MCP handshake, so doing this here
 * means the caller never has to re-derive it. Previously the guide told agents to shell
 * out to `review-assist-mcp agents --write`, which has no handshake, resolved to
 * `generic`, and refused to write — so every agent fell through to placing the files by
 * hand, in whatever directory it happened to be in.
 */
export function installRoles(bundle: RoleBundle, opts: { onlyIfChanged?: boolean } = {}): string[] {
  if (!bundle.install_dir) return [];
  mkdirSync(bundle.install_dir, { recursive: true });
  const written: string[] = [];
  for (const r of Object.values(bundle.roles)) {
    const file = join(bundle.install_dir, r.filename);
    if (opts.onlyIfChanged) {
      try {
        if (readFileSync(file, "utf8") === r.definition) continue;
      } catch {
        /* missing or unreadable: write it */
      }
    }
    writeFileSync(file, r.definition, "utf8");
    written.push(file);
  }
  return written;
}

/** Did this server write the file, or did a person? Only the former may be removed. */
function isGeneratedDefinition(path: string): boolean {
  try {
    const content = readFileSync(path, "utf8");
    return content.includes(MARKER) || LEGACY_SIGNATURES.some((sig) => content.includes(sig));
  } catch {
    return false;
  }
}

/** Every path any version of this server might have written a definition to. */
function candidateDefinitionPaths(dirs: string[]): string[] {
  const paths: string[] = [];
  for (const dir of dirs) {
    for (const entry of Object.values(REGISTRY)) {
      if (!entry.install_dir) continue;
      for (const role of ["author", "reviewer"] as RoleName[]) {
        paths.push(join(dir, entry.install_dir, entry.filename(role)));
      }
    }
  }
  return paths;
}

/**
 * Remove definitions this server wrote that should no longer be there, BEFORE writing
 * the current ones. Installing without this leaves residue that silently wins.
 *
 * Two kinds of residue, and they are removed for different reasons:
 *
 * PROJECT SCOPE is always wrong. An earlier version told agents to shell out and place
 * the files themselves, which landed them in whatever directory the agent happened to
 * be in. Claude Code prefers a project-scoped subagent over a user-scoped one, so a
 * forgotten copy in a repo does not sit harmlessly beside the real definition — it
 * shadows it, and the session runs last month's prompt while the server reports having
 * installed this month's. Swept for every environment, since none of them belong here.
 *
 * USER SCOPE is legitimate, so only definitions for roles the current bundle no longer
 * contains are removed — a rename would otherwise leave the old role installed and
 * dispatchable forever. Files still in the bundle are left for installRoles to
 * overwrite, which keeps its onlyIfChanged behaviour meaningful: a steady state must
 * not churn files, because Claude Code asks the user to restart whenever they change.
 *
 * Never touches a file without the marker or a legacy signature.
 */
export function sweepStaleRoleDefinitions(
  bundle: RoleBundle,
  projectDirs: string[]
): string[] {
  const home = homedir();
  const scoped = projectDirs
    .map((d) => resolve(d))
    .filter((d, i, all) => d !== home && all.indexOf(d) === i);

  const keep = new Set(
    bundle.install_dir
      ? Object.values(bundle.roles).map((r) => join(bundle.install_dir!, r.filename))
      : []
  );

  const targets = [
    ...candidateDefinitionPaths(scoped),
    ...candidateDefinitionPaths([home]).filter((p) => !keep.has(p)),
  ];

  const removed: string[] = [];
  for (const path of targets) {
    if (!existsSync(path) || !isGeneratedDefinition(path)) continue;
    try {
      rmSync(path, { force: true });
      removed.push(path);
    } catch {
      /* a definition we cannot remove is reported by its absence from this list */
    }
  }
  return removed;
}

export const KNOWN_ENVS: RoleEnv[] = ["claude", "codex", "generic"];

/** Tools each role may reach. Read by index.ts from REVIEW_ASSIST_ROLE. */
export const ROLE_TOOLS: Record<RoleName, readonly string[]> = {
  author: [
    "get_generation_guide",
    "list_transcripts",
    "search_transcript",
    "read_transcript",
    "compute_diff",
  ],
  reviewer: [
    "get_generation_guide",
    "get_role_definitions",
    "compute_diff",
    "record_interview_round",
    "submit_document",
    "set_consent",
    "manage_consent",
  ],
};

export function activeRole(): RoleName | undefined {
  const v = (process.env.REVIEW_ASSIST_ROLE ?? "").toLowerCase();
  return v === "author" || v === "reviewer" ? v : undefined;
}
