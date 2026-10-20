// 只读/可写边界的守卫：--readonly 与 write_roots 决定写操作能不能落到某个项目。
export class WriteDeniedError extends Error {
  constructor(message) {
    super(message);
    this.name = "WriteDeniedError";
  }
}

const WRITE_TOOLS = new Set([
  "piweb_send_message",
  "piweb_create_session",
  "piweb_abort_session",
  "piweb_fork_session",
  "piweb_auto_name_session",
  "piweb_rename_session",
  "piweb_delete_session",
  "piweb_set_model",
]);

function normalizeRoots(roots) {
  return (roots ?? [])
    .map((root) => String(root).trim().replace(/\/+$/, ""))
    .filter(Boolean);
}

export function createGuard({ readonly = false, writeRoots = [] } = {}) {
  const roots = normalizeRoots(writeRoots);
  return {
    readonly,
    writeRoots: roots,
    writeToolNames: [...WRITE_TOOLS],
    isWriteTool: (name) => WRITE_TOOLS.has(name),
    /** 写操作前调用；cwd 不在允许的项目根下就抛 WriteDeniedError。 */
    assertWritable(cwd, action) {
      if (readonly) {
        throw new WriteDeniedError(`只读模式：${action} 被拒绝（服务以 --readonly / readonly:true 启动）`);
      }
      if (!roots.length) return;
      const target = String(cwd ?? "").replace(/\/+$/, "");
      const allowed = roots.some((root) => target === root || target.startsWith(`${root}/`));
      if (!allowed) {
        throw new WriteDeniedError(
          `写操作被拒绝：${action} 的目标项目 ${target || "(未知)"} 不在允许写入的根目录里（write_roots: ${roots.join(", ")}）`,
        );
      }
    },
  };
}
