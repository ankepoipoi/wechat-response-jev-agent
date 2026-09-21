import { useEffect, useMemo, useRef, useState } from "react";
import { parseChat } from "../shared/parse.ts";
import { mergeBaseline } from "../shared/metrics.ts";
import type { AnalysisResult, Baseline, Session } from "../shared/types.ts";
import { getHealth, runAnalyze } from "./api.ts";
import { ChatStream } from "./components/ChatStream.tsx";
import { Overview } from "./components/Overview.tsx";
import { SessionList } from "./components/SessionList.tsx";
import {
  appendWithoutOverlap,
  loadSessions,
  makeSessionId,
  persistSessions,
} from "./sessions.ts";

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
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [input, setInput] = useState("");
  const [selfName, setSelfName] = useState<string | null>(null);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [configured, setConfigured] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">("light");

  const hydrated = useRef(false);

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

    setSessions(loadSessions());
    hydrated.current = true;

    getHealth()
      .then((h) => setConfigured(h.configured))
      .catch(() => setConfigured(false));
  }, []);

  useEffect(() => {
    if (hydrated.current) persistSessions(sessions);
  }, [sessions]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(THEME_KEY, theme);
  }, [theme]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 4200);
    return () => clearTimeout(t);
  }, [notice]);

  const parsed = useMemo(
    () => parseChat(input, selfName ?? undefined),
    [input, selfName],
  );

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  /* ---------------- 记录管理 ---------------- */

  function onNew() {
    setActiveId(null);
    setName("");
    setInput("");
    setSelfName(null);
    setResult(null);
    setError(null);
    setNotice("已开始一段新记录，粘贴聊天后记得点「保存记录」");
  }

  function onSelectSession(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    setActiveId(id);
    setInput(s.input);
    setSelfName(s.selfName);
    setName(s.name);
    setResult(s.result);
    setError(null);
    setNotice(
      s.result
        ? `已载入「${s.name}」，接着把新聊天粘贴进来就会自动接到下面`
        : `已载入「${s.name}」`,
    );
  }

  function onSave() {
    const trimmed = name.trim() || "未命名";
    const now = Date.now();

    if (activeId) {
      setSessions((prev) =>
        prev.map((s) =>
          s.id === activeId
            ? { ...s, name: trimmed, input, selfName, updatedAt: now, result }
            : s,
        ),
      );
      setNotice(`已更新「${trimmed}」`);
      return;
    }

    const created: Session = {
      id: makeSessionId(),
      name: trimmed,
      input,
      selfName,
      createdAt: now,
      updatedAt: now,
      result,
    };
    setSessions((prev) => [created, ...prev]);
    setActiveId(created.id);
    setNotice(`已保存为「${trimmed}」。下次载入它，新聊天会自动接在下面。`);
  }

  function onRename(id: string, next: string) {
    setSessions((prev) =>
      prev.map((s) => (s.id === id ? { ...s, name: next, updatedAt: Date.now() } : s)),
    );
    if (id === activeId) setName(next);
  }

  function onDelete(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === activeId) onNew();
  }

  /**
   * 粘贴时如果已经载入了某段记录，就把新内容接到它下面（自动去掉重叠部分），
   * 而不是覆盖掉原来的聊天。
   */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!activeId) return;
    const pasted = e.clipboardData.getData("text");
    if (!pasted.trim()) return;

    e.preventDefault();
    const before = parsed.messages.length;
    const merged = appendWithoutOverlap(input, pasted);
    setInput(merged);
    const after = parseChat(merged, selfName ?? undefined).messages.length;
    const added = after - before;
    setNotice(
      added > 0
        ? `已接到上次记录下面，新增 ${added} 条（重复部分自动去掉了）`
        : "这段内容已经在记录里了，没有重复添加",
    );
  }

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

      // 分析结果随手存进当前记录，下次载入不用再花额度
      if (activeId) {
        setSessions((prev) =>
          prev.map((s) =>
            s.id === activeId
              ? { ...s, result: r, selfName, updatedAt: Date.now() }
              : s,
          ),
        );
      }

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
  const canSave = input.trim().length > 0;

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

      <div className="layout">
        <SessionList
          sessions={sessions}
          activeId={activeId}
          onSelect={onSelectSession}
          onNew={onNew}
          onRename={onRename}
          onDelete={onDelete}
        />

        <div className="stack">
          <section className="card stack">
            <div className="row">
              <input
                className="name-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="给这段记录起个名字（如「和小洪水」）"
              />
              <button className="btn-ghost" onClick={onSave} disabled={!canSave}>
                {activeSession ? "保存记录" : "保存为新记录"}
              </button>
            </div>

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              placeholder={
                "把微信聊天记录粘贴到这里。\n\n三种格式都支持：\n  昵称 / 日期时间 / 正文   （微信多选复制，各占一行）\n  昵称 21:03              （正文换行写）\n  昵称：正文\n\n已经载入了某段记录时，直接粘贴新聊天，会自动接到下面。"
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
                    分析中
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
                {activeSession ? ` · 当前记录「${activeSession.name}」` : ""}
              </span>
            </div>

            {activeId ? (
              <div className="banner banner-append">
                <span>📌</span>
                <span>
                  正在「{activeSession?.name ?? "未命名"}」中。粘贴新聊天会自动接在下面，
                  不用手动拼接。
                </span>
              </div>
            ) : null}

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

            {notice ? (
              <div className="banner banner-info">
                <span>✓</span>
                <span>{notice}</span>
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
            聊天内容只存在这台电脑的浏览器里，不会上传。分析时会把片段发给模型服务商，这是工具工作的前提。
          </p>
        </div>
      </div>
    </div>
  );
}
