# 桌面贴贴宠物

一个 Linux 桌面宠物 MVP。应用提供一个 Tauri + React 的管理界面，用来导入猫/狗动作帧包、预览动画和切换动作；同时启动一个透明置顶的原生 GTK 宠物窗口，在桌面上播放宠物动画。

当前版本的主流程是“导入本地动作帧包”，不再依赖在线生图服务才能运行。项目中仍保留了 Minimax 图像生成和参考图上传相关代码，作为后续重新接入 AI 生成链路的基础。

## 功能

- 导入 6 组本地动作帧：
  - 待机 `idle`
  - 坐下 `sit`
  - 睡觉 `sleep`
  - 开心 `happy`
  - 走路 `walk`
  - 跳跃 `jump`
- 每组动作支持 PNG / JPG / WebP 帧图。
- 主界面预览当前宠物动作动画。
- 桌面宠物窗口透明、置顶、可拖拽。
- 桌面宠物右键菜单可切换动作。
- 关闭主界面时只隐藏窗口，宠物继续运行。
- 系统托盘提供：
  - 打开主界面
  - 退出应用
- 宠物数据保存到浏览器 IndexedDB。
- 帧包目录和缩放比例保存到 localStorage。

## 技术栈

- Tauri 2
- React 19
- Vite
- TypeScript
- Rust
- GTK 3
- GDK Pixbuf
- Tauri tray icon

## 项目架构

```text
pet-desktop-tauri/
  README.md
  package.json
  package-lock.json
  index.html
  vite.config.ts
  tsconfig.json
  src/
    main.tsx
    styles.css
    types.ts
    storage.ts
    generator.ts
    vite-env.d.ts
  src-tauri/
    Cargo.toml
    Cargo.lock
    build.rs
    tauri.conf.json
    capabilities/
      default.json
    icons/
      icon.png
    src/
      main.rs
      lib.rs
      native_pet.rs
    gen/
      schemas/
  tools/
    upload-server.mjs
    nginx-upload-static.conf
```

## 文件说明

### 根目录

| 文件 | 作用 |
| --- | --- |
| `README.md` | 项目说明文档。 |
| `package.json` | 前端依赖、Tauri CLI 依赖和 npm 脚本。 |
| `package-lock.json` | npm 依赖锁定文件，建议提交。 |
| `index.html` | Vite 前端 HTML 入口。 |
| `vite.config.ts` | Vite 配置，开发端口固定为 `1420`。 |
| `tsconfig.json` | TypeScript 编译配置。 |

### 前端 `src/`

| 文件 | 作用 |
| --- | --- |
| `src/main.tsx` | React 主入口。包含管理界面、动作帧导入、预览播放、宠物窗口 UI、动作切换和缩放控制。 |
| `src/styles.css` | 管理界面和宠物窗口样式。 |
| `src/types.ts` | 宠物类型、动作枚举、帧集合类型和存储 key。 |
| `src/storage.ts` | IndexedDB 持久化、BroadcastChannel 同步、动作切换后同步 Rust 原生窗口。 |
| `src/generator.ts` | 旧版/预留生成器。支持 Minimax 关键图生成、本地 Canvas 兜底生成和多帧渲染，目前不是主界面主流程。 |
| `src/vite-env.d.ts` | Vite 类型声明。 |

### Tauri / Rust `src-tauri/`

| 文件 | 作用 |
| --- | --- |
| `src-tauri/Cargo.toml` | Rust crate 配置和依赖。启用了 Tauri `tray-icon` 功能。 |
| `src-tauri/Cargo.lock` | Rust 依赖锁定文件，应用项目建议提交。 |
| `src-tauri/build.rs` | Tauri 构建脚本入口。 |
| `src-tauri/tauri.conf.json` | Tauri 应用配置、窗口配置、构建配置和 deb 打包配置。 |
| `src-tauri/capabilities/default.json` | Tauri 权限配置。 |
| `src-tauri/icons/icon.png` | 应用图标。 |
| `src-tauri/src/main.rs` | Rust 二进制入口，调用库里的 `run()`。 |
| `src-tauri/src/lib.rs` | Tauri 主逻辑。注册命令、启动原生宠物窗口、创建托盘菜单、拦截主界面关闭事件、处理 Minimax 和上传接口。 |
| `src-tauri/src/native_pet.rs` | 原生 GTK 透明宠物窗口。负责读取帧图、绘制动画、拖拽、右键动作菜单和缩放。 |
| `src-tauri/gen/schemas/` | Tauri 生成的 schema 文件。可以提交，用于配置校验和 IDE 辅助。 |

### 工具 `tools/`

| 文件 | 作用 |
| --- | --- |
| `tools/upload-server.mjs` | 简单 HTTP 上传服务。用于把本地参考图上传成公网 URL，供 Minimax 图生图使用。 |
| `tools/nginx-upload-static.conf` | 上传服务的 nginx 静态文件和反代配置示例。 |

## 帧包规范

默认帧包目录：

```text
/data/大帅哥小项目/frame-slicer
```

目录结构：

```text
frame-slicer/
  idle/
    000.png
    001.png
    ...
  sit/
  sleep/
  happy/
  walk/
  jump/
```

要求：

- 必须包含 `idle`、`sit`、`sleep`、`happy`、`walk`、`jump` 六个目录。
- 每个目录至少 5 张图片。
- 支持 `png`、`jpg`、`jpeg`、`webp`。
- 文件名按字典序排序，建议使用 `000.png`、`001.png`、`002.png` 这种命名。
- 透明 PNG 效果最好。

## 数据流

```text
本地帧包
-> React 管理界面调用 Tauri 命令 load_preset_frame_pack
-> Rust 读取动作目录并转成 data URL
-> 前端保存 PetProfile 到 IndexedDB
-> 前端通知 BroadcastChannel
-> Rust 原生 GTK 宠物窗口读取同一个帧包目录
-> 桌面宠物窗口播放动画
```

动作切换：

```text
主界面按钮 / 宠物右键菜单
-> setCurrentAction
-> 更新 IndexedDB
-> 调用 set_native_pet_action
-> GTK 窗口切换动作
```

主界面关闭：

```text
点击关闭按钮
-> Tauri CloseRequested
-> prevent_close
-> hide studio 窗口
-> 进程继续运行
-> GTK 宠物窗口继续存在
```

## 开发环境

### Node.js 依赖

```bash
npm install
```

### Linux 系统依赖

不同发行版包名会有差异。Debian / Ubuntu 系可参考：

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

## 开发运行

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

这种情况请使用 `npm run tauri:dev`，或者执行正式构建后的 release 二进制。

## 正式构建

推荐使用：

```bash
npm run tauri:build
```

不要单独用下面这个命令生成最终应用：

```bash
cargo build --release
```

原因是单独的 Cargo 构建可能不会完整走 Tauri 的前端资源嵌入流程，运行后可能仍尝试连接 `localhost:1420`。

构建产物：

```text
src-tauri/target/release/pet_desktop_tauri
src-tauri/target/release/bundle/deb/桌面贴贴宠物_0.1.0_amd64.deb
```

运行 release 二进制：

```bash
./src-tauri/target/release/pet_desktop_tauri
```

安装 deb：

```bash
sudo apt install "./src-tauri/target/release/bundle/deb/桌面贴贴宠物_0.1.0_amd64.deb"
```

## Minimax 预留链路

项目保留了 Minimax 图像生成相关代码：

- 前端：`src/generator.ts`
- Rust 命令：`generate_minimax_image`
- 参考图上传命令：`upload_reference_image`
- 上传服务：`tools/upload-server.mjs`

上传服务启动示例：

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

注意：不要把 API Key、token、cookie 或任何私密配置提交到 GitHub。

## 当前边界

- 目前主流程依赖现成动作帧包，暂未内置完整 AI 生成流程。
- 还没有开机自启动。
- 还没有持久化桌面宠物窗口位置。
- 目前主要面向 Linux。
- 当前 bundle 配置主要生成 deb 包。

## GitHub 上传建议

应该提交源码、配置、锁文件、图标和工具脚本；不要提交依赖目录和构建产物。

建议提交：

```text
README.md
.gitignore
package.json
package-lock.json
index.html
vite.config.ts
tsconfig.json
src/
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/build.rs
src-tauri/tauri.conf.json
src-tauri/capabilities/
src-tauri/icons/
src-tauri/src/
src-tauri/gen/
tools/
```

不要提交：

```text
node_modules/
dist/
src-tauri/target/
.env
.env.*
*.log
```

## License

如果要公开发布，建议补充一个明确的开源协议文件，例如 `MIT`、`Apache-2.0` 或 `GPL-3.0`。
