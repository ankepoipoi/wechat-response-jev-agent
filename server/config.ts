/**
 * 本机配置存储。
 *
 * 页面上填的 API Key 走这里落盘到项目根目录的 `.config.json`（已 gitignore），
 * **不会存到浏览器、也不会下发给前端**。前端只能拿到「是否已配置」和掩码预览。
 *
 * 优先级：页面上填的 > .env > 进程环境变量默认值。
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** 配置文件路径（导出以便测试做备份/恢复） */
export const CONFIG_FILE = path.resolve(__dirname, "../.config.json");
const FILE = CONFIG_FILE;

export interface StoredConfig {
  typesafeApiKey?: string;
  llmBaseUrl?: string;
  llmApiKey?: string;
  llmModel?: string;
}

export function loadStoredConfig(): StoredConfig {
  try {
    if (!existsSync(FILE)) return {};
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const cfg = raw as StoredConfig;
    return {
      typesafeApiKey: typeof cfg.typesafeApiKey === "string" ? cfg.typesafeApiKey : undefined,
      llmBaseUrl: typeof cfg.llmBaseUrl === "string" ? cfg.llmBaseUrl : undefined,
      llmApiKey: typeof cfg.llmApiKey === "string" ? cfg.llmApiKey : undefined,
      llmModel: typeof cfg.llmModel === "string" ? cfg.llmModel : undefined,
    };
  } catch {
    // 文件损坏时当作没配置，不要让服务起不来
    return {};
  }
}

/** 写盘。空字符串表示清除该项 */
export function saveStoredConfig(patch: StoredConfig): StoredConfig {
  const current = loadStoredConfig();
  const next: StoredConfig = { ...current };

  for (const [key, value] of Object.entries(patch) as [keyof StoredConfig, string][]) {
    const trimmed = value.trim();
    if (trimmed) next[key] = trimmed;
    else delete next[key];
  }

  if (Object.keys(next).length === 0) {
    // 没内容了就把文件删掉，保持干净
    try {
      writeFileSync(FILE, "{}", "utf8");
    } catch {
      // 忽略
    }
    return {};
  }

  writeFileSync(FILE, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return next;
}

const ENV_KEYS = [
  "TYPESAFE_API_KEY",
  "LLM_API_KEY",
  "LLM_BASE_URL",
  "LLM_MODEL",
] as const;

/**
 * 首次调用时记下 .env 提供的原始值。
 * 页面上把某项清除后要能回退到这里，否则 process.env 会一直留着旧值 ——
 * 之前就踩过：「清除」后 health 依然显示已配置。
 */
let envFallback: Record<string, string | undefined> | null = null;

/**
 * 把存储的配置灌进 process.env，让当前进程立刻生效。
 * 每次启动调用一次；页面保存后也会调用。
 */
export function applyStoredConfig(): void {
  if (envFallback === null) {
    envFallback = {};
    for (const k of ENV_KEYS) envFallback[k] = process.env[k];
  }

  const cfg = loadStoredConfig();
  const apply = (envKey: (typeof ENV_KEYS)[number], stored?: string) => {
    if (stored) {
      process.env[envKey] = stored;
      return;
    }
    const fallback = envFallback?.[envKey];
    if (fallback === undefined) delete process.env[envKey];
    else process.env[envKey] = fallback;
  };

  apply("TYPESAFE_API_KEY", cfg.typesafeApiKey);
  apply("LLM_API_KEY", cfg.llmApiKey);
  apply("LLM_BASE_URL", cfg.llmBaseUrl);
  apply("LLM_MODEL", cfg.llmModel);
}

/** 只露头尾，供界面上确认「填的是哪个 Key」 */
export function maskKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "••••••";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

export interface ConfigStatus {
  typesafe: {
    configured: boolean;
    preview: string;
    /** 配置来自页面设置还是 .env */
    source: "page" | "env" | null;
  };
  llm: {
    configured: boolean;
    preview: string;
    baseUrl: string;
    model: string;
    source: "page" | "env" | null;
  };
}

export function configStatus(): ConfigStatus {
  const stored = loadStoredConfig();
  const typesafeKey = process.env.TYPESAFE_API_KEY ?? "";
  const llmKey = process.env.LLM_API_KEY ?? "";

  return {
    typesafe: {
      configured: Boolean(typesafeKey),
      preview: maskKey(typesafeKey),
      source: typesafeKey ? (stored.typesafeApiKey ? "page" : "env") : null,
    },
    llm: {
      configured: Boolean(llmKey),
      preview: maskKey(llmKey),
      baseUrl: process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com",
      model: process.env.LLM_MODEL?.trim() || "deepseek-chat",
      source: llmKey ? (stored.llmApiKey ? "page" : "env") : null,
    },
  };
}
