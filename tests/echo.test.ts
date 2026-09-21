import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChat } from "../shared/parse.ts";
import { computeStats, reviewReply } from "../shared/metrics.ts";
import { appendToSession, appendWithoutOverlap } from "../src/sessions.ts";
import type { Session } from "../shared/types.ts";

const SELF = "我";
const count = (text: string) => parseChat(text, SELF).messages.length;

/* ------------------------------------------------------------------ */
/* 聊天解析                                                            */
/* ------------------------------------------------------------------ */

test("格式 A：昵称 / 日期 / 正文各占一行", () => {
  const parsed = parseChat(
    `小洪水
2026年09月21日 17:18
我们抱一下吧

leeds
2026年09月21日 17:20
抱抱`,
  );
  assert.deepEqual(parsed.names, ["小洪水", "leeds"]);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].text, "我们抱一下吧");
  assert.equal(parsed.messages[0].time, "17:18");
});

test("格式 B：昵称与时间同行，正文换行", () => {
  const parsed = parseChat(`对方 21:00
今天好累

我 21:02
辛苦了`);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].text, "今天好累");
});

test("格式 C：昵称：正文", () => {
  const parsed = parseChat(`我：在吗
对方：在的`);
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[1].text, "在的");
});

test("跨天时间换算成绝对分钟数", () => {
  const parsed = parseChat(`A
2026年09月20日 23:50
晚安

B
2026年09月21日 08:10
早`);
  const diff = parsed.messages[1].minute! - parsed.messages[0].minute!;
  assert.equal(diff, 500); // 10 分钟 + 24 小时 = 1450-950
});

test("微信 .dat 文件名不会被当成用户补充的描述", () => {
  const parsed = parseChat(`我 21:00
[图片] 微信图片_20260921175133_37685.dat`);
  assert.equal(parsed.messages[0].media, "image");
  assert.equal(parsed.messages[0].note, undefined);
});

test("占位符后手写的描述会被保留", () => {
  const parsed = parseChat(`对方 21:00
[语音] 她说周末要加班`);
  assert.equal(parsed.messages[0].media, "voice");
  assert.equal(parsed.messages[0].note, "她说周末要加班");
});

/* ------------------------------------------------------------------ */
/* 追加合并                                                            */
/* ------------------------------------------------------------------ */

const base = `我 21:00
在吗

对方 21:02
在的`;

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
  const merged = appendWithoutOverlap(base, `对方 21:10
有空呀`);
  assert.equal(count(merged), 3);
});

test("追加：旧内容为空时取新内容本身", () => {
  const incoming = `我 21:00
在吗`;
  assert.equal(appendWithoutOverlap("", incoming), incoming);
});

test("追加：完全重复不会让记录膨胀", () => {
  const merged = appendWithoutOverlap(base, base);
  assert.equal(count(merged), 2);
  assert.equal(merged, base);
});

test("appendToSession 返回真实新增条数并更新记录", () => {
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
    `对方 21:02
在的

我 21:05
周末有空吗`,
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
  const parsed = parseChat(
    `我 21:00
在吗

对方 21:10
在的`,
    "我",
  );
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
