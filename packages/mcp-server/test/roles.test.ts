/**
 * Installing role definitions has to reconcile, not just write.
 *
 * The case that motivates this: a repo still held `.claude/agents/intent-reviewer.md`
 * from an older version that installed at project scope. Claude Code prefers a
 * project-scoped subagent, so that copy shadowed the user-scoped one — the server
 * reported installing the current prompt while every session ran the old one.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { dirname, join } from "node:path";
import { getRoles, installRoles, sweepStaleRoleDefinitions, ROLE_TOOLS } from "../src/roles.js";

const scratch = mkdtempSync(join(tmpdir(), "review-assist-roles-"));
const projectDir = join(scratch, "my-repo");
const claudeAgents = join(projectDir, ".claude", "agents");
const codexAgents = join(projectDir, ".codex", "agents");

const bundle = getRoles({ env: "claude" });

beforeEach(() => {
  rmSync(projectDir, { recursive: true, force: true });
  mkdirSync(claudeAgents, { recursive: true });
  mkdirSync(codexAgents, { recursive: true });
});

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("rendered definitions", () => {
  it("carry a provenance marker, so a later sweep knows what it wrote", () => {
    for (const role of Object.values(bundle.roles)) {
      expect(role.definition).toContain("review-assist-mcp: generated file");
    }
  });

  it("still render the tools allowlist that enforces the role split", () => {
    expect(bundle.roles.reviewer!.definition).toContain("mcp__review-assist__submit_document");
    expect(bundle.roles.author!.definition).not.toContain("mcp__review-assist__submit_document");
  });

  it("generate the access list from ROLE_TOOLS, so prose cannot drift from the allowlist", () => {
    // The frontmatter allowlist was already generated; the prose list beside it was not,
    // and the reviewer prompt ended up declaring three of the seven tools it had.
    for (const role of ["author", "reviewer"] as const) {
      const def = getRoles({ env: "claude", role }).roles[role]!.definition;
      for (const tool of ROLE_TOOLS[role]) {
        expect(def).toContain(`\`${tool}\``);
        expect(def).toContain(`mcp__review-assist__${tool}`);
      }
    }
  });

  it("do not grant the reviewer tools that belong to the orchestrator", () => {
    expect(ROLE_TOOLS.reviewer).not.toContain("get_role_definitions");
    expect(ROLE_TOOLS.reviewer).not.toContain("manage_consent");
    expect(ROLE_TOOLS.reviewer).toContain("submit_document");
    expect(ROLE_TOOLS.author).not.toContain("submit_document");
  });

  it("give the repo's house rules to the reviewer only, since they are questions the author answers", () => {
    expect(ROLE_TOOLS.reviewer).toContain("get_reviewer_instructions");
    expect(ROLE_TOOLS.author).not.toContain("get_reviewer_instructions");
    // It is the reviewer's one read of repository content, so the prompt has to say what
    // that content may and may not do. Untrusted text arriving through a tool is exactly
    // the shape of an instruction injection.
    expect(bundle.roles.reviewer!.definition).toContain(".reviewer/");
  });

  it("tell the reviewer the house rules ADD to the standing set rather than replace it", () => {
    // The failure this guards: a repo ships a three-line .reviewer/ folder, the reviewer
    // reads it as the question set, and the standing questions go unasked. The folder
    // is written without them in view, so it can never be the whole set.
    const def = bundle.roles.reviewer!.definition;
    expect(def).toContain("EXTRA questions");
    // Whitespace-tolerant: the prompt is hard-wrapped, so the phrase spans a line.
    expect(def).toMatch(/house\s+rules are EXTRA questions[\s\S]{0,80}standing\s+set below/);
    expect(def).toContain("They replace neither.");
  });

  it("tell both roles to start at the same time, not one after the other", () => {
    // The serialization this removes was 670s of a 1400s median across 15 runs: the author
    // could not write anything until the reviewer had paged the whole diff and handed back
    // q_ids, so two independent reads added up instead of overlapping.
    expect(bundle.roles.author!.definition).toContain("You do not wait to be asked.");
    expect(bundle.roles.reviewer!.definition).toMatch(/start at the same time as the author/);
    expect(bundle.how_to_run).toMatch(/concurrently|at the same time|before waiting on either/);
  });

  it("let each role read the other's half of the interview, and only that half", () => {
    // The run is the channel between two agents that cannot talk. Before these, the
    // questions and the answers both had to be hand-carried as chat text by whoever
    // dispatched the roles — 25,567 and 28,943 bytes across two real runs.
    expect(ROLE_TOOLS.author).toContain("get_questions");
    expect(ROLE_TOOLS.reviewer).toContain("get_answers");
    // Each reads what the other WROTE; neither gets a second way to write.
    expect(ROLE_TOOLS.author).not.toContain("record_interview_round");
    expect(ROLE_TOOLS.reviewer).not.toContain("answer_questions");
  });

  it("leave no unsubstituted placeholders", () => {
    for (const role of Object.values(bundle.roles)) {
      expect(role.definition).not.toMatch(/\{\{[A-Z]+\}\}/);
    }
  });
});

describe("sweepStaleRoleDefinitions", () => {
  it("removes a project-scoped definition, which always shadows the real one", () => {
    const stale = join(claudeAgents, "intent-reviewer.md");
    writeFileSync(stale, "---\nname: intent-reviewer\ntools: mcp__review-assist__submit_document\n---\nold\n");
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it("removes project-scoped copies for OTHER clients too — none of them belong there", () => {
    const staleCodex = join(codexAgents, "intent-author.toml");
    writeFileSync(staleCodex, 'name = "intent-author"\nenv = { REVIEW_ASSIST_ROLE = "author" }\n');
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).toContain(staleCodex);
  });

  it("removes definitions written before the marker existed", () => {
    // No marker; recognised by the allowlist an older render always emitted.
    const legacy = join(claudeAgents, "intent-author.md");
    writeFileSync(legacy, "---\ntools: mcp__review-assist__read_transcript\n---\n");
    expect(sweepStaleRoleDefinitions(bundle, [projectDir])).toContain(legacy);
  });

  it("never touches a file it did not write", () => {
    const handWritten = join(claudeAgents, "intent-reviewer.md");
    writeFileSync(handWritten, "---\nname: intent-reviewer\n---\nMy own reviewer, nothing to do with review-assist.\n");
    const mine = join(claudeAgents, "my-helper.md");
    writeFileSync(mine, "---\nname: my-helper\ntools: mcp__review-assist__compute_diff\n---\n");

    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    expect(removed).not.toContain(handWritten);
    expect(existsSync(handWritten)).toBe(true);
    // Not one of our filenames, so out of scope even though it mentions our tools.
    expect(removed).not.toContain(mine);
    expect(existsSync(mine)).toBe(true);
  });

  it("leaves user-scope definitions that are part of the current bundle", () => {
    const removed = sweepStaleRoleDefinitions(bundle, [projectDir]);
    for (const role of Object.values(bundle.roles)) {
      expect(removed).not.toContain(join(bundle.install_dir!, role.filename));
    }
  });

  it("refuses to treat the home directory as project scope", () => {
    // Guards the degenerate case where the server is started from ~, which would
    // otherwise make the project sweep delete the real user-scope definitions.
    expect(sweepStaleRoleDefinitions(bundle, [homedir()])).toEqual([]);
  });

  it("is idempotent — a clean tree sweeps to nothing", () => {
    expect(sweepStaleRoleDefinitions(bundle, [projectDir])).toEqual([]);
  });
});

describe("installRoles", () => {
  it("writes definitions that the sweep then recognises as its own", () => {
    const local = { ...bundle, install_dir: claudeAgents };
    const written = installRoles(local);
    expect(written).toHaveLength(2);
    for (const path of written) {
      expect(readFileSync(path, "utf8")).toContain("review-assist-mcp: generated file");
    }
    expect(sweepStaleRoleDefinitions(bundle, [projectDir]).sort()).toEqual(written.sort());
  });

  it("onlyIfChanged does not churn a steady state", () => {
    const local = { ...bundle, install_dir: claudeAgents };
    installRoles(local);
    expect(installRoles(local, { onlyIfChanged: true })).toEqual([]);
  });
});

/**
 * The author may read the repository, and may ask the developer — expressed per CLIENT.
 *
 * Two separate failures live here, and only the first was fixed when this was written.
 *
 * ONE: `tools:` in a Claude Code subagent is an allowlist, and it was generated from
 * ROLE_TOOLS — this server's MCP tools and nothing else — so the author shipped with no
 * file access at all, not as a decision but as a side effect of expressing a different one
 * ("the author must not reach submit_document").
 *
 * TWO, and the reason these tests are per client: the fix listed `Read`, `Grep`, `Glob` and
 * `AskUserQuestion` for every client. Claude Code got a correct allowlist. Codex has no
 * per-tool allowlist at all — it scopes MCP access per server, which is why the role lock
 * lives in REVIEW_ASSIST_ROLE — and arrives with its own file tools under its own names, so
 * its author was handed an access list naming four tools it does not have, one of which
 * (asking the user) has no Codex equivalent whatsoever. The earlier tests were Claude-only,
 * which is exactly why that shipped.
 */
describe("what the author may do beyond this server's tools", () => {
  const def = (env: string) => getRoles({ env }).roles.author!.definition;
  const toolsLine = (d: string) => d.split("\n").find((l) => l.startsWith("tools:")) ?? "";
  const CLAUDE_ONLY = ["Read", "Grep", "Glob", "AskUserQuestion"];

  describe("on Claude Code, which takes an allowlist", () => {
    it("names the read-only file tools and the way to ask the developer", () => {
      const line = toolsLine(def("claude"));
      for (const t of CLAUDE_ONLY) expect(line).toContain(t);
      expect(line).toContain("mcp__review-assist__get_spine");
    });

    it("grants nothing that can write or execute", () => {
      // The author answers questions, and a role that can edit the repository it is
      // describing can make its own answers true.
      const line = toolsLine(def("claude"));
      for (const t of ["Bash", "Edit", "Write", "NotebookEdit"]) expect(line).not.toContain(t);
    });

    it("documents them, so the prose cannot drift from the allowlist", () => {
      for (const t of CLAUDE_ONLY) expect(def("claude")).toContain(`- \`${t}\``);
    });
  });

  for (const env of ["codex", "generic"]) {
    describe(`on ${env}, which has no per-tool allowlist`, () => {
      it("never names a tool this client does not have", () => {
        // The bug this file exists to prevent: an access list promising `Grep` to a client
        // whose search tool is not called that, and `AskUserQuestion` to one with no
        // equivalent at all.
        const d = def(env);
        for (const t of CLAUDE_ONLY) expect(d).not.toContain(`\`${t}\``);
      });

      it("states the capability instead, so the author still knows it may look", () => {
        // Silence would be worse than a wrong name: the author would not know it may read
        // the code, and would report the transcript silent on a question the code answers.
        const d = def(env);
        expect(d).toContain("reading the repository, read-only");
        expect(d).toContain("putting a question to the DEVELOPER");
      });

      it("says the developer question may be impossible, and must never block", () => {
        expect(def(env)).toContain("NEVER blocking");
      });

      it("still carries the MCP tools, which are granted by the server not the client", () => {
        expect(def(env)).toContain("get_spine");
      });
    });
  }

  it("leaves the reviewer with no client grant on any client", () => {
    // Its independence is from the AUTHOR's framing rather than from the repository, so
    // widening it is defensible — but it is a separate decision, not this one.
    for (const env of ["claude", "codex", "generic"]) {
      const d = getRoles({ env }).roles.reviewer!.definition;
      for (const t of CLAUDE_ONLY) expect(d).not.toContain(`\`${t}\``);
    }
  });

  it("leaves no placeholder unsubstituted in any client's definition", () => {
    for (const env of ["claude", "codex", "generic"]) {
      for (const role of ["author", "reviewer"] as const) {
        expect(getRoles({ env }).roles[role]!.definition).not.toMatch(/\{\{[A-Z]+\}\}/);
      }
    }
  });
});

/**
 * A client that installs nothing must remove nothing at home scope.
 *
 * `candidateDefinitionPaths` enumerates every env's definitions and `keep` held only the
 * current bundle's, so a bundle with no `install_dir` kept nothing and swept BOTH envs'
 * definitions out of the home directory. `generic` is precisely that bundle, and
 * `detectEnv` falls back to it for any client whose `clientInfo.name` is unrecognised.
 *
 * Observed repeatedly while this was being written: a Claude Code session's intent-author
 * and intent-reviewer subagents disappeared whenever another tool connected to the server,
 * and the only symptom was their absence — the roles were reported installed, then were
 * gone, with nothing in between to look at.
 */
describe("the role-definition sweep", () => {
  let home: string;
  let claudeDir: string;
  let codexDir: string;
  const generated = (p: string) => {
    mkdirSync(dirname(p), { recursive: true });
    // Only a file carrying the generated marker is ever removed; this is what one looks like.
    writeFileSync(p, `<!-- review-assist-mcp: generated file — rewritten when the server connects -->\n`);
  };

  // The sweep resolves the home directory itself, via os.homedir(), which honours $HOME on
  // POSIX. Pointing it at a temp directory is what makes these tests real: written against
  // the actual home they passed whether or not the bug was present, because the files they
  // created were somewhere the sweep never looked.
  let realHome: string | undefined;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "review-assist-sweep-"));
    claudeDir = join(home, ".claude", "agents");
    codexDir = join(home, ".codex", "agents");
    realHome = process.env.HOME;
    process.env.HOME = home;
  });
  afterEach(() => {
    if (realHome === undefined) delete process.env.HOME;
    else process.env.HOME = realHome;
    // Each case gets a fresh home; the file's own afterAll does not reach them.
    rmSync(home, { recursive: true, force: true });
  });

  it("leaves both envs alone when the bundle installs nothing", () => {
    // The generic bundle. Previously this deleted every definition it found.
    generated(join(claudeDir, "intent-author.md"));
    generated(join(codexDir, "intent-author.toml"));
    const bundle = { ...getRoles({ env: "generic" }), install_dir: undefined };
    const removed = sweepStaleRoleDefinitions(bundle, []);
    expect(removed).toEqual([]);
    expect(existsSync(join(claudeDir, "intent-author.md"))).toBe(true);
    expect(existsSync(join(codexDir, "intent-author.toml"))).toBe(true);
  });

  it("still clears a project-scoped copy, which shadows the user-scoped one", () => {
    // The sweep's actual purpose: in Claude Code a project-scoped definition takes
    // precedence, so installing without removing it leaves the session on a stale prompt
    // while the server reports success.
    const projectDir = mkdtempSync(join(tmpdir(), "review-assist-proj-"));
    const stale = join(projectDir, ".claude", "agents", "intent-author.md");
    generated(stale);
    const bundle = { ...getRoles({ env: "generic" }), install_dir: undefined };
    expect(sweepStaleRoleDefinitions(bundle, [projectDir])).toContain(stale);
    expect(existsSync(stale)).toBe(false);
  });

  it("never touches a definition someone wrote by hand", () => {
    const mine = join(claudeDir, "intent-author.md");
    mkdirSync(dirname(mine), { recursive: true });
    writeFileSync(mine, "# my own prompt, not generated\n");
    const bundle = { ...getRoles({ env: "claude" }), install_dir: claudeDir };
    sweepStaleRoleDefinitions(bundle, []);
    expect(readFileSync(mine, "utf8")).toContain("my own prompt");
  });
});
