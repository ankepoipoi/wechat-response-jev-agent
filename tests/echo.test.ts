/**
 * 追加合并、统计与评级。
 * 解析格式的用例在 parse.test.ts。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChat } from "../shared/parse.ts";
import { computeStats, reviewReply } from "../shared/metrics.ts";
import { appendToSession, appendWithoutOverlap } from "../src/sessions.ts";
import type { Session } from "../shared/types.ts";

const SELF = "我";
const count = (text: string) => parseChat(text, SELF).messages.length;

const base = `我 21:00
在吗

对方 21:02
在的`;

/* ------------------------------------------------------------------ */
/* 追加合并                                                            */
/* ------------------------------------------------------------------ */

test("追加：尾部与新内容开头重叠时只补新增部分", () => {
  const merged = appendWithoutOverlap(
    base,
    `对方 21:02
在的

我 21:05
周末有空吗`,
  );
  assert.equal(count(merged), 3);
});

test("追加：无重叠直接接上", () => {
  const merged = appendWithoutOverlap(base, `对方 21:10\n有空呀`);
  assert.equal(count(merged), 3);
});

test("追加：旧内容为空时取新内容本身", () => {
  const incoming = `我 21:00\n在吗`;
  assert.equal(appendWithoutOverlap("", incoming), incoming);
});

test("追加：完全重复不会让记录膨胀", () => {
  const merged = appendWithoutOverlap(base, base);
  assert.equal(count(merged), 2);
  assert.equal(merged, base);
});

test("appendToSession 返回真实新增条数且不改动原对象", () => {
  const session: Session = {
    id: "s1",
    name: "测试",
    input: base,
    selfName: SELF,
    createdAt: 0,
    updatedAt: 0,
    result: null,
  };
  const { session: next, added } = appendToSession(
    session,
    `对方 21:02\n在的\n\n我 21:05\n周末有空吗`,
    SELF,
  );
  assert.equal(added, 1);
  assert.equal(count(next.input), 3);
  assert.equal(session.input, base, "原对象不应被改动");
});

/* ------------------------------------------------------------------ */
/* 统计与评级                                                          */
/* ------------------------------------------------------------------ */

test("回复间隔按「对方回我」计算", () => {
  // 必须传 selfName，否则消息都会被当成对方，算不出「对方回我」的间隔
  const parsed = parseChat(`我 21:00\n在吗\n\n对方 21:10\n在的`, SELF);
  assert.equal(parsed.messages[0].sender, "self");
  const stats = computeStats(parsed.messages);
  assert.equal(stats.replyMinutes, 10);
});

test("亲昵表达不会被当成敷衍，评级不低于 B", () => {
  const msg = {
    id: "m1",
    sender: "self" as const,
    text: "抱抱",
    time: "21:00",
    minute: 1260,
    media: "text" as const,
  };
  const review = reviewReply(msg, null, 1);
  assert.ok(
    ["S+", "S", "A", "B"].includes(review.grade),
    `期望不低于 B，实际 ${review.grade}`,
  );
});

test("不带问号的疑问句也算提问", () => {
  const msg = {
    id: "m1",
    sender: "self" as const,
    text: "周末要不要一起吃饭",
    time: "21:00",
    minute: 1260,
    media: "text" as const,
  };
  const review = reviewReply(msg, null, 2);
  assert.ok(review.reasons.some((r) => r.includes("问题")));
});
