/**
 * 共享类型与分类词典。
 *
 * 设计红线：模型只负责「从给定选项里选一个 / 在给定等级上打分」，
 * 任何用于展示的数字（好感度、百分比、趋势、评级）都必须由
 * shared/metrics.ts 的纯函数算出，模型不得参与计算。
 */

export type Sender = "self" | "other";

export type MediaKind =
  | "text"
  | "voice"
  | "image"
  | "sticker"
  | "video"
  | "file"
  | "link"
  | "location"
  | "other";

export interface Message {
  id: string;
  sender: Sender;
  text: string;
  /** 原始时间文本，如 "21:03"，用于展示 */
  time: string | null;
  /** 距当日零点的分钟数，仅用于计算回复间隔；解析不出时为 null */
  minute: number | null;
  media: MediaKind;
  /** 用户在占位符后补充的描述（语音/图片转述） */
  note?: string;
}

export interface ParseDiagnostics {
  /** 实际选中的解析策略 */
  strategy: "triple" | "block" | "inline";
  /** 识别到的消息条数 */
  messageCount: number;
  /** 识别到的昵称数量 */
  nameCount: number;
  /** 带时间戳的消息占比 0~1，回复间隔等统计依赖它 */
  timestampRatio: number;
  /** 没能归入任何消息的非空行数 */
  orphanLines: number;
  /** 原文是倒序（最新的在最上面），已自动按时间顺序整理 */
  reversed: boolean;
  /** 给用户看的提示（为空表示一切正常） */
  warnings: string[];
}

export interface ParsedChat {
  messages: Message[];
  /** 文本里出现过的昵称（供用户选"哪个是我"） */
  names: string[];
  /** 解析诊断，用来把「没能识别」的原因说清楚 */
  diagnostics: ParseDiagnostics;
}

/* ------------------------------------------------------------------ */
/* 情绪词典                                                            */
/* ------------------------------------------------------------------ */

export interface EmotionDef {
  key: string;
  label: string;
  /** 冷暖倾向：warm 靠近 / cold 疏离 / flat 中性，仅用于配色 */
  tone: "warm" | "cold" | "flat";
}

export const EMOTIONS: EmotionDef[] = [
  { key: "joy", label: "开心", tone: "warm" },
  { key: "anticipation", label: "期待", tone: "warm" },
  { key: "trust", label: "安心", tone: "warm" },
  { key: "flirt", label: "暧昧", tone: "warm" },
  { key: "gratitude", label: "感谢", tone: "warm" },
  { key: "surprise", label: "惊讶", tone: "flat" },
  { key: "neutral", label: "平淡", tone: "flat" },
  { key: "curiosity", label: "好奇", tone: "flat" },
  { key: "fatigue", label: "疲惫", tone: "cold" },
  { key: "sadness", label: "低落", tone: "cold" },
  { key: "anxiety", label: "不安", tone: "cold" },
  { key: "annoyance", label: "不耐烦", tone: "cold" },
  { key: "anger", label: "生气", tone: "cold" },
  { key: "distance", label: "疏离", tone: "cold" },
];

export const EMOTION_MAP: Record<string, EmotionDef> = Object.fromEntries(
  EMOTIONS.map((e) => [e.key, e]),
);

/* ------------------------------------------------------------------ */
/* 意图词典                                                            */
/* ------------------------------------------------------------------ */

export interface IntentDef {
  key: string;
  label: string;
}

export const INTENTS: IntentDef[] = [
  { key: "share", label: "分享日常" },
  { key: "ask", label: "提问求解" },
  { key: "invite", label: "发起邀约" },
  { key: "praise", label: "夸赞认可" },
  { key: "comfort", label: "安慰关心" },
  { key: "tease", label: "调侃玩笑" },
  { key: "flirt", label: "暧昧试探" },
  { key: "explain", label: "解释说明" },
  { key: "complain", label: "吐槽抱怨" },
  { key: "refuse", label: "婉拒推脱" },
  { key: "apologize", label: "道歉" },
  { key: "thanks", label: "道谢" },
  { key: "end", label: "收束话题" },
  { key: "other", label: "其他" },
];

export const INTENT_MAP: Record<string, IntentDef> = Object.fromEntries(
  INTENTS.map((i) => [i.key, i]),
);

/* ------------------------------------------------------------------ */
/* 分析结果                                                            */
/* ------------------------------------------------------------------ */

export interface Tag {
  key: string;
  label: string;
  probability: number;
}

export interface MessageInsight {
  id: string;
  emotions: Tag[];
  intents: Tag[];
  /** 该句是否由 Jev 判定为"值得回应却没被接住" */
  dropped: boolean;
}

export interface BehaviorStats {
  /** 对方回复我的平均间隔（分钟）；样本不足时为 null */
  replyMinutes: number | null;
  /** 对方平均每条字数 */
  avgLength: number | null;
  /** 主动开口次数（对方在沉默后先说话） */
  initiativeCount: number;
  /** 对方消息条数 */
  count: number;
  /** 对方以问句结尾的比例 0~1 */
  questionRate: number | null;
}

export interface Affinity {
  /** 0~100 的互动温度，非"喜欢你的概率" */
  value: number;
  /** 置信度 0~1，来自 Jev 分布集中度 */
  confidence: number;
  /** 参与统计的样本是否充足 */
  sufficient: boolean;
  /** 构成说明，展示用 */
  breakdown: {
    modelScore: number;
    behaviorScore: number;
  };
}

export type Grade = "S+" | "S" | "A" | "B" | "C" | "D";

export interface ReplyReview {
  id: string;
  grade: Grade;
  /** 一句话建议 */
  tip: string;
  /** 该回复的扣分/加分点 */
  reasons: string[];
}

export interface AnalysisResult {
  model: string;
  usage: { input: number; output: number };
  latencyMs: number;
  insights: MessageInsight[];
  affinity: Affinity;
  stats: BehaviorStats;
  reviews: ReplyReview[];
  /** 与历史基线对比后的提示，样本不足时为空 */
  baselineNote: string | null;
  /**
   * 对话过长时只分析了最近一部分；这里是原始条数。
   * 没截断时不存在。
   */
  truncatedFrom?: number;
  /** 本次实际参与分析的消息条数 */
  analyzedCount: number;
}

/* ------------------------------------------------------------------ */
/* 请求 / 响应                                                          */
/* ------------------------------------------------------------------ */

export interface AnalyzeRequest {
  messages: Message[];
  selfName: string;
  /** 历史基线（由浏览器带上，服务端只读不存） */
  baseline?: Baseline | null;
}

export interface Baseline {
  sessions: number;
  avgReplyMinutes: number | null;
  avgLength: number | null;
  avgInitiative: number | null;
}

/* ------------------------------------------------------------------ */
/* 保存的聊天记录                                                       */
/* ------------------------------------------------------------------ */

export interface Session {
  id: string;
  /** 用户起的名字 */
  name: string;
  /** 原始粘贴文本。多次粘贴会累积在这里，新内容自动接在后面 */
  input: string;
  /** 用户选定的「我」的昵称 */
  selfName: string | null;
  createdAt: number;
  updatedAt: number;
  /** 上次分析结果缓存，切回来不用再花额度 */
  result: AnalysisResult | null;
}
