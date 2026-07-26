# review-assist-mcp

The MCP server an agent uses to author and submit an Intent Document. It never calls a
model — generation is the agent's job. The server provides ground truth and gatekeeps.

## Tools

- **`get_generation_guide`** — returns the JSON Schema and the two-agent authoring protocol. Call first.
- **`compute_diff`** `{ base, head? }` — deterministic PR diff (`base...head`) plus resolved SHAs. Anchors use these hunk line numbers.
- **`list_transcripts`** `{ path? }` — locate the session JSONL transcript(s) for the repo, newest first.
- **`read_transcript`** `{ path, offset?, limit? }` — page through a transcript to hydrate a fresh distiller agent (the on-disk transcript contains material compacted out of live context).
- **`submit_document`** `{ document, base, head?, strict?, write? }` — validate against the diff + head SHA. On pass, writes `.intent/<branch>.json`. On failure, returns findings to fix and resubmit.

## Run

```bash
npm run build --workspace review-assist-mcp
REVIEW_ASSIST_REPO=/path/to/repo node packages/mcp-server/dist/index.js   # stdio transport
```

Register in Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "review-assist": {
      "command": "node",
      "args": ["/abs/path/packages/mcp-server/dist/index.js"],
      "env": { "REVIEW_ASSIST_REPO": "${workspaceFolder}" }
    }
  }
}
```

The server is read-only against git except for writing the document under `.intent/`.
