import { test } from "node:test";
import assert from "node:assert/strict";

import { parseChat } from "../shared/parse.ts";

/* ------------------------------------------------------------------ */
/* 时间戳宽容度：微信可能出现的各种写法                                  */
/* ------------------------------------------------------------------ */

const STAMP_VARIANTS = [
  "2026年09月21日 17:18",
  "2026年9月21日 17:18",
  "2026/09/21 17:18",
  "2026-9-21 17:18",
  "2026.09.21 17:18",
  "9月21日 17:18",
  "09-21 17:18",
  "昨天 17:18",
  "今天 17:18",
  "前天 17:18",
  "星期三 17:18",
  "周三 17:18",
  "17:18",
  "17:18:33",
  "下午5:18",
  "下午 5:18",
  "晚上8:05",
];

for (const stamp of STAMP_VARIANTS) {
  test(`格式 A 能识别时间「${stamp}」`, () => {
    const parsed = parseChat(
      `小洪水\n${stamp}\n我们抱一下吧\n\nleeds\n${stamp}\n抱抱`,
    );
    assert.equal(parsed.messages.length, 2, `实际识别 ${parsed.messages.length} 条`);
    assert.equal(parsed.diagnostics.strategy, "triple");
    assert.ok(
      parsed.messages[0].time !== null,
      `「${stamp}」没解析出时间`,
    );
  });
}

test("下午/晚上会换算成 24 小时制", () => {
  const parsed = parseChat(`A\n下午5:18\n在吗`);
  assert.equal(parsed.messages[0].time, "17:18");

  const night = parseChat(`A\n晚上8:05\n在吗`);
  assert.equal(night.messages[0].time, "20:05");
});

test("带秒的时间只取时分", () => {
  const parsed = parseChat(`A\n17:18:33\n在吗`);
  assert.equal(parsed.messages[0].time, "17:18");
});

/* ------------------------------------------------------------------ */
/* 三种格式自动识别                                                     */
/* ------------------------------------------------------------------ */

test("策略选择：昵称/时间/正文各占一行 → triple", () => {
  const parsed = parseChat(
    `小洪水\n2026年09月21日 17:18\n我们抱一下吧\n\nleeds\n2026年09月21日 17:20\n抱抱`,
  );
  assert.equal(parsed.diagnostics.strategy, "triple");
  assert.deepEqual(parsed.names, ["小洪水", "leeds"]);
});

test("策略选择：昵称与时间同行 → block", () => {
  const parsed = parseChat(`对方 21:00\n今天好累\n\n我 21:02\n辛苦了`);
  assert.equal(parsed.diagnostics.strategy, "block");
  assert.equal(parsed.messages.length, 2);
});

test("策略选择：昵称：正文 → inline", () => {
  const parsed = parseChat(`我：在吗\n对方：在的`);
  assert.equal(parsed.diagnostics.strategy, "inline");
  assert.equal(parsed.messages.length, 2);
});

test("block 也支持「昵称 + 带日期的时间」同行", () => {
  const parsed = parseChat(
    `小洪水 2026年09月21日 17:18\n我们抱一下吧\nleeds 2026年09月21日 17:20\n抱抱`,
  );
  assert.equal(parsed.messages.length, 2);
  assert.ok(parsed.names.includes("小洪水"), `实际昵称：${parsed.names.join(",")}`);
  assert.equal(parsed.messages[0].time, "17:18");
});

test("昵称里带空格也不会被切错", () => {
  const parsed = parseChat(`Leeds 的男友 21:03\n在吗\n\n我 21:05\n在的`);
  assert.equal(parsed.messages.length, 2);
  assert.ok(
    parsed.names.includes("Leeds 的男友"),
    `昵称被切错了：${parsed.names.join(" | ")}`,
  );
});

test("长昵称（超过 24 字符）不再被丢弃", () => {
  const long = "leeds全球唯一指定男友真的超级长昵称";
  const parsed = parseChat(`A\n2026年09月21日 17:18\n在吗\n\n${long}\n2026年09月21日 17:19\n在的`);
  assert.ok(parsed.names.includes(long), `昵称未被识别：${parsed.names.join(",")}`);
});

/* ------------------------------------------------------------------ */
/* 正文里出现类似时间的行，不应被当成新消息                              */
/* ------------------------------------------------------------------ */

test("正文中的时间不会被误判成新消息头", () => {
  const parsed = parseChat(
    `A\n2026年09月21日 17:18\n我们 10:30 见吧\n\nB\n2026年09月21日 17:20\n好的`,
  );
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].text, "我们 10:30 见吧");
});

/* ------------------------------------------------------------------ */
/* 跨天                                                                */
/* ------------------------------------------------------------------ */

test("跨天换算成绝对分钟数", () => {
  const parsed = parseChat(`A\n2026年09月20日 23:50\n晚安\n\nB\n2026年09月21日 08:10\n早`);
  const diff = parsed.messages[1].minute! - parsed.messages[0].minute!;
  assert.equal(diff, 500);
});

test("相对日期（昨天→今天）也能算对间隔", () => {
  const parsed = parseChat(`A\n昨天 23:50\n晚安\n\nB\n今天 08:10\n早`);
  const diff = parsed.messages[1].minute! - parsed.messages[0].minute!;
  assert.equal(diff, 500);
});

/* ------------------------------------------------------------------ */
/* 媒体占位符                                                          */
/* ------------------------------------------------------------------ */

test("微信 .dat 文件名不会被当成用户描述", () => {
  const parsed = parseChat(`我 21:00\n[图片] 微信图片_20260921175133_37685.dat`);
  assert.equal(parsed.messages[0].media, "image");
  assert.equal(parsed.messages[0].note, undefined);
});

test("占位符后手写的描述会保留", () => {
  const parsed = parseChat(`对方 21:00\n[语音] 她说周末要加班`);
  assert.equal(parsed.messages[0].media, "voice");
  assert.equal(parsed.messages[0].note, "她说周末要加班");
});

test("视频通话/转账等新占位符能识别", () => {
  const parsed = parseChat(
    `A\n2026年09月21日 17:18\n[视频通话]\n\nB\n2026年09月21日 17:19\n[转账] 请收款`,
  );
  assert.equal(parsed.messages[0].media, "video");
  assert.equal(parsed.messages[1].media, "other");
  assert.equal(parsed.messages[1].note, "请收款");
});

/* ------------------------------------------------------------------ */
/* 诊断                                                                */
/* ------------------------------------------------------------------ */

test("没有时间信息时给出提示", () => {
  const parsed = parseChat(`我：在吗\n对方：在的`);
  assert.equal(parsed.diagnostics.timestampRatio, 0);
  assert.ok(parsed.diagnostics.warnings.some((w) => w.includes("时间")));
});

test("只有一个昵称时给出提示", () => {
  const parsed = parseChat(`我 21:00\n在吗\n\n我 21:02\n在的`);
  assert.equal(parsed.diagnostics.nameCount, 1);
  assert.ok(parsed.diagnostics.warnings.some((w) => w.includes("一个昵称")));
});

test("识别不出内容时给出提示", () => {
  const parsed = parseChat("这是一段随便写的话，不是聊天记录");
  assert.equal(parsed.diagnostics.messageCount, 0);
  assert.ok(parsed.diagnostics.warnings.some((w) => w.includes("没能识别")));
});

test("正常输入不产生警告", () => {
  const parsed = parseChat(
    `小洪水\n2026年09月21日 17:18\n我们抱一下吧\n\nleeds\n2026年09月21日 17:20\n抱抱`,
  );
  assert.deepEqual(parsed.diagnostics.warnings, []);
});

/* ------------------------------------------------------------------ */
/* 粘贴污染的容错                                                      */
/* ------------------------------------------------------------------ */

test("整段带 markdown 引用符（每行 > ）时能剥掉前缀", () => {
  const parsed = parseChat(
    `> 小洪水
> 2026年09月21日 17:18
> 我们抱一下吧
>
> leeds
> 2026年09月21日 17:20
> 抱抱`,
  );
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.names, ["小洪水", "leeds"]);
  assert.equal(parsed.messages[0].time, "17:18");
});

test("整段统一缩进也能解析", () => {
  const parsed = parseChat(
    `  小洪水
  2026年09月21日 17:18
  在吗

  leeds
  2026年09月21日 17:20
  在的`,
  );
  assert.equal(parsed.messages.length, 2);
  assert.deepEqual(parsed.names, ["小洪水", "leeds"]);
});

test("只有少数行带 > 时不做剥离（避免误伤正文）", () => {
  const parsed = parseChat(
    `小洪水
2026年09月21日 17:18
> 引用了一句别人的话

leeds
2026年09月21日 17:20
嗯嗯`,
  );
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.messages[0].text, "> 引用了一句别人的话");
});

test("Windows CRLF 换行不影响解析", () => {
  const parsed = parseChat(
    "小洪水\r\n2026年09月21日 17:18\r\n在吗\r\n\r\nleeds\r\n2026年09月21日 17:20\r\n在的",
  );
  assert.equal(parsed.messages.length, 2);
});

test("行尾多余空格不影响解析", () => {
  const parsed = parseChat(
    "小洪水  \n2026年09月21日 17:18  \n在吗  \n\nleeds  \n2026年09月21日 17:20  \n在的",
  );
  assert.equal(parsed.messages.length, 2);
});

test("倒序粘贴（最新的在最上面）会被翻转回时间顺序", () => {
  const parsed = parseChat(
    `leeds
2026年09月21日 17:20
在的

小洪水
2026年09月21日 17:18
在吗`,
    "小洪水",
  );
  assert.equal(parsed.messages.length, 2);
  assert.equal(parsed.diagnostics.reversed, true);
  // 翻转后最早的那条应该排在最前
  assert.equal(parsed.messages[0].time, "17:18");
  assert.equal(parsed.messages[0].sender, "self");
  assert.equal(parsed.messages[1].time, "17:20");
  assert.deepEqual(parsed.names, ["leeds", "小洪水"]);
});

test("正序输入不会被误判为倒序", () => {
  const parsed = parseChat(
    `小洪水
2026年09月21日 17:18
在吗

leeds
2026年09月21日 17:20
在的`,
  );
  assert.equal(parsed.diagnostics.reversed, false);
  assert.equal(parsed.messages[0].time, "17:18");
});

test("消息太少时不猜顺序", () => {
  const parsed = parseChat(`leeds\n2026年09月21日 17:20\n在的`);
  assert.equal(parsed.diagnostics.reversed, false);
});

test("同一分钟连发多条时，倒序仍能被识别", () => {
  // 真实聊天里同一分钟常有连续几条，这些「相等对」会把递减比例稀释，
  // 早期实现因此漏判，回复间隔被算成 0
  const parsed = parseChat(
    `leeds
2026年09月21日 17:30
嗯嗯

leeds
2026年09月21日 17:30
在的

小洪水
2026年09月21日 17:20
在吗

小洪水
2026年09月21日 17:20
喂`,
    "小洪水",
  );
  assert.equal(parsed.diagnostics.reversed, true);
  assert.equal(parsed.messages[0].text, "喂");
  assert.equal(parsed.messages[3].text, "嗯嗯");
});
