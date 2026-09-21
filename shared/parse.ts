/**
 * 微信聊天记录解析（自动识别格式）。纯函数，不依赖任何模型。
 *
 * 三种候选策略各自跑一遍，再按「消息数 + 时间戳覆盖率 + 昵称数」打分选最优：
 *
 *   triple  昵称 / 日期时间 / 正文     各占一行（微信多选复制）
 *   block   昵称 日期时间              同行，正文换行
 *   inline  昵称：正文
 *
 * 时间戳尽量宽容，覆盖微信可能出现的写法：
 *   2026年9月21日 17:18 · 2026/09/21 17:18 · 2026-9-21 17:18
 *   9月21日 17:18 · 09-21 17:18 · 昨天 17:18 · 星期三 17:18
 *   下午5:18 · 下午 5:18 · 17:18:33
 */

import type {
  MediaKind,
  Message,
  ParseDiagnostics,
  ParsedChat,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* 词法                                                                */
/* ------------------------------------------------------------------ */

const PERIOD = "(?:上午|下午|凌晨|早上|早晨|中午|傍晚|晚上)";

/** 17:18 / 17:18:33 / 下午5:18 / 下午 5:18 / 下午5：18 */
const CLOCK = `(?:${PERIOD}\\s*)?\\d{1,2}[:：]\\d{2}(?::\\d{2})?`;

const DATE =
  "(?:\\d{4}\\s*[年/\\-.]\\s*\\d{1,2}\\s*[月/\\-.]\\s*\\d{1,2}\\s*日?" +
  "|\\d{1,2}\\s*月\\s*\\d{1,2}\\s*日" +
  "|\\d{1,2}\\s*[/\\-]\\s*\\d{1,2}" +
  "|昨天|今天|前天|星期[一二三四五六日天]|周[一二三四五六日天])";

const DATETIME_LINE = new RegExp(`^(?:(?:${DATE})\\s*)?${CLOCK}$|^${DATE}$`);
const TIME_HEADER = new RegExp(
  `^(.{1,40}?)[\\s\\u3000]+((?:${DATE}\\s*)?${CLOCK})$`,
);
const INLINE_HEADER = /^([^\s:：]{1,40})\s*[:：]\s*(.+)$/;

const CLOCK_RE = new RegExp(`(${PERIOD})?\\s*(\\d{1,2})[:：](\\d{2})`);
const DATE_FULL_RE = /(\d{4})\s*[年/\-.]\s*(\d{1,2})\s*[月/\-.]\s*(\d{1,2})/;
const DATE_MD_RE = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/;
const DATE_SLASH_RE = /(\d{1,2})\s*[/\-]\s*(\d{1,2})/;
const WEEK_RE = /(?:星期|周)([一二三四五六日天])/;

const MEDIA =
  /^\[(语音|语音消息|语音通话|图片|动画表情|表情|视频|视频通话|文件|位置|链接|名片|聊天记录|转账|红包|音乐|小程序|接龙|投票)\]/;

const MEDIA_MAP: Record<string, MediaKind> = {
  语音: "voice",
  语音消息: "voice",
  语音通话: "voice",
  图片: "image",
  动画表情: "sticker",
  表情: "sticker",
  视频: "video",
  视频通话: "video",
  文件: "file",
  位置: "location",
  链接: "link",
};

/* ------------------------------------------------------------------ */
/* 时间解析                                                            */
/* ------------------------------------------------------------------ */

const WEEK_MAP: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 0,
  天: 0,
};

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function parseDatePart(raw: string, base: Date): Date | null {
  const full = raw.match(DATE_FULL_RE);
  if (full) {
    return new Date(Number(full[1]), Number(full[2]) - 1, Number(full[3]));
  }

  const md = raw.match(DATE_MD_RE);
  if (md) return new Date(base.getFullYear(), Number(md[1]) - 1, Number(md[2]));

  const slash = raw.match(DATE_SLASH_RE);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    // 只有「月/日」这种两段写法才认，避免把别的数字当日期
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
      return new Date(base.getFullYear(), a - 1, b);
    }
  }

  const week = raw.match(WEEK_RE);
  if (week) {
    const target = WEEK_MAP[week[1]];
    let diff = target - base.getDay();
    if (diff > 0) diff -= 7; // 取最近已经过去的那个星期几
    return addDays(base, diff);
  }

  if (/前天/.test(raw)) return addDays(base, -2);
  if (/昨天/.test(raw)) return addDays(base, -1);
  if (/今天/.test(raw)) return base;

  return null;
}

function parseClock(raw: string): number | null {
  const m = raw.match(CLOCK_RE);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3]);
  const period = m[1];
  if (
    (period === "下午" || period === "晚上" || period === "傍晚" || period === "中午") &&
    hour < 12
  ) {
    hour += 12;
  }
  if (period === "凌晨" && hour === 12) hour = 0;
  return hour * 60 + minute;
}

const pad = (n: number) => String(n).padStart(2, "0");

/* ------------------------------------------------------------------ */
/* 媒体占位符                                                          */
/* ------------------------------------------------------------------ */

function isBareFilename(note: string): boolean {
  const t = note.trim();
  if (/^(微信图片|微信视频|微信语音|mmexport|RPReplay|VID_|IMG_|Image)[\w.\-]*$/i.test(t)) {
    return true;
  }
  return /^[\w.\-]+\.(dat|jpg|jpeg|png|gif|bmp|webp|mp4|mov|amr|silk|mp3|pdf|docx?|xlsx?|pptx?|zip|rar)$/i.test(
    t,
  );
}

function splitMedia(text: string): { media: MediaKind; note?: string } {
  const m = text.match(MEDIA);
  if (!m) return { media: "text" };
  const rest = text.slice(m[0].length).trim();
  const note = rest && !isBareFilename(rest) ? rest : undefined;
  return { media: MEDIA_MAP[m[1]] ?? "other", note };
}

/* ------------------------------------------------------------------ */
/* 候选策略                                                            */
/* ------------------------------------------------------------------ */

interface RawMessage {
  name: string;
  text: string;
  rawTime: string | null;
  date: Date | null;
  minuteOfDay: number | null;
}

type Strategy = ParseDiagnostics["strategy"];

/** 昵称行候选：往前跳过空行，但不越过上一条的正文太远 */
function nameBefore(lines: string[], index: number): string {
  for (let j = index - 1; j >= Math.max(0, index - 2); j--) {
    const t = lines[j].trim();
    if (t) return t;
  }
  return "";
}

function parseTriple(lines: string[], base: Date): RawMessage[] {
  const stamps: number[] = [];
  lines.forEach((line, i) => {
    if (DATETIME_LINE.test(line.trim())) stamps.push(i);
  });

  const out: RawMessage[] = [];
  stamps.forEach((i, k) => {
    const name = nameBefore(lines, i);
    // 昵称必须存在、不能太长、也不能本身是个时间行
    if (!name || name.length > 40 || DATETIME_LINE.test(name)) return;

    // 正文结束于下一个昵称行之前
    let end = lines.length - 1;
    if (k + 1 < stamps.length) {
      let cursor = stamps[k + 1] - 1;
      while (cursor > i && !lines[cursor].trim()) cursor--;
      end = Math.max(i, cursor - 1);
    }

    const text = lines
      .slice(i + 1, end + 1)
      .map((s) => s.trimEnd())
      .filter((s) => s.trim())
      .join("\n");

    const stampRaw = lines[i].trim();
    out.push({
      name,
      text,
      rawTime: stampRaw,
      date: parseDatePart(stampRaw, base),
      minuteOfDay: parseClock(stampRaw),
    });
  });
  return out;
}

function parseBlock(lines: string[], base: Date): RawMessage[] {
  const out: RawMessage[] = [];
  let current: RawMessage | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const header = trimmed.match(TIME_HEADER);
    if (header) {
      if (current) out.push(current);
      current = {
        name: header[1].trim(),
        text: "",
        rawTime: header[2],
        date: parseDatePart(header[2], base),
        minuteOfDay: parseClock(header[2]),
      };
      continue;
    }
    if (current) {
      current.text = current.text ? `${current.text}\n${trimmed}` : trimmed;
    }
  }
  if (current) out.push(current);
  return out;
}

function parseInline(lines: string[]): RawMessage[] {
  const out: RawMessage[] = [];
  let current: RawMessage | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const header = trimmed.match(INLINE_HEADER);
    if (header) {
      if (current) out.push(current);
      current = {
        name: header[1],
        text: header[2],
        rawTime: null,
        date: null,
        minuteOfDay: null,
      };
    } else if (current) {
      current.text += `\n${trimmed}`;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * 给一个候选策略的表现打分。
 * 有时间戳的策略优先 —— 命中消息头结构比"碰巧有冒号"可信得多。
 */
function scoreMessages(messages: RawMessage[]): number {
  const valid = messages.filter((m) => m.text.trim());
  if (valid.length === 0) return 0;

  const names = new Set(valid.map((m) => m.name)).size;
  if (names === 0) return 0;

  const withTime = valid.filter((m) => m.minuteOfDay !== null).length;
  const timeRatio = withTime / valid.length;
  return valid.length * (0.4 + timeRatio * 0.6) + (withTime > 0 ? 3 : 0);
}

/* ------------------------------------------------------------------ */
/* 主入口                                                              */
/* ------------------------------------------------------------------ */

export function parseChat(input: string, selfName?: string): ParsedChat {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const base = new Date();

  const candidates: { strategy: Strategy; raw: RawMessage[]; score: number }[] = [
    { strategy: "triple", raw: parseTriple(lines, base), score: 0 },
    { strategy: "block", raw: parseBlock(lines, base), score: 0 },
    { strategy: "inline", raw: parseInline(lines), score: 0 },
  ];
  for (const c of candidates) c.score = scoreMessages(c.raw);
  candidates.sort((a, b) => b.score - a.score);

  const chosen = candidates[0];
  const kept = chosen.raw.filter((m) => m.text.trim());

  // 跨天也正确：换算成「距第一条带日期消息的绝对分钟数」
  const firstDate = kept.find((m) => m.date)?.date ?? null;
  const absMinute = (m: RawMessage): number | null => {
    if (m.minuteOfDay === null) return null;
    if (!m.date || !firstDate) return m.minuteOfDay;
    const dayDiff = Math.round(
      (m.date.getTime() - firstDate.getTime()) / 86_400_000,
    );
    return dayDiff * 1440 + m.minuteOfDay;
  };

  const messages: Message[] = kept.map((m, idx) => {
    const { media, note } = splitMedia(m.text);
    return {
      id: `m${idx + 1}`,
      sender: selfName && m.name === selfName ? "self" : "other",
      text: m.text,
      time:
        m.minuteOfDay === null
          ? null
          : `${pad(Math.floor((m.minuteOfDay % 1440) / 60))}:${pad(m.minuteOfDay % 60)}`,
      minute: absMinute(m),
      media,
      note,
    };
  });

  const names = [...new Set(kept.map((m) => m.name))];

  /* ---------------- 诊断 ---------------- */

  const withTime = messages.filter((m) => m.minute !== null).length;
  const timestampRatio = messages.length ? withTime / messages.length : 0;

  const nonEmptyLines = lines.filter((l) => l.trim()).length;
  const consumed = kept.reduce((sum, m) => {
    const body = m.text.split("\n").filter((l) => l.trim()).length;
    return sum + 1 + (m.rawTime ? 1 : 0) + body;
  }, 0);
  const orphanLines = Math.max(0, nonEmptyLines - consumed);

  const warnings: string[] = [];
  if (messages.length === 0) {
    warnings.push("没能识别出聊天内容，请确认粘贴的是聊天记录。");
  } else {
    if (withTime === 0) {
      warnings.push("这些消息没有时间信息，回复间隔等统计不可用。");
    } else if (timestampRatio < 0.8) {
      warnings.push(
        `有 ${messages.length - withTime} 条没解析出时间，相关统计可能偏差。`,
      );
    }
    if (names.length === 1) {
      warnings.push("只识别到一个昵称，确认一下是不是只有一个人说话。");
    }
    if (orphanLines >= 3) {
      warnings.push(`有 ${orphanLines} 行没能归入任何消息，格式可能有变化。`);
    }
  }

  return {
    messages,
    names,
    diagnostics: {
      strategy: chosen.strategy,
      messageCount: messages.length,
      nameCount: names.length,
      timestampRatio,
      orphanLines,
      warnings,
    },
  };
}
