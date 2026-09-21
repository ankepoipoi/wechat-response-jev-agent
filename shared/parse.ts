/**
 * 微信聊天记录解析。纯函数，不依赖任何模型。
 *
 * 支持两种粘贴格式：
 *   A. 微信多选复制（多行）：  「昵称 21:03」换行「正文」
 *   B. 手写速记（单行）：      「昵称：正文」
 *
 * 语音 / 图片 / 表情包在微信里复制出来只是占位符，
 * 占位符后面手写的描述会被记为 note，参与分析但注明是转述。
 */

import type { MediaKind, Message, ParsedChat } from "./types.ts";

/** 「昵称 21:03」「昵称 下午2:05」—— 昵称与时间之间只有空白 */
const TIME_HEADER =
  /^([^\s:：]{1,24})\s+((?:上午|下午|凌晨|早上|中午|晚上)?\d{1,2}:\d{2})$/;
/** 「昵称：正文」 */
const INLINE_HEADER = /^([^\s:：]{1,24})\s*[:：]\s*(.+)$/;
/** 媒体占位符 */
const MEDIA = /^\[(语音|图片|动画表情|表情|视频|文件|位置|链接|名片|聊天记录)\]/;

const MEDIA_MAP: Record<string, MediaKind> = {
  语音: "voice",
  图片: "image",
  动画表情: "sticker",
  表情: "sticker",
  视频: "video",
  文件: "file",
  位置: "location",
  链接: "link",
  名片: "other",
  聊天记录: "other",
};

function parseMinute(raw: string): number | null {
  const m = raw.match(/(上午|下午|凌晨|早上|中午|晚上)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  let hour = Number(m[2]);
  const minute = Number(m[3]);
  const period = m[1];
  if ((period === "下午" || period === "晚上" || period === "中午") && hour < 12) {
    hour += 12;
  }
  return hour * 60 + minute;
}

function splitMedia(text: string): { media: MediaKind; note?: string } {
  const m = text.match(MEDIA);
  if (!m) return { media: "text" };
  const rest = text.slice(m[0].length).trim();
  return { media: MEDIA_MAP[m[1]] ?? "other", note: rest || undefined };
}

export interface RawMessage {
  id: string;
  name: string;
  text: string;
  time: string | null;
  minute: number | null;
  media: MediaKind;
  note?: string;
}

function finalize(list: RawMessage[]) {
  return list.filter((m) => m.text.trim().length > 0);
}

/**
 * 解析整段粘贴文本。id 在此生成，保证前后端一致。
 * selfName 由用户在界面上指定，这里只负责切分与抽取昵称。
 */
export function parseChat(input: string, selfName?: string): ParsedChat {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const block = lines.some((l) => TIME_HEADER.test(l.trim()));

  const out: RawMessage[] = [];
  let current: RawMessage | null = null;

  const push = (m: RawMessage | null) => {
    if (m) out.push(m);
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (block) {
      const t = trimmed.match(TIME_HEADER);
      if (t) {
        push(current);
        current = {
          id: `m${out.length + 1}`,
          name: t[1],
          text: "",
          time: t[2],
          minute: parseMinute(t[2]),
          media: "text",
        };
        continue;
      }
      if (current) {
        current.text = current.text ? `${current.text}\n${trimmed}` : trimmed;
      }
      continue;
    }

    // 手写速记：每一行都是一条消息
    const i = trimmed.match(INLINE_HEADER);
    if (i) {
      push(current);
      current = {
        id: `m${out.length + 1}`,
        name: i[1],
        text: i[2],
        time: null,
        minute: null,
        media: "text",
      };
    } else if (current) {
      current.text += `\n${trimmed}`;
    }
  }
  push(current);

  const cleaned = finalize(out).map((m, idx) => {
    const { media, note } = splitMedia(m.text);
    return { ...m, id: `m${idx + 1}`, media, note };
  });

  const names = [...new Set(cleaned.map((m) => m.name))];

  return {
    messages: cleaned.map((m) => ({
      id: m.id,
      sender: selfName && m.name === selfName ? "self" : "other",
      text: m.text,
      time: m.time,
      minute: m.minute,
      media: m.media,
      note: m.note,
    })) satisfies Message[],
    names,
  };
}
