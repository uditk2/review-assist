/**
 * Role definitions for the two-agent distillation.
 *
 * The guide *describes* an author/reviewer split; these definitions *are* it. Each
 * environment gets its own pair under `agents/<env>/`, authored as markdown and
 * inlined at build time (esbuild `--loader:.md=text`), so the single-file bundle and
 * the .mcpb keep working unchanged.
 *
 * Adding an environment is a folder plus one registry line — no other code moves.
 *
 * The split is not cosmetic. The author holds the transcript and cannot submit; the
 * reviewer can submit and cannot read the transcript. Whatever the reviewer knows
 * about intent, it had to ask for — which is what makes `meta.interview` mean
 * something rather than merely counting calls.
 */

import claudeAuthor from "../agents/claude/author.md";
import claudeReviewer from "../agents/claude/reviewer.md";
import codexAuthor from "../agents/codex/author.md";
import codexReviewer from "../agents/codex/reviewer.md";
import genericAuthor from "../agents/generic/author.md";
import genericReviewer from "../agents/generic/reviewer.md";

export type RoleEnv = "claude" | "codex" | "generic";
export type RoleName = "author" | "reviewer";

interface EnvEntry {
  author: string;
  reviewer: string;
  /** Where the client reads agent definitions from, if it has such a place. */
  install_dir?: string;
  /** How to actually spin the roles up in this environment. */
  how_to_run: string;
}

const REGISTRY: Record<RoleEnv, EnvEntry> = {
  claude: {
    author: claudeAuthor,
    reviewer: claudeReviewer,
    install_dir: ".claude/agents",
    how_to_run:
      "Write each definition to .claude/agents/<name>.md (or run `review-assist-mcp agents --write`), " +
      "then dispatch them with the Task tool: the author first, then the reviewer, passing the " +
      "author's answers between them. Each subagent starts in its own context.",
  },
  codex: {
    author: codexAuthor,
    reviewer: codexReviewer,
    how_to_run:
      "Codex has no subagent file format. Run each role as its own `codex exec` invocation so it " +
      "starts fresh, relaying the reviewer's questions to the author process and the answers back.",
  },
  generic: {
    author: genericAuthor,
    reviewer: genericReviewer,
    how_to_run:
      "Start two separate agent sessions against this MCP server — one per role — and relay " +
      "questions and answers between them. What matters is that the reviewer never sees the " +
      "transcript, not which client you use.",
  },
};

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
  roles: Partial<Record<RoleName, string>>;
}

export function getRoles(opts: {
  env?: string;
  role?: RoleName;
  clientName?: string;
}): RoleBundle {
  const requested = opts.env?.toLowerCase();
  const env: RoleEnv = requested && isRoleEnv(requested) ? requested : detectEnv(opts.clientName);
  const entry = REGISTRY[env];
  const roles: Partial<Record<RoleName, string>> =
    opts.role === "author"
      ? { author: entry.author }
      : opts.role === "reviewer"
        ? { reviewer: entry.reviewer }
        : { author: entry.author, reviewer: entry.reviewer };

  return {
    env,
    detected_from: requested && isRoleEnv(requested)
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
