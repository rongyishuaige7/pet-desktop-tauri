# 贡献与仓库维护说明

这份文档用于说明仓库应提交哪些文件、哪些文件不应提交，以及本地开发时的基本注意事项。

## 推荐提交内容

应该提交源码、配置、锁文件、图标和工具脚本：

```text
README.md
CONTRIBUTING.md
LICENSE
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

不要提交依赖、构建产物、本地配置和敏感信息：

```text
node_modules/
dist/
src-tauri/target/
.env
.env.*
*.log
```

## 开发命令

安装依赖：

```bash
npm install
```

开发运行：

```bash
npm run tauri:dev
```

正式构建：

```bash
npm run tauri:build
```

不要把单独执行的 `cargo build --release` 当作最终应用构建方式。Tauri 应用需要通过 `npm run tauri:build` 完成前端资源构建和嵌入。

## 提交前检查

```bash
git status --short
npm run build
```

如果改动涉及 Rust/Tauri 逻辑，建议额外执行：

```bash
npm run tauri:build
```

## 安全注意事项

- 不要提交 API Key、token、cookie、密码或私钥。
- 不要提交本机路径下的大型动作帧素材。
- 不要提交 `node_modules/`、`dist/`、`src-tauri/target/`。
- 如果后续新增 `.env.example`，只放示例变量名，不放真实值。
