/**
 * 纯函数统计层。
 *
 * 这个文件里的每一个数字都是算出来的，不是模型说的。
 * 模型只负责分类与打分（Jev 的 choice / score），
 * 好感度的构成、回复评级、趋势对比全部由这里的函数决定。
 */

import type {
  Affinity,
  Baseline,
  BehaviorStats,
  Grade,
  Message,
  ReplyReview,
} from "./types.ts";

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));

/**
 * 中文提问识别。聊天里很少有人打问号，
 * 「要不要…」「你在吗」「我可爱不」这类都是把话抛回去，不能漏掉。
 * 这个正则是单一来源，analyze.ts 也复用，避免两处判断不一致。
 */
export const QUESTION_RE =
  /[？?]|吗[。.!！~～]*$|呢[。.!！~～]*$|吧[。.!！~～]*$|不[。.!！~～]*$|怎么|如何|为什么|要不要|能不能|可不可以|好不好|行不行|想不想|有没有|是不是|几点|在哪|在吗|在么/;

/**
 * 亲昵表达。很短，但绝不是敷衍 —— 这类回复维持的是温度，不是信息量，
 * 不能按「太短」扣分，否则会把情侣间的正常互动误判成差评。
 */
const AFFECTION_RE =
  /^(抱抱|抱一下|宝宝|宝贝|小宝贝|想你|想你了|亲亲|么么|爱你|贴贴|蹭蹭|乖乖|乖|老婆|老公|晚安|早安|好梦|在呢|嗯呢|mua|啵啵)[。.!！~～\s]*$/i;
/** 敷衍式应答：短且没有信息量 */
const BRUSH_OFF = /^(嗯|哦|好|好的|行|可以|哈哈|哈哈哈哈|😂|👍|ok|OK|okay|是的|对|是的呢)[。.！!~～\s]*$/i;

/* ------------------------------------------------------------------ */
/* 行为统计                                                            */
/* ------------------------------------------------------------------ */

export function computeStats(messages: Message[]): BehaviorStats {
  const other = messages.filter((m) => m.sender === "other");

  // 对方回复「我」的间隔：找到每条对方消息之前最近的一条我的消息
  const gaps: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const cur = messages[i];
    if (cur.sender !== "other" || cur.minute === null) continue;
    const curMinute = cur.minute;
    for (let j = i - 1; j >= 0; j--) {
      const prev = messages[j];
      if (prev.sender === "self") {
        if (prev.minute !== null && curMinute !== null) {
          const gap = curMinute - prev.minute;
          if (gap >= 0 && gap <= 720) gaps.push(gap);
        }
        break;
      }
    }
  }

  const lengths = other
    .filter((m) => m.media === "text" || m.note)
    .map((m) => Array.from(m.note ?? m.text).length)
    .filter((n) => n > 0);

  // 主动开口：对方那条消息的上一句是自己的（即对方开始了新一轮）
  let initiative = 0;
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].sender !== "other") continue;
    const prev = messages[i - 1];
    if (!prev || prev.sender === "self") initiative++;
  }

  const withQuestion = other.filter((m) => QUESTION_RE.test(m.text)).length;

  return {
    replyMinutes: gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : null,
    avgLength: lengths.length
      ? lengths.reduce((a, b) => a + b, 0) / lengths.length
      : null,
    initiativeCount: initiative,
    count: other.length,
    questionRate: other.length ? withQuestion / other.length : null,
  };
}

/* ------------------------------------------------------------------ */
/* 行为分：把统计换算成 0~100                                          */
/* ------------------------------------------------------------------ */

function speedScore(replyMinutes: number | null): number {
  if (replyMinutes === null) return 50;
  if (replyMinutes <= 2) return 100;
  if (replyMinutes <= 10) return 90 - (replyMinutes - 2) * 2;
  if (replyMinutes <= 60) return 74 - (replyMinutes - 10) * 0.5;
  return clamp(45 - (replyMinutes - 60) * 0.1, 15, 45);
}

function lengthScore(avgLength: number | null): number {
  if (avgLength === null) return 50;
  if (avgLength <= 5) return 35;
  return clamp(35 + (avgLength - 5) * 2.2, 35, 100);
}

function initiativeScore(count: number, initiative: number): number {
  if (count === 0) return 50;
  return clamp((initiative / count) * 160, 0, 100);
}

export function behaviorScore(stats: BehaviorStats): number {
  const s = speedScore(stats.replyMinutes);
  const l = lengthScore(stats.avgLength);
  const i = initiativeScore(stats.count, stats.initiativeCount);
  const q = (stats.questionRate ?? 0.2) * 100;
  return clamp(s * 0.35 + l * 0.25 + i * 0.25 + q * 0.15);
}

/* ------------------------------------------------------------------ */
/* 好感度（互动温度）                                                   */
/* ------------------------------------------------------------------ */

/**
 * 综合 Jev 的判断分（0~4）与程序统计分（0~100）。
 * 输出的是「互动温度」，不是「对方喜欢你的概率」——这两者不是一回事。
 */
export function combineAffinity(
  modelScore: number,
  modelConfidence: number,
  stats: BehaviorStats,
): Affinity {
  const beh = behaviorScore(stats);
  const modelPart = clamp((modelScore / 4) * 100);
  const value = Math.round(modelPart * 0.6 + beh * 0.4);
  return {
    value: clamp(value),
    confidence: clamp(modelConfidence, 0, 1),
    sufficient: stats.count >= 6,
    breakdown: {
      modelScore: Math.round(modelPart),
      behaviorScore: Math.round(beh),
    },
  };
}

/* ------------------------------------------------------------------ */
/* 回复评级                                                            */
/* ------------------------------------------------------------------ */

function gradeOf(score: number): Grade {
  if (score >= 90) return "S+";
  if (score >= 78) return "S";
  if (score >= 65) return "A";
  if (score >= 50) return "B";
  if (score >= 35) return "C";
  return "D";
}

/**
 * 给「我」的某条回复打分。
 * modelQuality 来自 Jev（0~3，四级：敷衍 → 接住 → 有推进 → 很好），其余全是统计。
 */
export function reviewReply(
  msg: Message,
  prevOther: Message | null,
  modelQuality: number,
): ReplyReview {
  // Jev 的 score 是 0~3（criteria 四级），映射到 0~60 分
  let score = (modelQuality / 3) * 60;
  const reasons: string[] = [];
  const tips: string[] = [];

  const trimmed = msg.text.trim();
  const len = Array.from(msg.text).length;
  const isQuestion = QUESTION_RE.test(msg.text);
  const isAffection = AFFECTION_RE.test(trimmed);
  // 亲昵表达虽然短，但不是在敷衍，不能按敷衍扣分
  const isBrushOff = !isAffection && BRUSH_OFF.test(trimmed);

  if (isAffection) {
    score += 8;
    reasons.push("亲昵表达，维持了温度");
    tips.push("亲昵没问题，顺势补一句具体的事会更稳");
  } else if (isQuestion) {
    score += 15;
    reasons.push("抛出新问题，把话接住了");
  } else {
    tips.push("结尾加个问题，对话更容易继续");
  }

  if (prevOther) {
    const otherLen = Array.from(prevOther.note ?? prevOther.text).length;
    if (otherLen > 0) {
      const ratio = len / otherLen;
      if (ratio >= 0.5 && ratio <= 2.2) {
        score += 10;
        reasons.push("篇幅和对方相当");
      } else if (ratio < 0.4 && !isAffection) {
        score -= 10;
        reasons.push("比对方短不少，容易像在敷衍");
        tips.push("多说一句自己的感受或细节");
      }
    }
    if (prevOther.minute !== null && msg.minute !== null) {
      const gap = msg.minute - prevOther.minute;
      if (gap >= 0 && gap <= 5) {
        score += 10;
        reasons.push("回应及时");
      } else if (gap > 60) {
        tips.push("隔了很久才回，可以先解释一下");
      }
    }
  }

  if (len >= 25 && !isBrushOff) {
    score += 5;
    reasons.push("给了足够信息");
  }

  if (isBrushOff) {
    score -= 20;
    reasons.push("像是敷衍式应答");
    tips.push("把「嗯/哦」换成一句具体回应");
  }

  // 亲昵表达本身是有效的亲密互动，不该因为"短"或"没推进"掉到 D
  if (isAffection) score = Math.max(score, 55);

  // 必须取整：Jev 的 score 可能是小数，累加后会算出 63.199999999999996 这种值
  const finalScore = Math.round(clamp(score));

  return {
    id: msg.id,
    grade: gradeOf(finalScore),
    score: finalScore,
    tip: tips[0] ?? "这条接得不错，保持",
    reasons: reasons,
  };
}

/* ------------------------------------------------------------------ */
/* 与历史基线对比                                                      */
/* ------------------------------------------------------------------ */

export function compareBaseline(
  stats: BehaviorStats,
  baseline: Baseline | null,
): string | null {
  if (!baseline || baseline.sessions < 3) return null;
  const parts: string[] = [];

  if (stats.replyMinutes !== null && baseline.avgReplyMinutes !== null) {
    const d = stats.replyMinutes - baseline.avgReplyMinutes;
    if (Math.abs(d) >= 3) {
      parts.push(
        d > 0
          ? `回复比平时慢了约 ${Math.round(d)} 分钟`
          : `回复比平时快了约 ${Math.round(-d)} 分钟`,
      );
    }
  }
  if (stats.avgLength !== null && baseline.avgLength !== null) {
    const d = stats.avgLength - baseline.avgLength;
    if (Math.abs(d) >= 8) {
      parts.push(
        d > 0 ? `这次话比平时多（+${Math.round(d)} 字/条）` : `这次话比平时少（${Math.round(d)} 字/条）`,
      );
    }
  }
  return parts.length ? parts.join("，") : null;
}

/** 用本次统计更新基线（存回浏览器 localStorage） */
export function mergeBaseline(
  prev: Baseline | null,
  stats: BehaviorStats,
): Baseline {
  if (!prev) {
    return {
      sessions: 1,
      avgReplyMinutes: stats.replyMinutes,
      avgLength: stats.avgLength,
      avgInitiative: stats.count ? stats.initiativeCount / stats.count : null,
    };
  }
  const n = prev.sessions + 1;
  const mix = (a: number | null, b: number | null) =>
    a === null ? b : b === null ? a : (a * prev.sessions + b) / n;
  return {
    sessions: n,
    avgReplyMinutes: mix(prev.avgReplyMinutes, stats.replyMinutes),
    avgLength: mix(prev.avgLength, stats.avgLength),
    avgInitiative: mix(
      prev.avgInitiative,
      stats.count ? stats.initiativeCount / stats.count : null,
    ),
  };
}
