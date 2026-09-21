import type { AnalysisResult, AnalyzeRequest } from "../shared/types.ts";

export async function runAnalyze(body: AnalyzeRequest): Promise<AnalysisResult> {
  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error ?? `请求失败（HTTP ${res.status}）`);
  }
  return data as AnalysisResult;
}

export async function getHealth(): Promise<{ ok: boolean; configured: boolean }> {
  const res = await fetch("/api/health");
  return (await res.json()) as { ok: boolean; configured: boolean };
}
