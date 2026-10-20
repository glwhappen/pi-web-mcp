// 读工具：列会话、筛会话、分诊、读内容、看文件与 git、看运行状态。
import { z } from "zod";
import { PiWebError } from "../client.js";
import { describeConfig } from "../config.js";
import { relTime, sessionListMarkdown, transcriptMarkdown, truncate } from "../format.js";
import { isUnread, markRead, updateReadState } from "../read-state.js";
import { TRIAGE_ORDER, classifySession, renderTriage } from "../triage.js";
import {
  failure,
  filterSessions,
  mapLimit,
  sortSessions,
  statusFlags,
  text,
} from "./shared.js";

/** 会话列表的一行摘要，供多个工具复用。 */
function flagsMap(sessions, snapshot, readState) {
  return new Map(sessions.map((session) => [session.id, statusFlags(session, snapshot, readState)]));
}

async function resolveSession(index, ref) {
  const snapshot = await index.load();
  return { snapshot, session: await index.resolve(ref, { data: snapshot }) };
}

export function registerReadTools(server, { client, index, getReadState, guard }) {
  // ------------------------------------------------------------ 自检
  server.registerTool("piweb_status", {
    title: "pi-web 连接自检",
    description: "检查 MCP 到 pi-web 的连接配置是否正常：地址、密码来源、会话总数、运行中的会话、读写边界（是否只读、允许写入的项目根）。连不上时先用这个排查。",
    inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => {
    try {
      const data = await client.listSessions();
      const sessions = data?.sessions ?? [];
      const readState = getReadState();
      return text(
        `✅ 连上 pi-web。\n\`\`\`json\n${JSON.stringify({
          ...describeConfig(client.config),
          guard: guard ? { readonly: guard.readonly, writeRoots: guard.writeRoots } : null,
          sessions: sessions.length,
          unread: sessions.filter((session) => isUnread(readState, session)).length,
          running: data?.runningSessionIds ?? [],
          awaitingInput: data?.awaitingInputSessionIds ?? [],
        }, null, 2)}\n\`\`\``,
      );
    } catch (error) {
      return failure(new PiWebError(
        `连不上 pi-web。\n${JSON.stringify(describeConfig(client.config), null, 2)}\n原因：${error instanceof Error ? error.message : String(error)}`,
      ));
    }
  });

  // ------------------------------------------------------------ 列会话
  server.registerTool("piweb_list_sessions", {
    title: "列出 pi-web 会话",
    description:
      "列出/筛选 pi-web 里的 pi 会话（按项目目录、关键词、状态、时间过滤）。"
      + "status: all|running|awaiting|unread，unread 用的是本 MCP 自己的已读游标（与浏览器里的未读标记不共享）。"
      + "keyword 只匹配会话名称/首条消息/目录，全文检索用 piweb_search_sessions，想要「哪些会话在等我」用 piweb_triage。",
    inputSchema: {
      cwd: z.string().optional().describe("按项目目录过滤，子目录也算（前缀匹配）"),
      project: z.string().optional().describe("按 projectKey/projectRoot 精确过滤"),
      keyword: z.string().optional().describe("匹配会话名称、首条消息、目录"),
      status: z.enum(["all", "running", "awaiting", "unread"]).optional().describe("状态过滤，默认 all"),
      include_empty: z.boolean().optional().describe("是否包含一条消息都没有的空会话，默认 false"),
      since: z.string().optional().describe("只看该时间之后有更新的，如 30m、24h、7d、2026-10-01"),
      sort: z.enum(["recent", "oldest", "created", "messages"]).optional().describe("排序，默认 recent"),
      limit: z.number().int().min(1).max(300).optional().describe("返回条数上限，默认 20"),
      include_subagents: z.boolean().optional().describe("是否包含子代理会话，默认 false"),
      force: z.boolean().optional().describe("绕过 pi-web 的会话列表缓存重新扫描"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const snapshot = await index.load({ force: Boolean(args.force) });
      const readState = getReadState();
      const matched = filterSessions(snapshot.sessions, args, snapshot, readState)
        .filter((session) => args.include_empty === true || session.messageCount > 0);
      const limit = args.limit ?? 20;
      const shown = sortSessions(matched, args.sort).slice(0, limit);
      const unreadTotal = snapshot.sessions.filter((session) => isUnread(readState, session)).length;
      return text(
        `共匹配 ${matched.length} 个会话${matched.length > shown.length ? `，显示最近 ${shown.length} 个` : ""}`
        + `（全部 ${snapshot.sessions.length}，运行中 ${snapshot.running.size}，等待输入 ${snapshot.awaiting.size}，本 MCP 未读 ${unreadTotal}）\n\n`
        + sessionListMarkdown(shown, flagsMap(shown, snapshot, readState)),
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 项目聚合
  server.registerTool("piweb_list_projects", {
    title: "按项目聚合会话",
    description: "按项目目录聚合 pi-web 会话：每个目录有多少会话、几个在跑、几个未读、最近活动时间。用来先看「我的活儿都压在哪个目录」。",
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe("返回项目数上限，默认 30"),
      min_sessions: z.number().int().min(1).optional().describe("只显示会话数不少于该值的项目，默认 1"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const snapshot = await index.load();
      const readState = getReadState();
      const groups = new Map();
      for (const session of snapshot.sessions) {
        if (session.transient) continue;
        const key = session.projectKey ?? session.cwd ?? "?";
        const group = groups.get(key) ?? {
          key,
          cwd: session.projectRoot ?? session.cwd,
          sessions: 0,
          running: 0,
          awaiting: 0,
          unread: 0,
          lastModified: session.modified,
        };
        group.sessions += 1;
        if (snapshot.running.has(session.id)) group.running += 1;
        if (snapshot.awaiting.has(session.id)) group.awaiting += 1;
        if (isUnread(readState, session)) group.unread += 1;
        if (String(session.modified) > String(group.lastModified)) group.lastModified = session.modified;
        groups.set(key, group);
      }
      const list = [...groups.values()]
        .filter((group) => group.sessions >= (args.min_sessions ?? 1))
        .sort((a, b) => String(b.lastModified).localeCompare(String(a.lastModified)))
        .slice(0, args.limit ?? 30);
      if (!list.length) return text("（没有项目）");
      const lines = list.map((group) =>
        `- ${relTime(group.lastModified)} ｜ \`${group.cwd}\` ｜ 会话 ${group.sessions}`
        + (group.running ? ` ｜ 🟢运行 ${group.running}` : "")
        + (group.awaiting ? ` ｜ 🟠待输入 ${group.awaiting}` : "")
        + (group.unread ? ` ｜ 🔵未读 ${group.unread}` : ""));
      return text(`共 ${groups.size} 个项目，显示 ${list.length} 个：\n${lines.join("\n")}\n`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 未读清单
  server.registerTool("piweb_list_unread", {
    title: "未读/待介入的会话",
    description:
      "一次列出需要我关注的会话：🟠 正在等待用户输入的、🔵 本 MCP 上次读过之后又有新内容的、🟢 正在跑但我没看过的。"
      + "注意：未读用的是本 MCP 的已读游标（用 piweb_get_session 或 piweb_mark_read 更新），与浏览器 localStorage 里的未读标记是两套。"
      + "想按「对话结局」判断谁在等我，用 piweb_triage。",
    inputSchema: {
      limit: z.number().int().min(1).max(100).optional().describe("每类最多显示多少条，默认 20"),
      since: z.string().optional().describe("只看该时间之后更新的，如 7d"),
      cwd: z.string().optional().describe("只看某个项目目录（前缀匹配）"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const snapshot = await index.load();
      const readState = getReadState();
      const pool = filterSessions(snapshot.sessions, {
        cwd: args.cwd,
        since: args.since,
        includeSubagents: false,
      }, { running: new Set(), awaiting: new Set() }, readState);
      const limit = args.limit ?? 20;
      const sort = (list) => sortSessions(list, "recent");

      const awaiting = sort(pool.filter((session) => snapshot.awaiting.has(session.id)));
      const running = sort(pool.filter((session) =>
        snapshot.running.has(session.id) && !snapshot.awaiting.has(session.id)));
      const unread = sort(pool.filter((session) =>
        isUnread(readState, session)
        && !snapshot.awaiting.has(session.id)
        && !snapshot.running.has(session.id)));

      const section = (title, list) => {
        if (!list.length) return `${title}：无\n`;
        return `${title}：${list.length} 个\n${sessionListMarkdown(list.slice(0, limit), flagsMap(list.slice(0, limit), snapshot, readState))}`;
      };

      return text(
        `已读游标共记录 ${Object.keys(readState.sessions).length} 个会话；未读 ${unread.length} 个，等待输入 ${awaiting.length} 个，进行中 ${running.length} 个。\n\n`
        + section("🟠 等待我输入", awaiting)
        + "\n"
        + section("🔵 有更新未读", unread)
        + "\n"
        + section("🟢 正在运行", running),
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 分诊
  server.registerTool("piweb_triage", {
    title: "会话分诊（谁在等我 / 谁半途死了）",
    description:
      "不经过模型，纯按「最后一条消息是谁 + 是否有悬挂的工具调用 + 多久没动」把会话分诊成："
      + "🟠等我回答（扩展弹窗）、❓可能在问我（最后一条助手消息带问号）、⚠️半途停下（最后一轮没有助手收尾）、"
      + "💤停滞（半途停下且很久没动）、🟢在跑、💬等我下一步。每条都给判定依据，可复现、可核查。"
      + "这是回答「现在还有多少对话在等我」最快的一招。默认只看最近 3 天有过活动的会话。",
    inputSchema: {
      since: z.string().optional().describe("只看该时间之后有更新的，默认 3d；传 all 表示不限时间"),
      cwd: z.string().optional().describe("只看某个项目目录（前缀匹配）"),
      limit: z.number().int().min(1).max(200).optional().describe("最多分诊多少个会话，默认 40（按最近活动取）"),
      per_group: z.number().int().min(1).max(50).optional().describe("每组最多列几个，默认 8"),
      stalled_hours: z.number().min(0.5).max(720).optional().describe("多久没动算「停滞」，默认 6 小时"),
      include_empty: z.boolean().optional().describe("是否包含没有任何消息的空会话，默认 false"),
      include_subagents: z.boolean().optional().describe("是否包含子代理会话，默认 false"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const snapshot = await index.load();
      const readState = getReadState();
      const since = args.since === "all" ? undefined : (args.since ?? "3d");
      const candidates = sortSessions(
        filterSessions(snapshot.sessions, { cwd: args.cwd, since, includeSubagents: Boolean(args.include_subagents) }, snapshot, readState),
        "recent",
      ).slice(0, args.limit ?? 40);

      // 每个候选会话只看活跃分支的最后一条消息（一次轻量请求）。
      const fetched = await mapLimit(candidates, 6, async (session) => {
        const data = await client.getContext(session.id, { tail: 1 });
        return data?.context?.messages?.[0] ?? null;
      });

      const now = Date.now();
      const judged = [];
      const errors = [];
      candidates.forEach((session, position) => {
        const outcome = fetched[position];
        if (outcome?.error) {
          errors.push(`${session.id}: ${outcome.error.message ?? outcome.error}`);
          return;
        }
        const item = classifySession({
          session,
          lastMessage: outcome?.value ?? null,
          running: snapshot.running.has(session.id),
          awaiting: snapshot.awaiting.has(session.id),
          now,
          stalledMs: (args.stalled_hours ?? 6) * 3600_000,
        });
        if (item.state === "empty" && args.include_empty !== true) return;
        judged.push({ ...item, session });
      });

      const rendered = renderTriage(judged, { now, perGroup: args.per_group ?? 8, groups: TRIAGE_ORDER });
      return text(
        rendered
        + (errors.length ? `\n（有 ${errors.length} 个会话读不到最后一条消息：${errors.slice(0, 3).join("；")}）` : ""),
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 全文搜索
  server.registerTool("piweb_search_sessions", {
    title: "全文搜索会话内容",
    description:
      "在所有会话的消息正文里做字面量（不区分大小写）搜索，返回命中片段所在的会话 id。"
      + "服务端有 3 秒时间预算，结果可能被截断（truncated）；命中很多时缩小关键词或用 piweb_get_session 细看。",
    inputSchema: {
      query: z.string().min(1).max(200).describe("搜索关键词（字面量，最长 200 字）"),
      limit: z.number().int().min(1).max(100).optional().describe("返回命中条数上限，默认 20"),
      cwd: z.string().optional().describe("只看某个项目目录（前缀匹配）"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const data = await client.search(args.query);
      const results = Array.isArray(data?.results) ? data.results : [];
      const filtered = args.cwd
        ? results.filter((hit) => (hit.session?.cwd ?? "").startsWith(String(args.cwd).replace(/\/+$/, "")))
        : results;
      const shown = filtered.slice(0, args.limit ?? 20);
      if (!shown.length) {
        return text(`没有命中「${args.query}」的会话${data?.truncated ? "（搜索被时间预算截断，可能还有遗漏）" : ""}。`);
      }
      const body = shown.map((hit, position) =>
        `${position + 1}. \`${hit.session.id}\` ｜ ${hit.session.cwd} ｜ ${relTime(hit.session.modified)}\n`
        + `   ${hit.session.name || (hit.session.firstMessage ?? "").slice(0, 60)}\n`
        + `   …${hit.before}**${hit.match}**${hit.after}…`).join("\n\n");
      return text(
        `命中 ${filtered.length} 条${data?.truncated ? "（truncated=true，服务端时间预算内没搜完）" : ""}`
        + `，显示 ${shown.length} 条：\n\n${body}`,
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 读会话
  server.registerTool("piweb_get_session", {
    title: "读取会话内容",
    description:
      "读取一个会话的对话内容（默认最后 30 条消息，含工具调用摘要）。session 可传完整 id、id 前缀、会话名称或名称/首条消息片段。"
      + "要读更早的历史用 offset 往前翻；思考内容默认只给预览，include_thinking=\"full\" 会去取完整思考链。"
      + "默认会把该会话在本地标记为已读。",
    inputSchema: {
      session: z.string().describe("会话 id / id 前缀 / 名称 / 名称或首条消息片段"),
      tail: z.number().int().min(1).max(1000).optional().describe("读取最后 N 条消息，默认 30；要全量就传大值"),
      offset: z.number().int().min(0).max(5000).optional().describe("从末尾往前跳过 N 条，用于分页读更早的历史，默认 0"),
      include_thinking: z.enum(["none", "preview", "full"]).optional().describe("思考内容：none(默认)/preview(预览)/full(取全文，较慢)"),
      include_tools: z.boolean().optional().describe("是否包含工具调用与结果，默认 true"),
      max_chars: z.number().int().min(1000).max(400_000).optional().describe("正文总字数预算，默认 60000"),
      tool_result_chars: z.number().int().min(100).max(20_000).optional().describe("单条工具结果截断长度，默认 800"),
      mark_read: z.boolean().optional().describe("读完后标记已读，默认 true"),
      format: z.enum(["markdown", "json"]).optional().describe("markdown（默认）或 json（原始消息结构）"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const { snapshot, session } = await resolveSession(index, args.session);
      const offset = args.offset ?? 0;
      const limit = args.tail ?? 30;
      const wantThinking = args.include_thinking ?? "none";
      const detail = await client.getSession(session.id, {
        tail: offset + limit,
        deferThinking: wantThinking !== "full",
      });

      let messages = detail?.context?.messages ?? [];
      let entryIds = detail?.context?.entryIds ?? [];
      if (offset > 0) {
        const from = Math.max(0, messages.length - offset - limit);
        const to = Math.max(0, messages.length - offset);
        messages = messages.slice(from, to);
        entryIds = entryIds.slice(from, to);
      }

      // 历史 thinking 只存预览（deferred），include_thinking="full" 时逐块取全文。
      let thinkingFetched = 0;
      if (wantThinking === "full") {
        const targets = [];
        messages.forEach((message, messageIndex) => {
          if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
          message.content.forEach((block, blockIndex) => {
            if (block?.type === "thinking" && block.deferred && entryIds[messageIndex]) {
              targets.push({ messageIndex, blockIndex, entryId: entryIds[messageIndex] });
            }
          });
        });
        const capped = targets.slice(0, 40);
        const results = await mapLimit(capped, 6, ({ entryId, blockIndex }) => client.getThinking(session.id, entryId, blockIndex));
        results.forEach((outcome, position) => {
          if (!outcome.value?.thinking) return;
          const { messageIndex, blockIndex } = capped[position];
          messages[messageIndex].content[blockIndex] = { type: "thinking", thinking: outcome.value.thinking };
          thinkingFetched += 1;
        });
      }

      const header = detail?.info ?? session;
      if (args.mark_read !== false) {
        updateReadState((state) => markRead(state, { ...session, modified: header.modified ?? session.modified, name: header.name, cwd: header.cwd }));
      }

      const stats = detail?.stats ?? {};
      const thinkingNote = wantThinking === "full" && thinkingFetched
        ? `\n- 已补齐 ${thinkingFetched} 段完整思考内容`
        : (wantThinking === "preview" ? "\n- 思考内容为预览（传 include_thinking=\"full\" 取全文）" : "");
      const head = [
        `# ${header.name || "(未命名会话)"}`,
        `- 会话 id：\`${session.id}\``,
        `- 目录：${header.cwd}`,
        `- 最后活动：${relTime(header.modified)}（${header.modified}）`,
        `- 消息数：${header.messageCount}｜用户 ${stats.userMessages ?? "?"} 条，助手 ${stats.assistantMessages ?? "?"} 条，工具调用 ${stats.toolCalls ?? "?"} 次`,
        `- 模型：${detail?.context?.model ? `${detail.context.model.provider}/${detail.context.model.modelId}` : "未知"}｜思考等级 ${detail?.context?.thinkingLevel ?? "?"}`,
        offset > 0
          ? `- 这是从末尾往前第 ${offset + 1}~${offset + limit} 条（要更早继续加 offset）`
          : null,
        detail?.context?.hasMore && offset === 0
          ? `- 前面还有约 ${detail.context.turnsBefore ?? "?"} 轮未加载`
          : null,
        thinkingNote || null,
        `- 运行状态：${snapshot.running.has(session.id) ? "🟢 运行中" : "⚪️ 空闲"}${snapshot.awaiting.has(session.id) ? "｜🟠 等待输入" : ""}`,
      ].filter(Boolean).join("\n");

      if (args.format === "json") {
        return text(`${head}\n\n\`\`\`json\n${JSON.stringify({ info: header, context: { ...detail?.context, messages }, stats }, null, 2).slice(0, args.max_chars ?? 60_000)}\n\`\`\``);
      }

      const transcript = transcriptMarkdown(messages, {
        includeThinking: wantThinking !== "none",
        includeTools: args.include_tools !== false,
        maxChars: args.max_chars ?? 60_000,
        toolResultChars: args.tool_result_chars ?? 800,
      });
      return text(`${head}\n\n---\n\n${transcript || "（这个会话还没有消息）"}`);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 运行状态
  server.registerTool("piweb_agent_state", {
    title: "查看 agent 运行状态",
    description: "不带 session 时给全局快照（哪些会话在跑/等待输入）；带 session 时给该会话的详细状态（是否流式中、上下文占用、模型、排队消息）。",
    inputSchema: {
      session: z.string().optional().describe("会话 id / 名称；省略则看全局"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      if (!args.session) {
        const data = await client.runningSnapshot();
        const running = data?.runningSessionIds ?? [];
        const awaiting = data?.awaitingInputSessionIds ?? [];
        return text(
          `运行中 ${running.length} 个：${running.length ? running.map((id) => `\`${id}\``).join("、") : "无"}\n`
          + `等待输入 ${awaiting.length} 个：${awaiting.length ? awaiting.map((id) => `\`${id}\``).join("、") : "无"}\n`
          + `会话列表版本：${data?.sessionListVersion ?? "?"}`,
        );
      }
      const { session } = await resolveSession(index, args.session);
      const result = await client.agentState(session.id);
      if (!result?.running) {
        return text(`会话 \`${session.id}\` 当前没有存活进程（空闲）。\n- 目录：${session.cwd}\n- 最后活动：${relTime(session.modified)}`);
      }
      const state = result.state ?? {};
      const usage = state.contextUsage;
      return text(
        `会话 \`${session.id}\` 进程存活。\n`
        + `- 流式输出中：${state.isStreaming ? "是" : "否"}｜提示词进行中：${state.isPromptRunning ? "是" : "否"}`
        + `｜shell 运行中：${state.isBashRunning ? "是" : "否"}｜压缩中：${state.isCompacting ? "是" : "否"}\n`
        + `- 排队消息：steering ${state.queuedMessages?.steering?.length ?? 0} 条，followUp ${state.queuedMessages?.followUp?.length ?? 0} 条\n`
        + `- 模型：${state.model ? `${state.model.provider}/${state.model.id}` : "未知"}｜思考等级：${state.thinkingLevel ?? "?"}\n`
        + `- 上下文占用：${usage ? `${usage.tokens} tokens / ${usage.contextWindow}（${usage.percent}%）` : "未知"}\n`
        + `- 会话文件：${state.sessionFile || "?"}`,
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 模型清单
  server.registerTool("piweb_list_models", {
    title: "列出可用模型",
    description: "列出某个项目目录下 pi 可用的模型（provider/model 形式）与默认模型、可用思考等级。新建会话或切模型前拿它选值。",
    inputSchema: {
      cwd: z.string().optional().describe("项目目录，默认取当前会话/常用目录；不确定就传会话的 cwd"),
      filter: z.string().optional().describe("只看名字里含该关键词的模型"),
      limit: z.number().int().min(1).max(500).optional().describe("最多列出多少，默认 60"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      let cwd = args.cwd;
      if (!cwd) {
        const snapshot = await index.load();
        cwd = snapshot.sessions[0]?.cwd ?? process.cwd();
      }
      const data = await client.listModels(cwd);
      const models = data?.models && typeof data.models === "object" ? data.models : {};
      const modelList = Array.isArray(data?.modelList) ? data.modelList : [];
      const needle = args.filter ? String(args.filter).toLowerCase() : null;
      // models 是 "provider:modelId" → 显示名 的映射；modelList 带 provider/id，用来过滤。
      const entries = Object.entries(models)
        .filter(([ref, name]) => !needle || `${ref} ${name}`.toLowerCase().includes(needle));
      const shown = entries.slice(0, args.limit ?? 60);
      const byProvider = new Map();
      for (const [ref, name] of shown) {
        const provider = ref.split(":")[0];
        if (!byProvider.has(provider)) byProvider.set(provider, []);
        byProvider.get(provider).push(`${ref}（${name}）`);
      }
      const body = [...byProvider.entries()]
        .map(([provider, list]) => `- **${provider}**：${list.join("、")}`)
        .join("\n");
      return text(
        `目录 ${cwd} 下可用 ${entries.length} 个模型（modelList ${modelList.length} 条）`
        + `${entries.length > shown.length ? `，显示前 ${shown.length} 个` : ""}。\n`
        + `默认模型：${data?.defaultModel ? `${data.defaultModel.provider ?? ""}${data.defaultModel.modelId ? `/${data.defaultModel.modelId}` : ""}` : "未设置"}`
        + `｜默认思考等级：${data?.defaultThinkingLevel ?? "?"}\n\n`
        + body,
      );
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 文件与 git
  server.registerTool("piweb_list_files", {
    title: "列项目文件",
    description: "列出某个项目目录下的文件（优先 git ls-files，跳过 .gitignore）。可带 filter 做模糊匹配。用来定位某个项目里有哪些文件可读。",
    inputSchema: {
      cwd: z.string().describe("项目目录的绝对路径"),
      filter: z.string().optional().describe("文件名模糊匹配（如 mcp、route.ts）"),
      limit: z.number().int().min(1).max(2000).optional().describe("最多列出多少，默认 100"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const data = await client.listFiles(args.cwd, args.filter);
      if (args.filter) {
        const matches = data?.matches ?? [];
        const shown = matches.slice(0, args.limit ?? 100);
        if (!shown.length) return text(`在 ${args.cwd} 里没匹配到「${args.filter}」的文件。`);
        return text(
          `${args.cwd} 匹配 ${matches.length} 个文件${matches.length > shown.length ? `，显示前 ${shown.length}` : ""}：\n`
          + shown.map((item) => `- \`${item.path}\`${item.score !== undefined ? `（score ${item.score}）` : ""}`).join("\n"),
        );
      }
      const files = data?.files ?? [];
      const shown = files.slice(0, args.limit ?? 100);
      return text(
        `${args.cwd} 共 ${files.length} 个文件${data?.truncated ? "（已截断）" : ""}${files.length > shown.length ? `，显示前 ${shown.length}` : ""}：\n`
        + shown.map((file) => `- \`${file}\``).join("\n"),
      );
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("piweb_read_file", {
    title: "读项目文件内容",
    description: "读一个文本文件的片段（服务端按块返回，默认一块；用 offset=nextOffset 继续读下一块）。只读文本类文件，二进制会被拒。",
    inputSchema: {
      path: z.string().describe("文件的绝对路径"),
      offset: z.number().int().min(0).optional().describe("从第几个字节开始读，默认 0"),
      max_chars: z.number().int().min(100).max(200_000).optional().describe("返回内容截断长度，默认 20000"),
      session_id: z.string().optional().describe("会话 id：用于放行「被该会话引用过」的目录之外的文件"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const data = await client.readFile(args.path, { offset: args.offset, sessionId: args.session_id });
      const content = String(data?.content ?? "");
      return text(
        `\`${args.path}\`（${data?.size ?? "?"} 字节，语言 ${data?.language ?? "text"}）\n`
        + `- 本次读取：offset ${args.offset ?? 0} → ${data?.nextOffset ?? "?"}${data?.truncated ? "（还有后续，用这个 offset 继续）" : "（已到文件尾）"}\n\n`
        + "```" + (data?.language ?? "") + "\n" + truncate(content, args.max_chars ?? 20_000) + "\n```",
      );
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("piweb_git_status", {
    title: "看项目 git 改动",
    description: "看某个项目目录的 git 状态：分支仓库根、改了哪些文件（状态码）、增删行数。用来验收 agent 到底动了什么。",
    inputSchema: { cwd: z.string().describe("项目目录的绝对路径") },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const data = await client.gitStatus(args.cwd);
      if (!data?.isGitRepository) return text(`${args.cwd} 不是 git 仓库。`);
      const files = data.files ?? [];
      if (!files.length) return text(`${args.cwd}（仓库根 ${data.repositoryRoot}）工作区干净，没有改动。`);
      const lines = files.slice(0, 100).map((file) =>
        `- \`${file.code ?? "?"}\` ${file.filePath ?? "?"}${file.originalPath ? `（原 ${file.originalPath}）` : ""}`);
      return text(
        `${args.cwd}（仓库根 ${data.repositoryRoot}）有 ${files.length} 个改动文件，`
        + `+${data.additions ?? 0} / -${data.deletions ?? 0} 行：\n${lines.join("\n")}`
        + (files.length > 100 ? `\n…还有 ${files.length - 100} 个` : ""),
      );
    } catch (error) {
      return failure(error);
    }
  });

  server.registerTool("piweb_git_diff", {
    title: "看单文件 git diff",
    description: "看某个文件相对 git 的完整 patch。复制到会话里让 agent 改，或用来核查它的改动是否合理。",
    inputSchema: {
      cwd: z.string().describe("项目目录（仓库内）的绝对路径"),
      path: z.string().describe("目标文件的绝对路径"),
      max_chars: z.number().int().min(500).max(200_000).optional().describe("patch 截断长度，默认 30000"),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async (args) => {
    try {
      const data = await client.gitDiff(args.cwd, args.path);
      if (!data?.supported) return text(`拿不到 diff：${args.path}（可能不是 git 跟踪的文件，或不在仓库内）`);
      if (!data.patch) return text(`${args.path} 没有未提交的改动。`);
      return text(`\`${args.path}\`（状态 ${data.status ?? "?"}）\n\n\`\`\`diff\n${truncate(data.patch, args.max_chars ?? 30_000)}\n\`\`\``);
    } catch (error) {
      return failure(error);
    }
  });

  // ------------------------------------------------------------ 实时流
  server.registerTool("piweb_watch_session", {
    title: "实时看会话正在输出什么",
    description:
      "订阅会话的事件流，在指定秒数内收集正在生成的内容（文本增量、思考增量、工具调用），返回期间累计的文本。"
      + "适合「它现在跑到哪了」。注意：会话没在运行时订阅会把它拉起成一个空闲进程（等同在 pi-web 打开该会话）。",
    inputSchema: {
      session: z.string().describe("会话 id / 名称"),
      seconds: z.number().int().min(2).max(300).optional().describe("监听时长秒数，默认 30"),
      include_thinking: z.boolean().optional().describe("是否也收集思考增量，默认 false"),
      until_idle: z.boolean().optional().describe("会话跑完就提前结束（最多仍受 seconds 限制），默认 true"),
    },
    annotations: { readOnlyHint: false, openWorldHint: true },
  }, async (args) => {
    try {
      const { session } = await resolveSession(index, args.session);
      const seconds = args.seconds ?? 30;
      const includeThinking = Boolean(args.include_thinking);
      let assistantText = "";
      let thinkingText = "";
      const tools = [];
      const counts = new Map();
      let ended = false;

      const started = Date.now();
      await client.watchEvents(session.id, {
        seconds,
        onEvent: (event) => {
          counts.set(event?.type ?? "?", (counts.get(event?.type ?? "?") ?? 0) + 1);
          const update = event?.assistantMessageEvent;
          if (update && typeof update.type === "string" && update.type.endsWith("_delta") && typeof update.delta === "string") {
            if (update.type.startsWith("text")) assistantText += update.delta;
            else if (update.type.startsWith("thinking") && includeThinking) thinkingText += update.delta;
            return;
          }
          if (event?.type === "tool_execution_start" && typeof event.toolName === "string") tools.push(event.toolName);
          if (event?.type === "agent_end") ended = true;
        },
      });

      const elapsed = ((Date.now() - started) / 1000).toFixed(1);
      const eventSummary = [...counts.entries()].map(([type, count]) => `${type}×${count}`).join("、") || "无事件";
      const body = [
        `会话 \`${session.id}\` 监听了 ${elapsed}s${ended ? "（期间检测到一轮结束）" : ""}，事件：${eventSummary}`,
        tools.length ? `工具调用：${tools.join(" → ")}` : null,
        includeThinking && thinkingText ? `\n## 思考增量\n\n${truncate(thinkingText, 6000)}` : null,
        assistantText ? `\n## 新输出\n\n${truncate(assistantText, 20_000)}` : "\n（这段时间没有新的文本输出）",
      ].filter(Boolean).join("\n");
      return text(body);
    } catch (error) {
      return failure(error);
    }
  });

  // 供写工具复用
  return { resolveSession, flagsMap };
}
