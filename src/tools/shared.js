// 工具层公用：返回封装、筛选、等待逻辑。
import { PiWebError } from "../client.js";
import { isUnread } from "../read-state.js";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function text(value) {
  return { content: [{ type: "text", text: value }] };
}

export function failure(error) {
  const message = error instanceof PiWebError
    ? error.message
    : error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text", text: `❌ ${message}` }], isError: true };
}

export function parseSince(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const relative = /^(\d+)\s*(m|h|d|w)$/i.exec(raw);
  if (relative) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[relative[2].toLowerCase()];
    return Date.now() - Number(relative[1]) * unit;
  }
  const ts = Date.parse(raw);
  if (Number.isFinite(ts)) return ts;
  throw new PiWebError(`看不懂 since 参数：${raw}（用 30m / 24h / 7d / 2026-10-01 这类写法）`);
}

export function statusFlags(session, snapshot, readState) {
  return {
    running: snapshot.running.has(session.id),
    awaiting: snapshot.awaiting.has(session.id),
    unread: isUnread(readState, session),
  };
}

export function filterSessions(sessions, options, snapshot, readState) {
  const { cwd, project, keyword, status = "all", since, includeSubagents = false } = options ?? {};
  const sinceTs = parseSince(since);
  const needle = keyword ? String(keyword).toLowerCase() : null;

  return sessions.filter((session) => {
    if (session.transient) return false;
    if (!includeSubagents && session.relation?.kind === "subagent") return false;
    if (cwd) {
      const target = String(cwd).replace(/\/+$/, "");
      if (session.cwd !== target && !session.cwd.startsWith(`${target}/`)) return false;
    }
    if (project && session.projectKey !== project && session.projectRoot !== project) return false;
    if (sinceTs && Date.parse(session.modified ?? "") < sinceTs) return false;
    if (needle) {
      const haystack = `${session.name ?? ""}\n${session.firstMessage ?? ""}\n${session.cwd ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    if (status === "running" && !snapshot.running.has(session.id)) return false;
    if (status === "awaiting" && !snapshot.awaiting.has(session.id)) return false;
    if (status === "unread" && !isUnread(readState, session)) return false;
    return true;
  });
}

export function sortSessions(sessions, sort) {
  const sorted = sessions.slice();
  if (sort === "created") sorted.sort((a, b) => String(b.created).localeCompare(String(a.created)));
  else if (sort === "messages") sorted.sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0));
  else if (sort === "oldest") sorted.sort((a, b) => String(a.modified).localeCompare(String(b.modified)));
  else sorted.sort((a, b) => String(b.modified).localeCompare(String(a.modified)));
  return sorted;
}

/** 从后往前取「最后一条用户消息之后」的助手文本。 */
export function lastAssistantReply(messages) {
  const collected = [];
  for (let index = (messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") break;
    if (message?.role !== "assistant") continue;
    const blocks = Array.isArray(message.content) ? message.content : [];
    const texts = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text);
    if (texts.length) collected.unshift(texts.join("\n"));
  }
  return collected.join("\n\n");
}

export function busyState(state) {
  return Boolean(
    state?.isStreaming || state?.isPromptRunning || state?.isBashRunning
    || state?.isCompacting || (state?.pendingMessageCount ?? 0) > 0,
  );
}

/**
 * 等到会话这一轮跑完：先观察到忙碌，再观察到空闲；整轮太快没观察到忙碌时，
 * 连续空闲 minIdleMs 也算结束。等待输入（extension UI）时提前返回。
 */
export async function waitForIdle(client, id, { timeoutMs = 120_000, pollMs = 2000, minIdleMs = 4000 } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let sawBusy = false;
  let idleSince = null;

  while (Date.now() < deadline) {
    await sleep(pollMs);
    let snapshot = null;
    try {
      snapshot = await client.runningSnapshot();
    } catch {
      // 轮询快照失败不致命，继续看单会话状态。
    }
    if (snapshot?.awaitingInputSessionIds?.includes(id)) {
      return { status: "awaiting_input" };
    }
    let state = null;
    let alive = false;
    try {
      const result = await client.agentState(id);
      alive = Boolean(result?.running);
      state = result?.state ?? null;
    } catch {
      alive = false;
    }
    if (alive && busyState(state)) {
      sawBusy = true;
      idleSince = null;
      continue;
    }
    if (sawBusy) return { status: "done", state };
    idleSince ??= Date.now();
    if (Date.now() - idleSince >= minIdleMs) return { status: "done", state };
  }
  return { status: "timeout" };
}

export function statusBanner(status) {
  if (status === "timeout") return "⏳ 等待超时，这一轮可能还在跑；可稍后用 piweb_get_session 或 piweb_wait_for_reply 再取。";
  if (status === "awaiting_input") return "🟠 会话正在等待用户输入（扩展 UI 弹窗），需要人介入才能继续。";
  return null;
}

/** 有限并发地跑一批异步任务，返回与输入同序的结果（出错记为 { error }）。 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = { value: await worker(items[index], index) };
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(runners);
  return results;
}
