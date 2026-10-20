// 手动验证写路径：新建会话 -> 等回复 -> 读会话 -> 重命名 -> 删除。
// 会真的调用模型，慎用。
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";

const cwd = process.env.PI_WEB_MCP_TEST_CWD || "/tmp/piweb-mcp-write-test";
fs.mkdirSync(cwd, { recursive: true });

const transport = new StdioClientTransport({ command: "node", args: [new URL("../src/index.js", import.meta.url).pathname], stderr: "inherit" });
const client = new Client({ name: "smoke-write", version: "0" });
await client.connect(transport);

async function call(name, args) {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).map((c) => c.text ?? "").join("\n");
  console.log(`\n===== ${name} ${JSON.stringify(args)} =====\n${text.slice(0, 2500)}\n[len=${text.length}${res.isError ? " ERROR" : ""}]`);
  return { text, isError: res.isError };
}

const created = await call("piweb_create_session", {
  cwd,
  message: "只回答两个字：收到。不要调用任何工具。",
  wait_seconds: 90,
});
const id = /创建会话 `([^`]+)`/.exec(created.text)?.[1];
if (!id) throw new Error("没能拿到 sessionId");

await call("piweb_get_session", { session: id, tail: 10 });
await call("piweb_agent_state", { session: id });
await call("piweb_rename_session", { session: id, name: "pi-web-mcp 冒烟测试" });
await call("piweb_mark_read", { session: id });
await call("piweb_list_sessions", { keyword: "冒烟测试", limit: 5 });
await call("piweb_delete_session", { session: id, confirm: true });

await client.close();
