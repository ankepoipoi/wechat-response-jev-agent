import { appendToSession } from "./src/sessions.ts";
import { parseChat } from "./shared/parse.ts";
import type { Session } from "./shared/types.ts";

const SELF = "我";
const count = (t: string) => parseChat(t, SELF).messages.length;

// 用户第一次粘贴的内容
const firstChat = `我 21:00
在吗

对方 21:02
在的`;

// 第二次粘贴：开头故意重复了上次的结尾（模拟微信多选复制）
const secondChat = `对方 21:02
在的

我 21:05
周末有空吗`;

// 第三次粘贴：全新内容
const thirdChat = `对方 21:10
有空呀`;

/* --- 模拟 App 的状态 --- */
let input = "";
let sessions: Session[] = [];
let activeId: string | null = null;

/* ① 首次粘贴 → 保存为新记录 */
input = firstChat;
sessions = [
  {
    id: "s1",
    name: "和小洪水",
    input,
    selfName: SELF,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    result: null,
  },
];
activeId = "s1";
input = ""; // 保存后清空

console.log("① 保存为新记录");
console.log(`   输入框已清空: ${input === ""}`);
console.log(`   记录条数: ${count(sessions[0].input)}`);

/* ② 载入这条记录 */
input = "";
console.log("\n② 载入记录");
console.log(`   输入框为空: ${input === ""}`);

/* 粘贴动作：追加进记录 + 清空输入框 */
function paste(text: string): number {
  const target = sessions.find((s) => s.id === activeId)!;
  const { session: next, added } = appendToSession(target, text, SELF);
  sessions = sessions.map((s) => (s.id === target.id ? next : s));
  input = ""; // 关键：粘贴后输入框保持空
  return added;
}

/* ③ 粘贴含重叠的新聊天 */
const a1 = paste(secondChat);
console.log("\n③ 粘贴含重叠的新聊天");
console.log(`   新增: ${a1} 条（期望 1 —— 重复的「在的」不算）`);
console.log(`   输入框为空: ${input === ""}`);
console.log(`   记录条数: ${count(sessions[0].input)}（期望 3）`);

/* ④ 再粘贴一次完全相同的内容 */
const a2 = paste(secondChat);
console.log("\n④ 重复粘贴同一段");
console.log(`   新增: ${a2} 条（期望 0）`);
console.log(`   记录条数: ${count(sessions[0].input)}（期望 3，不膨胀）`);

/* ⑤ 粘贴全新内容 */
const a3 = paste(thirdChat);
console.log("\n⑤ 粘贴全新聊天");
console.log(`   新增: ${a3} 条（期望 1）`);
console.log(`   记录条数: ${count(sessions[0].input)}（期望 4）`);

console.log("\n=== 记录最终内容 ===");
console.log(sessions[0].input);
