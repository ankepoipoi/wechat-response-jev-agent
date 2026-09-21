import { useState } from "react";
import type { SuggestResult } from "../../shared/types.ts";

interface Props {
  result: SuggestResult | null;
  loading: boolean;
  error: string | null;
  /** 是否配置了生成式大模型 */
  configured: boolean;
  onRefresh: () => void;
}

export function Suggestions({
  result,
  loading,
  error,
  configured,
  onRefresh,
}: Props) {
  const [copied, setCopied] = useState<number | null>(null);

  async function copy(index: number, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(index);
      setTimeout(() => setCopied((c) => (c === index ? null : c)), 1600);
    } catch {
      // 剪贴板不可用时忽略，用户可以手动选中
    }
  }

  return (
    <section className="card stack">
      <div className="row">
        <h2 className="section-title">最能拉近距离的回复</h2>
        <div className="spacer" />
        {configured ? (
          <button className="btn-ghost" onClick={onRefresh} disabled={loading}>
            {loading ? "生成中…" : "换一批"}
          </button>
        ) : null}
      </div>

      {!configured ? (
        <div className="banner banner-warn">
          <span>🔌</span>
          <span>
            这个功能要另接一个生成式大模型（Jev 只做判断、不写句子）。
            在项目根目录 <code className="inline">.env</code> 里填好{" "}
            <code className="inline">LLM_API_KEY</code>、
            <code className="inline">LLM_BASE_URL</code>、
            <code className="inline">LLM_MODEL</code> 后重启服务即可。
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="banner banner-error">
          <span>⚠️</span>
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="muted">正在照着你们平时的语气写回复…</div>
      ) : null}

      {result ? (
        <>
          <div className="suggest-list">
            {result.suggestions.map((s, i) => (
              <div key={`${i}-${s.text.slice(0, 8)}`} className="suggest-item">
                <div className="row" style={{ gap: 8 }}>
                  {s.tone ? (
                    <span className="tag" data-tone="warm">
                      {s.tone}
                    </span>
                  ) : null}
                  <div className="spacer" />
                  <button className="mini-text" onClick={() => copy(i, s.text)}>
                    {copied === i ? "✓ 已复制" : "复制"}
                  </button>
                </div>
                <p className="suggest-text">{s.text}</p>
                {s.reason ? <p className="suggest-reason">{s.reason}</p> : null}
              </div>
            ))}
          </div>
          <div className="muted">
            {result.model} · 基于最近 {result.usedMessages} 条 · tokens{" "}
            {result.usage.input}/{result.usage.output}
          </div>
          <p className="muted" style={{ margin: 0 }}>
            建议是用来帮你把自己的意思说清楚的，不是话术。觉得不像你平时说话就换一批。
          </p>
        </>
      ) : null}

      {!loading && !result && !error && configured ? (
        <div className="muted">分析完成后会自动生成建议。</div>
      ) : null}
    </section>
  );
}
