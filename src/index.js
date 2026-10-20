#!/usr/bin/env node
// pi-web-mcp：把 Pi Web 的 HTTP API 包成 MCP 服务。
// 默认 stdio（给 pi / Claude Desktop 这类本机客户端用）；
// 加 --http 时用 Streamable HTTP 暴露（端点 /mcp），方便远端 AI 直接接入。
import http from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { PiWebClient } from "./client.js";
import { describeConfig, loadConfig } from "./config.js";
import { createGuard } from "./guard.js";
import { loadReadState } from "./read-state.js";
import { SessionIndex } from "./session-index.js";
import { registerTools } from "./tools/index.js";

const VERSION = "1.1.0";

const HELP = `pi-web-mcp ${VERSION} — 把 Pi Web 的 HTTP API 包成 MCP 服务

用法:
  pi-web-mcp                 # stdio 模式（MCP 客户端自己拉起，默认）
  pi-web-mcp --http          # Streamable HTTP 模式，默认监听 127.0.0.1:30142
  pi-web-mcp --http --host 0.0.0.0 --port 8080 --http-token <token>
  pi-web-mcp --readonly      # 只注册只读工具（不给任何 AI 改会话状态的能力）
  pi-web-mcp --write-root ~/projects --write-root /srv/code   # 只允许对这两个目录下的会话写操作
  pi-web-mcp --tools piweb_list_unread,piweb_get_session        # 只暴露指定工具
  pi-web-mcp --status        # 打印配置并试连一次 pi-web，然后退出
  pi-web-mcp --help

配置（命令行 > 环境变量 > ~/.config/pi-web-mcp/config.json）:
  PI_WEB_URL            pi-web 地址，默认 http://127.0.0.1:30141
  PI_WEB_PASSWORD       pi-web 密码（Basic Auth 用户名固定 pi，可用 PI_WEB_USERNAME 改）
  PI_WEB_PASSWORD_FILE  密码文件；默认还会尝试 ~/.config/pi-web-mcp/password、~/pi-web.password
  PI_WEB_MCP_HOME       配置目录，默认 ~/.config/pi-web-mcp
  PI_WEB_MCP_TOKEN      HTTP 模式的 Bearer token（非本机监听时必须提供）
  PI_WEB_MCP_READONLY=1 等同 --readonly

环境与安全:
  HTTP 模式绑非本机地址时必须配置 token，否则拒绝启动。
  客户端可用 Authorization: Bearer <token> 或 X-Pi-Web-Mcp-Token 头。

退出码:
  0 正常；1 启动失败或 --status 连不上 pi-web；2 参数错误
`;

function parseArgs(argv) {
  const options = {
    http: false,
    host: null,
    port: null,
    help: false,
    status: false,
    version: false,
    httpToken: null,
    readonly: false,
    writeRoots: [],
    tools: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const [flag, inlineValue] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, null];
    const value = () => (inlineValue !== null ? inlineValue : argv[++index]);
    if (flag === "--help" || flag === "-h") options.help = true;
    else if (flag === "--version" || flag === "-v") options.version = true;
    else if (flag === "--status") options.status = true;
    else if (flag === "--http") options.http = true;
    else if (flag === "--readonly") options.readonly = true;
    else if (flag === "--port" || flag === "-p") options.port = Number(value());
    else if (flag === "--host" || flag === "-H") options.host = value();
    else if (flag === "--http-token") options.httpToken = value();
    else if (flag === "--write-root") options.writeRoots.push(value());
    else if (flag === "--tools") options.tools = String(value()).split(",").map((name) => name.trim()).filter(Boolean);
    else {
      process.stderr.write(`未知参数：${arg}\n\n${HELP}`);
      process.exit(2);
    }
  }
  if (options.port !== null && (!Number.isInteger(options.port) || options.port <= 0 || options.port > 65535)) {
    process.stderr.write(`端口不合法：${options.port}\n`);
    process.exit(2);
  }
  return options;
}

function buildContext({ config, guard, toolFilter }) {
  const client = new PiWebClient(config);
  const index = new SessionIndex(client);
  return {
    client,
    index,
    guard,
    toolFilter,
    getReadState: () => loadReadState(),
  };
}

function buildServer(context) {
  const server = new McpServer(
    { name: "pi-web", version: VERSION, title: "Pi Web 会话管家" },
    {
      instructions:
        "通过 pi-web 的 HTTP API 查看、筛选、分诊、读取 pi 会话，以及给会话发消息、新建/分支/中断会话。"
        + "会话内容用 piweb_get_session 读，全文检索用 piweb_search_sessions，"
        + "「谁在等我 / 谁半途死了」用 piweb_triage，看项目改动用 piweb_git_status。",
    },
  );
  registerTools(server, context);
  return server;
}

function isLoopback(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function tokenFromRequest(req) {
  const header = req.headers.authorization;
  if (typeof header === "string" && /^Bearer\s+/i.test(header)) return header.replace(/^Bearer\s+/i, "").trim();
  const alt = req.headers["x-pi-web-mcp-token"];
  if (typeof alt === "string") return alt.trim();
  try {
    return new URL(req.url ?? "/", "http://localhost").searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const config = loadConfig();
  if (options.host) config.http.host = options.host;
  if (options.port) config.http.port = options.port;
  if (options.httpToken) config.httpToken = options.httpToken;

  const guard = createGuard({
    readonly: options.readonly || config.readonly,
    writeRoots: options.writeRoots.length ? options.writeRoots : config.writeRoots,
  });
  const toolFilter = options.tools ? new Set(options.tools) : (config.tools.length ? new Set(config.tools) : null);
  const context = buildContext({
    config,
    guard,
    toolFilter: toolFilter ? (name) => toolFilter.has(name) : null,
  });

  if (options.status) {
    const summary = describeConfig(config);
    try {
      const data = await context.client.listSessions();
      process.stdout.write(`✅ 连上 pi-web\n${JSON.stringify({
        ...summary,
        guard: { readonly: guard.readonly, writeRoots: guard.writeRoots },
        sessions: data?.sessions?.length ?? 0,
        runningSessionIds: data?.runningSessionIds ?? [],
        awaitingInputSessionIds: data?.awaitingInputSessionIds ?? [],
      }, null, 2)}\n`);
    } catch (error) {
      process.stderr.write("❌ 连不上 pi-web\n");
      process.stderr.write(`${JSON.stringify(summary, null, 2)}\n`);
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    }
    return;
  }

  if (!options.http) {
    const server = buildServer(context);
    await server.connect(new StdioServerTransport());
    return;
  }

  // HTTP 模式：对外必须带 token；非本机监听时没有 token 直接拒绝启动。
  const { host, port } = config.http;
  const token = config.httpToken;
  if (!isLoopback(host) && !token) {
    process.stderr.write(
      `拒绝启动：HTTP 模式要绑 ${host}（非本机），但没有配置 token。\n`
      + "请在 ~/.config/pi-web-mcp/config.json 里加 \"httpToken\": \"…\"，或用 --http-token / PI_WEB_MCP_TOKEN 提供。\n",
    );
    process.exit(1);
  }

  // 无状态模式：每个请求一套 server+transport，多客户端可并发接入。
  const httpServer = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (!req.url || !req.url.startsWith("/mcp")) {
      send(404, { error: "Not found. MCP endpoint is /mcp" });
      return;
    }
    if (token && tokenFromRequest(req) !== token) {
      res.writeHead(401, { "content-type": "application/json", "www-authenticate": "Bearer" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const server = buildServer(context);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      process.stderr.write(`[pi-web-mcp] 请求处理失败：${error}\n`);
      if (!res.headersSent) send(500, { error: "Internal server error" });
    }
  });

  httpServer.listen(port, host, () => {
    process.stderr.write(
      `[pi-web-mcp] HTTP MCP 已启动：http://${host}:${port}/mcp`
      + `（pi-web: ${config.baseUrl}｜${guard.readonly ? "只读" : "可写"}`
      + `${guard.writeRoots.length ? `，写限制在 ${guard.writeRoots.join(", ")}` : ""}｜token ${token ? "已启用" : "未启用"}）\n`,
    );
  });

  const shutdown = () => {
    httpServer.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((error) => {
  process.stderr.write(`[pi-web-mcp] 启动失败：${error instanceof Error ? error.stack : String(error)}\n`);
  process.exit(1);
});
