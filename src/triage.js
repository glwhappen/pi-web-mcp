// 会话分诊：不经过模型，纯靠「最后一条消息是谁 + 是否有悬挂的工具调用 + 多久没动」
// 把会话分成 需要我介入 / 半途停下 / 在跑 / 等我下一步。规则写死，结果可解释、可复现。
import { relTime } from "./format.js";

export const TRIAGE_STATES = {
  awaiting_input: { icon: "🟠", label: "等我回答", hint: "扩展 UI 弹窗挂着，不回答它跑不下去" },
  question: { icon: "❓", label: "可能在问我", hint: "最后一条助手消息带问号" },
  interrupted: { icon: "⚠️", label: "半途停下", hint: "最后一轮没有助手收尾" },
  stalled: { icon: "💤", label: "停滞", hint: "半途停下且很久没动" },
  running: { icon: "🟢", label: "在跑", hint: "正在执行，不用管" },
  waiting_me: { icon: "💬", label: "等我下一步", hint: "助手已收尾，球在我这" },
  empty: { icon: "⚪️", label: "空会话", hint: "没有任何消息" },
};

/** 分组顺序：越靠前越需要人管。 */
export const TRIAGE_ORDER = [
  "awaiting_input",
  "question",
  "interrupted",
  "stalled",
  "running",
  "waiting_me",
  "empty",
];

const QUESTION_PATTERN = /[?？]/;

function assistantText(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function pendingToolCalls(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  return blocks.filter((block) => block?.type === "toolCall").map((block) => block.toolName ?? "tool");
}

/**
 * 判定单个会话的状态。lastMessage 是该会话活跃分支上的最后一条消息。
 * stalledMs：半途停下超过这么久就升级为「停滞」。
 */
export function classifySession({ session, lastMessage, running = false, awaiting = false, now = Date.now(), stalledMs = 6 * 3600_000 }) {
  const base = { id: session.id, modified: session.modified, cwd: session.cwd, running, awaiting };

  if (!session.messageCount) return { ...base, state: "empty", reason: "会话里没有消息" };
  if (awaiting) return { ...base, state: "awaiting_input", reason: "pi-web 报告它正在等待输入（扩展 UI 弹窗）" };
  if (running) return { ...base, state: "running", reason: "进程在跑" };
  if (!lastMessage) return { ...base, state: "empty", reason: "读不到消息内容" };

  const role = lastMessage.role;
  if (role === "assistant") {
    const calls = pendingToolCalls(lastMessage);
    if (calls.length) {
      return { ...base, state: "interrupted", reason: `最后一条是工具调用（${calls.join("、")}），没等到结果` };
    }
    const text = assistantText(lastMessage);
    if (!text) return { ...base, state: "interrupted", reason: "最后一条助手消息没有文本输出" };
    if (QUESTION_PATTERN.test(text)) {
      return { ...base, state: "question", reason: "最后的助手回复里带问号，可能在等我拍板", excerpt: text.slice(-200) };
    }
    return {
      ...base,
      state: "waiting_me",
      reason: "助手已经收尾，球在我这边",
      excerpt: text.slice(-200),
    };
  }
  if (role === "user") {
    const state = now - Date.parse(session.modified ?? "") > stalledMs ? "stalled" : "interrupted";
    return { ...base, state, reason: "最后一条是我的消息，助手没有回复" };
  }
  if (role === "toolResult") {
    const state = now - Date.parse(session.modified ?? "") > stalledMs ? "stalled" : "interrupted";
    return { ...base, state, reason: "工具结果之后再没有后续输出" };
  }
  const state = now - Date.parse(session.modified ?? "") > stalledMs ? "stalled" : "interrupted";
  return { ...base, state, reason: `最后一条是 ${role ?? "未知类型"} 消息` };
}

export function countByState(judged) {
  const counts = new Map();
  for (const item of judged) counts.set(item.state, (counts.get(item.state) ?? 0) + 1);
  return counts;
}

function line(session, item, now) {
  const meta = TRIAGE_STATES[item.state];
  const name = session.name || (session.firstMessage ?? "").replace(/\s+/g, " ").slice(0, 60) || "(未命名)";
  const excerpt = item.excerpt ? `\n    ↳ …${item.excerpt.replace(/\s+/g, " ").slice(-160)}` : "";
  return `- ${relTime(session.modified, now)} ｜ \`${session.id}\` ｜ ${session.cwd} ｜ ${name}`
    + `\n    ↳ ${meta.icon} ${item.reason}${excerpt}`;
}

/** 把判定结果渲染成分组 Markdown。 */
export function renderTriage(items, { now = Date.now(), perGroup = 8, groups = TRIAGE_ORDER } = {}) {
  const buckets = new Map();
  for (const item of items) {
    if (!buckets.has(item.state)) buckets.set(item.state, []);
    buckets.get(item.state).push(item);
  }
  const total = items.length;
  const header = groups
    .filter((state) => buckets.has(state))
    .map((state) => `${TRIAGE_STATES[state].icon}${TRIAGE_STATES[state].label} ${buckets.get(state).length}`)
    .join(" ｜ ");

  const sections = [];
  for (const state of groups) {
    const list = buckets.get(state);
    if (!list) continue;
    const meta = TRIAGE_STATES[state];
    list.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
    const shown = list.slice(0, perGroup);
    sections.push(
      `## ${meta.icon} ${meta.label}（${list.length}）— ${meta.hint}\n`
      + shown.map((item) => line(item.session, item, now)).join("\n")
      + (list.length > shown.length ? `\n- …还有 ${list.length - shown.length} 个，缩小范围或加大 limit` : ""),
    );
  }
  return `分诊 ${total} 个会话：${header}\n\n${sections.join("\n\n")}\n`;
}
