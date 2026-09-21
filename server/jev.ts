/**
 * Jev 调用封装。
 *
 * 只做一件事：把「state + 一组问题」发给 Jev，拿回结构化答案。
 * Jev 不生成文本 —— 它只会从你给的选项里挑一个，或在给定等级上打分。
 *
 * 通道自动选择：
 *   sk-or- 开头的 Key 走 OpenRouter（无需 waitlist）
 *   其他走 TypeSafe 官方直连
 */

const TYPESAFE_URL = "https://api.typesafe.ai/v1/systemone";
const OPENROUTER_URL = "https://openrouter.ai/api/alpha/decisions";

export type Question =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export interface JevAnswer {
  type: "choice" | "score" | "noul";
  choice?: string;
  probabilities?: Record<string, number>;
  score?: number;
  confidence?: number;
  noul?: number;
}

export interface JevResult {
  answers: Record<string, JevAnswer>;
  model: string;
  usage: { input: number; output: number };
}

export class JevError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const MESSAGES: Record<number, string> = {
  401: "Jev 认证失败，请检查 .env 里的 API Key",
  403: "当前 API 账号没有调用权限",
  422: "模型无法处理这段输入，试试缩短粘贴范围",
  429: "Jev 正忙，稍后再试",
  529: "Jev 暂时繁忙，稍后再试",
};

function pickEndpoint(key: string) {
  if (key.startsWith("sk-or-")) {
    return { url: OPENROUTER_URL, model: "typesafe/jev-1.13" };
  }
  return { url: TYPESAFE_URL, model: "jev-latest" };
}

export async function askJev(
  apiKey: string,
  state: unknown,
  questions: Record<string, Question>,
  timeoutMs = 60_000,
): Promise<JevResult> {
  const { url, model } = pickEndpoint(apiKey);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, state, questions }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    throw new JevError(
      e.name === "TimeoutError" ? "Jev 响应超时，请缩短聊天范围重试" : `网络请求失败：${e.message}`,
      504,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new JevError(MESSAGES[res.status] ?? `Jev 返回 ${res.status}：${body.slice(0, 200)}`, res.status);
  }

  const data = (await res.json()) as {
    answers?: Record<string, JevAnswer>;
    model?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  return {
    answers: data.answers ?? {},
    model: data.model ?? model,
    usage: {
      input: data.usage?.input_tokens ?? 0,
      output: data.usage?.output_tokens ?? 0,
    },
  };
}

/** 把 choice 的概率分布转成排序后的标签列表 */
export function topTags(
  answer: JevAnswer | undefined,
  labelOf: (key: string) => string,
  limit = 3,
): { key: string; label: string; probability: number }[] {
  if (!answer?.probabilities) return [];
  return Object.entries(answer.probabilities)
    .map(([key, probability]) => ({ key, label: labelOf(key), probability }))
    .sort((a, b) => b.probability - a.probability)
    .slice(0, limit);
}
