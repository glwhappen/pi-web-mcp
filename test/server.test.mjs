// 单元测试：用一个假 pi-web 跑通「列会话 / 分诊 / 读会话 / 写操作 / 只读模式 / 重试」。
// 用法: node --test test/
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockPiWeb } from "./mock-piweb.mjs";

const SERVER = path.join(import.meta.dirname, "..", "src", "index.js");

async function withServer({ mock, args = [], env = {} } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mcp-test-"));
  // HOME 也指到临时目录：否则会读到开发机上的 ~/pi-web.password，
  // 测试就在「本机通过、CI 失败」之间飘（CI 第一次跑就抓到了这个）。
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mcp-home-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER, ...args],
    env: {
      ...process.env,
      HOME: fakeHome,
      PI_WEB_URL: mock.url,
      PI_WEB_MCP_HOME: home,
      PI_WEB_PASSWORD: "test-password",
      ...env,
    },
    stderr: "ignore",
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  const call = async (name, args2) => {
    const result = await client.callTool({ name, arguments: args2 });
    const body = (result.content ?? []).map((part) => part.text ?? "").join("\n");
    return { text: body, isError: Boolean(result.isError) };
  };
  return { client, call, home };
}

test("列出工具、读会话列表与筛选", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock });
  t.after(() => client.close());

  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  assert.ok(names.includes("piweb_list_sessions"));
  assert.ok(names.includes("piweb_triage"));
  assert.ok(names.includes("piweb_send_message"));
  assert.equal(names.length, 25, `工具数应为 25，实际 ${names.length}`);

  const all = await call("piweb_list_sessions", { limit: 10 });
  assert.match(all.text, /共匹配 3 个会话/);
  assert.match(all.text, /改登录页/);

  const scoped = await call("piweb_list_sessions", { cwd: "/proj/beta" });
  assert.match(scoped.text, /共匹配 1 个会话/);
  const withEmpty = await call("piweb_list_sessions", { cwd: "/proj/beta", include_empty: true });
  assert.match(withEmpty.text, /共匹配 2 个会话/);
  assert.match(scoped.text, /另一个项目/);

  const keyword = await call("piweb_list_sessions", { keyword: "爬虫" });
  assert.match(keyword.text, /共匹配 1 个会话/);
});

test("分诊把会话分成 可能在问我 / 半途停下 / 在跑", async (t) => {
  const mock = await startMockPiWeb({ running: [] });
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock });
  t.after(() => client.close());

  // stalled_hours 调大，避免「半途停下」被升级成「停滞」
  const result = await call("piweb_triage", { limit: 10, stalled_hours: 700, since: "all" });
  assert.ok(!result.isError, result.text);
  assert.match(result.text, /❓ 可能在问我/);
  assert.match(result.text, /`a1`/);
  assert.match(result.text, /⚠️ 半途停下/);
  assert.match(result.text, /`a2`/);
  assert.match(result.text, /`b1`/, "最后一条是悬挂的工具调用，应判为半途停下");
  // 空会话默认不出现在分诊结果里
  assert.ok(!result.text.includes("`c1`"));
});

test("读会话：渲染消息、补齐思考全文、更新已读游标", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());
  const { client, call, home } = await withServer({ mock });
  t.after(() => client.close());

  const preview = await call("piweb_get_session", { session: "改登录页", tail: 10, include_thinking: "preview" });
  assert.match(preview.text, /👤 用户/);
  assert.match(preview.text, /帮我把登录页改一下/);
  assert.match(preview.text, /调用工具/);
  assert.match(preview.text, /改好了。/);
  assert.match(preview.text, /思考内容为预览/);

  const full = await call("piweb_get_session", { session: "a1", tail: 10, include_thinking: "full", mark_read: false });
  assert.match(full.text, /完整的思考内容/);
  assert.match(full.text, /已补齐 1 段完整思考/);

  const cursor = JSON.parse(fs.readFileSync(path.join(home, "read-state.json"), "utf8"));
  assert.ok(cursor.sessions.a1, "读过的会话应写进已读游标");
});

test("写路径：发消息带 guard，只读模式与 write_roots 会拒绝", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());

  const writable = await withServer({ mock, env: { PI_WEB_MCP_READONLY: "0" } });
  t.after(() => writable.client.close());
  const sent = await writable.call("piweb_send_message", { session: "a1", message: "继续" });
  assert.ok(!sent.isError, sent.text);
  assert.match(sent.text, /已投递/);
  assert.equal(mock.state.prompts.at(-1).command.type, "prompt");
  assert.equal(mock.state.prompts.at(-1).command.message, "继续");

  // write_roots 只允许 /proj/alpha，b1 在 /proj/beta 应被拒
  const rootHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-mcp-root-"));
  fs.writeFileSync(path.join(rootHome, "config.json"), JSON.stringify({ writeRoots: ["/proj/alpha"], readonly: false }));
  const guarded = await withServer({ mock, env: { PI_WEB_MCP_HOME: rootHome } });
  t.after(() => guarded.client.close());
  const denied = await guarded.call("piweb_send_message", { session: "b1", message: "越界" });
  assert.ok(denied.isError);
  assert.match(denied.text, /不在允许写入的根目录/);
  const allowed = await guarded.call("piweb_send_message", { session: "a1", message: "允许" });
  assert.ok(!allowed.isError, allowed.text);

  // 只读模式：写工具不注册
  const readonly = await withServer({ mock, args: ["--readonly"] });
  t.after(() => readonly.client.close());
  const toolNames = (await readonly.client.listTools()).tools.map((tool) => tool.name);
  assert.ok(!toolNames.includes("piweb_send_message"));
  assert.ok(!toolNames.includes("piweb_delete_session"));
  assert.ok(toolNames.includes("piweb_get_session"));
  assert.ok(toolNames.includes("piweb_mark_read"), "只读模式仍应保留本地的已读游标工具");
});

test("--tools 白名单只注册指定工具", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());
  const { client } = await withServer({ mock, args: ["--tools", "piweb_status,piweb_triage"] });
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["piweb_status", "piweb_triage"]);
});

test("5xx 自动重试后成功", async (t) => {
  const mock = await startMockPiWeb({ failTimes: 2 });
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock });
  t.after(() => client.close());
  const result = await call("piweb_status", {});
  assert.ok(!result.isError, result.text);
  assert.match(result.text, /连上 pi-web/);
  const failures = mock.state.requests.length;
  assert.ok(failures >= 3, `应至少重试两次，实际发了 ${failures} 个请求`);
});

test("git / 文件 / 模型 / 实时流等工具都能返回", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock });
  t.after(() => client.close());

  assert.match((await call("piweb_git_status", { cwd: "/proj/alpha" })).text, /src\/login\.tsx/);
  assert.match((await call("piweb_git_diff", { cwd: "/proj/alpha", path: "/proj/alpha/src/login.tsx" })).text, /\+new/);
  assert.match((await call("piweb_list_files", { cwd: "/proj/alpha", filter: "login" })).text, /src\/login\.tsx/);
  assert.match((await call("piweb_read_file", { path: "/proj/alpha/src/login.tsx" })).text, /export const a = 1/);
  assert.match((await call("piweb_list_models", { cwd: "/proj/alpha" })).text, /mock:mock-1/);

  const watched = await call("piweb_watch_session", { session: "a1", seconds: 3 });
  assert.ok(!watched.isError, watched.text);
  assert.match(watched.text, /你好/);
  assert.match(watched.text, /read/);
});

test("pi-web 需要密码而没配时给出可操作的报错", async (t) => {
  const mock = await startMockPiWeb({ requireAuth: true });
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock, env: { PI_WEB_PASSWORD: "" } });
  t.after(() => client.close());
  const result = await call("piweb_status", {});
  assert.ok(result.isError, result.text);
  assert.match(result.text, /需要密码/);
  assert.match(result.text, /PI_WEB_PASSWORD/);
});

test("重命名与删除走 guard，并写入假 pi-web", async (t) => {
  const mock = await startMockPiWeb();
  t.after(() => mock.close());
  const { client, call } = await withServer({ mock });
  t.after(() => client.close());

  assert.match((await call("piweb_rename_session", { session: "a1", name: "新名字" })).text, /新名字/);
  assert.equal(mock.state.renamed.get("a1"), "新名字");

  const refused = await call("piweb_delete_session", { session: "b1" });
  assert.ok(refused.isError);
  assert.match(refused.text, /confirm=true/);
  assert.match((await call("piweb_delete_session", { session: "b1", confirm: true })).text, /已删除/);
  assert.ok(mock.state.deleted.has("b1"));
});
