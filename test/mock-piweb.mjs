// 假 pi-web：模仿本 MCP 用到的那批端点，供单元测试跑，不需要真的 pi-web。
import http from "node:http";

const SESSIONS = [
  {
    id: "a1", cwd: "/proj/alpha", projectKey: "/proj/alpha", projectRoot: "/proj/alpha",
    name: "改登录页", firstMessage: "帮我把登录页改一下", messageCount: 12,
    created: "2026-10-19T01:00:00.000Z", modified: "2026-10-20T02:00:00.000Z",
  },
  {
    id: "a2", cwd: "/proj/alpha", projectKey: "/proj/alpha", projectRoot: "/proj/alpha",
    firstMessage: "检查一下部署脚本有没有 bug", messageCount: 4,
    created: "2026-10-18T01:00:00.000Z", modified: "2026-10-19T02:00:00.000Z",
  },
  {
    id: "b1", cwd: "/proj/beta", projectKey: "/proj/beta", projectRoot: "/proj/beta",
    name: "另一个项目", firstMessage: "写个爬虫", messageCount: 30,
    created: "2026-10-10T01:00:00.000Z", modified: "2026-10-11T02:00:00.000Z",
  },
  {
    id: "c1", cwd: "/proj/beta", firstMessage: "", messageCount: 0,
    created: "2026-10-20T01:00:00.000Z", modified: "2026-10-20T01:00:00.000Z",
  },
];

// 每个会话活跃分支上的最后一条消息，决定分诊结果。
const LAST_MESSAGES = {
  a1: { role: "assistant", content: [{ type: "text", text: "要我先做第 1 项吗？" }] },
  a2: { role: "toolResult", content: [{ type: "text", text: "ok" }] },
  b1: { role: "assistant", content: [{ type: "toolCall", toolCallId: "t1", toolName: "bash", input: {} }] },
};

function nowMinus(minutes) {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

export async function startMockPiWeb({ failTimes = 0, requireAuth = true, running = ["a1"], awaiting = [] } = {}) {
  const state = {
    requests: [],
    prompts: [],
    failuresLeft: failTimes,
    renamed: new Map(),
    deleted: new Set(),
    running: new Set(running),
    awaiting: new Set(awaiting),
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    state.requests.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });

    const json = (status, payload) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (requireAuth && !req.headers.authorization) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    if (state.failuresLeft > 0) {
      state.failuresLeft -= 1;
      json(503, { error: "temporarily unavailable" });
      return;
    }

    const path = url.pathname;
    const bodyPromise = new Promise((resolve) => {
      let raw = "";
      req.on("data", (chunk) => { raw += chunk; });
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve({});
        }
      });
    });

    void bodyPromise.then((body) => {
      if (path === "/api/sessions") {
        json(200, {
          sessions: SESSIONS.filter((session) => !state.deleted.has(session.id))
            .map((session) => ({ ...session, ...(state.renamed.has(session.id) ? { name: state.renamed.get(session.id) } : {}) })),
          sessionListVersion: 1,
          runningSessionIds: [...state.running],
          awaitingInputSessionIds: [...state.awaiting],
          completionNotificationSuppressedSessionIds: [],
        });
        return;
      }
      if (path === "/api/agent/running") {
        json(200, { sessionListVersion: 1, runningSessionIds: [...state.running], awaitingInputSessionIds: [...state.awaiting] });
        return;
      }
      if (path === "/api/sessions/search") {
        json(200, { results: [{ session: SESSIONS[0], entryId: "e1", blockIndex: 0, before: "…", match: "登录", after: "…" }], truncated: false });
        return;
      }
      const contextMatch = /^\/api\/sessions\/([^/]+)\/context$/.exec(path);
      if (contextMatch) {
        const id = contextMatch[1];
        json(200, { context: { messages: LAST_MESSAGES[id] ? [LAST_MESSAGES[id]] : [], entryIds: ["e1"], hasMore: false, turnsBefore: 0 }, tail: 1, before: null });
        return;
      }
      const detailMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
      if (detailMatch && req.method === "GET") {
        const id = detailMatch[1];
        const session = SESSIONS.find((item) => item.id === id);
        if (!session) {
          json(404, { error: "Session not found" });
          return;
        }
        const messages = [
          { role: "user", content: "帮我把登录页改一下" },
          {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "先看代码…", deferred: true },
              { type: "toolCall", toolCallId: "t1", toolName: "read", input: { path: "/proj/alpha/login.tsx" } },
              { type: "text", text: "改好了。" },
            ],
          },
          { role: "toolResult", toolName: "read", isError: false, content: [{ type: "text", text: "文件内容" }] },
        ];
        json(200, {
          sessionId: id,
          filePath: `/tmp/${id}.jsonl`,
          info: { ...session, path: `/tmp/${id}.jsonl`, modified: nowMinus(30) },
          leafId: "e3",
          tree: [],
          snapshotRevision: "r1",
          context: {
            messages,
            entryIds: ["e1", "e2", "e3"],
            hasMore: true,
            turnsBefore: 3,
            thinkingLevel: "low",
            model: { provider: "mock", modelId: "mock-1" },
          },
          stats: { userMessages: 1, assistantMessages: 1, toolCalls: 1, toolResults: 1, totalMessages: 3 },
          totalActiveMs: 1000,
        });
        return;
      }
      if (detailMatch && req.method === "PATCH") {
        state.renamed.set(detailMatch[1], body.name);
        json(200, { ok: true });
        return;
      }
      if (detailMatch && req.method === "DELETE") {
        state.deleted.add(detailMatch[1]);
        json(200, { ok: true });
        return;
      }
      const thinkingMatch = /^\/api\/sessions\/([^/]+)\/entries\/([^/]+)\/thinking$/.exec(path);
      if (thinkingMatch) {
        json(200, { thinking: "完整的思考内容" });
        return;
      }
      const forkMatch = /^\/api\/sessions\/([^/]+)\/fork$/.exec(path);
      if (forkMatch) {
        state.renamed.set("forked", undefined);
        json(200, { sessionId: "forked", session: { ...SESSIONS[0], id: "forked", name: "改登录页 (fork)" } });
        return;
      }
      const autoNameMatch = /^\/api\/sessions\/([^/]+)\/auto-name$/.exec(path);
      if (autoNameMatch) {
        state.renamed.set(autoNameMatch[1], "自动起的名字");
        json(200, { title: "自动起的名字", usage: null });
        return;
      }
      const exportMatch = /^\/api\/sessions\/([^/]+)\/export$/.exec(path);
      if (exportMatch) {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>exported</html>");
        return;
      }
      const agentMatch = /^\/api\/agent\/([^/]+)$/.exec(path);
      if (agentMatch && req.method === "GET") {
        const id = agentMatch[1];
        if (!state.running.has(id)) {
          json(200, { running: false });
          return;
        }
        json(200, { running: true, state: { isStreaming: false, isPromptRunning: false, isBashRunning: false, isCompacting: false, pendingMessageCount: 0, model: { provider: "mock", id: "mock-1" }, thinkingLevel: "low", contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 }, sessionFile: `/tmp/${id}.jsonl` } });
        return;
      }
      if (agentMatch && req.method === "POST") {
        state.prompts.push({ id: agentMatch[1], command: body });
        state.running.add(agentMatch[1]);
        if (body.type === "prompt") {
          // 立刻结束这一轮：waitForIdle 会走「连续空闲」兜底。
          setTimeout(() => state.running.delete(agentMatch[1]), 200);
        }
        json(200, { success: true, data: { promptRunId: "run-1" } });
        return;
      }
      if (path === "/api/agent/new") {
        state.prompts.push({ id: "new", command: body });
        json(200, { success: true, sessionId: "new-session", data: null, model: { provider: "mock", modelId: "mock-1" }, thinkingLevel: "low" });
        return;
      }
      const eventsMatch = /^\/api\/agent\/([^/]+)\/events$/.exec(path);
      if (eventsMatch) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(`data: ${JSON.stringify({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "你好" } })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "tool_execution_start", toolName: "read" })}\n\n`);
        setTimeout(() => res.end(), 300);
        return;
      }
      if (path === "/api/models") {
        json(200, {
          models: { "mock:mock-1": "Mock One", "other:two": "Mock Two" },
          modelList: [{ id: "mock-1", name: "Mock One", provider: "mock", input: ["text"] }],
          defaultModel: { provider: "mock", modelId: "mock-1" },
          defaultThinkingLevel: "low",
          thinkingLevels: { "mock:mock-1": ["off", "low"] },
        });
        return;
      }
      if (path === "/api/file-index") {
        json(200, url.searchParams.get("q")
          ? { matches: [{ path: "src/login.tsx", score: 10 }] }
          : { files: ["src/login.tsx", "README.md"], truncated: false });
        return;
      }
      if (path.startsWith("/api/files/")) {
        json(200, { content: "export const a = 1;\n", nextOffset: 19, truncated: false, language: "typescript", size: 19 });
        return;
      }
      if (path === "/api/git/status") {
        json(200, { isGitRepository: true, repositoryRoot: "/proj/alpha", files: [{ filePath: "src/login.tsx", status: "modified", code: "M", indexStatus: " ", worktreeStatus: "M" }], additions: 3, deletions: 1 });
        return;
      }
      if (path === "/api/git/diff") {
        json(200, { supported: true, status: "modified", patch: "--- a\n+++ b\n@@\n-old\n+new\n" });
        return;
      }
      json(404, { error: `mock 没实现：${req.method} ${path}` });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
