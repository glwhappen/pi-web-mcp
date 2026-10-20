# pi-web-mcp

[English](./README.md) | [简体中文](./README.zh-CN.md)

![test](https://github.com/glwhappen/pi-web-mcp/actions/workflows/test.yml/badge.svg)

把 [Pi Web](https://github.com/agegr/pi-web)（[pi coding agent](https://github.com/earendil-works/pi) 的网页版）的 HTTP API 包成 MCP 服务，让任何 MCP 客户端（pi、Claude Desktop、Cursor、你自己的 agent…）都能查看、分诊、检索、读取和驱动你的 pi 会话。

Pi Web 本身只给浏览器用。这个服务把它的接口变成 **25 个工具**：列/筛会话、读对话正文、**分诊哪些对话在等我**、全文检索、发消息并等回复、分支/重命名/删除会话、看项目改动 —— 走 stdio 或 Streamable HTTP。

```
┌────────────┐   MCP (stdio / HTTP)   ┌──────────────┐   HTTP   ┌──────────┐
│ 任意 AI     │ ─────────────────────► │ pi-web-mcp   │ ───────► │ pi-web   │ ──► pi 会话
│ MCP 客户端  │ ◄───────────────────── │ (本项目)      │ ◄─────── │ :30141   │     (~/.pi/agent/sessions)
└────────────┘                        └──────────────┘          └──────────┘
```

## 快速开始

需要 **Node.js ≥ 22** 和一个正在运行的 Pi Web。

```bash
# 不克隆直接跑（npx 会自动从 GitHub 取包）
npx -y github:glwhappen/pi-web-mcp --status    # 自检：配置 + 试连 pi-web
npx -y github:glwhappen/pi-web-mcp             # 在 stdin/stdout 上跑 MCP 服务
```

或者装一次：

```bash
npm install -g github:glwhappen/pi-web-mcp   # 之后直接跑 pi-web-mcp
# 或者克隆下来：
git clone https://github.com/glwhappen/pi-web-mcp && cd pi-web-mcp && npm ci
node src/index.js --status
```

配置连接（环境变量或 `~/.config/pi-web-mcp/config.json` 二选一）：

```bash
export PI_WEB_URL=http://127.0.0.1:30141
export PI_WEB_PASSWORD=你的-pi-web-密码     # Basic Auth，用户名固定 pi
```

注册到 MCP 客户端。以 pi 的 `~/.pi/agent/mcp.json` 为例：

```json
{
  "mcpServers": {
    "pi-web": {
      "command": "npx",
      "args": ["-y", "github:glwhappen/pi-web-mcp"],
      "env": { "PI_WEB_URL": "http://127.0.0.1:30141", "PI_WEB_PASSWORD": "…" },
      "exposure": "deferred",
      "toolExposure": {
        "piweb_triage": "direct",
        "piweb_list_unread": "direct",
        "piweb_list_sessions": "direct",
        "piweb_get_session": "direct",
        "piweb_search_sessions": "direct",
        "piweb_send_message": "direct"
      }
    }
  }
}
```

Claude Desktop / Cursor / 其它客户端用同样的 `command` + `env` 结构；远端客户端见 [HTTP 模式](#http-模式给远端-ai)。

## 工具（25 个）

### 读

| 工具 | 作用 |
| --- | --- |
| `piweb_status` | 连接与边界自检（地址、密码来源、读写模式、会话数） |
| `piweb_list_sessions` | 筛会话：`cwd` / `project` / `keyword` / `status` / `since` / `sort` / `limit`（默认不含空会话） |
| `piweb_list_projects` | 按项目目录聚合：会话数、运行中、未读、最近活动 |
| `piweb_list_unread` | 待介入清单（🟠等待输入 / 🔵未读 / 🟢运行中） |
| `piweb_triage` | **分诊**：❓可能在问我 / ⚠️半途停下 / 💤停滞 / 🟢在跑 / 💬等我下一步，每条给判定依据 |
| `piweb_search_sessions` | 全会话正文全文检索（服务端 3s 预算，可能 truncated） |
| `piweb_get_session` | 读对话正文；`offset` 向前翻页，`include_thinking=none/preview/full` 控制思考内容 |
| `piweb_agent_state` | 全局运行快照，或单会话详细状态（流式/排队/上下文占用） |
| `piweb_list_models` | 某目录下可用模型 + 默认模型 + 思考等级 |
| `piweb_list_files` | 列项目文件（优先 git 索引），可模糊匹配 |
| `piweb_read_file` | 读文本文件片段（用 `offset` 继续读下一块） |
| `piweb_git_status` | 项目改动清单 + 增删行数 |
| `piweb_git_diff` | 单文件完整 patch |
| `piweb_watch_session` | 实时看会话正在输出什么（订阅事件流） |

### 写

| 工具 | 作用 |
| --- | --- |
| `piweb_send_message` | 发提示词；`wait_seconds>0` 时等这一轮跑完并带回回复 |
| `piweb_wait_for_reply` | 轮询等这一轮结束，取最后助手回复 |
| `piweb_create_session` | 新建会话（可带首条提示词、模型、思考等级） |
| `piweb_fork_session` | 从当前分支复制出新会话 |
| `piweb_auto_name_session` | 让模型给会话起名 |
| `piweb_set_model` | 切换会话模型 |
| `piweb_abort_session` | 中断当前这一轮 |
| `piweb_mark_read` | 更新本服务的已读游标（单个/全部/反向标未读） |
| `piweb_rename_session` | 重命名 |
| `piweb_export_session` | 导出 pi 官方单文件 HTML |
| `piweb_delete_session` | 删除（需 `confirm=true`，连带子代理会话） |

`session` 参数接受：完整 id、id 前缀、精确名称、名称/首条消息片段；命中多个会报错并列出候选，**不会猜**。

## 分诊规则

`piweb_triage` 不调用模型，纯规则：看活跃分支上的最后一条消息是什么、有没有悬挂的工具调用、多久没动。快、可解释、可复现，每条判定都带依据。

| 判定 | 依据 |
| --- | --- |
| 🟠 等我回答 | Pi Web 报告该会话正等扩展 UI 输入 |
| 🟢 在跑 | 会话有活的 agent 进程 |
| ⚠️ 半途停下 | 最后一条是「我的消息」/工具结果/悬着的工具调用/助手无文本 |
| 💤 停滞 | 同上，且静默超过 `stalled_hours`（默认 6 小时） |
| ❓ 可能在问我 | 最后一条助手消息带问号 |
| 💬 等我下一步 | 助手已收尾 |
| ⚪️ 空会话 | 没有任何消息（默认不列） |

## 未读是怎么算的

Pi Web 自身的未读标记存在**浏览器 localStorage**，服务端拿不到。所以本服务维护自己的游标 `<配置目录>/read-state.json`（记录你读过的会话 `modified` 时间，带跨进程文件锁）。
`piweb_get_session` / `piweb_wait_for_reply` 读完自动更新游标，`piweb_mark_read` 手动管理。

**浏览器里的未读和 MCP 的未读是两套**，互不影响。

## 配置

优先级：命令行 > 环境变量 > `~/.config/pi-web-mcp/config.json` > 密码文件。

```json
{
  "baseUrl": "http://127.0.0.1:30141",
  "username": "pi",
  "password": "…",
  "timeoutMs": 30000,
  "httpToken": "…",
  "writeRoots": [],
  "tools": [],
  "http": { "host": "127.0.0.1", "port": 30142 }
}
```

| 键 / 环境变量 | 说明 |
| --- | --- |
| `baseUrl` / `PI_WEB_URL` | Pi Web 地址，默认 `http://127.0.0.1:30141` |
| `password` / `PI_WEB_PASSWORD` | Pi Web 密码（Basic Auth，用户名固定 `pi`） |
| `PI_WEB_USERNAME` | 改 Basic Auth 用户名 |
| `PI_WEB_PASSWORD_FILE` | 密码文件；否则依次尝试 `~/.config/pi-web-mcp/password`、`~/pi-web.password` |
| `httpToken` / `PI_WEB_MCP_TOKEN` | HTTP 模式的 Bearer token；绑非本机地址时必需 |
| `readonly` / `PI_WEB_MCP_READONLY=1` | 只注册只读工具（外加本地已读游标与 `wait_for_reply`） |
| `writeRoots` | 数组；非空时写操作只允许落在这些项目根目录下的会话 |
| `tools` | 数组；非空时只注册列出的工具 |
| `http.host` / `http.port` | HTTP 模式监听地址，默认 `127.0.0.1:30142` |
| `PI_WEB_MCP_HOME` | 配置目录，默认 `~/.config/pi-web-mcp` |

命令行参数：`--http`、`--host`、`--port`、`--http-token`、`--readonly`、`--write-root <目录>`（可重复）、`--tools a,b,c`、`--status`、`--version`、`--help`。

## HTTP 模式（给远端 AI）

```bash
pi-web-mcp --http --host 172.17.0.1 --port 30142
```

端点是 `POST /mcp`（Streamable HTTP，无状态：每个请求一套实例，多客户端可并发）。客户端用 `Authorization: Bearer <httpToken>` 或 `X-Pi-Web-Mcp-Token` 头鉴权。

> 绑非本机地址时**没配 token 会拒绝启动**。

远端客户端配置：

```json
{
  "mcpServers": {
    "pi-web": {
      "url": "https://pi-mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer <httpToken>" }
    }
  }
}
```

systemd 单元示例见 [`deploy/pi-web-mcp.service.example`](./deploy/pi-web-mcp.service.example)。

## 安全模型

这个服务能让 agent 改文件、跑命令，请当成特权接口对待：

- **HTTP 模式一定配 token**（绑非本机地址时不配直接拒绝启动）。
- **`--readonly`** 砍掉所有会改状态的工具（只读 16 个工具 vs 可写 25 个）。
- **`--write-root`** 把写操作限制在指定项目根下的会话，多 agent 共用端点时尤其有用。
- 对外暴露前先套 HTTPS 反代（如 [nginx-proxy-manager](https://github.com/NginxProxyManager/nginx-proxy-manager)）。
- 本机优先用 stdio：不占端口，进程生命周期由客户端管。
- `piweb_delete_session` 必须显式传 `confirm: true`。

## 开发

```bash
git clone https://github.com/glwhappen/pi-web-mcp
cd pi-web-mcp
npm ci
npm test                       # 单元测试：跑假 pi-web，不需要真实例
npm run smoke                  # 真机只读冒烟
npm run smoke:write            # 真机写路径（会新建会话、花模型 token）
```

目录结构：

```
src/
  index.js          入口：命令行参数、stdio/HTTP 传输、优雅退出
  client.js         Pi Web HTTP 客户端（Basic Auth、超时、重试、SSE 订阅）
  config.js         配置解析（env > config.json > 密码文件）
  guard.js          读写边界（readonly / writeRoots）
  session-index.js  会话列表缓存 + id/名称解析
  read-state.js     已读游标（跨进程文件锁）
  triage.js         分诊规则与渲染
  format.js         会话/消息 → Markdown
  tools/            {index,shared,read,write}.js —— 25 个工具
test/
  mock-piweb.mjs    假 Pi Web
  server.test.mjs   单元测试
deploy/
  pi-web-mcp.service.example
```

单元测试用的是假 Pi Web，任何机器上都能跑，不需要装 pi。

## 已知限制

- Pi Web 的未读在浏览器本地，本服务另存一份游标（见上）。
- `piweb_search_sessions` 受服务端 3 秒搜索预算限制，可能返回 `truncated`。
- `piweb_watch_session` 若会话没在运行，会把它的 agent 进程拉起来（等同在 Pi Web 里打开该会话）。
- `piweb_send_message` / `piweb_create_session` 会让对方 agent 真正动手（改文件、跑命令），发之前确认会话选对了。
- HTTP 模式无状态：没有服务端主动通知，也没有仅 SSE 的能力。

## 许可

MIT
