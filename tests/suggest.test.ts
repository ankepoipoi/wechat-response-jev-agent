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
