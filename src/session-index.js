// 会话索引：带短 TTL 缓存的会话列表 + id/名称解析。
import { PiWebError } from "./client.js";

export class SessionIndex {
  constructor(client, { ttlMs = 5000 } = {}) {
    this.client = client;
    this.ttlMs = ttlMs;
    this.snapshot = null;
    this.loadedAt = 0;
  }

  /** 写操作后让下一次读取重新拉取会话列表。 */
  invalidate() {
    this.snapshot = null;
    this.loadedAt = 0;
  }

  async load({ force = false } = {}) {
    if (!force && this.snapshot && Date.now() - this.loadedAt < this.ttlMs) return this.snapshot;
    const data = await this.client.listSessions({ force });
    const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
    this.snapshot = {
      sessions,
      byId: new Map(sessions.map((session) => [session.id, session])),
      running: new Set(data?.runningSessionIds ?? []),
      awaiting: new Set(data?.awaitingInputSessionIds ?? []),
      listVersion: data?.sessionListVersion ?? null,
    };
    this.loadedAt = Date.now();
    return this.snapshot;
  }

  /**
   * 把用户给的引用解析成会话。支持：完整 id、id 前缀、精确名称、名称/首条消息包含。
   * 命中多个时抛错并附候选，避免猜错会话。
   */
  async resolve(ref, { data = null } = {}) {
    const needle = String(ref ?? "").trim();
    if (!needle) throw new PiWebError("session 参数不能为空");
    const snapshot = data ?? await this.load();
    const sessions = snapshot.sessions;

    const exactId = snapshot.byId.get(needle);
    if (exactId) return exactId;

    const prefix = sessions.filter((session) => session.id.startsWith(needle));
    if (prefix.length === 1) return prefix[0];
    if (prefix.length > 1) throw new PiWebError(ambiguous(needle, prefix));

    const lower = needle.toLowerCase();
    const byName = sessions.filter((session) => (session.name ?? "").toLowerCase() === lower);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) throw new PiWebError(ambiguous(needle, byName));

    const contains = sessions.filter((session) =>
      (session.name ?? "").toLowerCase().includes(lower)
      || (session.firstMessage ?? "").toLowerCase().includes(lower));
    if (contains.length === 1) return contains[0];
    if (contains.length > 1) throw new PiWebError(ambiguous(needle, contains));
    throw new PiWebError(`找不到会话：${needle}。可用 piweb_list_sessions 先查 id/名称。`);
  }
}

function ambiguous(needle, candidates) {
  const shown = candidates
    .slice()
    .sort((a, b) => String(b.modified).localeCompare(String(a.modified)))
    .slice(0, 10)
    .map((session) => `${session.id} ｜ ${session.cwd} ｜ ${session.name || (session.firstMessage ?? "").slice(0, 40)}`)
    .join("\n");
  return `"${needle}" 匹配到 ${candidates.length} 个会话，请用完整 id 指定：\n${shown}`;
}
