import type {
  AnalysisResult,
  AnalyzeRequest,
  SuggestRequest,
  SuggestResult,
} from "../shared/types.ts";

export interface HealthInfo {
  ok: boolean;
  /** Jev（判断模型）是否配好 */
  configured: boolean;
  /** 生成式大模型是否配好，「最佳回复」依赖它 */
  llmConfigured: boolean;
  llmModel: string | null;
}

async function post<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string })?.error ?? `请求失败（HTTP ${res.status}）`);
  }
  return data as T;
}

export function runAnalyze(body: AnalyzeRequest): Promise<AnalysisResult> {
  return post<AnalysisResult>("/api/analyze", body);
}

export function runSuggest(body: SuggestRequest): Promise<SuggestResult> {
  return post<SuggestResult>("/api/suggest", body);
}

export async function getHealth(): Promise<HealthInfo> {
  const res = await fetch("/api/health");
  return (await res.json()) as HealthInfo;
}
