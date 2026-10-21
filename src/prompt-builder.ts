import type { PetAction } from "./types";

export const FRAMES_PER_ACTION = 5;
export const MAX_PROMPT_LENGTH = 1500;

export const DEFAULT_STYLE_NOTES =
  "Q 版贴纸桌面宠物风格，轮廓圆润，厚白色描边，角色完整居中，背景干净。";
export const DEFAULT_NEGATIVE_PROMPT =
  "不要文字、水印、额外动物、人类、服装、项圈、错误毛色、身体裁切、肢体畸形。";
export const DEFAULT_APPEARANCE_NOTES =
  "严格保持参考图中的毛色、花纹、耳朵、眼睛、鼻口和尾巴特征。";

const ACTION_LABELS: Record<PetAction, string> = {
  idle: "待机",
  sit: "坐下",
  sleep: "睡觉",
  happy: "开心",
  walk: "走路",
  jump: "跳跃"
};

const ACTION_DESCRIPTIONS: Record<PetAction, string> = {
  idle: "自然站立，重心稳定，眼睛睁开，轻微呼吸感，尾巴放松。",
  sit: "自然坐下，后腿收拢，前爪放在身体前方，表情温顺。",
  sleep: "蜷缩或趴着闭眼入睡，姿态放松，头部、耳朵和尾巴仍清楚可见。",
  happy: "开心微笑，眼睛明亮，身体轻微弹跳或抬爪回应，尾巴轻快上扬。",
  walk: "小步前进，身体略侧向，前后爪自然交替，尾巴轻微摆动。",
  jump: "轻轻跃起，身体离地但仍完整居中，四肢自然收起或伸展。"
};

export interface PromptContext {
  species: "cat" | "dog";
  petName: string;
  referenceImageUrl: string;
  characterReferenceUrl: string;
  appearanceNotes?: string;
  styleNotes?: string;
  negativePrompt?: string;
  background?: "green" | "neutral";
}

function compact(value: string | undefined, fallback: string, limit: number) {
  const text = value?.trim() || fallback;
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function basePrompt(context: PromptContext) {
  const species = context.species === "cat" ? "猫" : "狗";
  const appearance = compact(context.appearanceNotes, DEFAULT_APPEARANCE_NOTES, 420);
  const style = compact(context.styleNotes, DEFAULT_STYLE_NOTES, 220);
  const negative = compact(context.negativePrompt, DEFAULT_NEGATIVE_PROMPT, 220);
  return { species, appearance, style, negative };
}

function backgroundInstruction(context: PromptContext) {
  return context.background === "green"
    ? "背景使用纯色 #00FF00 绿幕，均匀无渐变、无阴影、无地面，角色边缘干净，便于抠图。"
    : "背景使用干净浅色，均匀无渐变、无阴影、无地面。";
}

export function buildCharacterPrompt(context: PromptContext) {
  const { species, appearance, style, negative } = basePrompt(context);
  return [
    `请根据参考图中的同一只${species}，生成一张 Q 版桌面贴纸宠物角色设定图。`,
    `宠物名字：${context.petName || "未命名"}。`,
    `必须严格保持参考图中的角色身份：脸型、眼距、耳朵形状和位置、鼻口、毛色、花纹、胸口、爪子、尾巴和身体比例。不要重新设计角色。`,
    `外观备注：${appearance}`,
    `画面：单个完整全身角色，正面或轻微 3/4 朝向，居中，1:1，厚白色贴纸描边，轮廓清晰，适合小尺寸桌面显示。${backgroundInstruction(context)}`,
    `风格：${style}`,
    `禁止：${negative}不要多视图排版、文字、Logo、水印、场景、家具、其他动物或人类。`
  ].join("\n");
}

export function buildActionPrompt(
  context: PromptContext,
  action: PetAction,
  frameIndex: number,
  totalFrames = FRAMES_PER_ACTION
) {
  const { species, appearance, style, negative } = basePrompt(context);
  const label = ACTION_LABELS[action];

  return [
    `以角色设定图中的同一只${species}为唯一角色来源，生成「${label}」动作的连续动画关键帧。`,
    `动作描述：${ACTION_DESCRIPTIONS[action]}`,
    `角色一致性：保持脸型、眼距、耳朵、毛色、花纹、胸口、爪子、尾巴和身体比例完全一致；只改变姿态、表情和动作节奏，不要重新设计角色。`,
    `外观备注：${appearance}`,
    `画面：完整全身，居中，1:1，厚白色贴纸描边，轮廓清晰。${backgroundInstruction(context)}`,
    `风格：${style}`,
    `禁止：${negative}不要裁切身体、耳朵、尾巴或爪子，不要奔跑、攻击、摔倒或飞出画面。`,
    `这是该动作连续 ${totalFrames} 帧中的第 ${frameIndex + 1} 帧，只做细微姿态变化，保持构图和角色身份完全一致。`
  ].join("\n");
}

export function buildSpriteSheetPrompt(
  context: PromptContext,
  action: PetAction
) {
  const { species, appearance, style, negative } = basePrompt(context);
  const label = ACTION_LABELS[action];

  return [
    `以角色设定图中的同一只${species}为唯一角色来源，生成一张 3 列 × 2 行的动作序列图。`,
    `整张图为 3:2 横版，共 6 个等大正方形格子。前 5 格按从左到右、从上到下依次是「${label}」动作的第 1-5 帧；第 6 格留空，只保留纯背景。`,
    `动作描述：${ACTION_DESCRIPTIONS[action]}`,
    `角色一致性：保持脸型、眼距、耳朵、毛色、花纹、胸口、爪子、尾巴和身体比例完全一致；只改变姿态、表情和动作节奏，不要重新设计角色。`,
    `外观备注：${appearance}`,
    `每格角色完整全身、居中、比例一致；格子之间不要边框、分隔线、数字、文字、水印或场景。`,
    context.background === "green"
      ? `背景：所有格子统一使用纯色 #00FF00 绿幕，均匀无渐变、无阴影、无地面，角色边缘干净。`
      : `背景：所有格子统一使用干净浅色，均匀无渐变、无阴影、无地面。`,
    `风格：${style}`,
    `禁止：${negative}不要裁切身体、耳朵、尾巴或爪子，不要奔跑、攻击、摔倒或飞出格子。`
  ].join("\n");
}

export function actionLabel(action: PetAction) {
  return ACTION_LABELS[action];
}
