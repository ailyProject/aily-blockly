# Blockly 1.0.2 交互连续性修复

## 范围与根因

主软件保留 `blockly: npm:aily-project-blockly@^1.0.2`，实装版本 `1.0.2`；未升级至 13，未修改 Blockly 包、锁文件或 Coder 分支。

原来组件在变更后防抖 500 ms 调用 `runWithPreparedProjectCode()`。该入口获取独占工作区编辑锁时，会执行 `cancelCurrentGesture()`、`hideChaff()`、输入拦截及等待遮罩。后台任务恰好撞上下一次拖拽、字段编辑或注释输入，就会主动终止交互；只监听 drag start/end 无法覆盖这些情况。

## 实现

- 后台代码刷新使用单独的 `runWithBackgroundProjectCode()`，仍与保存/ABS 共用项目操作队列，但不获取编辑锁，不取消手势、不关闭编辑器。
- 在排队执行、异步资源准备及发布前后校验项目、页面、运行时与内容版本；过期结果返回重试信号，真实生成错误仍上报。
- 统一读取当前手势、WidgetDiv、DropDownDiv 和 DOM 编辑焦点。拖拽、字段编辑、下拉、注释、可编辑文本及输入法组合输入期间推迟后台生成和小地图同步。
- 防抖任务合并；一次只运行一个后台生成任务，仅有待处理变更时重试。离开编辑态后恢复刷新，不永久暂停后台。
- 显式保存、编译及 ABS/AI 修改的事务保护不变。注释仍参与生成，不能当作无关 UI 事件丢弃。

## 验证方法

```sh
./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
./node_modules/.bin/ng test --configuration=blockly-performance --watch=false --browsers=ChromeHeadless
AILY_E2E_PROJECT=/path/to/installed/project ./node_modules/.bin/playwright test e2e/tests/blockly-interaction-continuity.spec.ts --reporter=line --repeat-each=2
git diff --check
```

定向单元测试 38 项通过，覆盖交互态、异步期间继续编辑、运行时替换、过期结果重试、真实错误保留及原有显式编辑锁边界。类型检查、生产构建和差异格式检查通过。

Electron 用例使用生产构建和真实编辑器/生成器，在工程副本中加入三个小型测试块。用户原工程、活动窗口及配置不作测试写入；复制时排除工程实例锁，关闭测试进程后清理副本。

用例覆盖：

1. 从连接栈拆出积木，持续按住 1300 ms；随后切换另一块拖拽 1300 ms，再次拖回 700 ms。
2. 文本编辑停留 1200 ms、组合输入事件停留 900 ms、数字输入停留 900 ms，保持焦点。
3. 下拉打开停留 1200 ms 后选择另一选项。
4. 注释输入停留 1500 ms，保持焦点；上述连续编辑期间后台不生成。
5. 注释失焦后恢复后台生成，生成结果包含最新文本、数字、下拉值和注释。
6. 再次编辑注释，未失焦时调用真实保存入口，后读 `project.abi` 确认最后输入已保存。

最终 Electron 回归连续重复两次，结果 `2 passed (52.3s)`，两次均无正在拖拽时被取消的记录。已检查最终注释保持焦点的截图。

运行环境：macOS、Electron 35.7.5、实装 aily-project-blockly 1.0.2；截图 3024×1768（逻辑窗口 1512×884）。截图与结构化附件由 Playwright 写入 `test-results` / `playwright-report`，不纳入源码提交。

## 验收边界

- 组合输入使用确定性 composition 事件，不等同于 macOS/Windows 系统输入法候选窗实测；触屏、笔输入、第三方自定义弹层也未逐个验收。
- 本轮是交互连续性修复，不代表万级积木拖拽性能验收；生成器自身的同步长任务仍属于独立性能问题。
- 构建保留既有 mermaid/fastdom CommonJS 警告。隔离 Electron 的空工具目录触发依赖下载，退出测试时出现取消下载日志；没有据此声称硬件编译/上传通过。
- 未提交、推送、发布 npm 包或替换已安装的发行版。

## 补充：AI 落盘后的小地图同步

AI 的 ABS 导入（包括分块加载）会关闭 Blockly 事件，因此不能依赖普通块变更事件触发小地图刷新。代码查看器已有保存结果的显式发布入口，小地图此前缺少对应通知。

主软件增加工作区视觉刷新通知：ABS 导入结束（成功或失败回滚）以及活动页重新装载后，请求小地图同步。仍复用原有 500 ms 防抖和交互保护，等待编辑锁释放、拖拽或输入结束后再复制最终状态；不额外生成代码，不取消手势、不关闭输入框。通知携带工作区对象，旧工作区通知不会刷新新工作区；关闭小地图时不排队，组件销毁时取消订阅。同时修正小地图 `Events.disable/enable` 的嵌套计数配对，避免嵌套调用后事件永久关闭。

本次仍仅修改主软件，不修改 `aily-npm-blockly`，不升级 `aily-project-blockly@1.0.2`。

验证命令：

```sh
./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
./node_modules/.bin/ng test --configuration=abs-sync --ts-config=tsconfig.blockly-minimap.spec.json --include=src/app/integrations/blockly/abs/abs-minimap-refresh.spec.ts --include=src/app/integrations/blockly/abs/abs-workspace-sync.service.spec.ts --watch=false --browsers=ChromeHeadless
AILY_E2E_PROJECT=/path/to/installed/project ./node_modules/.bin/playwright test e2e/tests/blockly-ai-minimap.spec.ts --reporter=line
git diff --check
```

结果：类型检查、生产构建通过；ChromeHeadless **163 项通过**；Electron **2 项通过（31.1 s）**。定向配置用于隔离本轮测试，CLI 的两个 `--include` 必须同时提供。

- 单元测试覆盖静默导入合并、锁释放后刷新、字段变化和删除、输入期间延迟、关闭/销毁/异工作区通知、嵌套事件关闭，以及 ABS 失败回滚和派生输出发布失败时的刷新通知。
- Electron 从真实已安装库的工程复制临时样本，保留 Arduino 入口并加入延时块。分别启用/关闭小地图，通过 Agent 使用的真实宿主桥执行 `abs_projection → abs_validate → abs_apply`，后读 `project.abi` 和 `project.abs`；不是调用大模型生成整段会话。
- 连续两轮修改数字 `1101 → 2202 → 4404`，第一轮新增独立块，第二轮删除；比对主画布与小地图的类型、字段、父块和输入连接，并检查小地图真实 SVG 文本及 code viewer 状态。小地图 XML 副本使用独立 ID，不按块 ID 比较两个工作区。
- 每次导入后立即打开数字编辑器，停留 900 ms 保持焦点，编辑结束后小地图同步最新内容。已查看并检查最终截图，小地图显示 `4404` 且无已删除块残留。
- 截图位于 `test-results/blockly-ai-minimap-AI-ABS--ec3e8--code-preview-minimap-true-/ai-minimap-enabled.png` 和 `test-results/blockly-ai-minimap-AI-ABS--4e01f-code-preview-minimap-false-/ai-minimap-disabled.png`；报告内另有结构化状态附件。

边界：本轮没有新增万级积木性能、硬件编译/上传或已安装发行版验收；保留上述构建警告及隔离测试工具下载/退出取消日志。用户原工程和实际配置未改动，测试副本及隔离配置在退出后清理。

## 补充：2026-09-24 新建/打开时的 toolbox 与通知并发交互

### 复现与原因

真实 Electron 中，项目 toolbox 首次可点击后立即展开，启动阶段仍存在一条独立的 600 ms 定时任务：

`loadProject → generateAndWriteSketchIno / generateAndWritePythonEntry → generateWorkspaceCodeForPreprocess → runWithPreparedProjectCode → acquireWorkspaceEditLease → cancelCurrentGesture + hideChaff`

在工作区实例上记录原方法调用和堆栈，修复前可以观察到 flyout 先打开，随后被上述后台任务关闭。此前 `fa158a0bd` 修复了积木变更后的防抖预览路径，但没有覆盖这条项目启动源码落盘路径。

历史定位：600 ms 任务可追溯到 `96c2d2690`（2026-04-18）；源码预处理接入独占 `runWithPreparedProjectCode` 的关键提交是 `edfb88a8f`（2026-09-15 15:36:13 +0800）。这是旧的启动任务与后续独占发布机制组合产生的回归，不是 notification-box 显隐本身已被证明会抢焦点。

通知测试使用真实 `NoticeService.update`，包括首次弹出、完成状态和每 200 ms 更新进度。另在 flyout 拖拽中触发真实 `FinishedLoading`，覆盖库监听器调用 `updateToolbox` 的情况；这些路径本轮未观察到独立中断，因此没有额外包装 `updateToolbox`、修改通知样式或更改库代码。

### 修复边界

- 删除独立的 600 ms 独占生成任务，把启动源码落盘与原 1000 ms 的启动预览刷新合为一次非独占后台发布。
- 复用 `runWithBackgroundProjectCode` 的项目队列和版本校验；手势、画布拖动、输入、下拉和注释编辑期间等待，空闲后发布同一份源码及 code viewer 快照。
- Arduino 仍通过宿主发布桥写 `.temp/sketch/sketch.ino` 及生成头文件；Python 原子写 `main.py`，不写 Arduino sketch。生成器宏的发布逻辑保留。
- 用户编辑使准备结果过期、或构建发布桥返回 `BUILD_WORKSPACE_BUSY` 时，仅重试尚未完成的启动任务；真正生成错误仍记录并停止重试。
- 项目切换、工作区替换、重复调度和组件销毁都会使旧任务失效，避免异步结束后再次排队或发布旧预览。
- 显式保存/编译/ABS 的独占事务不变；没有修改 Coder、`aily-npm-blockly`、依赖版本或锁文件，仍为 `aily-project-blockly@1.0.2`。

### 回归方法

```sh
./node_modules/.bin/tsc -p tsconfig.app.json --noEmit
./node_modules/.bin/ng test --configuration=abs-sync --ts-config=tsconfig.blockly-interaction.spec.json --include=src/app/integrations/blockly/abs/abs-startup-interaction.spec.ts --include=src/app/integrations/blockly/abs/abs-prepared-code.spec.ts --include=src/app/editors/blockly-editor/utils/blockly-performance.spec.ts --include=src/app/editors/blockly-editor/services/builder.service.spec.ts --watch=false --browsers=ChromeHeadless
AILY_E2E_PROJECT=/path/to/installed/project ./node_modules/.bin/playwright test e2e/tests/blockly-startup-interaction.spec.ts e2e/tests/blockly-ai-minimap.spec.ts e2e/tests/blockly-interaction-continuity.spec.ts --reporter=line
git diff --check
```

定向单元测试覆盖合并/等待/重试/取消/真实错误，以及 Arduino/Python 启动发布边界。Electron 新增两个入口：正常打开，以及真实 `projectNewFromTemplate` 创建后激活；均从 toolbox 首次可点击开始操作，而非等待全部后台任务完成。

每个入口检查：启动后 flyout 保持展开且源码文件与预览一致；通知弹出期间继续展开；从 flyout 拖入积木并跨越库工具箱更新；持续画布平移；连接块拆开后连续拖拽；文本、数字、下拉和注释在进度通知连续更新时保持交互；注释失焦后预览恢复且包含最终内容。整段后台交互中 `cancelCurrentGesture` 调用次数必须为零。

最终结果：类型检查和生产构建通过；ChromeHeadless **48 项通过**；上述三个文件的 Electron 用例合跑 **5 项通过（2.2 min）**，包含两项启动交互、两项 AI 小地图开/关及一项原有连续交互/显式保存回归。已复核真实 toolbox、注释/通知和 AI 小地图截图。构建仍有既有 CommonJS 警告；隔离测试退出时取消工具链下载，部分测试由 fixture 超时清理其自身 Electron 进程树，未计作硬件编译验收。

验收边界：新建用例调用真实创建服务并读取新目录中的发布文件，但没有从新建向导逐项选择板卡或完成网络依赖安装；Python 发布由单元测试覆盖，本轮 Electron 样本为 Linkbit Arduino 工程。未修改用户原工程和配置，未替换已安装发行版，未提交或发布。截图与调用堆栈保留在 `test-results/blockly-startup-interactio-*`；继续适用上述系统输入法、Windows、硬件和超大工作区边界。

## 补充：编译失败通知 `BUILD_SOURCE_STALE` 与正在进行的拖拽

用户进一步提供了具体的“编译失败 / BUILD_SOURCE_STALE: Workspace changed after code capture”截图。本轮不再只测试被动进度通知，而是使用真实 `_BuilderService.handleCompileError`，包含 error 样式、详情、底部日志发布及后续源码过期校验。

修复前的 Electron 对照结果：在按住块时单独调用该错误处理入口，1300 ms 后拖拽仍在继续；随后在下一次按住块时调用正式编译的 `generateWorkspaceBuildSnapshotForPreprocess`，拖拽被终止。工作区实例堆栈记录到 `acquireWorkspaceEditLease → cancelCurrentGesture`，回归测试在“仍在拖拽”断言处明确失败。源码检查同时发现依赖变化后的 `background_preprocess` 也仍共用独占生成入口。

这次补修编译读取边界，而不是隐藏通知或移除错误校验：

- 编译/预处理读取改用带版本校验的非独占后台 reader；等待用户手势和编辑结束后才捕获源码，不获取输入遮罩、不取消手势、不关闭 flyout 或字段编辑器。
- 等待发生在项目操作队列之外，显式保存仍能提交正在编辑的字段；排队后和异步资源准备后再次检查交互、项目、页面、运行时与版本。
- 无效快照和宿主发布忙状态可重试；真正的生成错误正常报错。取消构建、项目/工作区/页面切换及编辑器销毁会终止等待；后台预处理被 AI/新请求取代时不再发布旧结果。
- 保留编译请求写入和子进程启动前的 `assertFresh`。捕获后真正修改源码仍会报 `BUILD_SOURCE_STALE`，但这条错误通知不会终止新的拖拽。没有把过期代码当作有效构建输入。
- Python `main.py` 也使用编辑结束后捕获的快照版本，避免拿等待前的版本误判新结果；文件异步写入后再次核对版本。
- 保存和 ABS 的编辑事务、子进程的磁盘来源校验、Coder 路径均未改动。本节对编译读取边界的补修取代上节“显式编译不变”的描述；启动修复本身保留。

新增 `e2e/tests/blockly-build-interaction.spec.ts`：真实错误通知中保持拖拽；编译取快照在拖拽时等待、松手后完成；捕获后修改字段，调用真正的 `assertFresh` 产生同文错误，下一次拖拽仍持续；字段编辑时后台预处理及错误通知并发，输入焦点保持，提交输入后预处理获得最新文本。全过程不允许调用 `cancelCurrentGesture`。

追加验证命令：

```sh
node --test child/scripts/build-source-capture.test.js
AILY_E2E_PROJECT=/path/to/installed/project ./node_modules/.bin/playwright test e2e/tests/blockly-build-interaction.spec.ts e2e/tests/blockly-startup-interaction.spec.ts e2e/tests/blockly-ai-minimap.spec.ts e2e/tests/blockly-interaction-continuity.spec.ts --reporter=line
```

验证结果：定向 ChromeHeadless **59 项通过**，构建来源 Node 测试 **16 项通过**（含 Blockly/Coder 两种来源和源码过期拒绝），四个 Electron 文件合跑 **6 项通过（2.7 min）**；随后调整截图到错误框出现的当刻，新增编译交互用例再次 **1 项通过（42.5 s）**。生产构建、类型检查和差异格式检查通过。最后补测安装打断准备时保留 pending、销毁后不复活任务。

验收边界：该用例覆盖真实 Electron、生成器、编译取快照/错误处理和文件发布路径，不启动硬件编译器，不代表完整 SDK 编译或上传通过；没有更改 notification-box 样式或屏蔽源码过期错误。已复核同文红色错误框与拖拽/输入并存的截图，保存在 `test-results/build-notice-visual/blockly-build-interaction--3ccd1--active-Blockly-interaction/`；旧的全套截图可能显示随后覆盖它的下载进度通知。
