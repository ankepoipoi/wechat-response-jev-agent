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
  type AnalysisResult,
  type AnalyzeRequest,
  type Message,
  type MessageInsight,
  type ReplyReview,
} from "../shared/types.ts";
import {
  combineAffinity,
  compareBaseline,
  computeStats,
  reviewReply,
} from "../shared/metrics.ts";
import { askJev, topTags, type Question } from "./jev.ts";

const EMOTION_HINT: Record<string, string> = {
  joy: "语气轻快、有笑意、表达高兴或满足",
  anticipation: "期待某事、盼望见面或继续聊",
  trust: "放松、安心、愿意托付或倾诉",
  flirt: "暧昧、试探、带有好感的暗示",
  gratitude: "表达感谢、领情",
  surprise: "意外、没料到",
  neutral: "平静陈述，没有明显情绪",
  curiosity: "好奇、想追问、想了解更多",
  fatigue: "累、困、提不起劲",
  sadness: "低落、失落、委屈",
  anxiety: "担心、不安、患得患失",
  annoyance: "不耐烦、嫌烦、语气发硬",
  anger: "生气、指责、明显不满",
  distance: "冷淡、保持距离、刻意疏远",
};

const INTENT_HINT: Record<string, string> = {
  share: "分享自己的日常、见闻、状态",
  ask: "提出问题或请求帮助",
  invite: "提出见面、邀约、一起做某事",
  praise: "夸奖、认可、表示欣赏",
  comfort: "安慰、关心对方",
  tease: "开玩笑、调侃、逗对方",
  flirt: "暧昧试探、释放好感信号",
  explain: "解释原因、说明情况",
  complain: "吐槽、抱怨某事或某人",
  refuse: "拒绝、推脱、婉拒",
  apologize: "道歉、表示歉意",
  thanks: "道谢",
  end: "结束话题、示意要停了",
  other: "不属于以上任何一类",
};

const WARMTH_LEVELS = [
  "明显在拉开距离：敷衍、不接话、只回最少字",
  "客气但有距离：礼貌回应，不主动延伸话题",
  "平稳交流：有来有回，话题能接住",
  "比较投入：会主动延伸话题、追问细节",
  "很投入：主动分享、主动找话题、情绪外露",
];

const QUALITY_LEVELS = [
  "把天聊死了：敷衍、答非所问或冷场",
  "接住了但没延伸：回应正确，话题到此为止",
  "接住并有来有回：有回应也有推进",
  "很好地推进：接住对方情绪、给出细节、抛出新话题",
];

const QUESTION_RE =
  /[？?]|吗[？?。.!！~～]*$|呢[？?。.!！~～]*$|吧[？?。.!！~～]*$|要不要|能不能|可不可以|好不好|行不行|想不想|有没有|是不是|在吗|在么/;
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
): Promise<AnalysisResult> {
  const started = Date.now();
  const messages = req.messages;

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
        instructions: `这条回复「${snippet}」接住了对方上一句吗？`,
        criteria: QUALITY_LEVELS,
      };
    }
  }

  questions["warmth"] = {
    type: "score",
    instructions: "整体来看，对方在这段对话里的投入程度是？",
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
  };
}
