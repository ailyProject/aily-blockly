# Aily Blockly 外部子应用开发提示词

本文用于在外部仓库开发 Aily Blockly child 独立子应用。外部仓库可能无法读取主应用源码，因此下面把主应用已经确定的宿主行为、目录契约、通信协议和验证标准一并写入提示词。

适用范围：

- 硬件调试类工具。
- 协议调试类工具。
- 需要独立 Node 后台、WebSocket、原生依赖或长时间运行进程的工具。
- 需要被 AI、脚本或自动化流程调用的复杂工具。

不适用范围：

- 纯轻量 UI 工具。
- 强依赖 Aily Blockly Angular 内部状态和组件生命周期的工具。
- 不需要独立后台、不需要 CLI、不需要脱离主应用单独开发的工具。

## 1. 可直接复制的开发提示词

下面内容可以直接交给 Codex 或其他开发 Agent，用来在外部子应用仓库中生成、修改或验证子应用。

```text
你正在开发一个 Aily Blockly 外部 child 独立子应用。当前仓库是子应用仓库，不能假设能读取 Aily Blockly 主应用源码。请严格按照以下宿主契约实现。

目标：
- 产出一个可复制到 Aily Blockly 主应用 `child/tools/<tool-id>/` 的完整子应用目录，或在本仓库生成等价的 `dist/<tool-id>/` 交付目录。
- 子应用必须能独立启动、独立调试、独立验证。
- 主应用只负责启动 Node 进程、加载 iframe、建立 Penpal 宿主控制通道、关闭或重启进程；工具业务能力必须留在子应用仓库内。

请先确认并固定这些命名：
- tool id：使用 kebab-case，例如 `network-debugger`、`serial-debugger`、`my-protocol-debugger`。
- package name：推荐 `@aily-project/subapp-<tool-id>`，但主应用识别工具不依赖 package name。
- i18n namespace：使用大写下划线，例如 `NETWORK_DEBUGGER`、`MY_PROTOCOL_DEBUGGER`。
- UI 标题 key：使用 `<NAMESPACE>.TITLE`。
- UI 描述 key：使用 `<NAMESPACE>.DESCRIPTION`。

必须实现的宿主识别结构：

<tool-id>/
  package.json
  index.js
  core.js
  cli.js
  server.js
  i18n/
    en.json
    zh_cn.json
    zh_hk.json
  ui/
    index.html
    ... framework or static assets
  vendor/
    penpal.min.js

如果不使用构建器，推荐使用 `ui/app.js`、`ui/styles.css`、`ui/light.css`、`ui/dark.css` 这种直观命名。若使用 Angular、Vue、React、Vite 或其他构建器，交付目录可以是框架生成的任意 JS/CSS 文件名和资源目录，例如 `main-*.js`、`chunk-*.js`、`styles-*.css`、`assets/` 等；这不影响主应用加载。主应用只要求 `ui/index.html` 存在，并且其中引用的资源能由 child server 正常提供。

Aily Blockly 主应用不会进入源码目录帮你构建，也不会为每个工具维护专用 Angular wrapper。构建后的可运行 UI 必须已经落在交付目录的 `ui/` 内。

主应用如何发现工具：
- 主应用运行时扫描 `child/tools/*`。
- 目录名默认就是 tool id。
- 目录内必须存在 `package.json`。
- 后台入口取 `package.json.main`，没有则使用 `index.js`。
- UI 入口必须是 `ui/index.html`。
- 主应用会读取 `i18n/en.json` 的第一个顶层对象作为 namespace，用它推导标题和描述 key。
- 如果缺少后台入口或 UI 入口，主应用不会注册该工具。

主应用如何启动工具：
- 工作目录是子应用目录。
- 命令固定为：
  `node <entry> serve --host 127.0.0.1 --port 0`
- `<entry>` 来自 `package.json.main`，通常是 `index.js`。
- 环境变量会包含：
  `AILY_CHILD_TOOL=1`
  `AILY_CHILD_TOOL_ID=<tool-id>`
- 默认启动超时约 8000 ms，特殊工具可能更长；所以 serve 模式必须尽快输出 ready。
- stdout 可以输出普通日志，但 ready/fatal 必须是单行 JSON。

serve 模式必须输出的 ready JSON：

{
  "event": "ready",
  "data": {
    "mode": "serve",
    "url": "http://127.0.0.1:54321/?token=...",
    "origin": "http://127.0.0.1:54321",
    "wsUrl": "ws://127.0.0.1:54321/ws?token=...",
    "shutdownUrl": "http://127.0.0.1:54321/api/shutdown?token=...",
    "port": 54321,
    "pid": 1234
  }
}

serve 模式失败时输出 fatal JSON：

{
  "event": "fatal",
  "data": {
    "message": "..."
  }
}

serve 模式安全要求：
- 只监听 `127.0.0.1`。
- 默认 `--port 0`，由系统分配随机端口。
- 每次启动生成随机 token。
- `/ws`、`/api/shutdown` 和所有敏感 API 必须校验 token。
- 静态文件服务必须做目录逃逸校验。
- 不默认开放宽松 CORS；如确实需要，只允许本地 origin。

主应用加载 iframe 的方式：
- 主应用拿到 ready.url 后，会追加：
  `lang=<normalized-lang>`
  `theme=<light-or-dark>`
- iframe 初次打开时的 URL 类似：
  `http://127.0.0.1:54321/?token=...&lang=zh_cn&theme=dark`
- 子应用 UI 必须在 Penpal 连接建立前先从 URL 参数读取 `token`、`lang`、`theme`，用于首屏语言、主题和 WebSocket 鉴权。
- `lang` 规范化规则：`zh`、`zh-cn`、`zh_cn` 归一为 `zh_cn`；`zh-hk`、`zh_hk`、`zh-tw`、`zh_tw` 归一为 `zh_hk`；其他语言转小写并把 `-` 换成 `_`；默认 `en`。
- `theme` 只接受 `light` 或 `dark`；非 `light` 一律按 `dark` 处理。

UI 运行限制：
- UI 是普通浏览器页面，运行在主应用 iframe 中。
- UI 不得直接访问 Electron preload、Node API 或文件系统。
- UI 不得假设存在 Angular、主应用组件、主应用状态管理或主应用源码。
- UI 使用 WebSocket 与自己的后台通信。
- UI 使用 Penpal 只做低频宿主控制和状态通知，不承载高频业务数据、日志流、扫描结果或硬件事件。
- 外部链接必须通过宿主 Penpal 方法 `openExternal(url)` 打开。

Penpal：主应用提供给子应用 UI 的方法：

getHostContext(): {
  toolId: string;
  lang: string;
  theme: "light" | "dark";
  platform: string;
}

childReady(payload?: {
  wsConnected?: boolean;
  backendStatus?: string;
  adapterState?: string;
  pid?: number;
}): void

childError(error: {
  message: string;
  detail?: string;
}): void

reportHostMessage(payload: {
  state?: "success" | "info" | "warning" | "error" | "loading" | "done" | "doing" | "warn";
  title?: string;
  message?: string;
  text?: string;
  detail?: string;
  showMessage?: boolean;
  sendToLog?: boolean;
  duration?: number;
}): { ok: boolean; error?: string }

requestClose(): void
requestRestart(): void
openExternal(url: string): void
sendToolSignal(signal: string, payload?: object): Promise<{ ok: boolean; waitFor: number }>

子应用 UI 需要通过 Penpal 暴露给主应用的方法：

setHostContext(context: {
  lang?: string;
  theme?: string;
  platform?: string;
}): { ok: true }

focusTool(): { ok: true }

beforeClose(): Promise<{
  canClose: boolean;
  scanning?: boolean;
  connected?: boolean;
}>

可选：
handleToolSignal(payload: {
  action?: string;
  type?: string;
  data?: string;
  payload?: object;
}): void | Promise<void>

ready 流程必须是：
1. `node index.js serve --host 127.0.0.1 --port 0` 启动后台。
2. 后台输出 stdout 单行 `{"event":"ready","data":...}`。
3. 主应用把 `ready.url` 加上 `lang`、`theme` 后加载 iframe。
4. UI 从 URL 读取 token/lang/theme，加载语言和主题。
5. UI 连接自己的 `/ws?token=...`。
6. UI 建立 Penpal 连接，必要时调用 `getHostContext()` 补齐上下文。
7. UI 确认 WebSocket/status 可用后调用 `childReady(...)`。
8. 主应用收到 `childReady` 后才隐藏 loading。

WebSocket 数据面：
- 连接地址：`ws://127.0.0.1:<port>/ws?token=<token>`。
- UI 应优先从当前页面 location 拼接 `/ws?token=...`，不要写死端口。
- 请求格式：
  `{ "id": 1, "method": "status", "params": {} }`
- 响应格式：
  `{ "id": 1, "ok": true, "result": {}, "error": "" }`
- 事件格式：
  `{ "event": "device", "data": {} }`
- 启动后建议服务端立刻给 WebSocket 客户端发送：
  `{ "event": "ready", "data": { "state": "ready", "pid": 1234 } }`
- 至少实现 `status` 方法，返回当前后台状态和 pid。

CLI 模式：
- `node index.js --help` 应输出帮助文本。
- `node index.js status` 必须输出单个 JSON 对象。
- 所有 CLI 命令 stdout 只输出一个 JSON 对象，格式：
  `{ "ok": true, "command": "status", "data": {}, "error": "" }`
- 成功退出码为 0，失败退出码非 0。
- CLI 不依赖 UI，不输出交互式提示。

推荐分层：
- `core.js`：核心能力，只包含业务逻辑，不知道 CLI、HTTP、WebSocket、Angular 或 DOM。
- `cli.js`：参数解析，调用 core，输出统一 JSON。
- `server.js`：HTTP 静态服务、WebSocket JSON-RPC、token 校验、shutdown、事件广播。
- `index.js`：根据命令选择 `serve`、`rpc`、CLI 子命令，处理 SIGTERM/SIGINT、uncaughtException、unhandledRejection。
- `ui/`：浏览器 UI。可以是手写 `app.js`，也可以是 Angular、Vue、React 等框架构建出的 bundle；无论文件名如何，都要实现 Penpal、WebSocket 客户端、i18n 和主题响应。

i18n 要求：
- 语言包放在 `i18n/<lang>.json`。
- 至少提供 `i18n/en.json`；推荐同时提供 `zh_cn.json` 和 `zh_hk.json`。
- 主应用已有多语言环境通常包括：`ar`、`de`、`en`、`es`、`fr`、`ja`、`ko`、`pt`、`ru`、`zh_cn`、`zh_hk`。
- `i18n/en.json` 至少包含：
  {
    "MY_TOOL_NAMESPACE": {
      "TITLE": "...",
      "DESCRIPTION": "..."
    }
  }
- child server 必须能提供：
  `/i18n/<lang>.json`
  `/tools/<tool-id>/i18n/<lang>.json`
- UI 加载语言时先尝试 URL 或 Penpal 传入的语言，失败后回退到 `en`。

主题要求：
- 无构建器静态 UI 推荐使用 `ui/styles.css` 放布局、尺寸、状态等基础样式，用 `ui/light.css` 和 `ui/dark.css` 放主题变量或覆盖。
- Angular、Vue、React、Vite 等框架项目不强制提供独立的 `light.css` / `dark.css` 文件；主题可以由框架 bundle、CSS variables、class、data attribute 或构建产物中的样式文件实现。
- UI 首屏必须读取 URL `theme` 并立即应用对应主题。
- Penpal `setHostContext({ theme })` 到达后必须切换到新主题。
- 不要把主题固定成单一浅色或单一深色；也不要依赖主应用 DOM 或 Angular 样式来完成子应用主题。

交付要求：
- 如果仓库根目录就是子应用目录，根目录必须能直接复制为 `child/tools/<tool-id>/`。
- 如果仓库有源码构建流程，必须生成 `dist/<tool-id>/`，其中包含主应用运行需要的完整文件。
- 不要要求 Aily Blockly 主应用额外安装每个子应用的专用脚本。
- 不要把主应用作为 `file:` 依赖写入子应用 lockfile。
- 依赖必须由子应用自己的 `package.json` 和 lockfile 表达。
- 原生依赖不要放进 asar；如需特殊发布说明，写入子应用 README。

验证命令：
- `node --check index.js`
- `node --check core.js`
- `node --check cli.js`
- `node --check server.js`
- `node index.js --help`
- `node index.js status`
- `node index.js serve --host 127.0.0.1 --port 0`

serve 验证：
- 确认 stdout 有单行 ready JSON。
- 打开 ready.url，并手动追加 `&lang=zh_cn&theme=dark` 或 `?lang=zh_cn&theme=dark`。
- 确认 `/i18n/zh_cn.json` 可访问，缺失语言能回退 `/i18n/en.json`。
- 确认 `theme=light` 和 `theme=dark` 都能让 UI 呈现对应主题；若是框架构建产物，不要求存在独立 `light.css` / `dark.css`。
- 确认 `/ws?token=...` 能连接并执行 `status`。
- 确认 `/api/shutdown?token=...` 能安全关闭。
- 确认错误 token 访问 `/ws` 和敏感 API 会被拒绝。

开发时请优先实现最小闭环：
1. 固定 tool id、namespace 和目录结构。
2. 实现 core 的 `status`。
3. 实现 CLI `status`。
4. 实现 serve 模式和 ready JSON。
5. 实现 `/ws` 的 `status` JSON-RPC。
6. 实现 UI 首屏、语言、主题和 WebSocket 连接。
7. 实现 Penpal `setHostContext`、`focusTool`、`beforeClose` 和 `childReady`。
8. 再逐步加入具体硬件、协议或 AI 能力。

禁止事项：
- 不要在子应用里导入 Aily Blockly 主应用源码。
- 不要要求主应用为该工具新增专用 Angular 组件。
- 不要通过 Penpal 传输高频日志、扫描列表、大量二进制或硬件事件。
- 不要让 UI 直接调用 Node、Electron preload 或文件系统。
- 不要只以 iframe load 作为 ready；必须等 WebSocket/status 可用后调用 `childReady`。
- 不要忽略 Windows 和 PowerShell 环境，涉及非 ASCII i18n 文件时必须按 UTF-8 读写。

完成后请输出：
- 修改的文件列表。
- 如何复制或发布到 `child/tools/<tool-id>/`。
- 已执行的验证命令和结果。
- 未验证项和原因。
```

## 2. 主应用必要背景

Aily Blockly 主应用是 Electron + Angular 应用。child 子应用不是 Angular 子模块，而是独立 Node 项目和普通浏览器 UI。主应用只提供统一宿主：

```text
Angular ChildToolHost
  -> ChildToolProcessService 启动 Node 子进程
  -> iframe 加载子应用 URL
  -> Penpal 建立低频宿主控制通道
  -> child UI 通过 WebSocket 调自己的 backend/core
```

主应用中的关键边界如下：

- 工具注册：扫描 `child/tools/*`，不是为每个子应用手写 Angular 注册。
- 统一路由：`/child-tool/:toolId`。
- 统一宿主组件：`ChildToolHostComponent`。
- 统一进程服务：`ChildToolProcessService`。
- 启动命令：`node <entry> serve --host 127.0.0.1 --port 0`。
- 初始上下文：主应用会把 `lang` 和 `theme` 追加到 iframe URL。
- 后续上下文：主应用通过 Penpal 调用子应用的 `setHostContext()`。
- 加载完成判断：不是 iframe `load`，而是子应用调用 `childReady()`。

外部子应用仓库只需要实现这些契约，不需要也不应该依赖主应用源码。

## 3. 子应用交付目录

推荐把外部仓库根目录设计成可直接复制的子应用目录。如果需要构建，则构建结果必须落到 `dist/<tool-id>/`。

```text
<tool-id>/
  package.json
  index.js
  core.js
  cli.js
  server.js
  i18n/
    en.json
    zh_cn.json
    zh_hk.json
    ar.json
    de.json
    es.json
    fr.json
    ja.json
    ko.json
    pt.json
    ru.json
  ui/
    index.html
    ... compiled JS/CSS/assets or static UI files
  vendor/
    penpal.min.js
  skill/
    <optional-skill-name>/
      SKILL.md
```

最小可运行目录可以只有 `en.json` 和必要 JS/CSS，但正式交付建议补齐主应用已有语言集合。

## 4. package.json 约定

主应用只强依赖 `main` 字段和本地依赖安装结果。推荐格式：

```json
{
  "name": "@aily-project/subapp-my-tool",
  "version": "0.1.0",
  "private": true,
  "description": "My tool for Aily Blockly",
  "main": "index.js",
  "bin": {
    "aily-my-tool": "index.js"
  },
  "scripts": {
    "serve": "node index.js serve",
    "cli": "node index.js",
    "status": "node index.js status"
  },
  "dependencies": {
    "penpal": "^7.0.0",
    "ws": "^8.0.0"
  }
}
```

注意：

- `main` 指向的文件必须存在。
- `ui/index.html` 必须存在。
- 不要把主应用写成 `file:` 依赖。
- 依赖安装由子应用目录自己负责。

## 5. ready/fatal stdout 协议

主应用按行读取 stdout。每一行都会尝试 `JSON.parse`，能解析且 `event` 为 `ready` 或 `fatal` 的行才参与启动状态判断。

ready 必须在启动超时前输出：

```json
{"event":"ready","data":{"mode":"serve","url":"http://127.0.0.1:54321/?token=...","origin":"http://127.0.0.1:54321","wsUrl":"ws://127.0.0.1:54321/ws?token=...","shutdownUrl":"http://127.0.0.1:54321/api/shutdown?token=...","port":54321,"pid":1234}}
```

fatal 用于启动失败：

```json
{"event":"fatal","data":{"message":"failed to open adapter"}}
```

普通日志可以输出到 stdout 或 stderr，但不要把 ready JSON 格式化成多行。

## 6. iframe URL 上下文

主应用会把当前上下文追加到 `ready.url`：

```text
lang=<normalized-lang>
theme=<light-or-dark>
```

子应用 UI 首屏必须先读取 URL：

```js
const query = new URLSearchParams(window.location.search);
const token = query.get('token') || '';
const lang = normalizeLang(query.get('lang') || navigator.language || 'en');
const theme = normalizeTheme(query.get('theme'));
```

推荐规范化函数：

```js
function normalizeLang(lang) {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

function normalizeTheme(theme) {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
}
```

## 7. Penpal 控制面

Penpal 只用于宿主控制面。它适合做 ready、错误、关闭、重启、打开外链、语言主题同步和低频消息提示。

它不适合传：

- 高频串口日志。
- 扫描结果流。
- 大量设备事件。
- 二进制数据。
- 持续 telemetry。

这些数据必须走子应用自己的 WebSocket。

## 8. WebSocket 数据面

WebSocket 建议由 child backend 提供，UI 连接同源路径：

```js
const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?token=${encodeURIComponent(token)}`);
```

建议至少支持：

```json
{"id":1,"method":"status","params":{}}
```

响应：

```json
{"id":1,"ok":true,"result":{"state":"ready","pid":1234},"error":""}
```

如果后台有事件流，使用：

```json
{"event":"log","data":{"level":"info","message":"connected"}}
```

## 9. UI 与主题

UI 应该是工具界面，不是落地页。调试类工具应紧凑、可扫描、信息密度适中。

主应用对 UI 文件名的硬性要求只有一个：

```text
ui/index.html
```

`index.html` 可以引用任意构建产物。对于 Angular、Vue、React、Vite 等项目，JS/CSS 文件名可以由构建器生成，资源也可以放在 `assets/`、`static/` 或其他由 `index.html` 正确引用的目录中。

无构建器静态 UI 推荐提供：

```text
ui/app.js
ui/styles.css
ui/light.css
ui/dark.css
```

如果采用独立主题文件，推荐在 `index.html` 中保留主题 link：

```html
<link rel="stylesheet" href="./styles.css">
<link id="theme-style" rel="stylesheet" href="./dark.css">
```

切换主题时只替换 `theme-style` 的 href：

```js
function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;
  document.getElementById('theme-style')?.setAttribute('href', `./${normalized}.css`);
}
```

如果主题已经被框架打包进同一个 CSS 或 JS bundle，则只需要在首屏和 `setHostContext()` 时更新根节点 class/data attribute 或应用状态，确保视觉结果随 `light` / `dark` 切换即可。

## 10. i18n

子应用语言包由两处使用：

- 主应用扫描 `i18n/en.json` 推导 App Store 标题和描述。
- 子应用 UI 通过 HTTP 加载 `/i18n/<lang>.json`。

`i18n/en.json` 示例：

```json
{
  "MY_TOOL": {
    "TITLE": "My Tool",
    "DESCRIPTION": "Debug my protocol.",
    "STATUS": "Status"
  }
}
```

外部子应用统一只提供 `TITLE` / `DESCRIPTION`，避免额外区分 child 场景和普通工具场景。

## 11. CLI 与 AI 调用

子应用必须把核心能力暴露给 CLI，这样 AI、脚本和自动化流程可以绕开 UI 调用工具。

统一输出：

```json
{
  "ok": true,
  "command": "status",
  "data": {
    "state": "ready"
  },
  "error": ""
}
```

失败也输出 JSON：

```json
{
  "ok": false,
  "command": "scan",
  "data": {},
  "error": "adapter not found"
}
```

## 12. 验证清单

在外部仓库至少执行：

```bash
node --check index.js
node --check core.js
node --check cli.js
node --check server.js
node index.js --help
node index.js status
node index.js serve --host 127.0.0.1 --port 0
```

serve 启动后继续检查：

- stdout ready JSON 是单行。
- `ready.url` 能打开 `ui/index.html`。
- 追加 `lang=zh_cn&theme=dark` 后首屏语言和主题正确。
- `/i18n/zh_cn.json` 可访问。
- 缺失语言能回退 `/i18n/en.json`。
- `/ws?token=...` 能连接。
- WebSocket `status` 返回 `{ ok: true }`。
- `/api/shutdown?token=...` 能关闭服务。
- 错误 token 会被拒绝。

如果没有主应用源码，也可以完成以上验证；这些验证就是子应用和宿主集成前的最低交付标准。

## 13. 集成到主应用时的预期

交付给主应用后，目录应放到：

```text
child/tools/<tool-id>/
```

主应用启动后会自动扫描。只要满足以下条件，工具会进入 child 工具注册流程：

- `child/tools/<tool-id>/package.json` 存在。
- `package.json.main` 或 `index.js` 存在。
- `child/tools/<tool-id>/ui/index.html` 存在。
- `i18n/en.json` 可解析并提供合理标题描述。

如果需要特殊图标、历史 id、默认 toolbar 展示或特殊启动超时，需要主应用在小映射表里补例外；普通子应用不需要改主应用源码。

## 14. 最终原则

child 子应用的边界是：主应用托管生命周期，子应用拥有业务能力。

因此开发时优先保证：

- 能独立运行。
- 能通过 CLI 被 AI 调用。
- 能通过 WebSocket 承载实时数据。
- 能通过 Penpal 与宿主低频协作。
- 能通过 `lang` / `theme` 在首屏就贴合主应用上下文。
- 能作为完整目录被复制到 `child/tools/<tool-id>/`。
