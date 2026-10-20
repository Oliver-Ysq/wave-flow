# Tauri Desktop

Wave Flow 的 macOS 桌面壳、随包 Desktop Engine 和打包配置。桌面端不再启动 daemon：
Tauri 是 Engine 的唯一父进程，业务状态、Journal、Control 与 Agent 会话都由 Engine 持有。

## 目录

- `src/main.rs`：Tauri 宿主。spawn/supervise Engine、私有 JSONL 通道、托盘与菜单、
  窗口主题与显示时机、退出确认；不实现第二套 Run/Harness 状态。
- `web/`：React 工作台与 Vite 构建（`web/dist` 为产物，已忽略）。Markdown 渲染器是
  按需加载的独立 chunk。
- `tauri.conf.json` / `tauri.dev.conf.json`：生产与开发窗口、bundle、externalBin 配置。
- `capabilities/default.json`：主窗口权限，仅 `core:default`、窗口拖动与原生目录选择。
- `binaries/`：`desktop:prepare` 编译出的 Engine sidecar（已忽略，随构建生成）。
- `gen/`：Tauri CLI 生成的权限 schema（已忽略，不手改）。
- `icons/`：应用与托盘图标。

## 进程与通信

`bun run desktop:prepare` 把 `src/desktop/engine-main.ts` 编译为
`binaries/wave-flow-desktop-engine-<target>`，Tauri 以 externalBin 启动它。两边只通过
stdin/stdout 的 JSONL 通信：

- 请求带 `requestId`，响应按 id 关联；并发派发，响应不保证到达顺序，慢 action 不会
  队头阻塞。事件帧不带 `requestId`，Tauri 按帧形状分流。
- 每次 spawn 递增 generation，迟到的旧进程帧与 `Terminated` 事件被丢弃，不能影响新
  Engine。
- 不监听 loopback、不发布 descriptor 或心跳；Web 只调用 Tauri 私有命令。
- 仅 `WAVE_FLOW_HOME` 等白名单环境变量传入 Engine。

## 生命周期

- Engine 每秒检查父进程存活（ppid 变化或 `kill(pid, 0)` 返回 ESRCH），父进程消失即
  关闭会话并退出；stdin EOF 后显式 `process.exit`，不让 ACP 子进程句柄拖住进程。
- 启动时先把上一个进程遗留的 active ACP 节点收敛为 `interrupted`，绝不认领旧 session。
- ACP Worker 以独立进程组运行，终止为 SIGTERM → 3 秒宽限 → SIGKILL。
- 关闭窗口只隐藏（`CloseRequested` 被拦截）；菜单或 ⌘Q 退出会先唤起窗口、走应用内
  确认，再请求 Engine durable-first 写入取消（最多等 3 秒）。Engine 崩溃或管道失联时
  强制结束自身，下次启动按异常收敛为 `interrupted`，不伪造 `cancelled`。

## 启动显示

主窗口以 `visible: false` 创建，等 Web 首份耐久快照提交后调用 `reveal_main_window`
显示，避免先露出空白/白底再跳到工作台。主题与底色由 `web/index.html` 的内联脚本在
首帧前确定。Web 侧 1.8 秒、Rust 侧 2.5 秒兜底：脚本或 Engine 故障时恢复页仍会显示。

## IPC 命令

`ensure_engine`、`engine_request`、`reveal_main_window`、`update_tray_summary`、
`take_menu_action`、`exit_desktop`、`set_window_theme`。业务 action 名由 Web 与 Engine
共同约定，Tauri 只转发，不解释 Run/Execution 语义。

## 构建与签名

- `bun run desktop:dev`：Tauri 开发模式（`tauri.dev.conf.json`，独立产品名与 bundle id）。
- `bun run web:dev`：只跑 Web 工作台，用于浏览器内 UI 迭代。
- `bun run desktop:build`：`desktop:prepare` → `tauri build` → `scripts/sign-macos-app.ts`。

签名脚本先清 xattr、按 Engine → 外层 App 的顺序签名（不用 `--deep` 代替顺序签名），
再用严格校验复核两层身份与 Bundle ID。开发机无证书时使用 ad-hoc 身份，只保证同一构建内
身份一致；正式分发必须设置 `APPLE_SIGNING_IDENTITY`，并单独验证 hardened runtime、
Bun JIT entitlement 与公证——设置证书本身不代表已完成公证。当前 `desktop:prepare` 只
产出 `aarch64-apple-darwin`，Intel 构建需另加目标并验证。

macOS 最低版本 12.0；窗口使用原生交通灯与 Overlay 隐藏标题，标题栏拖动由 Tauri 官方
`data-tauri-drag-region="deep"` 处理，不需要 Web 侧 `startDragging`。
