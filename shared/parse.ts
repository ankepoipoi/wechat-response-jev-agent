/**
 * 微信聊天记录解析。纯函数，不依赖任何模型。
 *
 * 支持三种粘贴格式，按优先级自动识别：
 *
 *   A. 多选复制（带完整日期）  昵称 / 日期时间 / 正文   各自一行
 *   B. 多选复制（简版）        昵称 21:03 同行，正文换行
 *   C. 手写速记                昵称：正文
 *
 * 语音 / 图片 / 表情包复制出来只有占位符，占位符后面手写的描述会被记为
 * note（参与分析但注明是转述）；微信自带的 .dat 文件名不当作描述。
 */

import type { MediaKind, Message, ParsedChat } from "./types.ts";

/** 整行只有「日期 时间」，如 2026年09月21日 17:18 / 17:18 / 下午2:05 */
const DATETIME_LINE =
  /^(\d{4}年\d{1,2}月\d{1,2}日)?\s*(上午|下午|凌晨|早上|中午|晚上)?\s*\d{1,2}:\d{2}$/;
/** 「昵称 21:03」—— 昵称与时间之间只有空白 */
const TIME_HEADER =
  /^([^\s:：]{1,24})\s+((?:上午|下午|凌晨|早上|中午|晚上)?\d{1,2}:\d{2})$/;
/** 「昵称：正文」 */
const INLINE_HEADER = /^([^\s:：]{1,24})\s*[:：]\s*(.+)$/;
/** 媒体占位符 */
const MEDIA =
  /^\[(语音|图片|动画表情|表情|视频|视频通话|语音通话|文件|位置|链接|名片|聊天记录|转账|红包)\]/;

const MEDIA_MAP: Record<string, MediaKind> = {
  语音: "voice",
  图片: "image",
  动画表情: "sticker",
  表情: "sticker",
  视频: "video",
  视频通话: "video",
  语音通话: "voice",
  文件: "file",
  位置: "location",
  链接: "link",
  名片: "other",
  聊天记录: "other",
  转账: "other",
  红包: "other",
};

const DATE_RE = /(\d{4})年(\d{1,2})月(\d{1,2})日/;
const CLOCK_RE = /(上午|下午|凌晨|早上|中午|晚上)?\s*(\d{1,2}):(\d{2})/;

const pad = (n: number) => String(n).padStart(2, "0");

/** 从「2026年09月21日 17:18」这类文本里抽出日期与当天分钟数 */
function parseStamp(raw: string): { date: Date | null; minuteOfDay: number } | null {
  const t = raw.match(CLOCK_RE);
  if (!t) return null;
  let hour = Number(t[2]);
  const minute = Number(t[3]);
  const period = t[1];
  if ((period === "下午" || period === "晚上" || period === "中午") && hour < 12) {
    hour += 12;
  }
  const d = raw.match(DATE_RE);
  return {
    date: d ? new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])) : null,
    minuteOfDay: hour * 60 + minute,
  };
}

/** 微信自带的文件名不是有效描述 */
function isBareFilename(note: string): boolean {
  return /^(微信图片|微信视频|微信语音|mmexport|RPReplay)[\w-]*\.\w+$/i.test(note.trim());
}

function splitMedia(text: string): { media: MediaKind; note?: string } {
  const m = text.match(MEDIA);
  if (!m) return { media: "text" };
  const rest = text.slice(m[0].length).trim();
  const note = rest && !isBareFilename(rest) ? rest : undefined;
  return { media: MEDIA_MAP[m[1]] ?? "other", note };
}

/** 一行是否是「时间行」而不是正文 —— 用于避免把正文里的 12:30 误判 */
function isDatetimeLine(line: string): boolean {
  return DATETIME_LINE.test(line.trim());
}

interface RawMessage {
  name: string;
  text: string;
  rawTime: string | null;
  date: Date | null;
  minuteOfDay: number | null;
}

/** 格式 A：昵称 / 日期时间 / 正文，各自独立成行 */
function parseTriple(lines: string[]): RawMessage[] {
  const stamps: number[] = [];
  lines.forEach((l, i) => {
    if (isDatetimeLine(l)) stamps.push(i);
  });

  const out: RawMessage[] = [];
  stamps.forEach((i, k) => {
    const name = (lines[i - 1] ?? "").trim();
    if (!name || name.length > 24) return;
    const end = k + 1 < stamps.length ? stamps[k + 1] - 2 : lines.length - 1;
    const text = lines
      .slice(i + 1, end + 1)
      .map((s) => s.trimEnd())
      .filter((s) => s.trim())
      .join("\n");
    const timeText = lines[i].trim();
    const stamp = parseStamp(timeText);
    out.push({
      name,
      text,
      rawTime: timeText,
      date: stamp?.date ?? null,
      minuteOfDay: stamp?.minuteOfDay ?? null,
    });
  });
  return out;
}

/** 格式 B：昵称与时间同行，正文在下一行起 */
function parseBlock(lines: string[]): RawMessage[] {
  const out: RawMessage[] = [];
  let current: RawMessage | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const t = trimmed.match(TIME_HEADER);
    if (t) {
      if (current) out.push(current);
      const stamp = parseStamp(t[2]);
      current = {
        name: t[1],
        text: "",
        rawTime: t[2],
        date: null,
        minuteOfDay: stamp?.minuteOfDay ?? null,
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

/** 格式 C：每行一条「昵称：正文」 */
function parseInline(lines: string[]): RawMessage[] {
  const out: RawMessage[] = [];
  let current: RawMessage | null = null;

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    const i = trimmed.match(INLINE_HEADER);
    if (i) {
      if (current) out.push(current);
      current = {
        name: i[1],
        text: i[2],
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
 * 解析整段粘贴文本。
 *
 * 跨天也没问题：带日期的格式会换算成「距第一条消息的绝对分钟数」，
 * 所以「昨天 23:50 → 今天 08:10」算出来是 500 分钟，不是负数。
 */
export function parseChat(input: string, selfName?: string): ParsedChat {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");

  let raw: RawMessage[];
  if (lines.some(isDatetimeLine)) raw = parseTriple(lines);
  else if (lines.some((l) => TIME_HEADER.test(l.trim()))) raw = parseBlock(lines);
  else raw = parseInline(lines);

  const kept = raw.filter((m) => m.text.trim().length > 0);

  // 以第一条带日期的消息为基准，换算绝对分钟
  const base = kept.find((m) => m.date)?.date ?? null;
  const absMinute = (m: RawMessage): number | null => {
    if (m.minuteOfDay === null) return null;
    if (!m.date || !base) return m.minuteOfDay;
    const dayDiff = Math.round(
      (m.date.getTime() - base.getTime()) / 86_400_000,
    );
    return dayDiff * 1440 + m.minuteOfDay;
  };

  const messages: Message[] = kept.map((m, idx) => {
    const { media, note } = splitMedia(m.text);
    const abs = absMinute(m);
    return {
      id: `m${idx + 1}`,
      sender: selfName && m.name === selfName ? "self" : "other",
      text: m.text,
      time: m.minuteOfDay === null
        ? null
        : `${pad(Math.floor((m.minuteOfDay % 1440) / 60))}:${pad(m.minuteOfDay % 60)}`,
      minute: abs,
      media,
      note,
    };
  });

  return {
    messages,
    names: [...new Set(kept.map((m) => m.name))],
  };
}
