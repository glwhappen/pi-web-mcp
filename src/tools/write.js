// 写工具：发消息、新建/分支/重命名/删除会话、中断、切模型、已读游标。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { PiWebError } from "../client.js";
import { WriteDeniedError } from "../guard.js";
import { truncate } from "../format.js";
import { markRead, updateReadState } from "../read-state.js";
import {
  failure,
  lastAssistantReply,
  statusBanner,
  text,
  waitForIdle,
} from "./shared.js";

export function registerWriteTools(server, { client, index, getReadState, guard }) {
  const assertWritable = (cwd, action) => {
    try {
      guard.assertWritable(cwd, action);
    } catch (error) {
      if (error instanceof WriteDeniedError) throw new PiWebError(error.message);
      throw error;
    }
  };

  async function resolveWritable(ref, action) {
    const snapshot = await index.load();
    const session = await index.resolve(ref, { data: snapshot });
    assertWritable(session.cwd, action);
    return { snapshot, session };
  }

  function rememberRead(session, modified) {
    return updateReadState((state) => markRead(state, { ...session, modified: modified ?? session.modified }));
  }

  // ------------------------------------------------------------ 发消息
  server.registerTool("piweb_send_message", {
    title: "给会话发消息",
    description:
      "向一个已有会话发送提示词（等价于在 pi-web 输入框里发消息），让它继续干活。"
      + "会话没在运行时 pi-web 会自动把它拉起来。默认发完就返回；wait_seconds>0 时会等这一轮跑完并带回最后的助手回复。"
      + "注意：这会让对方 agent 真正执行操作（改文件、跑命令），发之前确认会话选对了。",
    inputSchema: {
      session: z.string().describe("会话 id / id 前缀 / 名称"),
      message: z.string().min(1).describe("要发送的提示词正文"),
      wait_seconds: z.number().int().min(0).max(900).optional().describe("等待这一轮结束的秒数，0=不等待（默认），建议 120~300"),
      streaming_behavior: z.enum(["steer", "followUp"]).optional().describe("会话正在流式输出时：steer=插话纠正，followUp=排队等它说完；不传则由 pi-web 决定"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "发消息");
      const payload = {
        type: "prompt",
        message: args.message,
        ...(args.streaming_behavior ? { streamingBehavior: args.streaming_behavior } : {}),
      };
      const result = await client.sendCommand(session.id, payload);
      index.invalidate();
      const lines = [`✅ 已投递给会话 \`${session.id}\`（${session.cwd}），提示词长度 ${args.message.length} 字。`];

      const waitSeconds = args.wait_seconds ?? 0;
      if (waitSeconds > 0) {
        const status = await waitForIdle(client, session.id, { timeoutMs: waitSeconds * 1000 });
        const banner = statusBanner(status.status);
        if (banner) lines.push(banner);
        const detail = await client.getSession(session.id, { tail: 40 }).catch(() => null);
        const reply = lastAssistantReply(detail?.context?.messages ?? []);
        lines.push(reply ? `\n## 回复\n\n${truncate(reply, 20_000)}` : "\n（这一轮没有产生新的助手文本）");
        rememberRead(session, detail?.info?.modified);
      } else {
        lines.push("提示：要拿回复用 piweb_wait_for_reply，或稍后 piweb_get_session 读最近消息；想看它正在输出什么用 piweb_watch_session。");
      }
      const data = result?.data;
      if (data && typeof data === "object" && data.promptRunId) lines.push(`promptRunId: ${data.promptRunId}`);
      return text(lines.join("\n"));
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 等回复
  server.registerTool("piweb_wait_for_reply", {
    title: "等待会话这一轮结束并取回复",
    description: "轮询某个会话，等它这一轮跑完（不再流式输出），然后返回最后的助手回复文本。适合先 piweb_send_message 不等、之后再来收结果。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      timeout_seconds: z.number().int().min(5).max(1800).optional().describe("最长等待秒数，默认 180"),
      poll_seconds: z.number().int().min(1).max(30).optional().describe("轮询间隔，默认 3"),
      max_chars: z.number().int().min(200).max(100_000).optional().describe("回复文本截断长度，默认 20000"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const { snapshot, session } = await (async () => {
        const snap = await index.load();
        return { snapshot: snap, session: await index.resolve(args.session, { data: snap }) };
      })();
      const status = await waitForIdle(client, session.id, {
        timeoutMs: (args.timeout_seconds ?? 180) * 1000,
        pollMs: (args.poll_seconds ?? 3) * 1000,
      });
      const detail = await client.getSession(session.id, { tail: 40 }).catch(() => null);
      const reply = lastAssistantReply(detail?.context?.messages ?? []);
      rememberRead(session, detail?.info?.modified ?? snapshot.byId.get(session.id)?.modified);
      return text(
        `会话 \`${session.id}\`：${status.status === "done" ? "这一轮已结束" : statusBanner(status.status) ?? status.status}\n\n`
        + (reply ? `## 回复\n\n${truncate(reply, args.max_chars ?? 20_000)}` : "（没有找到助手文本回复）"),
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 新会话
  server.registerTool("piweb_create_session", {
    title: "新建会话并可选发首条消息",
    description:
      "在指定项目目录下新建一个 pi 会话（返回真实 sessionId）。带 message 时把它作为首条提示词发出去；"
      + "不带 message 时只创建运行时（ensure_session）。可选指定 provider/modelId/thinking_level，模型取值用 piweb_list_models 查。",
    inputSchema: {
      cwd: z.string().describe("项目目录的绝对路径，必须已存在"),
      message: z.string().optional().describe("首条提示词；省略则只创建会话不发送"),
      provider: z.string().optional().describe("模型 provider（与 model_id 一起给）"),
      model_id: z.string().optional().describe("模型 id（与 provider 一起给）"),
      thinking_level: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("思考等级"),
      wait_seconds: z.number().int().min(0).max(900).optional().describe("发首条消息后等待完成的秒数，0=不等待（默认）"),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true, idempotentHint: false },
  }, async (args) => {
    try {
      assertWritable(args.cwd, "新建会话");
      if ((args.provider && !args.model_id) || (!args.provider && args.model_id)) {
        throw new PiWebError("provider 和 model_id 必须一起给");
      }
      const payload = {
        cwd: args.cwd,
        type: args.message ? "prompt" : "ensure_session",
        ...(args.message ? { message: args.message } : {}),
        ...(args.provider ? { provider: args.provider, modelId: args.model_id } : {}),
        ...(args.thinking_level ? { thinkingLevel: args.thinking_level } : {}),
      };
      const result = await client.newSession(payload);
      const id = result?.sessionId ?? "?";
      index.invalidate();
      const lines = [
        `✅ 已在 ${args.cwd} 创建会话 \`${id}\``,
        result?.model ? `- 模型：${result.model.provider}/${result.model.modelId}` : null,
        result?.thinkingLevel ? `- 思考等级：${result.thinkingLevel}` : null,
        args.message ? `- 已投递首条提示词（${args.message.length} 字）` : "- 未发送消息（仅创建运行时）",
      ].filter(Boolean);
      if (args.message && (args.wait_seconds ?? 0) > 0) {
        const status = await waitForIdle(client, id, { timeoutMs: (args.wait_seconds ?? 0) * 1000 });
        const banner = statusBanner(status.status);
        if (banner) lines.push(banner);
        const detail = await client.getSession(id, { tail: 40 }).catch(() => null);
        const reply = lastAssistantReply(detail?.context?.messages ?? []);
        lines.push(reply ? `\n## 回复\n\n${truncate(reply, 20_000)}` : "\n（还没有助手回复）");
      }
      return text(lines.join("\n"));
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 中断
  server.registerTool("piweb_abort_session", {
    title: "中断会话当前这一轮",
    description: "给正在运行的会话发 abort，停掉它当前这一轮（等价于界面上的 Stop）。",
    inputSchema: { session: z.string().describe("会话 id / 名称") },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "中断会话");
      await client.sendCommand(session.id, { type: "abort" });
      index.invalidate();
      return text(`⏹ 已向会话 \`${session.id}\` 发送中断。用 piweb_agent_state 可确认是否已停止。`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 分支
  server.registerTool("piweb_fork_session", {
    title: "从会话当前分支复制出新会话",
    description: "把会话当前分支整体复制成一个新会话（等价于侧边栏的 Fork）。原会话不受影响。用来「从这条线另开一条道」。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      name: z.string().optional().describe("顺手给新会话起个名字"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "分支会话");
      const result = await client.forkSession(session.id);
      const newId = result?.sessionId;
      if (!newId) throw new PiWebError("分支创建失败：pi-web 没有返回新会话 id");
      index.invalidate();
      if (args.name) await client.renameSession(newId, args.name).catch(() => {});
      return text(
        `🌱 已从 \`${session.id}\` 分支出新会话 \`${newId}\``
        + (args.name ? `（名称「${args.name}」）` : "")
        + `\n- 目录：${session.cwd}\n继续干活用 piweb_send_message 指向这个新 id。`,
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 自动命名
  server.registerTool("piweb_auto_name_session", {
    title: "让模型给会话起名",
    description: "调用 pi 的标题生成，让模型根据对话内容给会话起一个名字并落盘（等价于侧边栏的自动命名）。要花一次模型调用。",
    inputSchema: { session: z.string().describe("会话 id / 名称") },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "自动命名");
      const result = await client.autoNameSession(session.id);
      index.invalidate();
      return text(`🏷 会话 \`${session.id}\` 已自动命名为「${result?.title ?? "?"}」。`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 切模型
  server.registerTool("piweb_set_model", {
    title: "给会话换模型",
    description: "切换某个会话接下来使用的模型（等价于界面上的模型选择）。会话没在运行时会被拉起来。取值先用 piweb_list_models 查。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      provider: z.string().describe("模型 provider，如 new-api-half / opencode / deepseek"),
      model_id: z.string().describe("模型 id，如 deepseek-flash"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "切换模型");
      await client.sendCommand(session.id, { type: "set_model", provider: args.provider, modelId: args.model_id });
      return text(`🔧 会话 \`${session.id}\` 已切到 ${args.provider}/${args.model_id}（下一轮生效）。`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 已读游标
  server.registerTool("piweb_mark_read", {
    title: "标记会话已读/未读",
    description:
      "更新本 MCP 的已读游标：session 给了就标记该会话，省略则把当前所有未读会话一次性标记为已读；"
      + "unread=true 则反过来清掉游标，让它重新算未读。只影响本 MCP 的游标，不碰浏览器里的未读标记。",
    inputSchema: {
      session: z.string().optional().describe("会话 id / 名称；省略=对当前所有未读会话生效"),
      unread: z.boolean().optional().describe("true=标记为未读（清除游标），默认 false"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const snapshot = await index.load();
      if (args.session) {
        const session = await index.resolve(args.session, { data: snapshot });
        const result = updateReadState((state) => {
          if (args.unread) delete state.sessions[session.id];
          else markRead(state, session);
          return { count: Object.keys(state.sessions).length };
        });
        return text(`${args.unread ? "🔵 已标记为未读" : "✅ 已标记为已读"}：\`${session.id}\`（游标共 ${result.count} 个）`);
      }
      if (args.unread) {
        const result = updateReadState((state) => {
          for (const session of snapshot.sessions) delete state.sessions[session.id];
          return { count: 0 };
        });
        return text(`🔵 已清空已读游标（剩 ${result.count} 个），所有有消息的会话重新算未读。`);
      }
      const readState = getReadState();
      const unread = snapshot.sessions.filter((session) => {
        if (session.transient || !session.messageCount) return false;
        const seen = readState.sessions[session.id];
        return !seen || !seen.seenModified || String(session.modified) > String(seen.seenModified);
      });
      updateReadState((state) => {
        for (const session of unread) markRead(state, session);
      });
      return text(`✅ 已把 ${unread.length} 个未读会话全部标记为已读。`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 重命名
  server.registerTool("piweb_rename_session", {
    title: "重命名会话",
    description: "给会话改名字（等价于 pi-web 侧边栏的重命名）。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      name: z.string().min(1).describe("新名称"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveWritable(args.session, "重命名");
      await client.renameSession(session.id, args.name);
      index.invalidate();
      return text(`✏️ 会话 \`${session.id}\` 已重命名为「${args.name}」。`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 导出
  server.registerTool("piweb_export_session", {
    title: "导出会话为 HTML",
    description: "把会话导出成 pi 官方单文件 HTML（可离线翻阅/分享），写到本地磁盘并返回路径。大会话导出要几秒。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      out_path: z.string().optional().describe("输出文件绝对路径；默认 <系统临时目录>/pi-web-export/<会话id>.html"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveSessionById(index, args.session);
      const html = await client.exportSession(session.id);
      const outPath = args.out_path || path.join(os.tmpdir(), "pi-web-export", `${session.id}.html`);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, html);
      return text(`📄 已导出会话 \`${session.id}\`（${(html.length / 1024).toFixed(0)} KB）\n- 文件：${outPath}`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 删除
  server.registerTool("piweb_delete_session", {
    title: "删除会话",
    description: "删除会话（会连同它下面的子代理会话一起删掉，不可恢复）。必须显式传 confirm=true 才会执行。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      confirm: z.boolean().optional().describe("确认删除：必须显式传 true，否则拒绝执行"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      if (args.confirm !== true) throw new PiWebError("删除需要显式传 confirm=true");
      const { session } = await resolveWritable(args.session, "删除会话");
      await client.deleteSession(session.id);
      index.invalidate();
      updateReadState((state) => {
        delete state.sessions[session.id];
      });
      return text(`🗑 已删除会话 \`${session.id}\`（${session.cwd}）。`);
    } catch (error) {
      return failure(error);
    }
  });

  async function resolveSessionById(store, ref) {
    const snapshot = await store.load();
    return { snapshot, session: await store.resolve(ref, { data: snapshot }) };
  }
}
