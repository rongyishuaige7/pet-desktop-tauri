# 动作帧生成器

桌面宠物的 30 张动作帧（6 动作 × 5 帧，512×512 RGBA）由这里的脚本生成。
脚本是确定性的：同样的输入永远得到同样的输出，改参数后可以直接重跑。

## 依赖

```bash
python3 -m pip install --user pillow numpy
```

`npm run frames:check` 和 `src/frame-pack.test.ts` 不需要这两个包。

## 用法

```bash
python3 tools/frames/generate.py --action happy --action sit   # 重新生成并写回 frame-pack/
python3 tools/frames/generate.py --sync-public                # frame-pack/ -> public/frame-pack/
python3 tools/frames/generate.py --check                      # 检查出血边距
npm test                                                      # 含帧包守卫测试
```

## 约定（脚本会强制保证）

- 画布 512×512 RGBA，透明底，双线性重采样在预乘 alpha 上做，避免边缘发黑或发白。
- 头部（`y < 240`）刚性：只允许整体平移，不允许缩放。
- 每帧头顶至少留 16px、脚下至少留 8px 透明边距——任何姿势都不会被画布切平。
- 脚底锚在 `y = 474`，相邻帧不上下抖。

## 两处副本

`frame-pack/` 是源，`public/frame-pack/` 是 Vite 托管的副本。两者必须逐字节一致，
`src/frame-pack.test.ts` 会在不一致时失败；改完记得 `--sync-public`。

## 已知取舍

- **happy**：原 001/002 是「纵向拉伸 1.12 倍 + 上移 39px」导致的切顶，闭眼表情只存在于这两张
  坏帧里，且是另一套渲染（眼睛偏大、阴影更平），贴回干净身体会露出贴纸感。现在整组改用
  000 这张干净底图做受控弹跳，保留腮红，不再有切顶。
- **sit**：旧版把下半身整体等比例压扁，裆部被压平成一条直线、大腿消失。现在头部刚性下沉
  64px，压缩量集中在贴地部分，并加了膝盖外顶，腿部轮廓保住了。但纯 2D 形变只能做「蹲坐」，
  真正的盘腿坐姿需要重画或绑定骨骼。
