// Pi Web HTTP API 客户端：Basic Auth、超时、瞬时故障重试。
export class PiWebError extends Error {
  constructor(message, { status, body, retryable = false } = {}) {
    super(message);
    this.name = "PiWebError";
    this.status = status;
    this.body = body;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const RETRY_DELAYS_MS = [400, 1200];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class PiWebClient {
  constructor(config) {
    this.config = config;
  }

  authHeaders() {
    const { username, password } = this.config;
    if (!password) return {};
    return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
  }

  /** 单次请求：不重试，返回 { status, text }。 */
  async _once(url, { method, headers, body, timeoutMs }) {
    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(timeoutMs ?? this.config.timeoutMs),
    });
    const text = await response.text();
    return { response, text };
  }

  /**
   * 发请求并解析 JSON。网络抖动、429、5xx 会退避重试两次（GET 幂等，
   * POST 只在确定未到达服务端时重试——所以写操作默认不重试）。
   */
  async request(pathname, { method = "GET", body, timeoutMs, retry = method === "GET" || method === "HEAD", raw = false } = {}) {
    const url = `${this.config.baseUrl}${pathname}`;
    const headers = { accept: raw ? "*/*" : "application/json", ...this.authHeaders() };
    if (body !== undefined) headers["content-type"] = "application/json";
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let lastError;
    for (let attempt = 0; attempt <= (retry ? RETRY_DELAYS_MS.length : 0); attempt += 1) {
      if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt - 1]);
      let response;
      let text;
      try {
        ({ response, text } = await this._once(url, { method, headers, body: payload, timeoutMs }));
      } catch (error) {
        lastError = new PiWebError(
          `连不上 pi-web（${url}）：${error instanceof Error ? error.message : String(error)}。`
          + "确认服务在跑；地址可用 PI_WEB_URL 或 ~/.config/pi-web-mcp/config.json 的 baseUrl 覆盖。",
          { retryable: true },
        );
        continue;
      }

      if (response.status === 401 || response.status === 403) {
        const message = response.status === 401
          ? "pi-web 需要密码：设置环境变量 PI_WEB_PASSWORD，或把密码写进 ~/.config/pi-web-mcp/config.json 的 password 字段（也可放 ~/.config/pi-web-mcp/password 文件）。"
          : "pi-web 拒绝了这个请求（403）：请求的 Host/Origin 不受信任。若经域名访问，需把域名加进 pi-web 的 PI_WEB_ALLOWED_HOSTS。";
        throw new PiWebError(message, { status: response.status });
      }

      if (!response.ok) {
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        const message = data && typeof data.error === "string"
          ? data.error
          : `HTTP ${response.status} ${text.slice(0, 300)}`;
        const retryable = RETRYABLE_STATUS.has(response.status);
        lastError = new PiWebError(message, { status: response.status, body: data, retryable });
        if (retryable && attempt < RETRY_DELAYS_MS.length) continue;
        throw lastError;
      }

      if (raw) return { text, status: response.status, headers: response.headers };
      if (!text) return null;
      try {
        return JSON.parse(text);
      } catch {
        throw new PiWebError(`pi-web 返回了非 JSON 内容（${pathname}）：${text.slice(0, 200)}`);
      }
    }
    throw lastError;
  }

  // ---------------------------------------------------------------- 会话

  /** 全部会话 + 运行态快照（pi-web 侧有缓存，通常 <300ms）。 */
  listSessions({ force = false } = {}) {
    return this.request(`/api/sessions${force ? "?force=1" : ""}`, { timeoutMs: 60_000 });
  }

  /** 轻量快照：只含运行中/等待输入等 id 列表。 */
  runningSnapshot() {
    return this.request("/api/agent/running");
  }

  /** 会话全文搜索（服务端有 3s 时间预算，可能 truncated）。 */
  search(query) {
    return this.request(`/api/sessions/search?q=${encodeURIComponent(query)}`, { timeoutMs: 60_000 });
  }

  /** 单个会话的完整快照：info / tree / context.messages / stats。 */
  getSession(id, { tail, deferThinking = false } = {}) {
    const params = new URLSearchParams();
    if (Number.isFinite(tail) && tail > 0) params.set("tail", String(Math.min(tail, 1000)));
    if (deferThinking) params.set("deferThinking", "1");
    const query = params.size ? `?${params}` : "";
    return this.request(`/api/sessions/${encodeURIComponent(id)}${query}`, { timeoutMs: 60_000 });
  }

  /** 只取会话上下文（可分段：before=已加载的最旧 entry id，向前翻页）。 */
  getContext(id, { tail = 30, before, deferThinking = false } = {}) {
    const params = new URLSearchParams({ tail: String(Math.min(Math.max(tail, 1), 1000)) });
    if (before) params.set("before", before);
    if (deferThinking) params.set("deferThinking", "1");
    return this.request(`/api/sessions/${encodeURIComponent(id)}/context?${params}`, { timeoutMs: 60_000 });
  }

  /** 思考块全文（历史 thinking 只存预览，按 entryId + blockIndex 取原文）。 */
  getThinking(id, entryId, blockIndex) {
    return this.request(
      `/api/sessions/${encodeURIComponent(id)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
    );
  }

  /** 运行中会话的状态；未运行的会话返回 { running: false }。 */
  agentState(id) {
    return this.request(`/api/agent/${encodeURIComponent(id)}`);
  }

  /** 向已有会话发命令（prompt / steer / abort / set_model / compact ...）。 */
  sendCommand(id, command) {
    return this.request(`/api/agent/${encodeURIComponent(id)}`, {
      method: "POST",
      body: command,
      timeoutMs: 120_000,
    });
  }

  /** 新建会话（type:"prompt" 时顺带发首条消息）。 */
  newSession(payload) {
    return this.request("/api/agent/new", { method: "POST", body: payload, timeoutMs: 180_000 });
  }

  renameSession(id, name) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "PATCH", body: { name } });
  }

  deleteSession(id) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE", timeoutMs: 60_000 });
  }

  /** 从会话当前分支复制出一个新会话。 */
  forkSession(id) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/fork`, { method: "POST", body: {}, timeoutMs: 120_000 });
  }

  /** 让 pi 用模型生成会话名并落盘。 */
  autoNameSession(id) {
    return this.request(`/api/sessions/${encodeURIComponent(id)}/auto-name`, { method: "POST", body: {}, timeoutMs: 180_000 });
  }

  /** 导出会话为 pi 官方 HTML（单文件）。 */
  async exportSession(id) {
    const { text } = await this.request(`/api/sessions/${encodeURIComponent(id)}/export?inline=1`, {
      raw: true,
      timeoutMs: 120_000,
    });
    return text;
  }

  // ---------------------------------------------------------------- 其它

  /** 当前可用模型清单（按 cwd 解析项目/全局设置）。 */
  listModels(cwd) {
    return this.request(`/api/models?cwd=${encodeURIComponent(cwd)}`, { timeoutMs: 60_000 });
  }

  /** 目录下的文件索引（git ls-files 优先），可带 ?q= 做模糊匹配。 */
  listFiles(cwd, query) {
    const params = new URLSearchParams({ cwd });
    if (query) params.set("q", query);
    return this.request(`/api/file-index?${params}`, { timeoutMs: 60_000 });
  }

  /** 读文本文件（服务端按块返回：offset/内容/大小/语言）。 */
  readFile(absPath, { offset = 0, sessionId } = {}) {
    const segments = absPath.split("/").filter(Boolean).map(encodeURIComponent).join("/");
    const params = new URLSearchParams({ type: "read" });
    if (offset) params.set("offset", String(offset));
    if (sessionId) params.set("sessionId", sessionId);
    return this.request(`/api/files/${segments}?${params}`, { timeoutMs: 60_000 });
  }

  gitStatus(cwd) {
    return this.request(`/api/git/status?cwd=${encodeURIComponent(cwd)}`);
  }

  gitDiff(cwd, absPath) {
    return this.request(`/api/git/diff?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(absPath)}`, { timeoutMs: 60_000 });
  }

  /**
   * 订阅会话事件流（SSE），在 seconds 内收集事件。
   * 回调 onEvent(event) 收到每条 JSON 事件；返回时给出收集到的事件数组。
   */
  async watchEvents(id, { seconds = 30, onEvent, signal } = {}) {
    const url = `${this.config.baseUrl}/api/agent/${encodeURIComponent(id)}/events`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), seconds * 1000);
    const composite = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const events = [];
    try {
      const response = await fetch(url, {
        headers: { accept: "text/event-stream", ...this.authHeaders() },
        signal: composite,
      });
      if (!response.ok || !response.body) {
        throw new PiWebError(`事件流连接失败：HTTP ${response.status}`);
      }
      const decoder = new TextDecoder();
      let buffer = "";
      for await (const chunk of response.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLines = frame.split("\n").filter((line) => line.startsWith("data:"));
          if (!dataLines.length) continue;
          const payload = dataLines.map((line) => line.slice(5).trim()).join("\n");
          let event;
          try {
            event = JSON.parse(payload);
          } catch {
            continue;
          }
          events.push(event);
          if (onEvent) onEvent(event);
        }
      }
    } catch (error) {
      if (error?.name !== "AbortError" && error?.name !== "TimeoutError") throw error;
    } finally {
      clearTimeout(timer);
    }
    return events;
  }
}
