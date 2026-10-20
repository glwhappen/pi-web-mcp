// MCP 侧的「已读游标」。pi-web 自身的未读标记存在浏览器 localStorage，
// 服务端读不到，所以这里维护一份独立的游标：读过的会话记下当时的 modified 时间。
import fs from "node:fs";
import path from "node:path";
import { statePath } from "./config.js";

const MAX_ENTRIES = 5000;
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 3000;
const lockPath = `${statePath}.lock`;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadReadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.sessions && typeof parsed.sessions === "object") {
      return { version: 1, sessions: parsed.sessions };
    }
  } catch {
    // 文件不存在或损坏：从空状态开始。
  }
  return { version: 1, sessions: {} };
}

export function saveReadState(state) {
  const entries = Object.entries(state.sessions ?? {});
  if (entries.length > MAX_ENTRIES) {
    entries.sort((a, b) => String(b[1]?.seenAt ?? "").localeCompare(String(a[1]?.seenAt ?? "")));
    state.sessions = Object.fromEntries(entries.slice(0, MAX_ENTRIES));
  }
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temp = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(temp, statePath);
}

/** 用 .lock 文件做跨进程互斥（多个 pi/Claude 客户端可能各起一个 MCP 进程）。 */
function withLock(fn) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_MS;
  let descriptor = null;
  for (;;) {
    try {
      descriptor = fs.openSync(lockPath, "wx");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      // 崩溃残留的锁：按 mtime 判过期后抢过来，避免永久卡死。
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        // 锁文件刚被释放，下一轮重试即可。
      }
      if (Date.now() > deadline) throw new Error("已读游标正被另一个进程占用，请稍后重试");
      sleepSync(40);
    }
  }
  try {
    return fn();
  } finally {
    try {
      fs.closeSync(descriptor);
    } catch {
      // ignore
    }
    fs.rmSync(lockPath, { force: true });
  }
}

/** 读-改-写整段加锁，返回 mutator 的结果。 */
export function updateReadState(mutator) {
  return withLock(() => {
    const state = loadReadState();
    const result = mutator(state);
    saveReadState(state);
    return result;
  });
}

export function markRead(state, session) {
  state.sessions[session.id] = {
    seenModified: session.modified ?? null,
    seenAt: new Date().toISOString(),
    name: session.name ?? null,
    cwd: session.cwd ?? null,
  };
}

/** 未读 = 有消息、非临时会话，且本地游标缺失或落后于会话的 modified。 */
export function isUnread(state, session) {
  if (session.transient || !session.messageCount) return false;
  const seen = state.sessions[session.id];
  if (!seen) return true;
  if (!seen.seenModified || !session.modified) return true;
  return String(session.modified) > String(seen.seenModified);
}
