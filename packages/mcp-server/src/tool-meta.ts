/**
 * What each tool does to the user's machine, declared once, and sent to the client as the
 * tool's MCP annotations.
 *
 * Both directories this server can be listed in read these. Anthropic's Software Directory
 * Policy requires `readOnlyHint`, `destructiveHint` and `title` on every tool, and OpenAI's
 * plugin guidelines require all three hints as explicit booleans. Clients use them too: a
 * read-only tool can be allowed without a prompt, a destructive one is worth a second look.
 *
 * Keyed by tool name and typed, so index.ts cannot register a tool with no entry here, and
 * check-release-consistency fails on an entry for a tool that is no longer registered.
 *
 * `openWorldHint` is false for every tool and so is not a column: nothing here reaches
 * outside the machine. The only subprocess the server starts is git, against the local
 * repository.
 */

export interface ToolMeta {
  /** Shown to the user in place of the tool's name. */
  title: string;
  /** Changes nothing the user relies on. Reads, plus the in-memory heartbeat. */
  readOnly: boolean;
  /** Can replace or remove something the user would want back. Only meaningful when not readOnly. */
  destructive: boolean;
  /** Calling it again with the same arguments has no further effect. */
  idempotent: boolean;
}

const read = (title: string): ToolMeta => ({ title, readOnly: true, destructive: false, idempotent: true });
const write = (title: string, o: { destructive: boolean; idempotent: boolean }): ToolMeta => ({ title, readOnly: false, ...o });

export const TOOL_META = {
  get_generation_guide: read("Get the authoring guide"),
  read_diff: read("Read the diff"),
  get_hunk_notes: read("Get hunk notes"),
  get_reviewer_instructions: read("Get the repository's reviewer instructions"),
  list_transcripts: read("List session transcripts"),
  get_spine: read("Read a session's conversation"),
  read_transcript: read("Read part of a transcript"),
  get_contexts: read("Get what a session was about"),
  read_context: read("Read one part of a session"),
  // Keeps a cache of which files each session touched under ~/.review-assist, derived
  // from the transcripts and rebuilt from them. Nothing the user relies on changes.
  find_sessions_touching: read("Find the session that wrote a change"),
  get_questions: read("Get the reviewer's questions"),
  get_answers: read("Get the author's answers"),

  // Write only the server's own run state under ~/.review-assist. Each is keyed so that a
  // repeat replaces rather than adds: by change (compute_diff), hunk content, plan item,
  // question, or context block.
  compute_diff: write("Open a distillation run", { destructive: false, idempotent: true }),
  record_hunk_notes: write("Record hunk notes", { destructive: false, idempotent: true }),
  map_plan_to_hunks: write("Map the plan to hunks", { destructive: false, idempotent: true }),
  record_contexts: write("Record what a session was about", { destructive: false, idempotent: true }),
  record_interview_round: write("Record interview questions", { destructive: false, idempotent: true }),
  answer_questions: write("Answer the reviewer's questions", { destructive: false, idempotent: true }),
  // Re-importing replaces this server's own earlier copy of the same session, by design.
  import_session: write("Import a session transcript", { destructive: false, idempotent: true }),
  set_consent: write("Record consent for a repository", { destructive: false, idempotent: true }),

  // Replaces .intent/<branch>.json in the user's repository.
  submit_document: write("Validate and write the Intent Document", { destructive: true, idempotent: false }),
  // `reset` deletes a recorded decision, so the tool as a whole is destructive.
  manage_consent: write("List or reset repository consent", { destructive: true, idempotent: true }),
  // With `install`, writes agent definitions under ~/.claude/agents or ~/.codex/agents and
  // removes stale ones this server generated earlier. See toolMeta for the plugin case.
  get_role_definitions: write("Get the author and reviewer roles", { destructive: true, idempotent: true }),
} satisfies Record<string, ToolMeta>;

export type ToolName = keyof typeof TOOL_META;

/**
 * The entry for a tool, adjusted for how the server was launched. Inside a Claude Code
 * plugin the roles ship with the plugin and get_role_definitions writes nothing, so it is
 * read-only there.
 */
export function toolMeta(name: ToolName, opts: { plugin?: boolean } = {}): ToolMeta {
  const meta = TOOL_META[name];
  if (opts.plugin && name === "get_role_definitions") return { ...meta, readOnly: true, destructive: false };
  return meta;
}

/**
 * The MCP annotations for an entry. `title` is set here as well as at the top level of the
 * tool: the spec has it in both places, and a client or directory check may read either.
 */
export function toolAnnotations(meta: ToolMeta) {
  return {
    title: meta.title,
    readOnlyHint: meta.readOnly,
    destructiveHint: meta.readOnly ? false : meta.destructive,
    idempotentHint: meta.idempotent,
    openWorldHint: false,
  };
}
