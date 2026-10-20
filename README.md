# pi-web-mcp

[English](./README.md) | [简体中文](./README.zh-CN.md)

![test](https://github.com/glwhappen/pi-web-mcp/actions/workflows/test.yml/badge.svg)

An MCP server for [Pi Web](https://github.com/agegr/pi-web) — the web UI for the [pi coding agent](https://github.com/earendil-works/pi). It wraps Pi Web's HTTP API so any MCP client (pi, Claude Desktop, Cursor, your own agent…) can browse, triage, search, read and drive your pi sessions.

Pi Web itself only serves a browser. This server turns its API into **25 tools**: list and filter sessions, read transcripts, **triage which conversations are waiting for you**, full-text search, send messages and wait for replies, fork/rename/delete sessions, inspect project diffs — over stdio or Streamable HTTP.

```
┌────────────┐   MCP (stdio / HTTP)   ┌──────────────┐   HTTP   ┌──────────┐
│ any AI     │ ─────────────────────► │ pi-web-mcp   │ ───────► │ pi-web   │ ──► pi sessions
│ MCP client │ ◄───────────────────── │ (this repo)  │ ◄─────── │ :30141   │     (~/.pi/agent/sessions)
└────────────┘                        └──────────────┘          └──────────┘
```

## Quick start

Requires **Node.js ≥ 22** and a running Pi Web instance.

```bash
# run it without cloning (npm resolves the GitHub repo)
npx -y github:glwhappen/pi-web-mcp --status    # connectivity + config self-check
npx -y github:glwhappen/pi-web-mcp             # stdio MCP server on stdin/stdout
```

Or install it once:

```bash
npm install -g github:glwhappen/pi-web-mcp   # then run `pi-web-mcp`
# or, from a clone:
git clone https://github.com/glwhappen/pi-web-mcp && cd pi-web-mcp && npm ci
node src/index.js --status
```

Configure the connection (either environment variables or `~/.config/pi-web-mcp/config.json`):

```bash
export PI_WEB_URL=http://127.0.0.1:30141
export PI_WEB_PASSWORD=your-pi-web-password     # Basic Auth, username is always `pi`
```

Register it with your MCP client. For pi, `~/.pi/agent/mcp.json`:

```json
{
  "mcpServers": {
    "pi-web": {
      "command": "npx",
      "args": ["-y", "github:glwhappen/pi-web-mcp"],
      "env": { "PI_WEB_URL": "http://127.0.0.1:30141", "PI_WEB_PASSWORD": "…" },
      "exposure": "deferred",
      "toolExposure": {
        "piweb_triage": "direct",
        "piweb_list_unread": "direct",
        "piweb_list_sessions": "direct",
        "piweb_get_session": "direct",
        "piweb_search_sessions": "direct",
        "piweb_send_message": "direct"
      }
    }
  }
}
```

For Claude Desktop / Cursor / any other client, use the same `command` + `env` shape (see [HTTP mode](#http-mode-for-remote-ais) for remote clients).

## Tools

### Read

| Tool | What it does |
| --- | --- |
| `piweb_status` | Connectivity + config self-check (address, password source, read/write mode, session count) |
| `piweb_list_sessions` | List/filter sessions: `cwd`, `project`, `keyword`, `status`, `since`, `sort`, `limit` |
| `piweb_list_projects` | Aggregate by project directory: sessions, running, unread, last activity |
| `piweb_list_unread` | What needs attention: 🟠 awaiting input / 🔵 unread / 🟢 running |
| `piweb_triage` | **Classify every session**: ❓ probably asking me / ⚠️ stopped mid-turn / 💤 stalled / 🟢 running / 💬 waiting for my next step — with the evidence for each verdict |
| `piweb_search_sessions` | Literal full-text search across all transcripts (server-side 3s budget, may truncate) |
| `piweb_get_session` | Read a transcript; `offset` pages backwards, `include_thinking=none/preview/full` |
| `piweb_agent_state` | Global running snapshot, or one session's detail (streaming, queue, context usage) |
| `piweb_list_models` | Models available for a project, default model, thinking levels |
| `piweb_list_files` | List project files (git index first), fuzzy matched |
| `piweb_read_file` | Read a text file chunk (continue with `offset`) |
| `piweb_git_status` | Changed files + insertions/deletions |
| `piweb_git_diff` | Full patch for one file |
| `piweb_watch_session` | Watch what a session is producing right now (event stream) |

### Write

| Tool | What it does |
| --- | --- |
| `piweb_send_message` | Send a prompt; with `wait_seconds > 0`, wait for the turn and return the reply |
| `piweb_wait_for_reply` | Poll until the current turn finishes, return the last assistant reply |
| `piweb_create_session` | Create a session (optional first prompt, model, thinking level) |
| `piweb_fork_session` | Copy the current branch into a new session |
| `piweb_auto_name_session` | Let the model name a session |
| `piweb_set_model` | Switch a session's model |
| `piweb_abort_session` | Stop the current turn |
| `piweb_mark_read` | Update this server's read cursor (one/all, or mark unread again) |
| `piweb_rename_session` | Rename a session |
| `piweb_export_session` | Export the session as pi's single-file HTML |
| `piweb_delete_session` | Delete a session (needs `confirm=true`; subagent sessions go with it) |

The `session` argument accepts a full id, an id prefix, an exact name, or a fragment of the name/first message. An ambiguous match fails with the candidate list instead of guessing.

## Triage rules

`piweb_triage` runs no model — it is pure rules over the last message on the active branch, whether a tool call is still pending, and how long the session has been quiet. Fast, cheap, reproducible, and every verdict carries its evidence.

| Verdict | Evidence |
| --- | --- |
| 🟠 Awaiting input | Pi Web reports the session is blocked on an extension UI prompt |
| 🟢 Running | The session has a live agent process |
| ⚠️ Stopped mid-turn | Last entry is my message / a tool result / an unanswered tool call / an assistant message with no text |
| 💤 Stalled | Same as above, and the session has been idle for more than `stalled_hours` (default 6) |
| ❓ Probably asking me | Last assistant message contains a question mark |
| 💬 Waiting for my next step | The assistant finished its turn |
| ⚪️ Empty | No messages (excluded by default) |

## Read-cursor semantics

Pi Web keeps its "unread" markers in **browser localStorage**, which no server-side API exposes. This server therefore maintains its own cursor in `<config dir>/read-state.json` (the `modified` timestamp of each session you have read, guarded by a cross-process file lock). Reading a session via `piweb_get_session` / `piweb_wait_for_reply` updates it; `piweb_mark_read` manages it explicitly.

**Browser unread and MCP unread are two different sets** and do not affect each other.

## Configuration

Command line > environment > `~/.config/pi-web-mcp/config.json` > password files.

```json
{
  "baseUrl": "http://127.0.0.1:30141",
  "username": "pi",
  "password": "…",
  "timeoutMs": 30000,
  "httpToken": "…",
  "writeRoots": [],
  "tools": [],
  "http": { "host": "127.0.0.1", "port": 30142 }
}
```

| Key / env var | Meaning |
| --- | --- |
| `baseUrl` / `PI_WEB_URL` | Pi Web address, default `http://127.0.0.1:30141` |
| `password` / `PI_WEB_PASSWORD` | Pi Web password (Basic Auth, username is always `pi`) |
| `PI_WEB_USERNAME` | Override the Basic Auth username |
| `PI_WEB_PASSWORD_FILE` | Password file; otherwise `~/.config/pi-web-mcp/password`, then `~/pi-web.password` |
| `httpToken` / `PI_WEB_MCP_TOKEN` | Bearer token for HTTP mode. Required when binding a non-loopback host |
| `readonly` / `PI_WEB_MCP_READONLY=1` | Register read-only tools only (plus the local read cursor and `wait_for_reply`) |
| `writeRoots` | Array; when non-empty, write operations are only allowed for sessions inside these project roots |
| `tools` | Array; when non-empty, only these tools are registered |
| `http.host` / `http.port` | HTTP mode listen address, default `127.0.0.1:30142` |
| `PI_WEB_MCP_HOME` | Config directory, default `~/.config/pi-web-mcp` |

CLI flags: `--http`, `--host`, `--port`, `--http-token`, `--readonly`, `--write-root <dir>` (repeatable), `--tools a,b,c`, `--status`, `--version`, `--help`.

## HTTP mode (for remote AIs)

```bash
pi-web-mcp --http --host 172.17.0.1 --port 30142
```

The endpoint is `POST /mcp` (Streamable HTTP, stateless: one server instance per request, so several clients can connect concurrently). Clients authenticate with `Authorization: Bearer <httpToken>` or `X-Pi-Web-Mcp-Token`.

> Binding a non-loopback address **without** a token is refused at startup.

Client config for a remote endpoint:

```json
{
  "mcpServers": {
    "pi-web": {
      "url": "https://pi-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <httpToken>" }
    }
  }
}
```

A systemd unit example lives in [`deploy/pi-web-mcp.service.example`](./deploy/pi-web-mcp.service.example).

## Security model

This server can start agents that edit files and run commands, so treat it as a privileged interface:

- **Never expose HTTP mode without a token.** The server refuses to bind a non-loopback host without one.
- **`--readonly`** removes every tool that changes state (16 tools remain in read-only mode vs 25 in read-write mode).
- **`--write-root`** limits write operations to sessions inside given project roots — useful when several agents share the endpoint.
- Put HTTPS in front (a reverse proxy such as [nginx-proxy-manager](https://github.com/NginxProxyManager/nginx-proxy-manager)) before exposing it to the internet.
- Prefer stdio mode locally: nothing listens on a port, and the client controls the process lifetime.
- `piweb_delete_session` requires an explicit `confirm: true`.

## Development

```bash
git clone https://github.com/glwhappen/pi-web-mcp
cd pi-web-mcp
npm ci
npm test                       # unit tests against a mock pi-web (no real instance needed)
npm run smoke                  # read-only smoke test against a real pi-web
npm run smoke:write            # write path end-to-end (creates a session — spends model tokens)
```

Layout:

```
src/
  index.js          entry point: CLI flags, stdio/HTTP transports, graceful shutdown
  client.js         Pi Web HTTP client (Basic Auth, timeouts, retries, SSE subscription)
  config.js         config resolution (env > config.json > password files)
  guard.js          read/write boundaries (readonly, writeRoots)
  session-index.js  cached session list + id/name resolution
  read-state.js     read cursor (cross-process file lock)
  triage.js         session triage rules and rendering
  format.js         session/message → Markdown
  tools/            {index,shared,read,write}.js — the 25 tools
test/
  mock-piweb.mjs    fake Pi Web server
  server.test.mjs   unit tests
deploy/
  pi-web-mcp.service.example
```

The unit tests use a mock Pi Web, so they run anywhere — no pi installation required.

## Limitations

- Pi Web's unread markers are browser-local; this server keeps a separate cursor (see above).
- `piweb_search_sessions` is bounded by the server's 3-second search budget and can return `truncated`.
- `piweb_watch_session` starts the session's agent process if it is not running (the same thing opening the session in Pi Web does).
- `piweb_send_message` and `piweb_create_session` make a real agent do real work — check the session before sending.
- HTTP mode is stateless: no server-initiated notifications, no SSE-only features.

## License

MIT
