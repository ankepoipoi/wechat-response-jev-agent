/**
 * 「最能拉近距离的回复」生成。
 *
 * 这里不碰 Jev —— Jev 只判断不生成。做法是把最近的聊天原文交给
 * 生成式大模型，要求它模仿这段对话本身的语感来写回复。
 */

import type {
  Message,
  SuggestRequest,
  SuggestResult,
  Suggestion,
} from "../shared/types.ts";
import { LlmError, chatComplete, extractJson, type LlmConfig } from "./llm.ts";

/** 写回复主要看最近的上下文，不必把整段历史都塞进去 */
const CONTEXT_LIMIT = 40;

const SYSTEM = `你是一个中文聊天回复助手，帮用户把微信消息回好。

你只做一件事：根据两个人的聊天记录，站在其中一方的角度，写出当下最合适的回复。

硬性要求：
1. 严格模仿这段聊天里的说话风格 —— 用词习惯、语气亲疏、标点、是否爱用表情、有没有叠词或谐音梗。
2. 长度贴近双方平时的消息长度，不要突然变长、变正式。
3. 不要客套话、客服腔、书面语，要像他们本人会打出来的字。
4. 紧扣对方最后表达的情绪或诉求，不要答非所问。
5. 不写操纵、贬低、冷暴力或试探底线的内容。目标是坦诚地表达在意，而不是控制对方。

只输出 JSON，不要任何额外说明：
{"suggestions":[{"text":"可以直接发出的回复","reason":"为什么这句能拉近距离（一句话）","tone":"策略概括，4 字以内"}]}`;

/** 把聊天记录整理成给模型看的文本（导出以便测试） */
export function formatChat(messages: Message[], selfName: string): string {
  return messages
    .map((m) => {
      const who = m.sender === "self" ? `${selfName}（你）` : "对方";
      const body = m.note ? `${m.text}（这是用户转述：${m.note}）` : m.text;
      return `${m.time ? `[${m.time}] ` : ""}${who}：${body}`;
    })
    .join("\n");
}

export async function suggestReplies(
  cfg: LlmConfig,
  req: SuggestRequest,
): Promise<SuggestResult> {
  const recent = req.messages.slice(-CONTEXT_LIMIT);
  const chat = formatChat(recent, req.selfName);

  const styleHint =
    req.avgLength && req.avgLength > 0
      ? `对方平时平均每条约 ${Math.round(req.avgLength)} 个字，回复长度要贴近这个量级。`
      : "";

  const userPrompt = `【聊天记录（按时间顺序，最后一条是最新的）】
${chat}

【任务】
以「${req.selfName}」的身份，写出 3 条现在发出去的回复，目标是让关系更亲近、让对方感到被在意。
${styleHint}

3 条各用不同策略，例如：先接住情绪 / 顺着对方的梗接话 / 主动表达自己的感受 / 推进一件具体的事。
优先复用聊天记录里已经出现过的词和语气，不要引入一套新的说话风格。`;

  const { content, usage } = await chatComplete(cfg, [
    { role: "system", content: SYSTEM },
    { role: "user", content: userPrompt },
  ]);

  const parsed = extractJson(content) as { suggestions?: unknown };
  const raw = Array.isArray(parsed.suggestions) ? parsed.suggestions : [];

  const suggestions: Suggestion[] = raw
    .map((item) => {
      const s = (item ?? {}) as Record<string, unknown>;
      return {
        text: String(s.text ?? "").trim(),
        reason: String(s.reason ?? "").trim(),
        tone: String(s.tone ?? "").trim(),
      };
    })
    .filter((s) => s.text.length > 0)
    .slice(0, 5);

  if (suggestions.length === 0) {
    throw new LlmError("大模型没有给出可用的回复建议", 502);
  }

  return {
    suggestions,
    model: cfg.model,
    usage,
    usedMessages: recent.length,
  };
}
