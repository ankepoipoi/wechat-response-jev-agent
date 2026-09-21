import { useState } from "react";
import type { ReplyReview, SuggestResult, Suggestion } from "../../shared/types.ts";

interface Props {
  result: SuggestResult | null;
  loading: boolean;
  error: string | null;
  /** 是否配置了生成式大模型 */
  configured: boolean;
  /** 是否配置了 Jev（没配就没法评分） */
  jevConfigured: boolean;
  onRefresh: () => void;
}

/** 分数徽章：等级 + 分数，和聊天流里给你自己回复的评级同一套标准 */
function ScoreBadge({ review }: { review: ReplyReview | null }) {
  if (!review) {
    return (
      <span className="tag" data-tone="cold" title="Jev 没能评出分数">
        未评分
      </span>
    );
  }
  return (
    <span
      className="score-badge"
      data-grade={review.grade}
      title={review.reasons.join("；") || undefined}
    >
      <b>{review.grade}</b>
      <span>{review.score} 分</span>
    </span>
  );
}

function SuggestionCard({ item, isBest }: { item: Suggestion; isBest?: boolean }) {
  return (
    <div className="suggest-item" data-best={isBest}>
      <div className="row" style={{ gap: 8 }}>
        {isBest ? <span className="best-badge">★ Jev 评分最高</span> : null}
        {item.tone ? (
          <span className="tag" data-tone="warm">
            {item.tone}
          </span>
        ) : null}
        <div className="spacer" />
        <ScoreBadge review={item.review} />
        <CopyButton text={item.text} />
      </div>

      <p className="suggest-text">{item.text}</p>

      {item.reason ? <p className="suggest-reason">{item.reason}</p> : null}

      {item.review ? (
        <div className="score-reasons">
          {item.review.reasons.slice(0, 3).map((r) => (
            <span key={r} className="score-reason">
              {r}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="mini-text"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1600);
        } catch {
          // 剪贴板不可用时忽略，用户可以手动选中
        }
      }}
    >
      {done ? "✓ 已复制" : "复制"}
    </button>
  );
}

export function Suggestions({
  result,
  loading,
  error,
  configured,
  jevConfigured,
  onRefresh,
}: Props) {
  const best = result
    ? result.suggestions.reduce((acc, s) => Math.max(acc, s.review?.score ?? -1), -1)
    : -1;

  return (
    <section className="card stack">
      <div className="row">
        <h2 className="section-title">最能拉近距离的回复</h2>
        <div className="spacer" />
        {result && best >= 0 ? (
          <span className="muted">最高 {best} 分</span>
        ) : null}
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
            点右上角 <b>⚙ 设置</b> 填好{" "}
            <code className="inline">LLM_API_KEY</code> 等三项即可。
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
        <div className="muted">正在照着你们平时的语气写回复，写完再交给 Jev 打分…</div>
      ) : null}

      {result ? (
        <>
          {!result.scored ? (
            <div className="banner banner-warn">
              <span>ℹ️</span>
              <span>
                {jevConfigured
                  ? "Jev 这次没能给出评分，建议本身仍然可用。"
                  : "没配置 Jev，所以这些建议没有分数。"}
              </span>
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              下面每条都交给了 Jev 按「这条回复接住对方了吗」四级打分 ——
              和你自己回复的评级是<b>同一套标准</b>，可以直接比。
            </p>
          )}

          <div className="suggest-list">
            {result.suggestions.map((s, i) => (
              <SuggestionCard
                key={`${i}-${s.text.slice(0, 8)}`}
                item={s}
                // 服务端已按分数排序，第一条就是最高分
                isBest={i === 0 && result.scored && (s.review?.score ?? -1) >= 0}
              />
            ))}
          </div>

          <div className="muted">
            {result.model} · 基于最近 {result.usedMessages} 条 ·{" "}
            {result.latencyMs}ms · tokens {result.usage.input}/{result.usage.output}
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
