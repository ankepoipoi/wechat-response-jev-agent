import type { AnalysisResult } from "../../shared/types.ts";

const R = 76;
const CIRC = 2 * Math.PI * R;

function Gauge({ value }: { value: number }) {
  const offset = CIRC * (1 - Math.min(100, Math.max(0, value)) / 100);
  return (
    <div className="gauge">
      <svg width="176" height="176" viewBox="0 0 176 176">
        <defs>
          <linearGradient id="gaugeGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0%" stopColor="#6366f1" />
            <stop offset="100%" stopColor="#a855f7" />
          </linearGradient>
        </defs>
        <circle
          cx="88"
          cy="88"
          r={R}
          fill="none"
          stroke="var(--flat-bg)"
          strokeWidth="13"
        />
        <circle
          cx="88"
          cy="88"
          r={R}
          fill="none"
          stroke="url(#gaugeGrad)"
          strokeWidth="13"
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 0.9s cubic-bezier(.22,1,.36,1)" }}
        />
      </svg>
      <div className="gauge-center">
        <div className="gauge-value">{value}</div>
        <div className="gauge-label">互动温度</div>
      </div>
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

const fmt = (n: number | null, digits = 1) =>
  n === null ? "—" : n.toFixed(digits);

export function Overview({ result }: { result: AnalysisResult }) {
  const {
    affinity,
    stats,
    baselineNote,
    usage,
    latencyMs,
    model,
    truncatedFrom,
    analyzedCount,
  } = result;

  return (
    <div className="card stack">
      <div className="overview">
        <Gauge value={affinity.value} />
        <div className="stack" style={{ gap: 12 }}>
          <div className="row">
            <span className="tag" data-tone="flat">
              置信度 {Math.round(affinity.confidence * 100)}%
            </span>
            <span className="tag" data-kind="intent">
              模型判断分 {affinity.breakdown.modelScore}
            </span>
            <span className="tag" data-kind="intent">
              行为统计分 {affinity.breakdown.behaviorScore}
            </span>
          </div>
          <p className="muted" style={{ margin: 0 }}>
            互动温度 = 模型判断 × 60% + 行为统计 × 40%。
            它描述的是这段对话的投入程度，
            <b>不是「对方喜欢你的概率」</b>。
            {affinity.sufficient ? null : " 当前样本偏少，数字仅供参照。"}
          </p>
          {baselineNote ? <div className="hint">相比历史基线：{baselineNote}</div> : null}
        </div>
      </div>

      <div className="stat-grid">
        <Stat
          label="平均回复间隔"
          value={`${fmt(stats.replyMinutes)} 分钟`}
          sub="对方回你的速度"
        />
        <Stat
          label="平均每条字数"
          value={`${fmt(stats.avgLength, 0)} 字`}
          sub="对方的话多不多"
        />
        <Stat
          label="主动开口"
          value={`${stats.initiativeCount} 次`}
          sub="对方开启新一轮的次数"
        />
        <Stat
          label="追问比例"
          value={stats.questionRate === null ? "—" : `${Math.round(stats.questionRate * 100)}%`}
          sub="以问句结尾的比例"
        />
      </div>

      {truncatedFrom ? (
        <div className="hint">
          对话共 {truncatedFrom} 条，为控制单次请求规模，本次分析了最近的{" "}
          {analyzedCount} 条（统计与评级均基于这部分）。
        </div>
      ) : null}

      <div className="muted">
        {model} · {latencyMs}ms · tokens {usage.input}/{usage.output}
      </div>
    </div>
  );
}
