import { useEffect, useMemo, useState } from "react";
import { parseChat } from "../shared/parse.ts";
import { mergeBaseline } from "../shared/metrics.ts";
import type { AnalysisResult, Baseline } from "../shared/types.ts";
import { getHealth, runAnalyze } from "./api.ts";
import { ChatStream } from "./components/ChatStream.tsx";
import { Overview } from "./components/Overview.tsx";

const SAMPLE = `对方 21:00
今天加班好累啊，可能要十点才走

我 21:02
辛苦了，要不要给你带点吃的

对方 21:05
不用啦 我自己点外卖就好

我 21:06
好吧，那你忙完早点休息

对方 21:08
嗯嗯 你也是，周末有空吗？`;

const BASELINE_KEY = "echo.baseline";
const THEME_KEY = "echo.theme";

export default function App() {
  const [input, setInput] = useState("");
  const [selfName, setSelfName] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [configured, setConfigured] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  useEffect(() => {
    const savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === "dark" || savedTheme === "light") setTheme(savedTheme);
    const savedBaseline = localStorage.getItem(BASELINE_KEY);
    if (savedBaseline) {
      try {
        setBaseline(JSON.parse(savedBaseline) as Baseline);
      } catch {
        localStorage.removeItem(BASELINE_KEY);
      }
    }
    getHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  const parsed = useMemo(
    () => parseChat(input, selfName ?? undefined),
    [input, selfName],
  );

  async function onAnalyze() {
    if (!selfName || parsed.messages.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const r = await runAnalyze({
        messages: parsed.messages,
        selfName,
        baseline,
      });
      setResult(r);
      const next = mergeBaseline(baseline, r.stats);
      setBaseline(next);
      localStorage.setItem(BASELINE_KEY, JSON.stringify(next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const canAnalyze = Boolean(selfName) && parsed.messages.length > 0 && !loading;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">E</div>
          <div>
            <h1>Echo · 聊天洞察</h1>
            <p>逐句读懂情绪与意图 · 数字全部由程序计算</p>
          </div>
        </div>
        <button
          className="btn-ghost btn-icon"
          onClick={() => setTheme(theme === "light" ? "dark" : "light")}
          title="切换主题"
        >
          {theme === "light" ? "🌙" : "☀️"}
        </button>
      </header>

      <div className="stack">
        <section className="card stack">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={
              "把微信聊天记录粘贴到这里。\n\n支持两种格式：\n  昵称 21:03  （换行写正文）\n  昵称：正文\n\n语音/图片复制出来只有占位符，在后面补一句描述，AI 才知道那是什么。"
            }
          />

          {parsed.names.length > 0 ? (
            <div className="row">
              <span className="muted">哪个昵称是你？</span>
              <div className="chip-select">
                {parsed.names.map((n) => (
                  <button
                    key={n}
                    className="chip"
                    data-active={selfName === n}
                    onClick={() => setSelfName(n)}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="row">
            <button className="btn-primary" onClick={onAnalyze} disabled={!canAnalyze}>
              {loading ? (
                <>
                  <span className="spinner" />
                  分析ing
                </>
              ) : (
                "开始分析"
              )}
            </button>
            <button className="btn-ghost" onClick={() => setInput(SAMPLE)}>
              填入示例
            </button>
            <div className="spacer" />
            <span className="muted">
              解析到 {parsed.messages.length} 条
              {baseline ? ` · 已积累 ${baseline.sessions} 段对话基线` : ""}
            </span>
          </div>

          {!selfName && parsed.messages.length > 0 ? (
            <div className="banner banner-info">
              <span>ℹ️</span>
              <span>先选一下哪个昵称是你，才能区分「你」和「对方」。</span>
            </div>
          ) : null}

          {!configured ? (
            <div className="banner banner-error">
              <span>⚠️</span>
              <span>
                服务端还没配置 <code className="inline">TYPESAFE_API_KEY</code>
                ，请在项目根目录的 <code className="inline">.env</code> 里填入后重启服务。
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="banner banner-error">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          ) : null}
        </section>

        {result ? <Overview result={result} /> : null}

        {result ? (
          <section className="card">
            <ChatStream
              messages={parsed.messages}
              insights={result.insights}
              reviews={result.reviews}
            />
          </section>
        ) : null}

        <p className="muted" style={{ textAlign: "center", marginTop: 8 }}>
          聊天内容只在本机浏览器里，不会上传。分析时会把片段发给模型服务商，这是工具工作的前提。
        </p>
      </div>
    </div>
  );
}
