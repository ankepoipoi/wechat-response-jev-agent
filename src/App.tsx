import { useEffect, useMemo, useRef, useState } from "react";
import { parseChat } from "../shared/parse.ts";
import { mergeBaseline } from "../shared/metrics.ts";
import type { AnalysisResult, Baseline, Session } from "../shared/types.ts";
import { getHealth, runAnalyze } from "./api.ts";
import { ChatStream } from "./components/ChatStream.tsx";
import { Overview } from "./components/Overview.tsx";
import { SessionList } from "./components/SessionList.tsx";
import {
  appendToSession,
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
  /** 只装「新粘贴/新输入」的内容，载入记录后永远是空的 */
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
    const t = setTimeout(() => setNotice(null), 4600);
    return () => clearTimeout(t);
  }, [notice]);

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  /**
   * 界面上展示和参与分析的文本：
   * 有当前记录就是记录的全部内容，否则是输入框里还没保存的内容。
   */
  const displayText = activeSession ? activeSession.input : input;

  const parsed = useMemo(
    () => parseChat(displayText, selfName ?? undefined),
    [displayText, selfName],
  );

  /* ---------------- 记录管理 ---------------- */

  function onNew() {
    setActiveId(null);
    setName("");
    setInput("");
    setSelfName(null);
    setResult(null);
    setError(null);
    setNotice("已开始一段新记录，粘贴聊天后给它起个名字保存。");
  }

  function onSelectSession(id: string) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    setActiveId(id);
    setInput(""); // 输入框留空，只用来接新内容
    setSelfName(s.selfName);
    setName(s.name);
    setResult(s.result);
    setError(null);
    setNotice(`已载入「${s.name}」。直接粘贴新聊天，会自动接到下面。`);
  }

  /** 把一段文本追加进当前记录并落盘，返回新增条数与记录名 */
  function appendToActive(text: string): { added: number; label: string } | null {
    const target = sessions.find((x) => x.id === activeId);
    if (!target) return null;

    const { session: next, added } = appendToSession(target, text, selfName);
    setSessions((prev) => prev.map((s) => (s.id === target.id ? next : s)));
    return { added, label: target.name };
  }

  function onSave() {
    if (activeId) return; // 有记录时是自动保存的
    const trimmed = name.trim() || "未命名";
    const now = Date.now();
    const created: Session = {
      id: makeSessionId(),
      name: trimmed,
      input,
      selfName,
      createdAt: now,
      updatedAt: now,
      result: null,
    };
    setSessions((prev) => [created, ...prev]);
    setActiveId(created.id);
    setInput("");
    setNotice(`已保存为「${trimmed}」。以后直接粘贴新聊天就会自动接在下面。`);
  }

  function onRename(id: string, next: string) {
    setSessions((prev) =>
      prev.map((s) =>
        s.id === id ? { ...s, name: next, updatedAt: Date.now() } : s,
      ),
    );
    if (id === activeId) setName(next);
  }

  function onDelete(id: string) {
    setSessions((prev) => prev.filter((s) => s.id !== id));
    if (id === activeId) onNew();
  }

  /**
   * 粘贴即追加：已经载入了某段记录时，新聊天自动接到记录下面并立刻保存，
   * 输入框保持空的 —— 它只是新内容的入口，不承载历史。
   */
  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    if (!activeId) return;
    const pasted = e.clipboardData.getData("text");
    if (!pasted.trim()) return;

    e.preventDefault();
    const r = appendToActive(pasted);
    if (!r) return;
    setInput("");
    setResult(null); // 内容变了，旧结果不再匹配
    setNotice(
      r.added > 0
        ? `已自动追加 ${r.added} 条到「${r.label}」，点「开始分析」更新标签`
        : `这段内容已经在「${r.label}」里了，没有重复添加`,
    );
  }

  /** 手动输入的内容也支持追加 */
  function onAppendManual() {
    const r = appendToActive(input);
    if (!r) return;
    setInput("");
    setResult(null);
    setNotice(
      r.added > 0
        ? `已追加 ${r.added} 条到「${r.label}」`
        : `这段内容已经在「${r.label}」里了，没有重复添加`,
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
  const canSave = !activeSession && input.trim().length > 0;

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
              {activeSession ? (
                <>
                  <span className="record-tag">当前记录</span>
                  <span className="record-name">{activeSession.name}</span>
                  <div className="spacer" />
                  <span className="muted">粘贴新聊天会自动接在下面并保存</span>
                </>
              ) : (
                <>
                  <input
                    className="name-input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="给这段记录起个名字（如「和小洪水」）"
                  />
                  <button className="btn-ghost" onClick={onSave} disabled={!canSave}>
                    保存为新记录
                  </button>
                </>
              )}
            </div>

            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onPaste={onPaste}
              placeholder={
                activeSession
                  ? `在这里粘贴新的聊天记录 —— 会自动接到「${activeSession.name}」下面并立即保存。\n\n也可以先手动输入，再点「追加到记录」。`
                  : "把微信聊天记录粘贴到这里。\n\n三种格式都支持：\n  昵称 / 日期时间 / 正文   （微信多选复制，各占一行）\n  昵称 21:03              （正文换行写）\n  昵称：正文\n\n语音 / 图片 / 表情包复制出来只有占位符，在后面补一句描述，AI 才知道那是什么。"
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

              {activeSession && input.trim() ? (
                <button className="btn-ghost" onClick={onAppendManual}>
                  追加到记录
                </button>
              ) : null}

              {!activeSession ? (
                <button className="btn-ghost" onClick={() => setInput(SAMPLE)}>
                  填入示例
                </button>
              ) : null}

              <div className="spacer" />
              <span className="muted">
                共 {parsed.messages.length} 条
                {activeSession ? ` · 已保存` : ""}
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

            {notice ? (
              <div className="banner banner-info">
                <span>✓</span>
                <span>{notice}</span>
              </div>
            ) : null}
          </section>

          {result ? <Overview result={result} /> : null}

          {parsed.messages.length > 0 ? (
            <section className="card">
              {result ? null : (
                <p className="muted" style={{ margin: "0 0 14px" }}>
                  记录里的全部内容（{parsed.messages.length} 条）。点「开始分析」
                  生成情绪与意图标签。
                </p>
              )}
              <ChatStream
                messages={parsed.messages}
                insights={result?.insights ?? []}
                reviews={result?.reviews ?? []}
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
