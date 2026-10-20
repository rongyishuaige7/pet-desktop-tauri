# macOS 构建与发布

本文记录 macOS 版本的本地构建、Universal 构建、签名和公证流程。

## 1. 本地构建

前置条件：

- Xcode Command Line Tools
- Rust（stable）
- Node.js 22+

```bash
npm ci
npm run build
npm run tauri:build
```

产物：

```text
src-tauri/target/release/bundle/macos/桌面贴贴宠物.app
src-tauri/target/release/bundle/dmg/桌面贴贴宠物_0.1.0_aarch64.dmg
```

只想验证应用本体时：

```bash
npm run tauri:build -- --bundles app
```

DMG 依赖 `hdiutil` 和 Finder 自动化权限。如果构建环境禁止创建磁盘镜像，先只产出 `.app`，在普通终端或 CI 上再生成 DMG。

本仓库已在本地验证 aarch64 DMG 的 `hdiutil verify` 与挂载，DMG 内包含 `.app` 和 `Applications` 链接。

## 2. Universal（Apple Silicon + Intel）

```bash
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run tauri:build:universal
```

或：

```bash
npm run tauri:build -- --target universal-apple-darwin
```

验证架构：

```bash
lipo -info "src-tauri/target/universal-apple-darwin/release/pet_desktop_tauri"
```

应同时包含 `arm64` 和 `x86_64`。本仓库已实际构建并验证 universal 产物。

## 3. 代码签名

### 本地（证书在钥匙串）

```bash
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (TEAMID)"
npm run tauri:build
```

也可以把 identity 写进 `tauri.macos.conf.json` 的 `bundle.macOS.signingIdentity`。

### CI（导出 p12）

```bash
# 在钥匙串中导出 Developer ID Application 证书为 .p12
base64 -i certificate.p12 -o certificate-base64.txt
```

配置 GitHub Secrets：

```text
APPLE_CERTIFICATE
APPLE_CERTIFICATE_PASSWORD
APPLE_SIGNING_IDENTITY
KEYCHAIN_PASSWORD
```

`APPLE_CERTIFICATE` 是 p12 的 base64 内容，不是文件路径。

### 仅本地测试的 ad-hoc 签名

```bash
export APPLE_SIGNING_IDENTITY="-"
npm run tauri:build -- --bundles app
```

ad-hoc 签名不能通过 Gatekeeper 的正式分发检查，只适合本机运行。

## 4. 公证（Notarization）

使用 Apple ID + App-specific password：

```text
APPLE_ID
APPLE_PASSWORD        # App-specific password，不是 Apple ID 登录密码
APPLE_TEAM_ID
```

或使用 App Store Connect API Key：

```text
APPLE_API_ISSUER
APPLE_API_KEY
APPLE_API_KEY_PATH
```

然后重新执行构建。Tauri 会签名、提交公证并 stapling。

如需先做一次不 stapling 的公证检查：

```bash
npm run tauri:build -- --bundles dmg --skip-stapling
```

验证：

```bash
codesign --verify --deep --strict --verbose=2 "src-tauri/target/release/bundle/macos/桌面贴贴宠物.app"
spctl -a -vv "src-tauri/target/release/bundle/macos/桌面贴贴宠物.app"
```

## 5. CI 产物

`.github/workflows/ci.yml` 的 `macos-bundle` job 会在 tag 或手动触发时构建未签名 `.app` 并上传 artifact。

需要签名/公证时，在 CI 中注入上面的 Secrets，并把构建命令改为：

```bash
npm run tauri:build -- --bundles app,dmg
```

## 6. 开机自启

托盘菜单的“开机自启”会写入：

```text
~/Library/LaunchAgents/local.pet.desktop.sticker.plist
```

该 LaunchAgent 在下次登录时生效，不会立即拉起应用；关闭后已加载的任务会在注销后失效。开发模式下启用会指向 `target/debug/pet_desktop_tauri`，建议只在打包后的 `.app` 上使用。

## 7. 常见问题

- **`hdiutil: create failed - 操作不被允许`**：构建环境禁止创建磁盘镜像；在普通终端或 CI 上重试，或先只构建 `.app`。
- **`spctl` 拒绝**：未签名/未公证，或证书不是 Developer ID Application。
- **Intel 机器打不开**：确认构建的是 Universal 或 x86_64，而不是仅 arm64。
- **公证失败**：检查 `APPLE_PASSWORD` 是否为 App-specific password，以及 Team ID 是否正确。
