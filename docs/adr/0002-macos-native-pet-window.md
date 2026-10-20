# ADR 0002: macOS 桌面宠物窗口采用原生 AppKit 实现

## 状态

已接受，逐步实施中。

## 背景

ADR 0001 确定了“管理界面跨平台、桌面宠物窗口按平台原生实现”的路线。Linux 版本已经使用 GTK 原生窗口；macOS 版本此前没有实现，且 `gtk` 依赖没有做平台隔离，导致整个 crate 无法在 macOS 上编译。

macOS 上不能直接复用 GTK 方案：

- GTK 的定时器依赖 GLib 主循环，而 Tauri/tao 在 macOS 上运行的是 `NSApplication` 主循环，两者不共享。
- 即使通过 Homebrew 安装 GTK 让编译通过，宠物窗口的动画、拖拽和菜单也不会正常工作。
- 透明 `WebviewWindow` 可以工作，但阴影、边缘和右键菜单的质感受 WebKit 合成影响，需要额外的 NSPanel 插件。

## 决策

macOS 桌面宠物窗口使用 **AppKit NSPanel**，在 Tauri 的同一主线程、同一 `NSApplication` run loop 上创建：

- `NSPanel` + `NSWindowStyleMask::Borderless | NonactivatingPanel`。
- `setLevel(3)`（floating）、`CanJoinAllSpaces | FullScreenAuxiliary | Stationary | IgnoresCycle`。
- `orderFrontRegardless()` 显示窗口但不激活 App。
- `NSImageView` 显示帧图，`ScaleProportionallyUpOrDown` 居中。
- `NSEvent` 本地监听器处理左键拖拽（`performWindowDragWithEvent:`）和右键菜单。
- `NSTimer`（100ms，common run loop modes）驱动动作状态机。
- 帧图通过 `NSImage` 加载，按动作懒加载并缓存。
- 位置持久化到 `native-pet-settings.json`，拖拽结束后写入。

平台代码按 `#[cfg(target_os = ...)]` 隔离：

```text
src-tauri/src/native_pet/
  mod.rs         共享 runtime、公开 API、平台分发
  model.rs       动作、缩放、时间间隔
  settings.rs    统一设置结构与原子写入
  frame_pack.rs  帧包扫描、校验、data URL 编码
  linux.rs       GTK 实现
  macos.rs       AppKit 实现
  stub.rs        其他平台空实现
```

Tauri 命令与事件契约保持不变，前端主流程无需修改：

- `get_native_pet_settings`
- `load_preset_frame_pack`
- `set_native_pet_frame_root`
- `set_native_pet_action`
- `set_native_pet_scale`
- `native-pet-action-changed`
- 新增可选事件 `native-pet-error`

## 为什么不选其他方案

### 透明 Tauri WebviewWindow

优点是可以复用 React 和 CSS；缺点是透明窗口的阴影、边缘、点击区域和右键菜单在 WebKit 下不够可控，且要浮在全屏应用之上仍需要 NSPanel 级别的窗口处理。与 ADR 0001 的结论一致，不作为主路线。

### Swift 辅助进程

可以把 AppKit 逻辑写成独立 Swift 进程，通过 IPC 与 Tauri 通信；但会增加打包、签名、生命周期和 IPC 同步成本，收益有限。

### 在 macOS 上继续使用 GTK

不可行，原因是事件循环不兼容，而不是依赖安装问题。

## 影响

正面影响：

- macOS 可以原生运行管理界面和桌面宠物窗口。
- 窗口透明、置顶、非激活、拖拽和菜单使用系统原生能力，视觉和交互更稳定。
- Linux 与 macOS 共享帧包扫描、设置结构和 Tauri 命令，行为一致。
- 非 Linux 平台不再被 GTK 依赖阻塞编译。

负面影响：

- 新增 `objc2` / `objc2-app-kit` / `objc2-foundation` / `block2` 依赖，AppKit 代码需要主线程约束。
- macOS 窗口行为（全屏、Stage Manager、多屏）需要按系统版本做手工验证。
- 需要维护两套原生窗口实现。

## 验证

- `cargo check` / `cargo test` 在 macOS 与 Linux 上通过。
- `npm test`、`npm run build` 通过。
- 手工验收：透明、置顶、非激活、拖拽、右键菜单、动作同步、缩放、多屏、Retina、关闭 studio 后继续运行、托盘恢复、退出。
- 帧包缺失时保留旧帧，并通过 `native-pet-error` 上报。

## 后续

- 像素级透明区域点击穿透（可选）。
- 全屏应用之上的窗口级别开关。
- 帧图后台解码与更精细的内存上限。
- Windows 原生宠物窗口。
