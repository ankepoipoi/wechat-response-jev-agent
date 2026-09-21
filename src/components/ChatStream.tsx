import {
  EMOTION_MAP,
  type Message,
  type MessageInsight,
  type ReplyReview,
} from "../../shared/types.ts";

interface Props {
  messages: Message[];
  insights: MessageInsight[];
  reviews: ReplyReview[];
}

const MEDIA_LABEL: Record<string, string> = {
  voice: "语音",
  image: "图片",
  sticker: "表情包",
  video: "视频",
  file: "文件",
  location: "位置",
  link: "链接",
  other: "其他",
};

export function ChatStream({ messages, insights, reviews }: Props) {
  const insightOf = (id: string) => insights.find((i) => i.id === id);
  const reviewOf = (id: string) => reviews.find((r) => r.id === id);

  return (
    <div className="chat">
      {messages.map((m) => {
        const ins = insightOf(m.id);
        const rev = reviewOf(m.id);
        const skipped = (m.media !== "text" || !m.text.trim()) && !m.note;

        return (
          <div key={m.id} className="msg" data-side={m.sender}>
            <div className="meta">
              {m.sender === "self" ? "我" : "对方"}
              {m.time ? <span>· {m.time}</span> : null}
              {skipped ? (
                <span>· 没有补充内容，这条不参与分析</span>
              ) : null}
            </div>

            <div className={`bubble${ins?.dropped ? " dropped" : ""}`}>{m.text}</div>

            {m.note ? (
              <div className="meta">
                {MEDIA_LABEL[m.media] ?? "媒体"} · 你补充的描述：{m.note}
              </div>
            ) : null}

            {ins ? (
              <div className="tags">
                {ins.emotions.map((t) => (
                  <span
                    key={t.key}
                    className="tag"
                    data-tone={EMOTION_MAP[t.key]?.tone ?? "flat"}
                    title={`${Math.round(t.probability * 100)}%`}
                  >
                    {t.label} {Math.round(t.probability * 100)}%
                  </span>
                ))}
                {ins.intents.slice(0, 2).map((t) => (
                  <span key={t.key} className="tag" data-kind="intent">
                    {t.label} {Math.round(t.probability * 100)}%
                  </span>
                ))}
              </div>
            ) : null}

            {ins?.dropped ? (
              <div className="meta">⚠️ 对方在追问，这条被你一句话带过去了</div>
            ) : null}

            {rev ? (
              <div className="row" style={{ gap: 8 }}>
                <span className="grade">
                  回复评级 <b>{rev.grade}</b>
                </span>
                <span className="muted">{rev.tip}</span>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
