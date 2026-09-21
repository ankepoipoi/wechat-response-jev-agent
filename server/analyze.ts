/**
 * 分析编排。
 *
 * 一次请求问完全部问题：Jev 会并行评估，多问几个几乎不增加延迟。
 * 这里只负责「提问」和「把答案落到结构里」，
 * 真正的分数计算在 shared/metrics.ts，模型拿不到计算权。
 */

import {
  EMOTIONS,
  EMOTION_MAP,
  INTENTS,
  INTENT_MAP,
  RELATION_DESC,
  type AnalysisResult,
  type AnalyzeRequest,
  type Message,
  type MessageInsight,
  type ReplyReview,
} from "../shared/types.ts";
import {
  QUESTION_RE,
  combineAffinity,
  compareBaseline,
  computeStats,
  reviewReply,
} from "../shared/metrics.ts";
import { askJev, topTags, type Question } from "./jev.ts";
import { QUALITY_LEVELS } from "./jev-frames.ts";

/**
 * 这些描述会随每一条消息重复出现在请求里，是 token 消耗的大头。
 * 所以刻意写短 —— 保留区分度所需的关键词就够了，长篇描述会把
 * 长对话顶出模型上下文。
 */

const EMOTION_HINT: Record<string, string> = {
  joy: "高兴、有笑意",
  anticipation: "期待、想继续",
  trust: "放松、安心",
  flirt: "暧昧、暗示好感",
  gratitude: "道谢、领情",
  surprise: "意外、没料到",
  neutral: "平静陈述",
  curiosity: "好奇、想追问",
  fatigue: "累、困",
  sadness: "低落、委屈",
  anxiety: "担心、不安",
  annoyance: "不耐烦",
  anger: "生气、指责",
  distance: "冷淡、疏远",
};

const INTENT_HINT: Record<string, string> = {
  share: "分享日常见闻",
  ask: "提问或求助",
  invite: "邀约、提议一起",
  praise: "夸奖认可",
  comfort: "安慰关心",
  tease: "开玩笑调侃",
  flirt: "暧昧试探",
  explain: "解释说明",
  complain: "吐槽抱怨",
  refuse: "拒绝推脱",
  apologize: "道歉",
  thanks: "道谢",
  end: "收尾结束",
  other: "以上都不是",
};

const WARMTH_LEVELS = [
  "明显拉开距离：敷衍、不接话",
  "客气但有距离：礼貌、不延伸",
  "平稳交流：有来有回",
  "比较投入：会主动延伸话题",
  "很投入：主动分享、情绪外露",
];

const BRUSH_OFF = /^(嗯|哦|好|好的|行|可以|哈哈|😂|👍|ok|OK|是的|对)[。.！!~～\s]*$/i;

function formatState(messages: Message[]): string {
  return messages
    .map((m) => {
      const who = m.sender === "self" ? "我" : "对方";
      const time = m.time ? `[${m.time}] ` : "";
      const body = m.note ? `${m.text}（这段是用户手动转述，不是原始文字：${m.note}）` : m.text;
      return `${time}${who}：${body}`;
    })
    .join("\n");
}

/** 截出写进问题里的句子片段，太长会挤占 token */
function snippetOf(m: Message): string {
  const raw = (m.note ? `${m.text}（转述：${m.note}）` : m.text)
    .replace(/\s+/g, " ")
    .trim();
  return raw.length > 60 ? `${raw.slice(0, 60)}…` : raw;
}

/** 程序判断：对方这句话值得回应，但没有被接住 */
function isDropped(messages: Message[], index: number): boolean {
  const cur = messages[index];
  if (cur.sender !== "other") return false;
  if (!QUESTION_RE.test(cur.text)) return false;
  const next = messages[index + 1];
  if (!next) return true;
  if (next.sender !== "self") return false;
  return BRUSH_OFF.test(next.text.trim());
}

export async function analyzeChat(
  req: AnalyzeRequest,
  apiKey: string,
  maxMessages = 120,
): Promise<AnalysisResult> {
  const started = Date.now();

  /**
   * 逐句判断会把「情绪 + 意图」的描述按消息条数重复进请求，条数一多就会
   * 顶爆模型上下文。所以超长对话只分析最近的 maxMessages 条 ——
   * 近期对话对当下关系状态的判断更有意义，也保证请求不会失败。
   */
  const all = req.messages;
  const truncated = all.length > maxMessages;
  const messages = truncated ? all.slice(-maxMessages) : all;

  // 关系阶段要贯穿所有判断：crush 期的"秒回"和恋爱期的"秒回"含义不同，
  // 同一句"我错了"在两个阶段的合适程度也完全不一样
  const relationNote = req.relation ? `（背景：${RELATION_DESC[req.relation]}）` : "";

  const questions: Record<string, Question> = {};
  const analyzable: Message[] = [];

  for (const m of messages) {
    // 没有内容、也没补充说明的媒体占位符不参与分析
    if ((m.media !== "text" || !m.text.trim()) && !m.note) continue;
    analyzable.push(m);

    // 关键：Jev 不会把问题 id 发给模型，每个问题必须自带完整语义。
    // 逐句判断时要把句子原文写进 instructions，否则所有句子会得到同一组答案。
    const snippet = snippetOf(m);

    questions[`${m.id}_emo`] = {
      type: "choice",
      instructions: `这一句「${snippet}」——说这句话时的情绪是？`,
      criteria: Object.fromEntries(
        EMOTIONS.map((e) => [e.key, EMOTION_HINT[e.key] ?? e.label]),
      ),
    };
    questions[`${m.id}_int`] = {
      type: "choice",
      instructions: `这一句「${snippet}」——说这句话的意图是？`,
      criteria: Object.fromEntries(
        INTENTS.map((i) => [i.key, INTENT_HINT[i.key] ?? i.label]),
      ),
    };
    if (m.sender === "self") {
      questions[`${m.id}_q`] = {
        type: "score",
        instructions: `这条回复「${snippet}」接住了对方上一句吗？${relationNote}`,
        criteria: QUALITY_LEVELS,
      };
    }
  }

  questions["warmth"] = {
    type: "score",
    instructions: `整体来看，对方在这段对话里的投入程度是？${relationNote}`,
    criteria: WARMTH_LEVELS,
  };

  const jev = await askJev(apiKey, formatState(messages), questions);

  const insights: MessageInsight[] = analyzable.map((m) => ({
    id: m.id,
    emotions: topTags(jev.answers[`${m.id}_emo`], (k) => EMOTION_MAP[k]?.label ?? k),
    intents: topTags(jev.answers[`${m.id}_int`], (k) => INTENT_MAP[k]?.label ?? k),
    dropped: isDropped(messages, messages.indexOf(m)),
  }));

  const warmth = jev.answers["warmth"];
  const stats = computeStats(messages);
  const affinity = combineAffinity(
    warmth?.score ?? 2,
    warmth?.confidence ?? 0.3,
    stats,
  );

  const reviews: ReplyReview[] = [];
  analyzable.forEach((m) => {
    if (m.sender !== "self") return;
    const idx = messages.indexOf(m);
    let prevOther: Message | null = null;
    for (let i = idx - 1; i >= 0; i--) {
      if (messages[i].sender === "other") {
        prevOther = messages[i];
        break;
      }
    }
    const quality = jev.answers[`${m.id}_q`]?.score ?? 2;
    reviews.push(reviewReply(m, prevOther, quality));
  });

  return {
    model: jev.model,
    usage: jev.usage,
    latencyMs: Date.now() - started,
    insights,
    affinity,
    stats,
    reviews,
    baselineNote: compareBaseline(stats, req.baseline ?? null),
    analyzedCount: messages.length,
    ...(truncated ? { truncatedFrom: all.length } : {}),
  };
}
