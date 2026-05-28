# Prompt 模板

这个目录用于保存 AI 角色原型图和动作帧生成的通用 prompt 模板。

这里的模板可以提交到 GitHub。真实生成记录、私有参考图 URL、API Key、token、用户原图等不要提交。

## 目录结构

```text
prompts/
  README.md
  base-identity.md
  style-q-sticker.md
  negative.md
  character-model-sheet.md
  action-frame-pack.md
  actions/
    idle.md
    sit.md
    sleep.md
    happy.md
    walk.md
    jump.md
  examples/
    cat-example.json
    dog-example.json
```

## 模板写法

模板文件使用 Markdown，并在文件顶部保留 YAML Front Matter。

示例：

```md
---
id: character-model-sheet-v1
type: character_model_sheet
version: 1
variables:
  species: cat | dog
  pet_name: string
---

在这里填写具体 prompt。
```

## 建议变量

- `species`: 宠物类型，例如 `cat` 或 `dog`
- `pet_name`: 宠物名字
- `reference_image_url`: 参考图 URL
- `appearance_notes`: 外观描述
- `action`: 动作 ID
- `action_description`: 动作描述
- `style_notes`: 风格描述
- `negative_prompt`: 负面约束

## 高效使用流程

推荐把 `prompts/` 当成“通用模板库”，把每次真实生成用到的最终 prompt 保存到 `generation-runs/`。

标准流程：

```text
1. 准备宠物信息
2. 复制对应模板内容给 ChatGPT
3. 让 ChatGPT 合并模板并替换变量
4. 保存最终 prompt 到 generation-runs/
5. 把最终 prompt 复制到图像生成模型
6. 记录结果和失败原因
```

## 给 ChatGPT 的输入方式

### 生成角色原型图 prompt

把下面内容复制给 ChatGPT，并补齐变量：

```text
请根据我提供的信息，基于项目里的 prompt 模板，帮我合成一版“角色原型图 / 角色设定图”的最终图像生成 prompt。

要求：
- 使用中文输出。
- 只输出最终 prompt，不要解释。
- 保持约束完整，不要删减角色一致性、风格、负面约束。
- 保留图像生成模型容易理解的清晰分段。

宠物信息：
- species: cat
- pet_name: 奶茶
- reference_image_url: https://example.com/uploads/pet-reference.png
- appearance_notes: 这里填写宠物真实外观，例如毛色、花纹、耳朵、眼睛、尾巴、爪子等。
- style_notes: Q 版贴纸桌面宠物风格，白色描边，完整全身，背景干净。
- negative_prompt: 不要文字、水印、额外动物、人类、服装、项圈、错误毛色、身体裁切、肢体畸形。

请合并这些模板：
- prompts/base-identity.md
- prompts/style-q-sticker.md
- prompts/negative.md
- prompts/character-model-sheet.md
```

### 生成单个动作帧 prompt

把下面内容复制给 ChatGPT，并按动作替换 `action` 和 `action_description`：

```text
请根据我提供的信息，基于项目里的 prompt 模板，帮我合成一版“动作帧图像生成”的最终 prompt。

要求：
- 使用中文输出。
- 只输出最终 prompt，不要解释。
- 这是给图像生成模型使用的 prompt，不是给人看的说明文。
- 必须保持同一只宠物身份一致。
- 动作要明确，但不要破坏角色比例。

宠物信息：
- species: cat
- pet_name: 奶茶
- character_reference_url: https://example.com/uploads/pet-character-model-sheet.png
- action: idle
- action_description: 复制 prompts/actions/idle.md 里的动作描述。
- appearance_notes: 这里填写宠物真实外观，例如毛色、花纹、耳朵、眼睛、尾巴、爪子等。
- style_notes: Q 版贴纸桌面宠物风格，白色描边，完整全身，背景干净。
- negative_prompt: 不要文字、水印、额外动物、人类、服装、项圈、错误毛色、身体裁切、肢体畸形。

请合并这些模板：
- prompts/base-identity.md
- prompts/style-q-sticker.md
- prompts/negative.md
- prompts/action-frame-pack.md
- prompts/actions/idle.md
```

### 一次生成六个动作 prompt

如果要一次性让 ChatGPT 生成 6 个动作 prompt，用这个：

```text
请基于项目里的 prompt 模板，为同一只桌面宠物分别生成 6 份最终动作图像生成 prompt。

要求：
- 使用中文输出。
- 按 idle、sit、sleep、happy、walk、jump 分成 6 个小节。
- 每个小节只放该动作的最终 prompt。
- 不要解释。
- 六个动作必须保持完全相同的角色身份、画风、毛色、花纹和比例。

宠物信息：
- species: cat
- pet_name: 奶茶
- character_reference_url: https://example.com/uploads/pet-character-model-sheet.png
- appearance_notes: 这里填写宠物真实外观。
- style_notes: Q 版贴纸桌面宠物风格，白色描边，完整全身，背景干净。
- negative_prompt: 不要文字、水印、额外动物、人类、服装、项圈、错误毛色、身体裁切、肢体畸形。

请合并这些模板：
- prompts/base-identity.md
- prompts/style-q-sticker.md
- prompts/negative.md
- prompts/action-frame-pack.md
- prompts/actions/idle.md
- prompts/actions/sit.md
- prompts/actions/sleep.md
- prompts/actions/happy.md
- prompts/actions/walk.md
- prompts/actions/jump.md
```

## 保存最终 prompt

每次真实生成前，先创建一个本地记录目录：

```bash
mkdir -p generation-runs/$(date +%F)-pet-name
```

建议保存这些文件：

```text
generation-runs/YYYY-MM-DD-pet-name/
  request.json
  prompt-character.md
  prompt-idle.md
  prompt-sit.md
  prompt-sleep.md
  prompt-happy.md
  prompt-walk.md
  prompt-jump.md
  result-notes.md
```

`request.json` 示例：

```json
{
  "created_at": "2026-05-27T20:50:00+08:00",
  "provider": "minimax",
  "model": "image-01",
  "species": "cat",
  "pet_name": "奶茶",
  "reference_image_url": "https://example.com/uploads/pet-reference.png",
  "character_reference_url": "https://example.com/uploads/pet-character-model-sheet.png",
  "appearance_notes": "这里记录本次使用的外观描述。",
  "style_notes": "这里记录本次使用的风格描述。",
  "negative_prompt": "这里记录本次额外负面约束。",
  "template_versions": [
    "base-identity-v1",
    "style-q-sticker-v1",
    "negative-v1",
    "character-model-sheet-v1",
    "action-frame-pack-v1"
  ],
  "actions": ["idle", "sit", "sleep", "happy", "walk", "jump"]
}
```

保存 prompt 的方式：

```bash
cat > generation-runs/2026-05-27-pet-name/prompt-character.md
```

然后粘贴 ChatGPT 输出的最终 prompt，按 `Ctrl+D` 保存。

动作 prompt 同理：

```bash
cat > generation-runs/2026-05-27-pet-name/prompt-idle.md
cat > generation-runs/2026-05-27-pet-name/prompt-sit.md
cat > generation-runs/2026-05-27-pet-name/prompt-sleep.md
cat > generation-runs/2026-05-27-pet-name/prompt-happy.md
cat > generation-runs/2026-05-27-pet-name/prompt-walk.md
cat > generation-runs/2026-05-27-pet-name/prompt-jump.md
```

## 提交规则

可以提交：

```text
prompts/
prompts/examples/
```

不要提交：

```text
generation-runs/
private-prompts/
真实宠物照片
真实 API Key
私有图片 URL
```

## 本地生成记录

真实生成记录建议放到项目根目录的 `generation-runs/`，该目录默认不提交。

建议结构：

```text
generation-runs/
  2026-05-27-pet-name/
    request.json
    prompt-character.md
    prompt-idle.md
    result-notes.md
```
