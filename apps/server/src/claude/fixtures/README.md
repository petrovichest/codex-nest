# Claude transcript fixtures

Real `{ info, messages }` output captured from the Claude Agent SDK's
`getSessionInfo` / `getSessionMessages` during the Stage 0 spike (SDK 0.3.218,
Claude Code CLI 2.1.218). Do not hand-edit — regenerate by re-running the spike
capture if the SDK transcript shape changes.

- `session-plain-text.json` — one turn: user prompt, a thinking block, a final text answer.
- `session-tools.json` — one turn: Bash + Write `tool_use` blocks, their `tool_result`
  carrier messages, multiple thinking messages, and a final text answer.
- `session-read.json` — one turn: a `Read` tool_use whose result is an image block.
