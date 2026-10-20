// 只读冒烟：确认所有读工具能正常返回（不会改动任何会话状态）。
// 用法: node test/manual-smoke.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({
  command: "node",
  args: [new URL("../src/index.js", import.meta.url).pathname],
  stderr: "inherit",
});
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const tools = await client.listTools();
console.log(`TOOLS(${tools.tools.length}):`, tools.tools.map((tool) => tool.name).join(", "));

const results = [];
async function call(name, args, { max = 1200 } = {}) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const body = (res.content ?? []).map((part) => part.text ?? "").join("\n");
  const ms = Date.now() - started;
  results.push({ name, ms, len: body.length, error: Boolean(res.isError) });
  console.log(`\n===== ${name} ${JSON.stringify(args)} [${ms}ms, ${body.length}字${res.isError ? ", ERROR" : ""}] =====`);
  console.log(body.slice(0, max));
  if (body.length > max) console.log(`...[截断，共 ${body.length} 字]`);
  return body;
}

await call("piweb_status", {});
await call("piweb_list_sessions", { limit: 3 });
await call("piweb_list_projects", { limit: 3 });
await call("piweb_list_unread", { limit: 3 });
await call("piweb_triage", { limit: 12, per_group: 2 });
await call("piweb_search_sessions", { query: "MCP", limit: 2 });
await call("piweb_agent_state", {});
await call("piweb_list_models", { filter: "deepseek", limit: 10 });

const list = JSON.parse((await call("piweb_list_sessions", { limit: 1 }, { max: 400 })).match(/共匹配[\s\S]*/)?.[0] ? "{}" : "{}");
const firstId = /`([0-9a-f-]{36})`/.exec((await call("piweb_list_sessions", { limit: 1 }, { max: 400 })))[1];
await call("piweb_get_session", { session: firstId, tail: 3, include_thinking: "preview", mark_read: false }, { max: 1000 });

const repo = process.env.PI_WEB_REPO || process.cwd();
await call("piweb_list_files", { cwd: repo, filter: "route.ts", limit: 5 });
await call("piweb_git_status", { cwd: repo });
await call("piweb_read_file", { path: `${repo}/package.json`, max_chars: 400 });
await call("piweb_git_diff", { cwd: repo, path: `${repo}/package.json`, max_chars: 500 });
await call("piweb_watch_session", { session: firstId, seconds: 6 });

console.log("\n===== 汇总 =====");
for (const item of results) console.log(`${item.error ? "❌" : "✅"} ${item.name.padEnd(26)} ${String(item.ms).padStart(6)}ms  ${item.len} 字`);

await client.close();
