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

import roleAuthor from "../agents/_roles/author.md";
import roleReviewer from "../agents/_roles/reviewer.md";
import roleQuestions from "../agents/_roles/questions.md";
import claudeAuthorTpl from "../agents/claude/author.tpl.md";
import claudeReviewerTpl from "../agents/claude/reviewer.tpl.md";
import codexAuthorTpl from "../agents/codex/author.tpl.toml";
import codexReviewerTpl from "../agents/codex/reviewer.tpl.toml";
import genericAuthorTpl from "../agents/generic/author.tpl.md";
import genericReviewerTpl from "../agents/generic/reviewer.tpl.md";

export type RoleEnv = "claude" | "codex" | "generic";
export type RoleName = "author" | "reviewer";

/** The reviewer carries the baseline question set; the author answers, so it does not. */
const BODY: Record<RoleName, string> = {
  author: roleAuthor,
  reviewer: roleReviewer.trimEnd() + "\n" + roleQuestions,
};

interface EnvEntry {
  templates: Record<RoleName, string>;
  /** Where this client reads agent definitions from, if it has such a place. */
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
      "Install with `review-assist-mcp agents --write`, then dispatch the subagents with the " +
      "Task tool — author first, then reviewer, relaying questions and answers between them. " +
      "Each starts in its own context, and the `tools:` allowlist keeps the roles apart.",
  },
  codex: {
    templates: { author: codexAuthorTpl, reviewer: codexReviewerTpl },
    install_dir: ".codex/agents",
    filename: (r) => `intent-${r}.toml`,
    how_to_run:
      "Install with `review-assist-mcp agents --write` (writes TOML agent definitions to " +
      ".codex/agents/; use ~/.codex/agents/ for personal scope), then ask Codex to delegate the " +
      "author and reviewer parts to subagents. `/agent` switches between the running threads. " +
      "Each definition pins REVIEW_ASSIST_ROLE, so the server itself withholds the other role's tools.",
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
  return tpl.replace("{{BODY}}", BODY[role].trim()).replace("{{TOOLS}}", allowlist);
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
    install_dir: entry.install_dir,
    roles,
  };
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
