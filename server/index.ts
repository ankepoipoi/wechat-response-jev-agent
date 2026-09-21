/**
 * Echo 本机服务。
 *
 * 只做三件事：托管构建好的前端、把分析请求转给 Jev、把错误说清楚。
 * 不存任何聊天数据——长期基线由浏览器 localStorage 自己带上来的。
 * API Key 只留在这里，绝不下发到浏览器。
 */

import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { AnalysisResult } from "../shared/types.ts";
import { analyzeChat } from "./analyze.ts";
import { JevError } from "./jev.ts";
import { LlmError, readLlmConfig } from "./llm.ts";
import { suggestReplies } from "./suggest.ts";
import { applyStoredConfig, configStatus, saveStoredConfig } from "./config.ts";

// .env 已经加载完，这里再把页面上保存过的配置盖上去（页面配置优先）
applyStoredConfig();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

const PORT = Number(process.env.PORT ?? 3199);
const HOST = process.env.HOST ?? "127.0.0.1";
/**
 * 单次分析的最大条数。超出的长对话会取最近这么多条，
 * 而不是直接拒绝 —— 逐句分析的消息描述会重复进请求，太多会顶爆上下文。
 */
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 120);
/** 请求体允许携带的上限，超过分析上限时由 analyze 内部截取 */
const MAX_INPUT_MESSAGES = 2000;
/** 动态读取：页面上刚保存的 Key 要能立即生效，不能缓存在模块常量里 */
const typesafeKey = () => process.env.TYPESAFE_API_KEY?.trim() ?? "";

const app = express();
app.use(express.json({ limit: "2mb" }));

/* ------------------------------------------------------------------ */

const messageSchema = z.object({
  id: z.string().min(1).max(40),
  sender: z.enum(["self", "other"]),
  text: z.string().max(4000),
  time: z.string().max(20).nullable(),
  minute: z.number().nullable(),
  media: z.enum([
    "text",
    "voice",
    "image",
    "sticker",
    "video",
    "file",
    "link",
    "location",
    "other",
  ]),
  note: z.string().max(2000).optional(),
});

const relationSchema = z.enum(["crush", "dating"]);

const requestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_INPUT_MESSAGES),
  selfName: z.string().max(40),
  relation: relationSchema.nullable().optional(),
  baseline: z
    .object({
      sessions: z.number(),
      avgReplyMinutes: z.number().nullable(),
      avgLength: z.number().nullable(),
      avgInitiative: z.number().nullable(),
    })
    .nullable()
    .optional(),
});

/* ------------------------------------------------------------------ */
/* 简易限流：本机自用，挡住手抖连点就够了                                */
/* ------------------------------------------------------------------ */

let windowStart = Date.now();
let calls = 0;

function withinLimit(): boolean {
  const now = Date.now();
  if (now - windowStart > 3_600_000) {
    windowStart = now;
    calls = 0;
  }
  calls++;
  return calls <= 200;
}

/* ------------------------------------------------------------------ */

app.get("/api/health", (_req, res) => {
  const status = configStatus();
  res.json({
    ok: true,
    configured: status.typesafe.configured,
    maxMessages: MAX_MESSAGES,
    /** 是否配置了生成式大模型（「最佳回复」功能需要） */
    llmConfigured: status.llm.configured,
    llmModel: status.llm.configured ? status.llm.model : null,
  });
});

/* ------------------------------------------------------------------ */
/* 页面上的 API Key 配置                                                */
/*                                                                     */
/* Key 只写进本机 .config.json，前端只能拿到「是否已配置」和掩码预览，      */
/* 完整 Key 永远不下发到浏览器。                                          */
/* ------------------------------------------------------------------ */

app.get("/api/config", (_req, res) => {
  res.json(configStatus());
});

const configSchema = z.object({
  typesafeApiKey: z.string().max(500).optional(),
  llmBaseUrl: z.string().max(500).optional(),
  llmApiKey: z.string().max(500).optional(),
  llmModel: z.string().max(200).optional(),
});

app.post("/api/config", (req, res) => {
  const parsed = configSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "配置格式不正确" });
    return;
  }

  try {
    const saved = saveStoredConfig(parsed.data);
    const changed = Object.keys(saved).length > 0;
    // 立刻让当前进程生效，不用重启
    applyStoredConfig();
    console.log(
      `[config] 已更新：${Object.keys(parsed.data).filter((k) => (parsed.data as Record<string, string | undefined>)[k]?.trim()).join(", ") || "（清空）"}`,
    );
    res.json({ ok: true, status: configStatus(), hasConfig: changed });
  } catch (err) {
    console.error("[config] 写入失败：", err);
    res.status(500).json({ error: "配置没能保存到本机文件" });
  }
});

app.post("/api/analyze", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "聊天结构不符合要求，请检查粘贴内容" });
    return;
  }
  const key = typesafeKey();
  if (!key) {
    res.status(503).json({
      error: "还没配置 TypeSafe API Key，点右上角「设置」可以直接填。",
    });
    return;
  }
  if (!withinLimit()) {
    res.status(429).json({ error: "这一小时的请求有点多，歇会儿再来" });
    return;
  }

  try {
    const result = await analyzeChat(parsed.data, key, MAX_MESSAGES);
    console.log(
      `[analyze] 消息 ${parsed.data.messages.length} 条${result.truncatedFrom ? `（截取最近 ${result.analyzedCount} 条）` : ""}，${result.latencyMs}ms，tokens ${result.usage.input}/${result.usage.output}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof JevError) {
      console.error(`[analyze] jev ${err.status}`);
      res.status(err.status >= 400 && err.status < 600 ? err.status : 502).json({
        error: err.message,
      });
      return;
    }
    console.error("[analyze] 未预期错误：", err);
    res.status(500).json({ error: "分析没能完成，聊天内容已保留，可以重试" });
  }
});

/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 最佳回复建议：交给生成式大模型（Jev 不生成文本）                       */
/* ------------------------------------------------------------------ */

const suggestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_INPUT_MESSAGES),
  selfName: z.string().max(40),
  relation: relationSchema.nullable().optional(),
  avgLength: z.number().nullable().optional(),
  // 上一次的分析结果，让生成时能参考 Jev 的判断。它由本服务自己产出，原样透传即可
  analysis: z.custom<AnalysisResult>().nullable().optional(),
});

app.post("/api/suggest", async (req, res) => {
  const parsed = suggestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "聊天结构不符合要求，无法生成建议" });
    return;
  }

  const cfg = readLlmConfig();
  if (!cfg) {
    res.status(503).json({
      error:
        "还没配置生成式大模型（写回复需要它）。点右上角「设置」，填入 LLM 的地址、Key 和模型名即可。",
    });
    return;
  }

  try {
    // 把 Key 传下去：生成完之后还要交给 Jev 按同一套标准打分
    const result = await suggestReplies(cfg, parsed.data, typesafeKey());
    const grades = result.suggestions
      .map((s) => (s.review ? `${s.review.grade}(${s.review.score})` : "—"))
      .join(" ");
    console.log(
      `[suggest] ${result.suggestions.length} 条建议，基于最近 ${result.usedMessages} 条，` +
        `评分[${grades}]${result.scored ? "" : "（Jev 评分未成功）"}，` +
        `${result.latencyMs}ms，tokens ${result.usage.input}/${result.usage.output}`,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof LlmError) {
      console.error(`[suggest] llm ${err.status}`);
      res
        .status(err.status >= 400 && err.status < 600 ? err.status : 502)
        .json({ error: err.message });
      return;
    }
    console.error("[suggest] 未预期错误：", err);
    res.status(500).json({ error: "生成建议没能完成，可以重试" });
  }
});

/* ------------------------------------------------------------------ */

app.use(express.static(DIST));
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Echo 已启动 → http://${HOST}:${PORT}/`);
  const status = configStatus();
  if (!status.typesafe.configured) {
    console.warn("提示：还没配置 TypeSafe API Key，可以在页面上点「设置」填入。");
  }
  if (!status.llm.configured) {
    console.warn("提示：还没配置生成式大模型，「最能拉近距离的回复」暂不可用。");
  }
});
