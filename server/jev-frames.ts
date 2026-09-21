/**
 * Jev 的判断框架。
 *
 * 这些「等级描述」是 Jev 打分的标尺 —— 它只能在给定等级上打分，不自己发明刻度。
 *
 * 单独抽出来是因为有两处要用，而且**必须用同一套**：
 *   1. analyze.ts —— 给聊天里「我」的每条回复评级
 *   2. suggest.ts —— 给大模型生成的候选回复评级
 * 只有标尺一致，「建议的分数」和「你自己回复的分数」才可比。
 */

/** 接话质量四级（0~3 分），给 Jev 的 score 用 */
export const QUALITY_LEVELS = [
  "敷衍或答非所问，把天聊死了",
  "接住了，但没有延伸",
  "有回应也有推进",
  "接住情绪、给细节、抛新话题",
];

/**
 * 把等级描述转成写给大模型看的要求。
 * 让生成方知道"会被按什么标准评判"，它才会朝着高分去写 ——
 * 这正是用户要的「DeepSeek 也参考 Jev 的给定等级」。
 */
export function qualityRubricForPrompt(): string {
  return QUALITY_LEVELS.map((text, i) => `  ${i} 分 —— ${text}`).join("\n");
}

/** 等级对应的档位名，界面上展示用 */
export const QUALITY_NAMES = ["敷衍", "接住", "有推进", "很好"];
