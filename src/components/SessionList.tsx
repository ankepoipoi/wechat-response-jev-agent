import { useMemo, useState } from "react";
import { RELATION_LABELS, type Session } from "../../shared/types.ts";
import { parseChat } from "../../shared/parse.ts";
import { relativeTime } from "../sessions.ts";

interface Props {
  sessions: Session[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
}

function SessionItem({
  session,
  active,
  onSelect,
  onRename,
  onDelete,
}: {
  session: Session;
  active: boolean;
  onSelect: () => void;
  onRename: (name: string) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(session.name);

  const count = useMemo(
    () => parseChat(session.input).messages.length,
    [session.input],
  );

  function commit() {
    const next = draft.trim();
    onRename(next || session.name);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="session-item" data-active={active}>
        <input
          className="session-rename"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit();
            if (e.key === "Escape") {
              setDraft(session.name);
              setEditing(false);
            }
          }}
        />
      </div>
    );
  }

  return (
    <div
      className="session-item"
      data-active={active}
      onClick={onSelect}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSelect();
      }}
    >
      <div className="session-main">
        <div className="session-name">
          <span
            className="relation-tag"
            data-relation={session.relation}
            title={`关系阶段：${RELATION_LABELS[session.relation]}`}
          >
            {RELATION_LABELS[session.relation]}
          </span>
          <span className="session-name-text">{session.name}</span>
        </div>
        <div className="session-meta">
          {count} 条 · {relativeTime(session.updatedAt)}
          {session.result ? " · 已分析" : ""}
        </div>
      </div>
      <div className="session-actions">
        <button
          className="mini"
          title="重命名"
          onClick={(e) => {
            e.stopPropagation();
            setDraft(session.name);
            setEditing(true);
          }}
        >
          ✎
        </button>
        <button
          className="mini"
          title="删除"
          onClick={(e) => {
            e.stopPropagation();
            if (window.confirm(`删除「${session.name}」？这段聊天记录会从本机移除。`)) {
              onDelete();
            }
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}

export function SessionList({
  sessions,
  activeId,
  onSelect,
  onNew,
  onRename,
  onDelete,
}: Props) {
  return (
    <aside className="card session-panel">
      <div className="session-head">
        <span className="session-title">聊天记录</span>
        <button className="mini-text" onClick={onNew} title="开始一段新记录">
          ＋ 新建
        </button>
      </div>

      {sessions.length === 0 ? (
        <p className="muted" style={{ margin: "6px 2px" }}>
          还没有保存的记录。粘贴聊天后点「保存记录」，以后就能把新聊天接在它下面。
        </p>
      ) : (
        <div className="session-list">
          {sessions.map((s) => (
            <SessionItem
              key={s.id}
              session={s}
              active={s.id === activeId}
              onSelect={() => onSelect(s.id)}
              onRename={(name) => onRename(s.id, name)}
              onDelete={() => onDelete(s.id)}
            />
          ))}
        </div>
      )}
    </aside>
  );
}
