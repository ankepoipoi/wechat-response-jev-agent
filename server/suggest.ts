/**
 * 「最能拉近距离的回复」—— 生成 + 评分。
 *
 * 分工是刻意的：
 *   1. **生成**交给生成式大模型（DeepSeek 等）。Jev 不会写句子。
 *      但 prompt 里会带上 Jev 对这段对话的判断结果，以及 Jev 的评分标尺 ——
 *      让写的人知道"会被按什么标准评判"，朝着高分去写。
 *   2. **评分**交回 Jev。用与给你自己回复评级**完全相同的** reviewReply +
 *      QUALITY_LEVELS，所以"建议的分数"和"你自己回复的分数"是同一把尺子，
 *      可以直接比。
 */

import type {
  AnalysisResult,
  Message,
  SuggestRequest,
  SuggestResult,
  Suggestion,
} from "../shared/types.ts";
import { reviewReply } from "../shared/metrics.ts";
import { askJev, type JevAnswer, type Question } from "./jev.ts";
import { QUALITY_LEVELS, qualityRubricForPrompt } from "./jev-frames.ts";
import { LlmError, chatComplete, extractJson, type LlmConfig } from "./llm.ts";

/** 写回复主要看最近的上下文，不必把整段历史都塞进去 */
const CONTEXT_LIMIT = 40;
/** Jev 评分不该拖太久，它只是锦上添花 */
const JEV_SCORE_TIMEOUT = 30_000;

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

/**
 * 把 Jev 的判断结果压成一段「诊断」，作为生成时的参考。
 * 关键是两条：对方现在的状态，以及我哪里接得不好（避免重蹈覆辙）。
 */
export function formatDiagnosis(
  analysis: AnalysisResult | null | undefined,
  messages: Message[],
): string {
  if (!analysis) return "";
  const lines: string[] = [];

  const { affinity, stats } = analysis;
  lines.push(
    `互动温度 ${affinity.value}/100（构成：模型判断 ${affinity.breakdown.modelScore} + 行为统计 ${affinity.breakdown.behaviorScore}）`,
  );

  const bits: string[] = [];
  if (stats.replyMinutes !== null) {
    bits.push(`对方平均 ${stats.replyMinutes.toFixed(1)} 分钟回一次`);
  }
  if (stats.avgLength !== null) bits.push(`平均每条 ${stats.avgLength.toFixed(1)} 个字`);
  bits.push(`对方主动开口 ${stats.initiativeCount} 次`);
  if (stats.questionRate !== null) {
    bits.push(`以问句结尾占 ${Math.round(stats.questionRate * 100)}%`);
  }
  if (bits.length) lines.push(bits.join("；"));

  // 对方最近几句的情绪与意图
  const insightById = new Map(analysis.insights.map((i) => [i.id, i]));
  const emotive = messages
    .filter((m) => m.sender === "other")
    .slice(-5)
    .map((m) => {
      const ins = insightById.get(m.id);
      if (!ins) return null;
      const emo = ins.emotions
        .slice(0, 2)
        .map((t) => `${t.label}${Math.round(t.probability * 100)}%`)
        .join("/");
      const intent = ins.intents
        .slice(0, 2)
        .map((t) => `${t.label}${Math.round(t.probability * 100)}%`)
        .join("/");
      return `  「${m.text.slice(0, 24)}」→ 情绪 ${emo}；意图 ${intent}`;
    })
    .filter((x): x is string => x !== null);

  if (emotive.length) {
    lines.push("对方最近几句被判断为：");
    lines.push(...emotive);
  }

  // 我最近被判接得不好的回复 —— 明确点出来，避免重复同样的毛病
  const reviewById = new Map(analysis.reviews.map((r) => [r.id, r]));
  const weak = messages
    .filter((m) => m.sender === "self")
    .map((m) => ({ m, r: reviewById.get(m.id) }))
    .filter((x) => x.r && (x.r.grade === "C" || x.r.grade === "D"))
    .slice(-3);

  if (weak.length) {
    lines.push("我最近的回复里被判定接得不好的（写新回复时要避开这些毛病）：");
    for (const { m, r } of weak) {
      lines.push(`  「${m.text.slice(0, 24)}」→ ${r!.grade} 级，${r!.tip}`);
    }
  }

  return lines.join("\n");
}

/** 最后一条对方消息，评分时当作「要回应的对象」 */
function lastOtherMessage(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].sender === "other") return messages[i];
  }
  return null;
}

export async function suggestReplies(
  cfg: LlmConfig,
  req: SuggestRequest,
  typesafeKey: string,
): Promise<SuggestResult> {
  const started = Date.now();

  const recent = req.messages.slice(-CONTEXT_LIMIT);
  const chat = formatChat(recent, req.selfName);
  const diagnosis = formatDiagnosis(req.analysis, req.messages);

  const styleHint =
    req.avgLength && req.avgLength > 0
      ? `对方平时平均每条约 ${Math.round(req.avgLength)} 个字，回复长度要贴近这个量级。`
      : "";

  const userPrompt = `【聊天记录（按时间顺序，最后一条是最新的）】
${chat}
${diagnosis ? `\n【系统对这段对话的判断（供参考，别照抄）】\n${diagnosis}\n` : ""}
【你的回复将被这样评分】
${qualityRubricForPrompt()}
3 分是满分。特别注意：只"接住"只有 1 分，要拿到 2~3 分，
必须在接住的同时**带出新的东西** —— 一个具体的细节、一个明确的安排、或一个新的问题。
但这不意味着要把句子写长：保持对方熟悉的短句节奏，只是每一句都要有信息增量。

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
        review: null,
      };
    })
    .filter((s) => s.text.length > 0)
    .slice(0, 5);

  if (suggestions.length === 0) {
    throw new LlmError("大模型没有给出可用的回复建议", 502);
  }

  const scored = await scoreSuggestions(typesafeKey, recent, suggestions, req.selfName);

  // 把 Jev 给分最高的排到最前 —— 用户要的是「最能提升好感度的那一条」
  if (scored) {
    suggestions.sort((a, b) => (b.review?.score ?? -1) - (a.review?.score ?? -1));
  }

  return {
    suggestions,
    model: cfg.model,
    usage,
    usedMessages: recent.length,
    scored,
    latencyMs: Date.now() - started,
  };
}

/**
 * 交给 Jev 按同一套标准打分。
 *
 * 评分失败不影响建议本身 —— 只是没有分数，前端会说明。
 * 因为「建议」比「没有建议」有用得多。
 */
async function scoreSuggestions(
  apiKey: string,
  messages: Message[],
  suggestions: Suggestion[],
  selfName: string,
): Promise<boolean> {
  if (!apiKey.trim()) return false;

  const questions: Record<string, Question> = {};
  suggestions.forEach((s, i) => {
    const snippet = s.text.length > 60 ? `${s.text.slice(0, 60)}…` : s.text;
    questions[`sug${i}_q`] = {
      type: "score",
      instructions: `「${selfName}」准备这样回复：「${snippet}」——这条回复接住对方了吗？`,
      criteria: QUALITY_LEVELS,
    };
  });

  const state = messages
    .map((m) => {
      const who = m.sender === "self" ? selfName : "对方";
      const time = m.time ? `[${m.time}] ` : "";
      const body = m.note ? `${m.text}（用户转述：${m.note}）` : m.text;
      return `${time}${who}：${body}`;
    })
    .join("\n");

  let answers: Record<string, JevAnswer> = {};
  try {
    const jev = await askJev(apiKey, state, questions, JEV_SCORE_TIMEOUT);
    answers = jev.answers;
  } catch (err) {
    console.warn("[suggest] Jev 评分失败，仍返回建议：", (err as Error).message);
    return false;
  }

  const lastOther = lastOtherMessage(messages);

  suggestions.forEach((s, i) => {
    const quality = answers[`sug${i}_q`]?.score ?? 2;
    // 包成一条临时消息，复用给「我」的回复评级的那同一个函数，保证标尺一致
    const probe: Message = {
      id: `sug${i}`,
      sender: "self",
      text: s.text,
      time: null,
      minute: null,
      media: "text",
    };
    s.review = reviewReply(probe, lastOther, quality);
  });

  return true;
}
