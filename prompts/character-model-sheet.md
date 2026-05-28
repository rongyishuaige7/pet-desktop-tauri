---
id: character-model-sheet-v1
type: character_model_sheet
version: 1
provider: minimax
model: image-01
output: single_image
aspect_ratio: "1:1"
uses:
  - base-identity-v1
  - style-q-sticker-v1
  - negative-v1
variables:
  species: cat | dog
  pet_name: string
  reference_image_url: string
  appearance_notes: string
  style_notes: string
  negative_prompt: string
---

请根据参考图生成一张“桌面宠物角色原型图 / 角色设定图”。这张图将作为后续所有动作帧的唯一角色标准，因此角色身份一致性优先级最高。

任务目标：

- 把参考图中的 {{species}} 转化为一只 Q 版桌面贴纸宠物角色。
- 生成单个完整角色，不要生成多视图排版，不要生成多个版本对比。
- 角色需要正面或轻微 3/4 朝向，姿态稳定，便于后续作为动作帧参考。
- 画面中只能出现这一只宠物角色。
- 角色必须完整全身，居中展示，四肢、耳朵和尾巴不能被裁切。

角色一致性要求：

- 严格以 {{reference_image_url}} 中的宠物作为身份来源。
- 不要重新设计角色，不要把它变成另一只同品种宠物。
- 保持脸型、眼距、耳朵形状、鼻口区域、毛色、花纹、胸口、爪子和尾巴细节。
- 如果参考图中某些区域不清晰，宁可保持简化，也不要凭空新增复杂花纹。
- 必须遵守外观备注：{{appearance_notes}}

风格要求：

- 高质量 Q 版贴纸风格。
- 适合作为桌面悬浮宠物动画素材。
- 轮廓清楚，形状可爱，比例稳定。
- 干净白色贴纸描边。
- 简单浅色背景，便于后续抠图。
- 色彩明快但不能改变宠物真实毛色。
- 画面比例 1:1，角色位于中心，四周留有安全边距。

输出要求：

- 只输出一张完整角色设定图。
- 不要文字、标签、名称、箭头、注释、Logo、水印。
- 不要复杂背景，不要家具，不要其他动物，不要人。
- 不要服装或装饰品，除非外观备注明确要求。
- 不要把角色做成玩偶、机器人、人形兽或其他物种。

额外风格备注：

{{style_notes}}

额外负面约束：

{{negative_prompt}}
