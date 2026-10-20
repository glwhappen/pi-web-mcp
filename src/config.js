// 配置与状态文件路径。优先级：环境变量 > 配置文件 > 密码文件兜底。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_BASE_URL = "http://127.0.0.1:30141";

export const configDir = process.env.PI_WEB_MCP_HOME
  ? path.resolve(process.env.PI_WEB_MCP_HOME)
  : path.join(os.homedir(), ".config", "pi-web-mcp");
export const configPath = path.join(configDir, "config.json");
export const statePath = path.join(configDir, "read-state.json");

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readPasswordFile(file) {
  try {
    return fs.readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** pi-web 的密码文件候选位置（都读不到就当作无鉴权）。 */
function passwordFileCandidates() {
  return [
    process.env.PI_WEB_PASSWORD_FILE,
    path.join(configDir, "password"),
    path.join(os.homedir(), "pi-web.password"),
  ].filter((value) => typeof value === "string" && value.length > 0);
}

export function loadConfig() {
  const file = readJsonFile(configPath) ?? {};
  const baseUrl = String(process.env.PI_WEB_URL || file.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");

  let password = process.env.PI_WEB_PASSWORD ?? "";
  let passwordSource = password ? "env:PI_WEB_PASSWORD" : "";
  if (!password && typeof file.password === "string" && file.password) {
    password = file.password;
    passwordSource = "config.json";
  }
  if (!password) {
    for (const candidate of passwordFileCandidates()) {
      const value = readPasswordFile(candidate);
      if (value) {
        password = value;
        passwordSource = candidate;
        break;
      }
    }
  }

  const timeoutMs = Number(file.timeoutMs) > 0 ? Number(file.timeoutMs) : 30_000;
  const username = String(process.env.PI_WEB_USERNAME || file.username || "pi");

  // HTTP 模式（给远端 AI 接入）与写权限边界
  const httpToken = process.env.PI_WEB_MCP_TOKEN || (typeof file.httpToken === "string" ? file.httpToken : "");
  const readonly = process.env.PI_WEB_MCP_READONLY === "1" || file.readonly === true;
  const writeRoots = Array.isArray(file.writeRoots)
    ? file.writeRoots.filter((root) => typeof root === "string")
    : [];
  const tools = Array.isArray(file.tools) ? file.tools.filter((name) => typeof name === "string") : [];

  return {
    baseUrl,
    username,
    password,
    passwordSource,
    timeoutMs,
    configPath,
    httpToken,
    readonly,
    writeRoots,
    tools,
    http: {
      host: typeof file.http?.host === "string" ? file.http.host : "127.0.0.1",
      port: Number(file.http?.port) > 0 ? Number(file.http.port) : 30142,
    },
  };
}

/** 用于诊断输出的配置摘要，绝不包含密码本身。 */
export function describeConfig(config) {
  return {
    baseUrl: config.baseUrl,
    username: config.username,
    passwordConfigured: Boolean(config.password),
    passwordSource: config.passwordSource || null,
    configFile: config.configPath,
    stateFile: statePath,
    readonly: Boolean(config.readonly),
    writeRoots: config.writeRoots ?? [],
    http: config.http ?? null,
    httpTokenConfigured: Boolean(config.httpToken),
    toolAllowlist: config.tools?.length ? config.tools : null,
  };
}
