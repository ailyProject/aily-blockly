# Aily Blockly 工具开发规范

本文档用于后续新增工具时统一架构、集成方式、通信协议、打包和验证流程。这里的“工具”指通过 App Store、顶部/右侧工具栏或独立窗口打开的功能模块，例如串口监视器、网络调试器、BLE 调试器等。

## 1. 工具类型选择

新增工具前先判断工具属于哪一类。

### 1.1 Angular 内置工具

适用于：

- 纯前端或主要依赖主应用已有 Electron bridge 的工具。
- 不需要独立 Node 依赖、独立服务进程或原生模块。
- UI 与主应用生命周期强绑定。

推荐目录：

```text
src/app/tools/<tool-id>/
  <tool-id>.component.ts
  <tool-id>.component.html
  <tool-id>.component.scss
  i18n/
    en.json
    zh_cn.json
    ...
```

### 1.2 child 独立子应用工具

适用于：

- 需要独立 Node 后台、原生依赖、长时间运行进程或硬件能力。
- 需要提供 AI 可调用 CLI。
- UI 希望从主 Angular 包中解耦。
- 需要像小应用一样独立迭代、打包、调试。

推荐目录：

```text
child/tools/<tool-id>/
  package.json
  package-lock.json
  index.js        # 入口：serve / cli / rpc
  core.js         # 核心能力，不含 UI/协议细节
  cli.js          # AI/脚本可调用 CLI
  server.js       # 本地 HTTP + WebSocket 服务
  i18n/
    en.json
    zh_cn.json
    ...
  ui/
    index.html
    styles.css
    light.css
    dark.css
    app.js
```

主应用不再为每个 child 工具创建专用 Angular 目录。统一使用：

```text
src/app/tools/child-tool-host/
src/app/services/child-tool-process.service.ts
```

`child-tool-host` 只负责启动 child 服务、加载 iframe、建立 Penpal 宿主连接、关闭进程；具体工具能力必须留在 `child/tools/<tool-id>`。

## 2. 工具注册面

新增工具必须同时检查这些入口，避免“注册了但打不开”。

### 2.1 App 注册

文件：

```text
src/app/configs/tool.config.ts
```

Angular 内置工具需要更新：

- `APP_LIST`
- `AVAILABLE_APP_IDS`
- 如需默认显示，再更新 `DEFAULT_TOOLBAR_APP_IDS`

主应用启动时通过 `window.path.getAilyChildPath()` 扫描 `child/tools/*`，符合以下条件的目录会自动注册：

- 目录名使用 kebab-case，默认也是工具 id。
- 目录内存在 `package.json`。
- 后端入口存在：优先使用 `package.json` 的 `main` 字段，缺省为 `index.js`。
- UI 入口存在：`ui/index.html`。
- 语言元数据存在：优先读取 `i18n/en.json` 中第一个命名空间对象。

child 工具注册信息由目录内容推导：

```text
id          = <tool-id>
childDir    = tools/<tool-id>
routePath   = /child-tool/<tool-id>
namespace   = i18n/en.json 的顶层命名空间，缺省为 <tool-id> 转大写下划线
titleKey    = <namespace>.CHILD_TITLE 或 <namespace>.TITLE
description = <namespace>.CHILD_DESCRIPTION 或 <namespace>.DESCRIPTION
entry       = package.json.main 或 index.js
uiIndex     = ui/index.html
```

Angular 内置工具仍然在 src\app\configs\tool.config.ts的`APP_LIST` 中登记，例如：

```ts
{
  id: 'serial-monitor',
  name: 'MENU.TOOL_SERIAL',
  description: 'APP_STORE.SERIAL_DESC',
  action: 'tool-open',
  data: { type: 'tool', data: 'serial-monitor' },
  icon: 'fa-light fa-monitor-waveform',
  enabled: true
}
```

### 2.2 路由

文件：

```text
src/app/app.routes.ts
```

Angular 内置工具需要添加独立窗口路由：

```ts
{
  path: '<tool-id>',
  loadComponent: () => import('./tools/<tool-id>/<tool-id>.component').then(m => m.ToolComponent)
}
```

child 独立子应用工具统一使用一次性路由：

```ts
{
  path: 'child-tool/:toolId',
  loadComponent: () => import('./tools/child-tool-host/child-tool-host.component').then(m => m.ChildToolHostComponent)
}
```

历史路径可以按需保留 redirect：

```ts
{
  path: '<tool-id>',
  redirectTo: 'child-tool/<tool-id>',
  pathMatch: 'full'
}
```

### 2.3 主窗口右侧工具面板

文件：

```text
src/app/main-window/main-window.component.ts
src/app/main-window/main-window.component.html
```

Angular 内置工具需要：

- 在 TS 中 import 新工具组件。
- 在右侧工具 `@switch` 中添加 `@case ("<tool-id>")`。

示例：

```html
@case ("serial-monitor") {
  <app-serial-monitor></app-serial-monitor>
}
```

child 独立子应用工具不新增 `@case`。主窗口统一判断 `isChildTool(tool)` 后加载：

```html
@if (isChildTool(tool)) {
  <app-child-tool-host [toolId]="tool"></app-child-tool-host>
} @else {
  @switch (tool) {
    <!-- Angular 内置工具 case -->
  }
}
```

## 3. child 工具运行模式

child 工具推荐统一提供三种模式。

### 3.1 serve 模式

用于用户打开工具 UI。

```bash
node index.js serve --host 127.0.0.1 --port 0
```

要求：

- 只监听 `127.0.0.1`。
- 默认 `--port 0`，由系统分配随机端口。
- 每次启动生成随机 token。
- stdout 必须输出一行 JSON ready 事件。

ready 输出格式：

```json
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
```

Angular Host 在 iframe 加载前会把当前软件上下文追加到 `ready.url`：

```text
?token=...&lang=zh_cn&theme=dark
```

`lang` 使用当前软件语言，默认 `en`；`theme` 只使用 `light` 或 `dark`，默认 `dark`。

fatal 输出格式：

```json
{
  "event": "fatal",
  "data": {
    "message": "..."
  }
}
```

### 3.2 CLI 模式

用于 AI、脚本、自动化调用。

要求：

- 所有 CLI 命令向 stdout 输出一个 JSON 对象。
- 成功退出码为 `0`，失败退出码为非 `0`。
- 不输出交互式提示，不依赖 UI。

统一输出格式：

```json
{
  "ok": true,
  "command": "scan",
  "data": {},
  "error": ""
}
```

推荐命令：

```bash
node index.js --help
node index.js status
node index.js scan --duration-ms 5000
node index.js read ...
node index.js write ...
```

### 3.3 rpc 模式

用于兼容旧主应用进程控制或调试，不是新 UI 的首选通信方式。

```bash
node index.js rpc
```

输入输出采用 JSON-lines：

```json
{"id":1,"action":"status"}
{"id":1,"ok":true,"data":{"state":"unknown"},"error":""}
```

## 4. 通信规范

推荐使用“两层通信”。

```text
Angular Host <-> child UI iframe
  使用 Penpal，负责宿主控制面

child UI <-> child backend/core
  使用 WebSocket JSON-RPC，负责工具实时数据面
```

### 4.1 Penpal 控制面

Penpal 只负责 iframe 生命周期和宿主能力，不承载高频业务数据。

父页面向 child UI 暴露：

```ts
{
  getHostContext(): {
    lang: string;
    theme: 'light' | 'dark' | string;
    platform: string;
  };
  childReady(payload: {
    wsConnected?: boolean;
    backendStatus?: string;
    adapterState?: string;
    pid?: number;
  }): void;
  childError(error: { message: string }): void;
  reportHostMessage(payload: {
    state?: 'success' | 'info' | 'warning' | 'error' | 'loading' | 'done' | 'doing' | 'warn';
    title?: string;
    message?: string;
    text?: string;
    detail?: string;
    showMessage?: boolean;
    sendToLog?: boolean;
    duration?: number;
  }): { ok: boolean; error?: string };
  requestClose(): void;
  requestRestart(): void;
  openExternal(url: string): void;
}
```

`childError()` 表示 child UI 已进入不可恢复错误，父页面会切换 host 状态；普通提示、警告、可恢复错误应调用 `reportHostMessage()`。`reportHostMessage()` 只用于低频宿主通知，默认同时弹出 `message` 并写入主应用 log；大量日志流、扫描结果、硬件事件仍必须走 WebSocket 数据面。

child UI 向父页面暴露：

```ts
{
  setHostContext(context: {
    lang?: string;
    theme?: string;
    platform?: string;
  }): { ok: true };
  focusTool(): { ok: true };
  beforeClose(): Promise<{
    canClose: boolean;
    scanning?: boolean;
    connected?: boolean;
  }>;
}
```

父页面不要只依赖 iframe `load` 判断工具 ready。正确流程是：

```text
iframe load
  -> 建立 Penpal connection
  -> child UI 连接 WebSocket 并完成 status
  -> child UI 调用 host.childReady(...)
  -> 父页面隐藏 loading
```

### 4.2 WebSocket 数据面

WebSocket 用于工具 UI 与 child 后台的实时通信。

连接地址：

```text
ws://127.0.0.1:<port>/ws?token=<token>
```

请求格式：

```json
{
  "id": 1,
  "method": "scan.start",
  "params": {}
}
```

响应格式：

```json
{
  "id": 1,
  "ok": true,
  "result": {},
  "error": ""
}
```

事件格式：

```json
{
  "event": "device",
  "data": {}
}
```

高频事件、硬件通知、日志流、扫描结果必须走 WebSocket，不要经由 Angular 父页面转发。

## 5. 安全要求

child 工具必须遵守以下规则：

- 本地服务只监听 `127.0.0.1`。
- 端口默认随机分配。
- 每次启动生成随机 token。
- `/ws` 和敏感 API 必须校验 token。
- child UI 不直接访问 Electron preload、Node API 或文件系统。
- 打开外部链接必须通过 Penpal 调用父页面 `openExternal()`。
- 静态文件路径必须做目录逃逸校验。
- 不允许默认开启宽松 CORS。若必须开启，只允许本机 origin。

## 6. Electron Host 规范

child 工具在 Angular 中统一使用 `ChildToolHostComponent` 和 `ChildToolProcessService`，不要为每个 child 工具新增 `src/app/tools/<tool-id>`。

职责：

- 调用 service 启动 child 服务。
- 读取 ready JSON，拿到 `url`。
- iframe 加载 `url`。
- 通过 Penpal 建立宿主控制面。
- 工具关闭或组件销毁时停止 child 进程。

不应该做：

- 不在 Angular host 中实现工具核心业务。
- 不在 Angular host 中转发高频数据。
- 不在 Angular host 中直接操作硬件。

`ChildToolProcessService` 启动 child 服务时应检查：

- `child/tools/<tool-id>/package.json` 是否存在。
- `package.json.main` 指向的后端入口是否存在，缺省检查 `child/tools/<tool-id>/index.js`。
- `child/tools/<tool-id>/ui/index.html` 是否存在。

宿主不维护 `requiredDependencies` 清单，也不在启动前逐项检查 `node_modules`。缺失运行时依赖由 child 后端进程自身报错，并通过 stdout/stderr、`fatal` 事件或启动失败信息反馈给宿主。

## 7. core / cli / server 分层

child 工具后台推荐这样分层：

```text
core.js
  纯核心能力
  不知道 CLI、HTTP、WebSocket、Angular

cli.js
  参数解析
  调用 core
  输出统一 JSON

server.js
  HTTP 静态服务
  WebSocket JSON-RPC
  token 校验
  事件广播

index.js
  根据命令选择 serve / cli / rpc
  进程信号处理
```

核心能力必须优先放在 `core.js`，避免 UI、CLI、HTTP 各自复制业务逻辑。

## 8. UI 规范

child UI 应作为普通浏览器页面运行。

要求：

- 不依赖 Electron preload。
- 不直接 require Node 模块。
- 首次加载时从 URL 参数读取 `lang`、`theme`。
- 使用 Penpal 获取语言、主题、平台信息，并响应后续上下文变化。
- 语言文件从 `/i18n/<lang>.json` 加载，找不到时回退到 `/i18n/en.json`。
- 主题样式从 `ui/light.css` 或 `ui/dark.css` 加载，找不到或未传值时使用 `dark.css`。
- 使用 WebSocket 调用后台。
- loading 状态由真实 readiness 控制，不只看 HTML load。
- 长文本、UUID、日志等必须支持换行和滚动。
- 控件布局应紧凑、可扫描，调试类工具避免营销式页面。

如果需要构建器，可以在 child 工具内独立引入 Vite/React/Vue 等；但必须保证打包产物进入 `child/tools/<tool-id>/ui` 或 `dist/ui`，且 Electron `extraResources` 能复制。

## 9. i18n 规范

Angular host 需要使用主应用工具 i18n：

```ts
ngOnInit(): void {
  void this.initTool();
}

private async initTool(): Promise<void> {
  await this.toolI18n.load('<tool-id>');
}
```

模板使用：

```html
{{ 'TOOL_NAMESPACE.TITLE' | translate }}
```

child 工具的语言源文件统一放在 child 项目内：

```text
child/tools/<tool-id>/i18n/
  en.json
  zh_cn.json
  zh_hk.json
  ...
```

每个 child 工具的语言包至少提供：

```json
{
  "TOOL_NAMESPACE": {
    "TITLE": "...",
    "DESCRIPTION": "..."
  }
}
```

child 语言包不进入 Angular assets。宿主通过 `window.path.getAilyChildPath()` 在运行时读取 `child/tools/<tool-id>/i18n/<lang>.json`，并由 `ToolI18nService` 合并到 `TranslateService`。

新增 Angular 内置工具命名空间时，需要在 `src/app/services/tool-i18n.service.ts` 的 `TOOL_I18N_NAMESPACES` 中登记，例如：

```ts
'<tool-id>': ['TOOL_NAMESPACE']
```

child 独立工具不需要在 `TOOL_I18N_NAMESPACES` 中登记。工具 id 默认来自 `child/tools/<tool-id>` 目录名，namespace、标题 key 和描述 key 来自运行时读取的 `child/tools/<tool-id>/i18n/en.json`。

child server 应从同一目录提供语言包：

```text
/i18n/<lang>.json
/tools/<tool-id>/i18n/<lang>.json
```

child UI 通过 Penpal 接收宿主传入的 `lang`，再加载 `/i18n/<lang>.json`，找不到时回退到 `en.json`。

child UI 首次加载也必须读取 URL 中的 `lang`，因为 iframe URL 会在 Penpal 连接建立前先到达页面。

不要把 child UI 的所有文本重新塞回主应用 Angular 模板里，否则会破坏子应用边界。

## 10. 主题规范

child 工具 UI 目录必须提供：

```text
child/tools/<tool-id>/ui/
  styles.css
  light.css
  dark.css
```

`styles.css` 放布局、尺寸、状态样式等通用规则；`light.css` 和 `dark.css` 放颜色变量或主题覆盖。child UI 首次加载从 URL 参数读取 `theme`：

```text
?theme=light
?theme=dark
```

只接受 `light` 和 `dark`，其它值按 `dark` 处理。Penpal 收到新的 host context 时，也应重新加载对应主题 CSS。

## 11. 打包与依赖

child 工具通过根 `package.json` 被整体复制到 Electron resources。通常只维护一条 `child/tools` 资源规则，新增子应用目录后无需逐个追加打包项。

示例：

```json
{
  "from": "child/tools",
  "to": "child/tools",
  "filter": [
    "**/*",
    "!node_modules/aily-blockly/**",
    "!node_modules/.aily-blockly-*/**"
  ]
}
```

不要在根 `package.json` 为每个 child 工具添加 `install:<tool-id>` 脚本，也不要恢复统一的 `install:tools` 包装脚本。child 工具依赖由各自目录内的 `package.json` / `package-lock.json` 表达，构建或发布流程按需要在对应子目录安装。

原生依赖注意事项：

- 原生模块不要放进 asar。
- 不要随意执行 `npm audit fix --force`，尤其是含原生硬件依赖的工具。
- lockfile 不能把主项目作为本地 `file:` 依赖误加入 child 依赖。

## 12. 验证清单

每个 child 工具至少执行：

```bash
node --check child/tools/<tool-id>/index.js
node --check child/tools/<tool-id>/core.js
node --check child/tools/<tool-id>/cli.js
node --check child/tools/<tool-id>/server.js
```

CLI 验证：

```bash
node child/tools/<tool-id>/index.js --help
node child/tools/<tool-id>/index.js status
```

serve 验证：

```bash
node child/tools/<tool-id>/index.js serve --port 0
```

需要验证：

- ready JSON 正常输出。
- `ready.url` 追加 `lang`、`theme` 后能返回 UI HTML。
- `/i18n/<lang>.json` 能加载，缺失语言能回退到 `en.json`。
- `ui/light.css` 和 `ui/dark.css` 能按 `theme` 切换加载。
- Penpal vendor 或 UI bundle 能加载。
- WebSocket 能连接并执行 `status`。

主应用验证：

```bash
npx tsc -p tsconfig.app.json --noEmit
npx ng build --configuration development --base-href ./
```

如果未进行浏览器截图或交互验证，交付说明不要声称完成了视觉验证。

## 13. 新工具开发检查表

新增工具时按下面顺序执行：

- 明确工具类型：Angular 内置工具或 child 独立子应用。
- 确定 tool id、菜单名、图标、可见条件。
- 如果是 Angular 内置工具，更新 `tool.config.ts`、`app.routes.ts`、`main-window.component.ts/html`。
- 添加工具 i18n。
- 如果是 child 工具，创建 `child/tools/<tool-id>` 项目，确保包含 `package.json`、后端入口、`ui/index.html` 和 `i18n/en.json`。
- 如果 child 工具有历史 id、特殊图标或特殊启动超时，在 `tool.config.ts` 的小映射中补充例外。
- 实现 `core.js`。
- 实现 CLI，保证 AI 可调用。
- 实现 `serve`、HTTP 静态服务、WebSocket JSON-RPC。
- 实现 child UI。
- 实现 `lang`、`theme` URL 参数读取和 `light.css` / `dark.css` 加载。
- Angular host 只负责 iframe/Penpal/进程生命周期。
- 确认根 `package.json` 已整体复制 `child/tools`，不要新增 per-tool 安装脚本。
- 跑完整验证清单。

## 14. 推荐架构示意

```text
User opens tool
  |
  v
Angular ChildToolHost
  |
  | starts
  v
node child/tools/<tool-id>/index.js serve --host 127.0.0.1 --port 0
  |
  | stdout ready JSON
  v
Angular Host iframe loads ready.url
  |
  | Penpal control channel
  v
child UI
  |
  | WebSocket JSON-RPC
  v
child server.js
  |
  v
core.js
```

结论：后续硬件调试类、协议调试类、AI 可自动调用的复杂工具，优先采用 child 独立子应用架构；普通轻量 UI 工具继续使用 Angular 内置工具架构。
