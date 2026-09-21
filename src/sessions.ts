/**
 * 保存的聊天记录：读写 localStorage，以及「新内容接到旧内容下面」的合并逻辑。
 *
 * 注意：聊天记录只存在这台电脑的浏览器里，没有服务端，也不会上传。
 */

import type { Session } from "../shared/types.ts";
import { parseChat } from "../shared/parse.ts";

const KEY = "echo.sessions.v1";

export function loadSessions(): Session[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as Session[];
    if (!Array.isArray(list)) return [];
    return list
      .filter((s) => s && typeof s.id === "string")
      .map((s) => ({
        ...s,
        name: s.name || "未命名",
        createdAt: s.createdAt ?? Date.now(),
        updatedAt: s.updatedAt ?? Date.now(),
        result: s.result ?? null,
        selfName: s.selfName ?? null,
        // 关系阶段是后加的字段，老记录没有，默认按 crush 处理
        relation: s.relation === "dating" ? "dating" : "crush",
      }));
  } catch {
    return [];
  }
}

export function persistSessions(list: Session[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // 超出配额时静默失败：不影响正在进行的分析
  }
}

export function makeSessionId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 把新粘贴的内容接到已有内容下面。
 *
 * 微信「多选复制」经常和上次复制的内容有重叠（顺手连上次最后几条一起选了）。
 * 这里会找「已有内容的尾部」与「新内容的头部」之间最长的非空行重叠，
 * 只接上没出现过的部分，避免同一条消息被分析两遍。
 */
export function appendWithoutOverlap(oldText: string, newText: string): string {
  const base = oldText.replace(/\s+$/, "");
  const incoming = newText.replace(/\s+$/, "");

  if (!base.trim()) return incoming;
  if (!incoming.trim()) return base;

  const baseSig = base
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const newLines = incoming.split("\n");
  const newSig = newLines.map((l) => l.trim()).filter(Boolean);

  let overlap = 0;
  const max = Math.min(baseSig.length, newSig.length);
  for (let k = max; k > 0; k--) {
    const tail = baseSig.slice(baseSig.length - k);
    const head = newSig.slice(0, k);
    if (tail.every((line, i) => line === head[i])) {
      overlap = k;
      break;
    }
  }

  let dropped = 0;
  const kept = newLines.filter((line) => {
    if (line.trim() && dropped < overlap) {
      dropped++;
      return false;
    }
    return true;
  });

  const tail = kept
    .join("\n")
    .replace(/^\s*\n+/, "")
    .replace(/\s+$/, "");

  if (!tail.trim()) return base;
  return `${base}\n\n${tail}`;
}

/**
 * 把新内容追加进一段记录。
 *
 * 纯函数：不改动传入的对象，返回新记录对象和实际新增的条数。
 * 界面上「粘贴即自动保存」走的就是这里，所以它必须可测。
 */
export function appendToSession(
  session: Session,
  incoming: string,
  selfName: string | null,
): { session: Session; added: number } {
  const messagesOf = (text: string) =>
    parseChat(text, selfName ?? undefined).messages.length;

  const before = messagesOf(session.input);
  const merged = appendWithoutOverlap(session.input, incoming);
  const after = messagesOf(merged);

  return {
    session: { ...session, input: merged, updatedAt: Date.now() },
    added: after - before,
  };
}

/** 相对时间描述，列表里用 */
export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(ts).toLocaleDateString("zh-CN");
}
