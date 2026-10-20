// 把 pi-web 的会话数据渲染成给模型看的紧凑 Markdown。

export function truncate(value, limit) {
  const text = typeof value === "string" ? value : String(value ?? "");
  if (!Number.isFinite(limit) || limit <= 0 || text.length <= limit) return text;
  return `${text.slice(0, limit)}…（已截断，原 ${text.length} 字）`;
}

export function relTime(iso, now = Date.now()) {
  const ts = Date.parse(iso ?? "");
  if (!Number.isFinite(ts)) return "?";
  const diff = Math.max(0, now - ts);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (diff < minute) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / minute)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  if (diff < 30 * day) return `${Math.floor(diff / day)} 天前`;
  return iso.slice(0, 10);
}

/** 文本化 user/assistant/custom 消息的 content（字符串或 content block 数组）。 */
export function contentToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  const parts = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
    else if (block.type === "image") parts.push("[图片]");
    else if (block.type === "thinking" && typeof block.thinking === "string") parts.push(`[思考] ${block.thinking}`);
  }
  return parts.join("\n");
}

function toolCallSummary(block) {
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const first = Object.values(input).find((value) => typeof value === "string" && value.length > 0);
  return first ? ` ${truncate(String(first).replace(/\s+/g, " "), 120)}` : "";
}

function toolResultSummary(message) {
  const text = (message.content ?? [])
    .map((block) => (block && block.type === "text" ? block.text : block?.type === "image" ? "[图片]" : ""))
    .filter(Boolean)
    .join("\n");
  return text;
}

/**
 * 单条会话消息 → Markdown 片段。工具调用/结果默认折叠成一行，
 * includeTools 时保留完整结果文本（仍逐条截断）。
 */
export function messageToMarkdown(message, options = {}) {
  const {
    includeThinking = false,
    includeTools = true,
    maxChars = 4000,
    toolResultChars = 800,
  } = options;
  const role = message?.role ?? "unknown";
  const lines = [];

  if (role === "user") {
    lines.push("### 👤 用户", truncate(contentToText(message.content), maxChars));
  } else if (role === "assistant") {
    const blocks = Array.isArray(message.content) ? message.content : [];
    const chunks = [];
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") chunks.push(block.text);
      else if (block.type === "thinking" && includeThinking && typeof block.thinking === "string") {
        chunks.push(`> [思考] ${truncate(block.thinking.replace(/\s+/g, " "), 600)}`);
      } else if (block.type === "toolCall" && includeTools) {
        chunks.push(`⚙️ 调用工具 \`${block.toolName}\`${toolCallSummary(block)}`);
      }
    }
    lines.push("### 🤖 助手", chunks.length ? truncate(chunks.join("\n\n"), maxChars) : "(无文本输出)");
  } else if (role === "toolResult") {
    if (!includeTools) return "";
    const body = truncate(toolResultSummary(message).replace(/\s+/g, " "), toolResultChars);
    lines.push(`- ↩︎ \`${message.toolName ?? "tool"}\` ${message.isError ? "❌" : "✅"} ${body}`);
  } else if (role === "bashExecution") {
    lines.push(
      `### 💻 bash`,
      `$ ${truncate(message.command ?? "", 400)}`,
      truncate(String(message.output ?? "").trim(), toolResultChars),
    );
  } else if (role === "custom") {
    lines.push(`### ⚙️ ${message.customType ?? "custom"}`, truncate(contentToText(message.content), maxChars));
  } else {
    lines.push(`### ${role}`, truncate(JSON.stringify(message).slice(0, maxChars), maxChars));
  }

  const out = lines.filter((line) => line !== "").join("\n\n");
  return out ? `${out}\n` : "";
}

/** 整段对话 → Markdown，带总字数预算。 */
export function transcriptMarkdown(messages, options = {}) {
  const { totalChars = 60_000 } = options;
  const parts = [];
  let used = 0;
  let omitted = 0;
  for (const message of messages ?? []) {
    const rendered = messageToMarkdown(message, options);
    if (!rendered) continue;
    if (used + rendered.length > totalChars && parts.length > 0) {
      omitted = (messages ?? []).length - parts.length;
      break;
    }
    parts.push(rendered);
    used += rendered.length;
  }
  const body = parts.join("\n");
  return omitted > 0
    ? `${body}\n\n…（因字数预算省略了后面的 ${omitted} 条消息，可用 tail/limit 分段读取）\n`
    : body;
}

/** 会话一行摘要：时间、id、项目、名称/首条消息、状态。 */
export function sessionLine(session, flags = {}, now = Date.now()) {
  const tags = [];
  if (flags.running) tags.push("🟢运行中");
  if (flags.awaiting) tags.push("🟠等待输入");
  if (flags.unread) tags.push("🔵未读");
  if (session.relation?.kind === "subagent") tags.push("子会话");
  else if (session.relation?.kind === "fork") tags.push("分支");
  if (!session.messageCount) tags.push("空会话");
  const label = session.name || (session.firstMessage || "").replace(/\s+/g, " ").slice(0, 80) || "(无消息)";
  return `- ${relTime(session.modified, now)} ｜ \`${session.id}\` ｜ ${session.cwd} ｜ ${label}`
    + (tags.length ? ` ｜ ${tags.join(" ")}` : "")
    + ` ｜ ${session.messageCount} 条`;
}

export function sessionListMarkdown(sessions, flagsById = {}, { now = Date.now() } = {}) {
  if (!sessions.length) return "（没有匹配的会话）\n";
  return sessions.map((session) => sessionLine(session, flagsById.get(session.id) ?? {}, now)).join("\n") + "\n";
}
