/**
 * 生成式大模型调用封装（OpenAI 兼容接口）。
 *
 * Jev 只做判断、不生成文本，而「最佳回复」需要真的写出一句话，
 * 所以这里单独接一个对话模型。凡是 OpenAI 兼容的服务都能用：
 *   DeepSeek / 通义 / Kimi / 智谱 / OpenAI / 本地 Ollama …
 * 只要在 .env 里配好 base url、key、模型名即可。
 */

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** 没配置 Key 时返回 null，调用方据此提示用户去配 */
export function readLlmConfig(): LlmConfig | null {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    baseUrl: (process.env.LLM_BASE_URL?.trim() || "https://api.deepseek.com").replace(
      /\/+$/,
      "",
    ),
    apiKey,
    model: process.env.LLM_MODEL?.trim() || "deepseek-chat",
  };
}

/** baseUrl 可能自带 /v1，也可能不带 */
function completionsUrl(baseUrl: string): string {
  return /\/v\d+$/.test(baseUrl)
    ? `${baseUrl}/chat/completions`
    : `${baseUrl}/v1/chat/completions`;
}

export interface ChatMessage {
  role: "system" | "user";
  content: string;
}

export async function chatComplete(
  cfg: LlmConfig,
  messages: ChatMessage[],
  timeoutMs = 90_000,
): Promise<{ content: string; usage: { input: number; output: number } }> {
  let res: Response;
  try {
    res = await fetch(completionsUrl(cfg.baseUrl), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: cfg.model,
        messages,
        temperature: 0.85,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    throw new LlmError(
      e.name === "TimeoutError" ? "大模型响应超时，稍后重试" : `网络请求失败：${e.message}`,
      504,
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    const hint =
      res.status === 401 || res.status === 403
        ? "大模型认证失败，请检查 .env 里的 LLM_API_KEY"
        : `大模型返回 ${res.status}`;
    throw new LlmError(`${hint}：${body.slice(0, 200)}`, res.status);
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content.trim()) throw new LlmError("大模型返回了空内容", 502);

  return {
    content,
    usage: {
      input: data.usage?.prompt_tokens ?? 0,
      output: data.usage?.completion_tokens ?? 0,
    },
  };
}

/**
 * 从可能带 ```json 包裹、或前后夹着解释文字的回复里抠出 JSON。
 * 不强制各家用 response_format，兼容性更好。
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end === -1) {
    throw new LlmError("大模型没有返回可解析的 JSON", 502);
  }
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new LlmError("大模型返回的 JSON 无法解析", 502);
  }
}
