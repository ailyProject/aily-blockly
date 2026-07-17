# Blockly Generator 项目级运行时隔离改造方案

> 状态：核心隔离链路与动态库删除后的全量 rebuild 已实施并通过真实项目功能验证；依赖解析与动态库升级待后续完成  
> 适用仓库：`aily-blockly`  
> 更新时间：2026-07-17  
> 约束：不修改任何 Blockly 库包，不使用浏览器整页刷新

## 0. 2026-07-17 实施结论与方案收敛

文档对根因和 iframe Realm 选型的判断正确，但原方案首轮同时引入逐写入 Proxy journal、单库事务、依赖图、路径绑定代理和异步资源治理，实施面过大。结合当前应用“同一时刻只允许一个 active Blockly 项目”的约束，本轮采用更小且可完整验证的项目级生命周期边界：

1. 每个项目激活周期创建 hidden iframe，以 classic script 语义同步执行全部 `generator.js`。
2. 每次激活创建新的 Arduino/MicroPython Generator，所有生产代码生成入口读取当前 active Generator。
3. 项目激活时对宿主 Blockly 可变面做 checkpoint，销毁时整体恢复；当前覆盖 Blocks、Msg、Extensions、通用 registry、ContextMenuRegistry，以及 Field/FieldDropdown/Block/Workspace 等原型。
4. iframe timer、interval、RAF、idle callback 和 microtask 统一带 session/epoch guard，销毁时取消可取消资源。
5. workspace 先 dispose，再恢复宿主 checkpoint，最后移除 iframe，避免 block 销毁阶段调用已经失效的 child callback。
6. Angular 复用同一路由组件时，使用已 await 的 SPA `guide -> blockly-editor` 跳转触发确定性 teardown，不进行 Renderer 或浏览器刷新；编辑器对直接修改 query 参数的入口也有相同兜底。

### 0.1 相比原方案的修正

- **首轮用 session checkpoint 代替逐写入 journal。** 当前没有并发 project runtime，也不支持任意单库无损卸载，因此在项目边界恢复完整宿主状态比拦截每个内部注册 API 更简单，且能覆盖未预先枚举的同名覆盖。
- **原型必须纳入恢复面。** 对真实项目扫描发现 `lib-core-serial` 会修改 `Blockly.FieldDropdown.prototype.doClassValidation_` 并写入 `_serialValidatorInstalled`；原文仅列 Extensions/Blocks/Msg/registry，仍会发生跨项目泄漏。
- **脚本执行失败直接销毁 tainted session。** 不在已创建部分 lexical binding 的 Realm 中重试，也不继续把该库标记为加载成功。
- **保留项目内 classic script 共享。** 没有改成 Function/IIFE/严格模式，跨库裸全局 helper 仍可工作。

### 0.2 本轮已完成

- RuntimeService、fresh Generator factory、类内部 `this` 自引用修复。
- 父 document generator script loader 改为 iframe 内联 classic script loader。
- boardConfig、packageJson、i18n、Blockly facade、ProjectService facade 和受控 timer 注入。
- Builder、Uploader、保存 hash、AI edit/sync/lint 等代码生成入口迁移到 active runtime。
- 串口动态 toolbox 等父 window global 调用迁移到 `runtime.invokeGlobal()`。
- 项目切换、同路由 query 参数复用、close 路由均改为可 await 的 SPA 生命周期。
- 浏览器单测覆盖 Realm 共享/隔离、宿主状态与原型恢复、timer 取消、tainted Realm。
- Electron 生产渲染层 E2E 覆盖两个真实项目连续打开和 runtime session identity 变化。
- 库删除在依赖变更成功后同步 `.temp/package.json`，原地重建库注册层与 generator iframe runtime；编辑器、workspace 和 Router 均不重建，全程禁止 `projectOpen()`、`location.reload()` 或 Electron `webContents.reload()`。
- Electron E2E 覆盖真实项目卸载未使用库，验证 runtime session 更新、目标 generator 消失、剩余代码仍可生成，同时 Renderer、`app-blockly-editor` 与 `.blocklyBox` DOM identity 均保持不变。
- `Blockly.getMainWorkspace()` 和 runtime global 入参使用 workspace facade 跟踪库脚本注册的 change listener；旧 session 销毁前统一解绑，避免残留回调访问 inactive Realm。

### 0.3 后续增强项

- 运行时依赖源仍需从“物理安装库存”完全收敛到声明依赖图。
- 动态库升级仍需复用依赖同步 + runtime rebuild 入口；不应扩展为逐 lexical binding 卸载。
- ProjectService 的宏写入可继续收敛为显式 projectPath API，以覆盖已经进入 `await` 的极端晚到 Promise。
- checkpoint 方案若未来需要并发 project runtime 或可组合的单库卸载，再升级为 owner journal；当前不提前支付这部分复杂度。

## 目录

- [1. 背景](#1-背景)
- [2. 当前实现与根因](#2-当前实现与根因)
- [3. 两个真实项目的兼容性约束](#3-两个真实项目的兼容性约束)
- [4. 目标与非目标](#4-目标与非目标)
- [5. 核心架构](#5-核心架构)
- [6. Runtime Service 设计](#6-runtime-service-设计)
- [7. iframe Realm](#7-iframe-realm)
- [8. fresh Generator](#8-fresh-generator)
- [9. iframe 能力桥接](#9-iframe-能力桥接)
- [10. ProjectService 路径绑定代理](#10-projectservice-路径绑定代理)
- [11. Blockly facade 与宿主注册表 journal](#11-blockly-facade-与宿主注册表-journal)
- [12. Workspace listener](#12-workspace-listener)
- [13. Timer 与异步资源](#13-timer-与异步资源)
- [14. 项目运行时依赖解析](#14-项目运行时依赖解析)
- [15. 单库加载事务](#15-单库加载事务)
- [16. 项目切换时序](#16-项目切换时序)
- [17. 宿主全局函数迁移](#17-宿主全局函数迁移)
- [18. 库新增、删除和升级](#18-库新增删除和升级)
- [19. 文件级改造范围](#19-文件级改造范围)
- [20. 分阶段实施](#20-分阶段实施)
- [21. 测试方案](#21-测试方案)
- [22. 可观测性](#22-可观测性)
- [23. 风险与缓解](#23-风险与缓解)
- [24. 验收标准](#24-验收标准)
- [附录 A：当前关键代码入口](#附录-a当前关键代码入口)
- [附录 B：建议验证命令](#附录-b建议验证命令)
- [25. 最终结论](#25-最终结论)

## 1. 背景

当前应用在同一个 Electron Renderer 页面中依次打开不同 Blockly 项目时，库的 `generator.js` 会被插入主页面执行。脚本执行完成后，顶层词法绑定、`window.*`、Generator 对象属性、Blockly Extensions、workspace listener 和异步任务都会继续留在 Renderer 的全局运行环境中。

复现场景：

- 项目 A：`C:\Users\coloz\Documents\aily-project\xz32s3_xiaozhi_extend_199830`
- 项目 B：`C:\Users\coloz\Documents\aily-project\project_xzEsp32S3_586313`
- 先打开项目 A，再打开项目 B。
- 项目 A 所需库的 `generator.js` 状态没有完整释放。
- 项目 B 加载时复用或覆盖项目 A 留下的对象、数组、函数和 Blockly 注册项，最终错误地使用了项目 A 的库行为。

整页 `location.reload()` 虽然可以销毁 Renderer 的 JavaScript Realm，但正式打包后的应用刷新会破坏应用启动和资源加载流程，因此不能作为解决方案。

本方案改为：**只重建 Blockly 项目运行时，不刷新 Electron Renderer 和 Angular 页面。**

## 2. 当前实现与根因

### 2.1 当前加载链路

当前大致链路如下：

```text
ProjectService.projectOpen()
  -> BlocklyEditorComponent.loadProject()
  -> 扫描已安装库
  -> BlocklyService.loadLibrary()
  -> BlocklyService.loadLibraryInternal()
  -> 主 document.head 插入 <script src="file:///.../generator.js">
  -> generator.js 直接修改父页面全局对象
```

当前 `loadLibGenerator()` 的核心行为是：

1. 加载前读取 Arduino/MPY 中已有的 generator key。
2. 把 `generator.js` 作为 `<script>` 添加到父页面。
3. 加载后再次读取 generator key。
4. 只把新出现的 key 记入 `loadedGenerators`。

这种做法无法识别“覆盖已有同名 key”的情况。实际验证中，项目 B 的 `esp32-xzai` 最终有 53 个 generator key，其中只有 9 个会被当前算法识别为新增，另外 44 个同名覆盖不会被记录归属。

### 2.2 删除 script 标签不能撤销脚本副作用

移除 `<script>` 标签只会删除 DOM 节点，不会撤销已经发生的副作用，包括：

- 顶层 `var`、`function`、`let`、`const`、`class`。
- `window.*` 和隐式全局变量。
- `Arduino.forBlock` / `MPY.forBlock`。
- `Arduino.workspaceToCode` 等被覆盖的方法。
- Generator 上附加的 Map、Set、标记和辅助函数。
- `Blockly.Extensions`、Mutator、Mixin。
- `Blockly.Msg` 修改。
- workspace change listener。
- `setTimeout` 和其他延迟任务。
- 闭包中保存的旧项目数据。

### 2.3 当前 reset 范围和实际写入面不一致

当前 `reset()` 存在以下不足：

- 在基于归属恢复之前就清空 `loadedGenerators`。
- 主要清理 `Blockly.Arduino`、`Blockly.Python` 等属性，而库实际注册到 `window.Arduino`、`window.MPY`。
- 只按函数 key 删除，无法恢复被覆盖的旧函数。
- 不处理 Generator 的非函数直属属性。
- 不处理 Extensions、Mutator、Mixin、Msg、registry。
- 不处理项目级 `window.*`。
- 不处理 listener、timer 和已经开始的异步 Promise。

因此继续给 `reset()` 增加更多 `delete window.xxx` 只能缓解已知案例，不能建立可靠的生命周期边界。

## 3. 两个真实项目的兼容性约束

对两个项目中实际安装的 `generator.js` 进行只读扫描后，得到以下结果：

| 行为 | 项目 A | 项目 B | 设计影响 |
|---|---:|---:|---|
| `generator.js` 文件数 | 13 | 11 | 需要确定的项目级加载顺序 |
| `Arduino.forBlock` 赋值 | 197 | 264 | 必须使用项目级全新 Generator |
| Arduino 直属属性类型 | 11 | 20 | 不能只清理 `forBlock` |
| `setTimeout` | 31 | 35 | 需要 session resource ledger |
| workspace `addChangeListener` | 8 | 9 | iframe 销毁前必须释放 workspace/listener |
| Extension `register` | 17 | 20 | 必须回滚宿主 Blockly 注册表 |
| `registerMutator` | 3 | 3 | 必须回滚宿主 Blockly 注册表 |
| `registerMixin` | 1 | 1 | 必须回滚宿主 Blockly 注册表 |
| `Blockly.Msg` 写入 | 11 个 key | 1 个 key | 需要 overlay 或属性恢复 |

扫描未发现两个项目的 generator 使用以下能力：

- `require`、`module`、`exports`、`process`
- `eval`、动态 `Function`
- `globalThis`
- DOM `addEventListener/removeEventListener`
- `Blockly.registry` 或 ContextMenuRegistry 写入

虽然当前项目没有使用所有能力，宿主桥接仍应为未来库预留 registry 和 resource 记录接口。

### 3.1 项目内必须保留 classic script 全局共享

不能把每个库分别包进 `Function` 或 IIFE，因为当前库之间存在裸全局调用：

- `lib-core-variables` 顶层定义：
  - `registerVariableToBlockly`
  - `renameVariableInBlockly`
  - `isBlockConnected`
- `lib-core-serial`、`lib-dht`、`lib-esp32-xzai` 直接调用这些函数，没有通过 `window.xxx` 或模块导入。
- 项目 B 中 `lib-lvgl` 顶层定义 `ensureLvglLib`，`lib-esp32-xzai` 直接裸调用它。

此外，现有库包含非严格模式下的隐式全局赋值。loader 不能自动添加 `"use strict"`。

因此必须满足：

> 同一项目内的所有 generator 继续作为 classic script 在同一 Realm 中执行；不同项目使用不同 Realm。

### 3.2 必须隔离的典型项目状态

实际库会写入：

- `window.mcpControlParams`
- `window.aivoxControlServices`
- `window.mcpServiceParamMap`
- `window.customSerialPorts`
- `window.ENTRY_BLOCK_TYPES`
- 多个串口、变量和调试辅助函数
- `Arduino.workspaceToCode`
- `Arduino.dhtTypeMap`
- `Arduino.esp32Tasks`
- `Arduino.getTaskFuncName`
- `Arduino.getAllAivoxControlServices`
- 多个 `Arduino.lvgl*` 状态

项目 B 的 `esp32-xzai` 还存在顶层 `const EMOTION_ICON_MAP`。在同一 Realm 重复加载时会触发：

```text
SyntaxError: Identifier 'EMOTION_ICON_MAP' has already been declared
```

这些状态都不适合通过名称黑名单人工清理。

## 4. 目标与非目标

### 4.1 目标

1. 项目 A 打开后再打开项目 B，B 的运行状态与直接冷启动 B 完全一致。
2. 不调用 `location.reload()`、`window.location` 刷新或 Electron Renderer 重载。
3. 不修改任何库包的 `generator.js`、`block.json` 或 `toolbox.json`。
4. 保持现有 classic script、非严格模式和跨库裸全局函数的兼容性。
5. 每个项目激活周期使用全新的 Arduino/MPY Generator。
6. 项目退出后恢复宿主 Blockly 注册表到进入项目前的状态。
7. 旧项目的 timer、listener、Promise continuation 和异步库加载不能修改新项目。
8. 库安装、删除、升级时可以在当前页面内重建项目运行时。
9. 错误日志可以定位到具体项目、session、库、版本和 `generator.js` 路径。

### 4.2 非目标

1. 本方案不是恶意代码安全沙箱。同源 iframe 仍可能访问 `parent`/`top`。
2. 第一阶段不支持任意顺序的单库无损卸载。
3. 不把现有库一次性迁移为 ESM。
4. 不为每个库创建独立 Realm，因为这会破坏项目内全局协作。
5. 不重写整个 Blockly 工作区和注册机制。

### 4.3 方案选型

| 方案 | 结论 | 原因 |
|---|---|---|
| 浏览器/Renderer 整页 reload | 拒绝 | 正式安装包刷新会破坏应用启动和资源加载 |
| 继续扩充 `reset()` 的全局名称黑名单 | 拒绝 | 无法清除顶层 lexical binding，也无法覆盖未来库的未知写入 |
| 删除父页面 `<script>` 标签 | 拒绝 | 不会撤销已经执行的副作用 |
| 每个库一个 Function/IIFE | 拒绝 | 破坏现有跨库裸全局函数和非严格模式契约 |
| 每个库一个 iframe | 拒绝 | 项目内库无法共享变量和顶层 helper |
| Web Worker | 拒绝 | Blockly generator 需要同步访问 DOM、Block 和宿主对象 |
| Node `vm.Context` | 暂不采用 | 可以隔离词法环境，但 DOM、Angular Zone 和跨 context 宿主对象兼容成本更高 |
| 每项目一个 hidden iframe Realm | 采用 | 最接近当前浏览器 classic script 语义，并可通过移除 iframe 销毁整个 Realm |

## 5. 核心架构

```text
Electron Renderer / Angular Application
│
├─ ProjectService
│    └─ 项目切换、路径、锁和路由
│
├─ BlocklyEditorComponent
│    └─ 项目加载编排、workspace 生命周期
│
├─ BlocklyGeneratorRuntimeService
│    ├─ 当前 session / epoch
│    ├─ fresh ArduinoGenerator / MicroPythonGenerator
│    ├─ IframeGeneratorRealm
│    ├─ BlocklyBridge
│    ├─ HostRegistryJournal
│    └─ RuntimeResourceBag
│
├─ Host Blockly
│    ├─ Workspace
│    ├─ Blocks
│    ├─ Extensions / Mutators / Mixins
│    ├─ Msg / registry / field registry
│    └─ toolbox
│
└─ hidden iframe: Project Generator Realm
     ├─ 当前项目全部 classic generator.js
     ├─ 项目级 window / global lexical environment
     ├─ session i18n / boardConfig
     ├─ 受控 Blockly facade
     └─ 受控 projectService / timer / workspace 能力
```

### 5.1 关键原则

- iframe 负责隔离 JavaScript Realm、顶层词法绑定和 `window.*`。
- fresh Generator 负责隔离 Arduino/MPY 的可变对象状态。
- Blockly facade 和 journal 负责隔离仍然位于父页面的 Blockly 注册表。
- resource bag 和 epoch 负责隔离异步任务。
- workspace dispose 负责释放 block、field、validator 和 change listener 闭包。

以上几项缺一不可。

## 6. Runtime Service 设计

建议新增：

```text
src/app/editors/blockly-editor/services/blockly-generator-runtime.service.ts
```

建议公开接口：

```ts
export type GeneratorMode = 'arduino' | 'micropython';

export interface GeneratorRuntimeContext {
  projectPath: string;
  mode: GeneratorMode;
  boardConfig: unknown;
  packageJson: unknown;
  getWorkspace: () => Blockly.WorkspaceSvg | null;
  macroService: ProjectMacroService;
}

export interface GeneratorSource {
  packageName: string;
  version: string;
  filePath: string;
  source: string;
  i18n?: unknown;
}

export interface GeneratorLoadResult {
  packageName: string;
  filePath: string;
  arduinoBlockTypes: string[];
  mpyBlockTypes: string[];
  extensionNames: string[];
  globalNames: string[];
}

export class BlocklyGeneratorRuntimeService {
  preflight(projectPath: string): Promise<RuntimePreflightResult>;
  begin(context: GeneratorRuntimeContext): Promise<string>;
  loadGenerator(sessionId: string, source: GeneratorSource): Promise<GeneratorLoadResult>;
  rebuild(context: GeneratorRuntimeContext, sources: GeneratorSource[]): Promise<string>;

  getActiveGenerator(): ArduinoGenerator | MicroPythonGenerator | null;
  generateCode(workspace: Blockly.Workspace): string;

  updateBoardConfig(sessionId: string, boardConfig: unknown): void;
  updatePackageJson(sessionId: string, packageJson: unknown): void;
  invokeGlobal<T>(sessionId: string, name: string, ...args: unknown[]): T | undefined;

  deactivate(sessionId: string): void;
  destroy(sessionId: string): Promise<void>;
}
```

内部建议拆分为以下非 Angular 类：

```ts
class IframeGeneratorRealm {}
class BlocklyBridgeFactory {}
class BlocklyHostRegistryJournal {}
class RuntimeResourceBag {}
class LibraryLoadTransaction {}
```

### 6.1 Session 数据结构

```ts
interface ProjectGeneratorSession {
  id: string;
  epoch: number;
  projectPath: string;
  mode: GeneratorMode;
  state: 'creating' | 'loading' | 'active' | 'disposing' | 'disposed' | 'tainted' | 'failed';

  realm: IframeGeneratorRealm;
  arduino?: ArduinoGenerator;
  micropython?: MicroPythonGenerator;
  activeGenerator: ArduinoGenerator | MicroPythonGenerator;

  journal: BlocklyHostRegistryJournal;
  resources: RuntimeResourceBag;
  libraries: Map<string, LoadedGeneratorLibrary>;
}
```

同一路径的项目 reload 也必须创建新的 sessionId 和 iframe，不能因为 projectPath 相同而复用 Realm。

Session 不变量：

- 任意时刻最多只有一个 `active` session。
- sessionId、epoch 和 projectPath 在 session 创建后不可变。
- `loadedLibraries`、`loadedGenerators`、`libraryLoadTasks`、toolbox owner 等状态全部归属 session，不能继续作为服务进程生命周期状态。
- project ABI 只能在所有声明库、Blocks、Extensions 和 toolbox 提交完成后反序列化。
- session 进入 `disposing/tainted/failed/disposed` 后，任何 facade 都不得再写宿主状态。

## 7. iframe Realm

### 7.1 创建

```ts
const iframe = document.createElement('iframe');
iframe.hidden = true;
iframe.tabIndex = -1;
iframe.setAttribute('aria-hidden', 'true');
iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
document.body.appendChild(iframe);
await waitForIframeLoad(iframe);

const realmWindow = iframe.contentWindow!;
```

注意：

- 不设置会阻止父页面访问的 sandbox。
- iframe 是生命周期隔离边界，不是安全沙箱。
- iframe 必须由 RuntimeService 持有并在 session destroy 时移除。
- 父页面不得保存 child function、Window 或 DOM 的长期引用。

### 7.2 classic script 执行

宿主先读取 `generator.js` 源码，然后在 iframe document 中添加内联 classic script：

```ts
const script = realmWindow.document.createElement('script');
script.type = 'text/javascript';
script.dataset.generatorPath = source.filePath;
script.textContent =
  source.source +
  `\n//# sourceURL=${toFileSourceUrl(source.filePath)}`;

realmWindow.document.head.appendChild(script);
```

这样可以：

- 保留 classic script 顶层声明语义。
- 保留跨库裸全局函数。
- 避免逐库 Function/IIFE 导致的作用域变化。
- 避免 `file://` 路径编码、缓存和异步加载竞态。
- 通过 `sourceURL` 保留可读堆栈。

内联 classic script 在 append 时同步执行，不能依赖元素 `onload` 作为成功依据。append 前应临时监听 iframe `error`，记录 filename、line、column 和当前 transaction；异步 `unhandledrejection` 作为 session 级诊断单独处理。

加载时临时监听 iframe 的 `error` 和 `unhandledrejection`，将跨 Realm 错误转换为普通结构：

```ts
interface RuntimeScriptError {
  name: string;
  message: string;
  stack?: string;
  filePath: string;
  packageName: string;
  sessionId: string;
}
```

跨 Realm Error 不应依赖 `error instanceof Error`。

### 7.3 禁止的执行方式

不得使用：

```ts
new realmWindow.Function(source)();
```

不得自动包裹：

```ts
(() => {
  // generator source
})();
```

不得自动添加：

```js
"use strict";
```

这些方式都会破坏现有库的顶层函数、隐式全局和跨库调用契约。

### 7.4 预检与 tainted Realm

在销毁旧项目之前，先完成只读预检：

- 当前项目 `package.json` 可解析。
- 声明的库路径存在。
- `block.json`、`toolbox.json`、i18n 可解析。
- `generator.js` 可读取。
- 使用仓库已有 Acorn 依赖完成语法解析。
- 版本、包名和实际路径一致。

如果 generator 顶层运行时执行到一半后抛错，当前 Realm 必须标记为 `tainted`。原因是顶层 lexical binding 可能已经创建，无法可靠地逐项删除。

处理方式：

1. deactivate 当前 session。
2. 回滚宿主 journal。
3. 清理资源和 workspace。
4. 删除 iframe 和 Generator。
5. 创建新 session。
6. 按确定顺序重放此前已确认的库。

不能在 tainted Realm 中直接重试同一个 generator。

### 7.5 第一阶段不做并行热切换

可以在旧项目仍然 active 时完成文件读取、JSON 校验和 Acorn 语法预检，但第一阶段不在旧 workspace 仍运行时执行新项目 generator。

原因是现有 generator 会在顶层直接调用 `Blockly.getMainWorkspace()` 并添加 listener。如果把新项目脚本预执行到旧 workspace，会让新项目状态读取或修改旧项目 block；如果为此构造完整 staging workspace，则会显著扩大改造范围。

因此第一阶段采用：

```text
旧项目 active
  -> 只读 preflight 新项目
  -> 显式销毁旧 runtime/workspace
  -> 创建新 runtime/workspace
  -> 执行新项目 generator
```

新项目执行失败时进入干净错误状态并销毁 tainted session，不通过整页刷新恢复。后续如确实需要“新项目失败后旧项目继续可用”，可以再增加独立 staging workspace，但它不是本问题的必要条件。

## 8. fresh Generator

### 8.1 工厂化

Arduino 和 MicroPython Generator 改为每 session 创建：

```ts
export function createArduinoGenerator(): ArduinoGenerator {
  return new ArduinoGenerator();
}

export function createMicroPythonGenerator(): MicroPythonGenerator {
  return new MicroPythonGenerator();
}
```

模块单例可以在迁移期保留为 deprecated 导出，但生产代码不得继续使用。

### 8.2 修复类内部的单例自引用

当前两个 Generator 的 `getValue()` 等方法仍直接引用模块单例：

```ts
arduinoGenerator.statementToCode(...)
arduinoGenerator.valueToCode(...)
arduinoGenerator.nameDB_.getName(...)
```

必须改为：

```ts
this.statementToCode(...)
this.valueToCode(...)
this.nameDB_.getName(...)
```

MicroPython 同理。否则即使外部创建了新实例，部分代码路径仍会绕回旧单例。

### 8.3 统一代码生成入口

以下调用方停止直接 import `arduinoGenerator`：

- BlocklyComponent
- Blockly BuilderService
- Blockly UploaderService
- Blockly Editor ProjectService
- Arduino lint service
- AI editBlockTool
- 其他直接调用 `workspaceToCode()` 的代码

统一改为：

```ts
const code = generatorRuntime.generateCode(workspace);
```

或在确实需要 Generator API 时：

```ts
const generator = generatorRuntime.getActiveGenerator();
```

父页面不再设置真实的：

```ts
window.Arduino
window.MPY
window.MicropPython
```

这些对象只注入当前项目 iframe。

## 9. iframe 能力桥接

建议注入：

| 能力 | 注入值 | 说明 |
|---|---|---|
| `Blockly` | session-bound facade | 普通类/函数转发，可变注册面受控 |
| `Arduino` | 当前 session 新实例 | Arduino 模式 |
| `MPY` / `MicropPython` | 当前 session 新实例 | MicroPython 模式 |
| `boardConfig` | 当前项目深拷贝 | board 切换时显式更新；禁止直接引用宿主可变对象 |
| `packageJson` | 当前项目深拷贝 | 如未来 generator 需要 |
| `__BLOCKLY_LIB_I18N__` | session 独立对象 | 不再写父 window |
| `pinyinPro` | 只读宿主能力 | 项目 A 使用 |
| `projectService` | 路径绑定窄代理 | 只暴露实际需要的宏 API |
| `global` | 指向 iframe window | 兼容浏览器/Node fallback 写法 |
| timer APIs | session resource wrapper | 追踪、取消、epoch guard |
| `console` | 可选 session-tagging facade | 日志自动携带 session/package 信息 |

不得注入：

- `require`
- `process`
- `module`
- 原始、可变的完整 ProjectService
- 父页面真实 window 作为 child window 替代品

iframe 自己的 `window`、`self`、`globalThis`、`document` 必须保持为 child Realm 对象。

`boardConfig` 建议使用 `structuredClone()` 或现有安全 JSON clone。串口库可能写入派生字段，不能让这些修改反向污染根 ProjectService 保存的 board 配置。`updateBoardConfig()` 也只能更新当前 active session 的 clone。

当前 `lib-core-text` 只使用一次 `document.createElement('mutation')`。child document 生成的节点需要加入 Blockly XML 序列化烟测。

## 10. ProjectService 路径绑定代理

LVGL 等库可能在延迟回调中调用 `projectService.addMacro/removeMacro`。如果直接暴露根 ProjectService，旧回调可能在项目路径切换后修改新项目。

建议增加显式路径 API：

```ts
addMacroForProject(projectPath: string, macro: string): Promise<void>;
removeMacroForProject(projectPath: string, macroName: string): Promise<void>;
```

iframe 获得的代理：

```ts
const macroFacade = {
  addMacro: (macro: string) => {
    assertSessionActive(session.id);
    return projectService.addMacroForProject(session.projectPath, macro);
  },
  removeMacro: (name: string) => {
    assertSessionActive(session.id);
    return projectService.removeMacroForProject(session.projectPath, name);
  },
};
```

每次 await 前后都验证 sessionId/epoch。

## 11. Blockly facade 与宿主注册表 journal

### 11.1 为什么 iframe 仍然不够

`Arduino` 可以是项目独立实例，但 Blockly Workspace、BlockSvg 和注册表仍在父页面。generator callback 必须操作真实父页面 block，因此不能用 structured clone 或 `postMessage`。

如果直接把完整宿主 Blockly 裸注入 iframe，以下状态仍然会跨项目泄漏：

- Extensions、Mutator、Mixin
- Blocks
- Msg
- registry、field registry
- context menu
- workspace listener

因此需要 facade 和 journal。

### 11.2 Journal 数据结构

```ts
interface RuntimeOwner {
  sessionId: string;
  projectPath: string;
  packageName: string;
  version: string;
  libraryPath: string;
}

interface JournalEntry {
  sequence: number;
  owner: RuntimeOwner;
  surface: string;
  key: PropertyKey;
  before: PropertyDescriptor | RegistryValue | Absent;
  after: PropertyDescriptor | RegistryValue | Absent;
  undo(): void;
}
```

必须保存修改前值，而不是只保存新增 key：

```ts
if (entry.before === ABSENT) {
  Reflect.deleteProperty(target, entry.key);
} else {
  Object.defineProperty(target, entry.key, entry.before);
}
```

回滚前验证当前值仍等于 `after`。如果不一致，说明存在新的 owner 或越界写入，禁止盲目覆盖，直接触发整个 runtime rebuild。

### 11.3 Blockly facade

```ts
const sessionBlockly = new Proxy(Blockly, {
  get(target, key) {
    assertSessionReadable(session);

    if (key === 'Blocks') return blocksProxy;
    if (key === 'Msg') return msgProxy;
    if (key === 'Extensions') return extensionsFacade;
    if (key === 'registry') return registryFacade;
    if (key === 'fieldRegistry') return fieldRegistryFacade;
    if (key === 'ContextMenuRegistry') return contextMenuFacade;
    if (key === 'getMainWorkspace') return getSessionWorkspace;
    if (key === 'defineBlocksWithJsonArray') return defineBlocksWithJournal;

    return Reflect.get(target, key);
  },
});
```

普通构造器继续转发真实宿主对象。例如 `Blockly.BlockSvg` 必须保持父页面真实构造器，保证：

```js
block instanceof Blockly.BlockSvg
```

仍然成立。

### 11.4 各注册面处理

| 注册面 | 处理方式 |
|---|---|
| `Arduino/MPY.forBlock` | fresh Generator 为主；每库事务记录新增/覆盖用于诊断 |
| Generator 直属属性 | fresh Generator 整体丢弃，不逐项 delete |
| `Blockly.Blocks` | 保存每个 type 修改前 descriptor，退出时恢复 |
| `Extensions.register` | 保存旧 extension，记录新 callback |
| `registerMutator/registerMixin` | 与 Extension 同一个 journal |
| `Extensions.unregister` | unregister 前保存旧 callback |
| `Blockly.Msg` | Proxy 记录写入前 descriptor |
| 通用 registry | 记录 type + name + 旧 item |
| field registry | 按 Blockly registry FIELD 类型记录 |
| ContextMenuRegistry | register/unregister 前读取旧 item；拒绝项目调用全局 reset |
| toolbox | 按 session/library owner 标记，事务提交后统一更新 |

Blockly 11.2.2 的 Extensions 没有公开 getter，只能通过：

```ts
Blockly.Extensions.TEST_ONLY.allExtensions
```

读取被替换前的 callback。这个内部依赖必须封装在单独的 `BlocklyRegistryAdapter` 中，并增加版本锁定测试，避免 Blockly 升级后静默失效。

## 12. Workspace listener

库既会通过：

```js
Blockly.getMainWorkspace().addChangeListener(...)
```

添加 listener，也会通过：

```js
block.workspace.addChangeListener(...)
```

绕过 Blockly facade。

建议在 session 绑定 workspace 时，对当前 workspace 实例的 `addChangeListener/removeChangeListener` 做一次可恢复包装：

1. 保存原方法。
2. 将 child callback 包成带 session active 检查的 wrapper。
3. 记录原 callback、wrapper 和 workspace。
4. destroy 时逐一 remove。
5. workspace dispose 后恢复原方法。

项目切换时仍必须实际调用 `workspace.dispose()`，因为 field validator、tooltip、mutator、block onchange 等闭包也可能来自旧 iframe。

workspace 必须在 Extensions、Blocks 和 iframe 销毁前 dispose，否则旧 block 的销毁流程可能访问已经被移除的注册项和 child callback。

## 13. Timer 与异步资源

RuntimeResourceBag 至少跟踪：

- `setTimeout/clearTimeout`
- `setInterval/clearInterval`
- `requestAnimationFrame/cancelAnimationFrame`
- `requestIdleCallback/cancelIdleCallback`
- `queueMicrotask`
- Observer、Worker 和未来新增的 event listener
- workspace change listener
- generator 脚本加载 Promise

建议让 child timer 使用父页面受控 wrapper，而不是 child 原生 timer：

```ts
function sessionSetTimeout(callback: Function, delay: number, ...args: unknown[]) {
  const id = hostSetTimeout(() => {
    resources.timeouts.delete(id);
    if (!isSessionActive(session.id, session.epoch)) return;
    callback(...args);
  }, delay);

  resources.timeouts.add(id);
  return id;
}
```

这样既能统一取消，也能控制 Angular Zone 的执行边界。

Promise continuation 和已经进入 microtask queue 的任务无法真正取消，因此所有能写宿主状态的 facade 都必须检查 session active/epoch。

## 14. 项目运行时依赖解析

当前“已安装库扫描”会在读取项目声明依赖后，继续扫描整个：

```text
node_modules/@aily-project/lib-*
```

这适合库管理器展示，但不适合作为运行时加载源。node_modules 中可能存在未声明或安装残留的库。

建议拆分：

```ts
scanInstalledLibrariesForManager(projectPath)
resolveDeclaredRuntimeLibraries(projectPath, packageJson, usedLibraryManifest)
```

运行时只加载：

1. 当前项目 package.json 明确声明的 Blockly 库。
2. 当前 ABI/used-library manifest 识别并完成依赖恢复后写回声明的库。
3. 开发板明确声明且由宿主解析出的必需库。

不得因为库物理存在于 node_modules 就自动执行它的 `generator.js`。

加载顺序必须确定：

1. 核心库优先。
2. 使用可用的依赖声明建立拓扑顺序。
3. 没有依赖信息时使用稳定的包名排序。
4. 全部 generator 加载完毕后，才加载 ABI 并放行 `FINISHED_LOADING`。

同一 session 内按规范化真实路径、包名和版本去重，禁止同一 `generator.js` 被重复执行。

## 15. 单库加载事务

每个库使用一个 `LibraryLoadTransaction`：

```text
begin transaction
  -> 写入 session i18n
  -> 执行 generator classic script
  -> 通过 facade 写宿主注册表并同步记录 journal
  -> 收集 Generator/Extensions/Msg/global 变化
  -> 暂存 block 定义
  -> 暂存 toolbox/metadata
  -> 校验 sessionId/epoch
  -> commit block/toolbox/metadata，并把 journal 标记为已提交
  -> 最后写 loadedLibraries/loadedLibraryInfos
end transaction
```

第一阶段不要求实现完整的影子 Blockly 注册表。事务期间 Extensions/Msg 等写入可以立即对当前新 workspace 可见，但每次写入必须先记录 `before`，失败时严格逆序恢复。这样既保留现有 generator 的即时 `isRegistered()` 语义，也避免 staging registry 带来的额外兼容成本。

任何步骤失败：

1. 立即把 transaction 标记 inactive。
2. 取消该 transaction 的资源。
3. 按 journal 逆序恢复宿主状态。
4. 不写 loaded 集合。
5. 如果 generator 已经开始执行，Realm 标记 tainted 并重建。

`Blockly.Events.FINISHED_LOADING` 和 toolbox update 应在整个项目库图加载完成后统一触发一次，而不是每个库各自触发。

## 16. 项目切换时序

推荐顺序：

```text
1. 对新项目做只读 preflight
2. 全局 project activation epoch++
3. runtime.deactivate(oldSession)
4. 停止 package watcher / local sync / debounce / 新库加载
5. 取消旧构建、上传和代码生成任务
6. 保存必要的项目和 workspace 状态
7. dispose 旧 workspace
8. 解绑 listener，清除 timer/resource
9. 按逆序回滚旧 session 的宿主 Blockly journal
10. 丢弃旧 Generator 实例
11. 移除旧 iframe 和所有 child 引用
12. 清理 BlocklyService 的 toolbox、maps、loaded bookkeeping
13. 更新 ProjectService.currentProjectPath
14. 创建新 workspace / session / Generator / iframe
15. 注入新项目 context
16. 加载新项目声明的库
17. 加载 project.abi
18. session 标记 active，项目标记 loaded
```

关键约束：

- 第 3 步必须早于修改 `currentProjectPath`。
- workspace dispose 必须早于注册表回滚和 iframe 删除。
- 每个 await 后必须重新检查 epoch/sessionId。
- `ngOnDestroy` 只作为幂等兜底，不能是唯一清理边界。

### 16.1 路由处理

当前项目切换使用：

```text
await close()
固定等待 100ms
再 navigate 到新项目
```

但 `close()` 内部没有 await 路由完成，100ms 只是竞态补偿。

应改为：

- SPA 路由跳转必须 `await router.navigate(...)`。
- 删除固定 100ms 延时。
- runtime teardown 由显式 API 完成，不依赖 Angular 是否复用组件。
- 即使保留“guide -> editor”的 SPA 导航，也不触发浏览器刷新。

## 17. 宿主全局函数迁移

当前宿主从父 window 调用库导出的函数，包括：

- `ensureSerialToolboxListener`
- `loadExistingSerialBlockToToolbox`
- `updateSerialCustomPorts`
- 其他变量、串口或工具函数

iframe 化后，这些函数位于当前项目 Realm，应改为：

```ts
runtime.invokeGlobal(
  activeSessionId,
  'ensureSerialToolboxListener',
  workspace,
);
```

或者提供固定宿主转发函数，但不要把 child 的真实函数复制到父 window。

`invokeGlobal()` 必须：

1. 验证 session active。
2. 只允许调用白名单或当前库已登记的 global export。
3. 捕获并标准化跨 Realm 错误。
4. 在 session 失效后返回 no-op/undefined，而不是执行旧函数。
5. 使用 iframe window 作为函数调用的 `this`。
6. 只返回调用结果，不把 child function 本身交给宿主长期保存。

## 18. 库新增、删除和升级

第一阶段不再尝试逐 key 卸载一个 generator。

原因：任意库都可能：

- 覆盖另一个库的同名 generator。
- 覆盖 `workspaceToCode`。
- 修改 window 全局和顶层词法绑定。
- 注册 timer、listener、Extensions。
- 被后加载库依赖其顶层函数。

推荐流程：

1. 保存当前 BlocklyProjectDocument 和视图状态。
2. 更新 package.json/依赖。
3. 重新解析当前运行时库图。
4. 销毁当前项目 session。
5. 创建新的 session/iframe/Generator。
6. 按新依赖图重放所有 generator。
7. 恢复文档和视图。

整个过程只重建 Blockly 项目运行时，不刷新 Angular/Electron 页面。

## 19. 文件级改造范围

| 文件/模块 | 改造内容 |
|---|---|
| 新增 `blockly-generator-runtime.service.ts` | session、epoch、iframe、fresh Generator、global 调用、销毁 |
| 可选新增 `blockly-runtime-registry.adapter.ts` | Blockly 11 注册表读取、写入和恢复适配 |
| 可选新增 `blockly-runtime-resource-bag.ts` | timer、RAF、listener、observer 追踪 |
| `blockly.service.ts` | generator 改由 runtime 加载；i18n 写 session；移除父 script loader；block/toolbox 事务化 |
| `blockly-editor.component.ts` | 显式 begin/deactivate/destroy；board config 同步；宿主 global 调用迁移 |
| `blockly.component.ts` | 使用 active Generator；不再设置父 `window.Arduino/MPY`；workspace listener 生命周期 |
| `arduino.ts` | factory；内部单例引用改 `this` |
| `micropython.ts` | factory；内部单例引用改 `this` |
| Blockly `builder.service.ts` | 从 runtime 生成代码 |
| Blockly `uploader.service.ts` | 从 runtime 生成代码 |
| Blockly editor `project.service.ts` | 从 runtime 生成代码 |
| AI lint/editBlock 工具 | 停止 import Generator 单例 |
| 根 `project.service.ts` | 显式 runtime teardown；await SPA 路由；删除 100ms 竞态 |
| `blockly-library-package.service.ts` | 拆分 manager inventory 和 runtime dependency resolver |
| 测试目录 | Runtime、journal、真实项目切换、打包环境测试 |

## 20. 分阶段实施

### 阶段 0：建立基线

- 为当前 A、B 两项目记录冷启动 generator/Extensions/toolbox/代码生成快照。
- 增加 A→B、B→A、B→B 自动化用例。
- 增加 runtime 诊断日志格式。
- 不修改现有行为。

### 阶段 1：fresh Generator

- 新增 Generator factory。
- 修复类内部单例引用。
- 迁移所有生产调用方到统一 runtime 入口。
- 暂时仍可使用旧 script loader，以单元测试确认代码生成一致。

### 阶段 2：项目级 iframe Realm

- 创建 RuntimeService 和 iframe。
- 在 iframe 内按 classic script 执行 generator。
- 注入 boardConfig、i18n、Generator、pinyinPro。
- 把串口等父 window 调用迁移为 `invokeGlobal()`。

### 阶段 3：Blockly facade 与 journal

- 接管 Extensions、Mutator、Mixin、Msg、Blocks。
- 接管 workspace listener 和 timer。
- 完成回滚冲突检测。
- 删除旧 `loadedGenerators = newKeys diff` 所有权逻辑。

### 阶段 4：项目切换与依赖解析

- 引入 project activation epoch。
- 删除 100ms 路由等待。
- 运行时只加载当前项目声明的库。
- 库增删升级改为 runtime rebuild。

### 阶段 5：删除旧路径

- 删除父 document generator `<script>` loader。
- 删除基于 script DOM 的 remove 逻辑。
- 删除父 window Generator/i18n/global export。
- 完成开发模式和正式安装包回归。

### 20.1 迁移期回退策略

开发迁移期可以用本地 feature flag 在“旧 loader”和“新 runtime”之间切换，以便对比生成代码和定位兼容问题，但该 flag 只用于开发验证：

- 不把整页 reload 作为任何错误回退。
- 新 runtime 出错时进入可诊断的干净失败状态。
- 正式启用前必须完成真实 A/B 项目和安装包验收。
- 验收完成后删除旧 loader 和生产环境 feature flag，避免长期维护两套生命周期。

## 21. 测试方案

### 21.1 单元测试

1. 每次 `begin()` 返回新的 sessionId、iframe 和 Generator identity。
2. `deactivate()` 后 facade 写操作全部拒绝/no-op。
3. classic script 顶层 function 可被后加载库裸调用。
4. 同一 Realm 重复顶层 const 会失败；新 Realm 加载成功。
5. Generator 直属属性只存在于当前 session 实例。
6. Extension register/unregister/override 能恢复原 callback。
7. `Blockly.Msg` 覆盖能恢复原 descriptor。
8. Blocks 同名覆盖能恢复旧定义。
9. timer/session listener destroy 后资源计数归零。
10. projectService facade 永远使用绑定路径。
11. 跨 Realm Error 可以稳定序列化。
12. journal 遇到 after-value 冲突时拒绝盲目恢复。

### 21.2 集成测试

1. 冷启动 A。
2. 冷启动 B。
3. A→B。
4. B→A。
5. B→B reload。
6. A→B→A 循环 50 次。
7. 快速连续点击打开 A/B，旧加载完成不得污染新 session。
8. 在 generator 加载中间主动抛错，重试后无残留。
9. 动态安装、删除、升级一个库后 rebuild 并恢复 ABI。
10. Arduino→MicroPython→Arduino 不交叉。
11. 包含 custom field、mutator、listener 的 workspace dispose 不报错。

### 21.3 A/B 专项断言

项目 B 冷启动与 A→B 后必须一致：

- Generator key 集合。
- 每个 generator function 的 owner/session。
- `Arduino.workspaceToCode` identity/owner。
- Arduino 直属属性集合。
- Extensions/Mutators/Mixins 集合和 callback owner。
- `mcpControlParams`、`aivoxControlServices`、`mcpServiceParamMap` 内容。
- Blocks、Msg、toolbox。
- 同一 ABI 的最终生成代码。

还需确认：

- A 独有的 DHT、FastLED、Servo 状态不会出现在 B。
- B 的 LVGL 状态不会残留到 A。
- 父页面 window 不包含库级 MCP、串口和变量全局。

### 21.4 正式安装包测试

至少验证：

- Angular 开发服务器环境。
- `npm run build` 产物。
- 正式安装包 `file://.../renderer/index.html` 环境。
- 应用全过程不调用浏览器刷新。
- iframe classic script、sourceURL、DOM mutation、timer wrapper 正常。
- 关闭项目、切换项目、切换开发板、动态依赖变更均正常。

## 22. 可观测性

建议日志统一包含：

```text
[GeneratorRuntime]
sessionId
epoch
projectPath
packageName
version
generatorPath
phase
durationMs
```

开发模式提供只读诊断快照：

```ts
interface RuntimeDiagnostics {
  sessionId: string;
  state: string;
  iframeCount: number;
  loadedLibraries: string[];
  arduinoGeneratorCount: number;
  mpyGeneratorCount: number;
  extensionCount: number;
  workspaceListenerCount: number;
  timeoutCount: number;
  journalEntryCount: number;
}
```

不得把完整项目源码、隐私路径内容或生成代码上传到远程日志。

## 23. 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| 同源 iframe 不是安全沙箱 | 明确只用于状态隔离；静态检查 `parent/top/prototype` 越界写入 |
| 同源 localStorage/IndexedDB 仍然共享 | 当前库未使用；加入静态扫描和开发态告警，禁止把它们当项目 session 状态 |
| Extensions 依赖 TEST_ONLY 内部 API | 封装适配器；锁定 Blockly 版本；升级时运行契约测试 |
| child callback 被父 registry 引用导致 iframe 无法 GC | workspace dispose、journal 逆序回滚、resource 清理后再删除 iframe |
| child document 与父 document 不同 | 对 mutation、DOMParser、canvas/file input 做兼容回归 |
| 跨 Realm Error/Array identity 差异 | Error 标准化；使用 `Array.isArray`，避免跨 Realm `instanceof Array` |
| iframe timer 不受父 Angular Zone 管理 | 给 child 注入父页面 session timer wrapper |
| generator 中途错误留下 lexical binding | Realm 标记 tainted，整 session 重建 |
| 快速项目切换产生晚到 Promise | 所有异步 continuation 检查 sessionId/epoch |
| 运行时误加载 node_modules 残留库 | 运行时只使用当前项目声明依赖和明确恢复结果 |
| 任意单库卸载的覆盖栈过于复杂 | 第一阶段统一 rebuild 当前项目 runtime |

## 24. 验收标准

以下条件全部满足后，方案才算完成：

- [ ] 不存在任何 `location.reload()` 或 Renderer reload 依赖。
- [ ] 当前项目始终只有一个 active generator iframe。
- [ ] 每个项目激活周期都有新的 Generator identity。
- [ ] 父 window 不再保存库级 generator 全局状态。
- [ ] 父 document 不再包含项目级 generator script。
- [ ] B 冷启动与 A→B 后的运行时快照完全一致。
- [ ] A→B→A 循环 50 次，iframe、listener、timer、Extensions 数量不增长。
- [ ] 同名 generator 覆盖能够正确归属，不再只记录新增 key。
- [ ] 旧 session 的延迟回调不能写入新项目。
- [ ] generator 执行失败后重试不会出现重复顶层 const。
- [ ] 动态库变更通过 runtime rebuild 正常恢复 workspace。
- [ ] 开发环境和正式安装包均通过回归。
- [ ] 整个改造不要求修改任何库包。

## 附录 A：当前关键代码入口

以下位置是实施时的首要修改点，行号可能随代码变化，优先按函数名定位：

| 相对路径 | 当前关键函数/行为 |
|---|---|
| `src/app/editors/blockly-editor/services/blockly.service.ts` | `loadLibraryInternal()`、`loadLibGenerator()`、`removeLibGenerator()`、`reset()`、串口动态 toolbox 调用 |
| `src/app/editors/blockly-editor/blockly-editor.component.ts` | `loadProject()`、`ngOnDestroy()`、boardConfig 更新、`window.updateSerialCustomPorts` |
| `src/app/editors/blockly-editor/components/blockly/blockly.component.ts` | `initDevMode()` 设置父 `window.Arduino/MPY`、workspace 生命周期 |
| `src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts` | `ArduinoGenerator`、`getValue()`、模块单例导出 |
| `src/app/editors/blockly-editor/components/blockly/generators/micropython/micropython.ts` | `MicroPythonGenerator`、`getValue()`、模块单例导出 |
| `src/app/services/project.service.ts` | `projectOpenInternal()`、`close()`、固定 100ms 等待、路由切换 |
| `src/app/services/blockly-library-package.service.ts` | `scanInstalledLibraries()`、声明依赖和物理库存扫描 |
| `src/app/services/npm.service.ts` | `getAllInstalledLibraries()` 当前同时服务运行时和库管理器 |
| `src/app/editors/blockly-editor/services/builder.service.ts` | 多处直接调用模块单例 `workspaceToCode()` |
| `src/app/editors/blockly-editor/services/uploader.service.ts` | 直接调用模块单例生成代码 |
| `src/app/editors/blockly-editor/services/project.service.ts` | 保存/读取代码时直接调用模块单例 |
| `src/app/tools/aily-chat/tools/editBlockTool.ts` | AI 工具直接 import Generator 单例 |
| `src/app/tools/aily-chat/services/arduino-lint.service.ts` | lint 代码生成入口需要迁移到 runtime |

## 附录 B：建议验证命令

文档实施完成后至少运行：

```powershell
npm run build
npm run test:e2e
git diff --check
```

其中 E2E 必须包含真实 A/B 项目切换场景；仅 TypeScript/Angular 构建通过不能证明 Realm、注册表和异步资源已经正确释放。

## 25. 最终结论

本问题的根因不是某一个库忘记清理变量，而是宿主把多个项目的 classic `generator.js` 放进了同一个、不可销毁的 Renderer 全局 Realm，同时复用了 Generator 单例和宿主 Blockly 注册表。

可靠的无刷新方案必须同时建立三个隔离边界：

1. **项目级 iframe Realm**：隔离顶层声明、隐式全局和 `window.*`。
2. **项目级 fresh Generator**：隔离 `forBlock`、`workspaceToCode` 和所有直属可变属性。
3. **宿主 Blockly facade + journal**：隔离并恢复 Extensions、Blocks、Msg、registry、listener 和 toolbox。

再配合 session epoch、资源账本、显式 teardown 和声明依赖解析，即可在不刷新 Electron Renderer、不修改库的前提下，稳定解决跨项目 generator 污染问题。
