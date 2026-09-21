import { useEffect, useState } from "react";
import { getConfig, saveConfig, type ConfigStatus } from "../api.ts";

const SOURCE_LABEL: Record<string, string> = {
  page: "页面上填的",
  env: ".env 文件",
};

interface Props {
  onStatusChange?: (status: ConfigStatus) => void;
}

export function Settings({ onStatusChange }: Props) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<ConfigStatus | null>(null);

  const [typesafeKey, setTypesafeKey] = useState("");
  const [llmBaseUrl, setLlmBaseUrl] = useState("");
  const [llmApiKey, setLlmApiKey] = useState("");
  const [llmModel, setLlmModel] = useState("");

  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getConfig()
      .then((s) => {
        setStatus(s);
        setLlmBaseUrl(s.llm.baseUrl);
        setLlmModel(s.llm.model);
        onStatusChange?.(s);
      })
      .catch(() => {
        /* 服务没起来时静默，页面其它部分会提示 */
      });
    // 只在挂载时拉一次；onStatusChange 由父组件用 useCallback 保持稳定
     
  }, []);

  async function submit(patch: Record<string, string>, okText: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await saveConfig(patch);
      setStatus(r.status);
      onStatusChange?.(r.status);
      setTypesafeKey("");
      setLlmApiKey("");
      setNotice(okText);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onSave() {
    const patch: Record<string, string> = {};
    if (typesafeKey.trim()) patch.typesafeApiKey = typesafeKey.trim();
    if (llmBaseUrl.trim()) patch.llmBaseUrl = llmBaseUrl.trim();
    if (llmApiKey.trim()) patch.llmApiKey = llmApiKey.trim();
    if (llmModel.trim()) patch.llmModel = llmModel.trim();

    if (Object.keys(patch).length === 0) {
      setError("没有需要保存的内容");
      return;
    }
    void submit(patch, "已保存，立即生效");
  }

  function statusLine(
    configured: boolean,
    preview: string,
    source: "page" | "env" | null,
  ) {
    if (!configured) return <span className="tag" data-tone="cold">未配置</span>;
    return (
      <>
        <span className="tag" data-tone="warm">已配置</span>
        <span className="muted">
          {preview}
          {source ? ` · 来自${SOURCE_LABEL[source]}` : ""}
        </span>
      </>
    );
  }

  return (
    <div className="settings">
      <button
        className="btn-ghost btn-icon"
        onClick={() => setOpen((v) => !v)}
        title="配置 API Key"
      >
        ⚙
      </button>

      {open ? (
        <div className="settings-panel card stack">
          <div className="row">
            <h2 className="section-title">配置 API Key</h2>
            <div className="spacer" />
            <button className="mini-text" onClick={() => setOpen(false)}>
              收起
            </button>
          </div>

          <p className="muted" style={{ margin: 0 }}>
            填好的 Key 只会写进这台电脑上的{" "}
            <code className="inline">.config.json</code>，<b>不会存到浏览器、也不会外传</b>。
            保存后立即生效，不用重启。留空的项表示不修改。
          </p>

          {/* ---- Jev / TypeSafe ---- */}
          <div className="settings-group">
            <div className="row">
              <span className="settings-label">Jev（TypeSafe）</span>
              {statusLine(
                status?.typesafe.configured ?? false,
                status?.typesafe.preview ?? "",
                status?.typesafe.source ?? null,
              )}
              {status?.typesafe.configured ? (
                <button
                  className="mini-text"
                  disabled={busy}
                  onClick={() => void submit({ typesafeApiKey: "" }, "已清除 TypeSafe Key")}
                >
                  清除
                </button>
              ) : null}
            </div>
            <input
              className="name-input"
              style={{ width: "100%" }}
              type="password"
              autoComplete="off"
              value={typesafeKey}
              onChange={(e) => setTypesafeKey(e.target.value)}
              placeholder={
                status?.typesafe.configured
                  ? "已配置，填入新值可替换"
                  : "apikey_xxx（判断情绪与意图，必填）"
              }
            />
            <span className="muted">
              申请地址：
              <a href="https://console.typesafe.ai/keys" target="_blank" rel="noreferrer">
                console.typesafe.ai/keys
              </a>
            </span>
          </div>

          {/* ---- 生成式大模型 ---- */}
          <div className="settings-group">
            <div className="row">
              <span className="settings-label">生成式大模型</span>
              {statusLine(
                status?.llm.configured ?? false,
                status?.llm.preview ?? "",
                status?.llm.source ?? null,
              )}
              {status?.llm.configured ? (
                <button
                  className="mini-text"
                  disabled={busy}
                  onClick={() => void submit({ llmApiKey: "" }, "已清除大模型 Key")}
                >
                  清除
                </button>
              ) : null}
            </div>

            <input
              className="name-input"
              style={{ width: "100%" }}
              type="password"
              autoComplete="off"
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder={
                status?.llm.configured
                  ? "已配置，填入新值可替换"
                  : "sk-xxx（写回复用，可选）"
              }
            />

            <div className="row" style={{ gap: 8 }}>
              <input
                className="name-input"
                style={{ flex: "2 1 200px" }}
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder="https://api.deepseek.com"
              />
              <input
                className="name-input"
                style={{ flex: "1 1 130px" }}
                value={llmModel}
                onChange={(e) => setLlmModel(e.target.value)}
                placeholder="deepseek-chat"
              />
            </div>
            <span className="muted">
              任何 OpenAI 兼容接口都行：DeepSeek / 通义 / Kimi / 智谱 / Ollama…
            </span>
          </div>

          <div className="row">
            <button className="btn-primary" onClick={onSave} disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </button>
            <div className="spacer" />
          </div>

          {notice ? (
            <div className="banner banner-info">
              <span>✓</span>
              <span>{notice}</span>
            </div>
          ) : null}
          {error ? (
            <div className="banner banner-error">
              <span>⚠️</span>
              <span>{error}</span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
