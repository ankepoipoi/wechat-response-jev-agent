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
import { analyzeChat } from "./analyze.ts";
import { JevError } from "./jev.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, "../dist");

const PORT = Number(process.env.PORT ?? 3199);
const HOST = process.env.HOST ?? "127.0.0.1";
const MAX_MESSAGES = Number(process.env.MAX_MESSAGES ?? 60);
const API_KEY = process.env.TYPESAFE_API_KEY ?? "";

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

const requestSchema = z.object({
  messages: z.array(messageSchema).min(1).max(MAX_MESSAGES),
  selfName: z.string().max(40),
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
  res.json({
    ok: true,
    configured: Boolean(API_KEY),
    maxMessages: MAX_MESSAGES,
  });
});

app.post("/api/analyze", async (req, res) => {
  const parsed = requestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "聊天结构不符合要求，请检查粘贴内容" });
    return;
  }
  if (!API_KEY) {
    res.status(503).json({ error: "还没配置 TYPESAFE_API_KEY，请在本机 .env 里填入" });
    return;
  }
  if (!withinLimit()) {
    res.status(429).json({ error: "这一小时的请求有点多，歇会儿再来" });
    return;
  }

  try {
    const result = await analyzeChat(parsed.data, API_KEY);
    console.log(
      `[analyze] 消息 ${parsed.data.messages.length} 条，${result.latencyMs}ms，tokens ${result.usage.input}/${result.usage.output}`,
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

app.use(express.static(DIST));
app.use((req, res, next) => {
  if (req.path.startsWith("/api")) return next();
  res.sendFile(path.join(DIST, "index.html"), (err) => {
    if (err) next();
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Echo 已启动 → http://${HOST}:${PORT}/`);
  if (!API_KEY) {
    console.warn("警告：未检测到 TYPESAFE_API_KEY，分析功能不可用。");
  }
});
