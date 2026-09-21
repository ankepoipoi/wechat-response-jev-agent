/**
 * 「最佳回复」相关：大模型配置读取、回复容错解析、聊天记录格式化。
 * 这些都不需要真的调用模型。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { extractJson, readLlmConfig } from "../server/llm.ts";
import { formatChat } from "../server/suggest.ts";
import type { Message } from "../shared/types.ts";

/* ------------------------------------------------------------------ */
/* 配置读取                                                            */
/* ------------------------------------------------------------------ */

function withEnv<T>(patch: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(patch)) saved[k] = process.env[k];

  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test("没配 LLM_API_KEY 时返回 null（界面据此提示去配）", () => {
  withEnv({ LLM_API_KEY: undefined }, () => {
    assert.equal(readLlmConfig(), null);
  });
});

test("只配 Key 时用 DeepSeek 的默认地址与模型", () => {
  withEnv(
    { LLM_API_KEY: "sk-test", LLM_BASE_URL: undefined, LLM_MODEL: undefined },
    () => {
      const cfg = readLlmConfig();
      assert.equal(cfg?.baseUrl, "https://api.deepseek.com");
      assert.equal(cfg?.model, "deepseek-chat");
      assert.equal(cfg?.apiKey, "sk-test");
    },
  );
});

test("baseUrl 末尾的斜杠会被去掉（避免拼出 //v1）", () => {
  withEnv(
    { LLM_API_KEY: "sk-test", LLM_BASE_URL: "https://api.moonshot.cn/v1/" },
    () => {
      assert.equal(readLlmConfig()?.baseUrl, "https://api.moonshot.cn/v1");
    },
  );
});

test("空白 Key 视为未配置", () => {
  withEnv({ LLM_API_KEY: "   " }, () => {
    assert.equal(readLlmConfig(), null);
  });
});

/* ------------------------------------------------------------------ */
/* 模型回复的容错解析                                                  */
/* ------------------------------------------------------------------ */

test("直接返回的 JSON 能解析", () => {
  const r = extractJson('{"suggestions":[{"text":"在的"}]}') as {
    suggestions: { text: string }[];
  };
  assert.equal(r.suggestions[0].text, "在的");
});

test("```json 代码块包裹能解析", () => {
  const r = extractJson('```json\n{"a":1}\n```') as { a: number };
  assert.equal(r.a, 1);
});

test("前后夹着说明文字也能解析", () => {
  const r = extractJson('好的，这是结果：\n{"a":2}\n希望有帮助！') as { a: number };
  assert.equal(r.a, 2);
});

test("拿不到 JSON 时明确抛错，而不是静默返回空", () => {
  assert.throws(() => extractJson("抱歉，我无法完成这个请求。"), /JSON/);
});

/* ------------------------------------------------------------------ */
/* 聊天记录格式化                                                      */
/* ------------------------------------------------------------------ */

const messages: Message[] = [
  {
    id: "m1",
    sender: "other",
    text: "我们抱一下吧",
    time: "17:18",
    minute: 1038,
    media: "text",
  },
  {
    id: "m2",
    sender: "self",
    text: "抱抱",
    time: "17:20",
    minute: 1040,
    media: "text",
  },
];

test("格式化时把自己标成「你」，对方保持「对方」", () => {
  const text = formatChat(messages, "豆豆");
  assert.ok(text.includes("[17:18] 对方：我们抱一下吧"));
  assert.ok(text.includes("[17:20] 豆豆（你）：抱抱"));
});

test("用户补充的媒体描述会注明是转述", () => {
  const text = formatChat(
    [
      {
        id: "m1",
        sender: "other",
        text: "[语音]",
        time: "21:00",
        minute: 1260,
        media: "voice",
        note: "她说周末要加班",
      },
    ],
    "我",
  );
  assert.ok(text.includes("这是用户转述"));
  assert.ok(text.includes("她说周末要加班"));
});

/* ------------------------------------------------------------------ */
/* 让生成参考 Jev 的判断                                                */
/* ------------------------------------------------------------------ */

import { formatDiagnosis } from "../server/suggest.ts";
import { QUALITY_LEVELS, qualityRubricForPrompt } from "../server/jev-frames.ts";
import type { AnalysisResult } from "../shared/types.ts";

function fakeAnalysis(): AnalysisResult {
  return {
    model: "jev",
    usage: { input: 1, output: 1 },
    latencyMs: 1,
    affinity: {
      value: 76,
      confidence: 0.6,
      sufficient: true,
      breakdown: { modelScore: 86, behaviorScore: 61 },
    },
    stats: {
      replyMinutes: 3.9,
      avgLength: 5.8,
      initiativeCount: 17,
      questionRate: 0.12,
      count: 20,
    },
    insights: [
      {
        id: "m1",
        emotions: [{ key: "anger", label: "生气", probability: 0.64 }],
        intents: [{ key: "complain", label: "吐槽抱怨", probability: 0.99 }],
        dropped: false,
      },
    ],
    reviews: [
      {
        id: "m2",
        grade: "D",
        score: 28,
        tip: "结尾加个问题，对话更容易继续",
        reasons: ["像是敷衍式应答"],
      },
    ],
    baselineNote: null,
    analyzedCount: 2,
  };
}

test("诊断里带上互动温度与行为统计", () => {
  const text = formatDiagnosis(fakeAnalysis(), messages);
  assert.ok(text.includes("互动温度 76/100"));
  assert.ok(text.includes("3.9 分钟回一次"));
  assert.ok(text.includes("5.8 个字"));
});

test("诊断里点出对方最近的情绪与意图", () => {
  const text = formatDiagnosis(fakeAnalysis(), messages);
  assert.ok(text.includes("生气"), "应包含对方情绪");
  assert.ok(text.includes("吐槽抱怨"), "应包含对方意图");
});

test("诊断里点出我自己接得不好的回复，避免重蹈覆辙", () => {
  const text = formatDiagnosis(fakeAnalysis(), messages);
  assert.ok(text.includes("D 级"), "应标出差的评级");
  assert.ok(text.includes("避开"), "应提示避免重复这些问题");
});

test("没有分析结果时诊断为空，不影响生成", () => {
  assert.equal(formatDiagnosis(null, messages), "");
  assert.equal(formatDiagnosis(undefined, messages), "");
});

test("评分标尺完整写进 prompt（让生成方知道会被怎么评）", () => {
  const rubric = qualityRubricForPrompt();
  for (const level of QUALITY_LEVELS) {
    assert.ok(rubric.includes(level), `标尺缺少「${level}」`);
  }
  assert.ok(rubric.includes("3 分"), "应标出满分档");
});

/* ------------------------------------------------------------------ */
/* 评分用的是和「我自己回复」完全相同的那把尺子                          */
/* ------------------------------------------------------------------ */

import { reviewReply } from "../shared/metrics.ts";

test("分数必须是整数（Jev 可能返回小数，累加后会出现 63.1999…）", () => {
  const probe = {
    id: "sug0",
    sender: "self" as const,
    // 长度刚好和对方相当，会触发 +10，容易暴露出浮点尾数
    text: "抱抱，我一直在呢，别急",
    time: null,
    minute: null,
    media: "text" as const,
  };
  // 1.16 是真实观察到的 Jev 返回值形状
  const review = reviewReply(probe, messages[0], 1.16);
  assert.equal(review.score, Math.round(review.score), `分数带小数：${review.score}`);
  assert.ok(Number.isInteger(review.score), `应为整数，实际 ${review.score}`);
});

test("reviewReply 现在会给出 0~100 的分数", () => {
  const probe = {
    id: "sug0",
    sender: "self" as const,
    text: "抱抱，我一直在呢，别急",
    time: null,
    minute: null,
    media: "text" as const,
  };
  const review = reviewReply(probe, messages[0], 3);
  assert.ok(typeof review.score === "number");
  assert.ok(review.score >= 0 && review.score <= 100, `分数越界：${review.score}`);
  assert.ok(["S+", "S", "A", "B", "C", "D"].includes(review.grade));
});

test("Jev 给满分的建议，等级应明显好于敷衍回复", () => {
  const good = reviewReply(
    { id: "a", sender: "self", text: "抱抱，我一直在呢，别急", time: null, minute: null, media: "text" },
    messages[0],
    3,
  );
  const bad = reviewReply(
    { id: "b", sender: "self", text: "嗯", time: null, minute: null, media: "text" },
    messages[0],
    0,
  );
  assert.ok(good.score > bad.score, `好回复(${good.score}) 应高于差回复(${bad.score})`);
});
