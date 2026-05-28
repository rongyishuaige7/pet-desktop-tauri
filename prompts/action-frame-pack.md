---
id: action-frame-pack-v1
type: action_frame_pack
version: 1
provider: minimax
model: image-01
output: image_per_action
aspect_ratio: "1:1"
uses:
  - base-identity-v1
  - style-q-sticker-v1
  - negative-v1
variables:
  species: cat | dog
  pet_name: string
  character_reference_url: string
  action: idle | sit | sleep | happy | walk | jump
  action_description: string
  appearance_notes: string
  style_notes: string
  negative_prompt: string
---

请根据角色设定图生成同一只桌面宠物的动作图。你必须把 `{{character_reference_url}}` 当作已经确定的角色模型，不允许重新设计角色。

任务目标：

- 生成动作：{{action}}
- 动作描述：{{action_description}}
- 角色类型：{{species}}
- 角色名称：{{pet_name}}
- 参考角色图：{{character_reference_url}}
- 外观备注：{{appearance_notes}}

角色一致性要求：

- 必须是角色设定图里的同一只宠物。
- 只能改变姿态、表情和动作节奏，不能改变角色身份。
- 保持脸型、眼距、耳朵形状、耳朵位置、鼻口区域、毛色、花纹、胸口、爪子、尾巴细节。
- 不要新增参考图中没有的花纹、服装、项圈、铃铛或装饰。
- 不要因为动作变化而改变身体比例。

动作要求：

- 动作必须清楚表达 {{action}}，但不要夸张到破坏角色比例。
- 姿态应适合作为桌面宠物动画关键帧。
- 动作要简单、干净、可读，便于后续切成多帧动画。
- 角色必须完整全身，居中展示，不能裁切身体、耳朵、尾巴或爪子。
- 如果是非循环动作，也要保持最终姿态自然，不要像战斗、奔跑、攻击或跌倒。

画面要求：

- 1:1 构图。
- 单个角色。
- 简单浅色背景或便于移除的干净背景。
- 厚白色贴纸描边。
- 边缘干净，无脏边，无噪点。
- 不要文字、Logo、水印、道具说明、漫画分格。

风格要求：

- 与角色设定图保持完全相同的 Q 版贴纸风格。
- 色彩、线条粗细、光影强度、描边宽度要与设定图一致。
- 不要变成写实照片、3D 渲染、油画、像素风或其他风格。

额外风格备注：

{{style_notes}}

额外负面约束：

{{negative_prompt}}
