# 桌面贴贴宠物

一个 Linux 桌面宠物应用原型。它用 Tauri + React 提供管理界面，用 Rust + GTK 创建一个透明置顶的原生桌面宠物窗口，让本地动作帧包里的猫猫狗狗在桌面上活动。

当前版本的核心路线是“导入本地动作帧包并播放”，因此不依赖在线 AI 服务也能运行。仓库里保留了 Minimax 图像生成和参考图上传链路，方便后续继续扩展为“上传宠物照片 -> 生成动作帧 -> 桌面宠物”的完整工作流。

## 功能特性

- 本地导入 6 组动作帧：待机、坐下、睡觉、开心、走路、跳跃。
- 支持 PNG、JPG、WebP 帧图，透明 PNG 效果最佳。
- 管理界面可预览动画、切换动作、调整宠物缩放比例。
- 原生 GTK 桌面宠物窗口透明、置顶、可拖拽。
- 宠物窗口右键菜单可直接切换动作。
- 关闭管理界面后，宠物窗口继续运行。
- 系统托盘支持重新打开管理界面和退出应用。
- 宠物配置保存到 IndexedDB，帧包目录和缩放比例保存到 localStorage。

## 技术栈

- Tauri 2
- React 19
- Vite
- TypeScript
- Rust
- GTK 3 / GDK Pixbuf
- Tauri tray icon

## 运行效果

建议后续在这里补充截图或 GIF：

```text
docs/screenshots/studio.png
docs/screenshots/desktop-pet.gif
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

Debian / Ubuntu 系统依赖可参考：

```bash
sudo apt update
sudo apt install -y \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libgtk-3-dev \
  libwebkit2gtk-4.1-dev \
  libayatana-appindicator3-dev \
  librsvg2-dev
```

### 2. 准备动作帧包

应用默认读取：

```text
/data/大帅哥小项目/frame-slicer
```

也可以在界面中手动修改帧包目录。

帧包目录结构：

```text
frame-slicer/
  idle/
    000.png
    001.png
    002.png
    003.png
    004.png
  sit/
  sleep/
  happy/
  walk/
  jump/
```

要求：

- 必须包含 `idle`、`sit`、`sleep`、`happy`、`walk`、`jump` 六个目录。
- 每个动作目录至少 5 张图片。
- 支持 `png`、`jpg`、`jpeg`、`webp`。
- 文件名按字典序排序，建议使用 `000.png`、`001.png` 这种编号。

### 3. 开发运行

```bash
npm run tauri:dev
```

开发模式会启动 Vite dev server，并让 Tauri 连接：

```text
http://localhost:1420
```

如果直接运行开发模式二进制但没有启动 Vite，可能看到：

```text
Could not connect to localhost: Connection refused
```

这种情况请使用 `npm run tauri:dev`，或者运行正式构建产物。

### 4. 正式构建

```bash
npm run tauri:build
```

构建产物：

```text
src-tauri/target/release/pet_desktop_tauri
src-tauri/target/release/bundle/deb/桌面贴贴宠物_0.1.0_amd64.deb
```

运行二进制：

```bash
./src-tauri/target/release/pet_desktop_tauri
```

安装 deb：

```bash
sudo apt install "./src-tauri/target/release/bundle/deb/桌面贴贴宠物_0.1.0_amd64.deb"
```

不要用 `cargo build --release` 作为最终应用构建命令。它可能不会完整执行 Tauri 的前端资源嵌入流程，导致应用运行后仍尝试连接 `localhost:1420`。

## 操作说明

- 点击“预置帧包”页签，填写本地帧包目录。
- 点击“一键导入并保存预置帧包”。
- 在管理界面右侧预览动画并切换动作。
- 拖拽桌面宠物窗口可以移动位置。
- 右键桌面宠物窗口可以切换动作。
- 关闭管理界面不会退出应用，宠物会继续留在桌面。
- 从系统托盘选择“打开主界面”可以恢复管理界面。
- 从系统托盘选择“退出应用”才会完全退出。

## 项目架构

```text
pet-desktop-tauri/
  src/                 React 管理界面
  src-tauri/           Tauri / Rust 桌面能力
  tools/               辅助工具脚本
  package.json         前端依赖和 npm 脚本
  src-tauri/Cargo.toml Rust 依赖和 crate 配置
```

运行时结构：

```text
React 管理界面
-> Tauri command
-> Rust 后端读取帧包、控制原生窗口
-> GTK 透明置顶窗口播放桌面宠物
```

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `src/main.tsx` | React 主入口，包含管理界面、帧包导入、动画预览、动作切换和缩放控制。 |
| `src/styles.css` | 管理界面和宠物窗口样式。 |
| `src/types.ts` | 宠物类型、动作枚举、帧集合类型和存储 key。 |
| `src/storage.ts` | IndexedDB 持久化、BroadcastChannel 同步、动作切换同步。 |
| `src/generator.ts` | 预留生成器逻辑，包含 Minimax 和本地 Canvas 生成链路，目前不是主流程。 |
| `src-tauri/src/lib.rs` | Tauri 主逻辑，注册命令、启动 GTK 宠物窗口、托盘菜单、窗口关闭拦截、Minimax/上传命令。 |
| `src-tauri/src/native_pet.rs` | 原生 GTK 宠物窗口，负责帧读取、绘制、动画计时、拖拽和右键菜单。 |
| `src-tauri/tauri.conf.json` | Tauri 应用窗口、构建和打包配置。 |
| `src-tauri/capabilities/default.json` | Tauri 权限配置。 |
| `tools/upload-server.mjs` | 参考图上传服务示例，用于 Minimax 图生图公网 URL。 |
| `tools/nginx-upload-static.conf` | 上传服务的 nginx 配置示例。 |

## 数据流

导入帧包：

```text
本地帧包目录
-> load_preset_frame_pack
-> Rust 读取 idle/sit/sleep/happy/walk/jump
-> 前端保存 PetProfile 到 IndexedDB
-> 通知 BroadcastChannel
-> 原生 GTK 宠物窗口读取同一帧包目录并播放
```

动作切换：

```text
管理界面按钮 / 宠物右键菜单
-> setCurrentAction
-> 更新 IndexedDB
-> 调用 set_native_pet_action
-> GTK 窗口切换动作
```

窗口关闭：

```text
点击管理界面关闭按钮
-> Tauri CloseRequested
-> prevent_close
-> hide studio 窗口
-> 应用进程继续运行
-> 桌面宠物继续存在
```

## Minimax 预留链路

仓库中保留了 AI 生成相关实现：

- `src/generator.ts`
- `generate_minimax_image`
- `upload_reference_image`
- `tools/upload-server.mjs`

上传服务示例：

```bash
mkdir -p /opt/pet-upload
cd /opt/pet-upload
PUBLIC_BASE_URL="https://your-domain.example" node /path/to/upload-server.mjs
```

上传接口接收：

```json
{
  "filename": "pet-reference.png",
  "content_type": "image/png",
  "base64": "..."
}
```

返回：

```json
{
  "url": "https://your-domain.example/uploads/pet-reference.png"
}
```

不要把 API Key、token、cookie 或任何私密配置提交到仓库。

## 当前限制

- 目前主流程依赖现成动作帧包，暂未内置完整 AI 生成流程。
- 默认帧包目录是本机路径，其他用户需要在界面中改成自己的帧包目录。
- 暂未持久化桌面宠物窗口位置。
- 暂未实现开机自启动。
- 当前主要面向 Linux。
- 当前打包目标主要是 deb。

## License

MIT
