// 工具注册入口：只读模式会跳过所有会改变 pi-web 状态的工具。
import { registerReadTools } from "./read.js";
import { registerWriteTools } from "./write.js";

/** 只读模式下也不注册的额外工具（会拉起会话进程）。 */
const READONLY_EXTRA_HIDDEN = new Set(["piweb_watch_session"]);

export function registerTools(server, ctx) {
  const { guard, toolFilter } = ctx;
  const hidden = new Set();
  if (guard?.readonly) {
    for (const name of READONLY_EXTRA_HIDDEN) hidden.add(name);
    for (const name of guard.writeToolNames ?? []) hidden.add(name);
  }

  const target = (hidden.size === 0 && !toolFilter) ? server : {
    registerTool(name, config, callback) {
      if (hidden.has(name)) return undefined;
      if (toolFilter && !toolFilter(name)) return undefined;
      return server.registerTool(name, config, callback);
    },
  };

  registerReadTools(target, ctx);
  registerWriteTools(target, ctx);
}
