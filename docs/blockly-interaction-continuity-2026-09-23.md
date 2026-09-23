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
