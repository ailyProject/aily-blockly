**架构概览**
这个仓库本质上是一个 Electron 桌面 IDE，分成 5 层：

- Electron 主进程负责窗口、IPC、npm/mcp/串口等系统能力，入口在 [electron/main.js](/Users/xiewendao/Documents/aily/aily-blockly/electron/main.js:1) 和 [electron/preload.js](/Users/xiewendao/Documents/aily/aily-blockly/electron/preload.js:12)。`preload` 把 `fs/path/terminal/builder/uploader` 等能力挂到渲染层。
- Angular 主壳负责把编辑器、AI 聊天、日志、终端等工具拼成一个工作台，主容器在 [main-window.component.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/main-window/main-window.component.ts:36)。
- Blockly 编辑器层负责项目文档、工作区、库加载、代码生成，核心在 [blockly.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/services/blockly.service.ts:84)、[project.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/services/project.service.ts:10)、[arduino.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts:74)。
- AI Agent 层集中在 `src/app/tools/aily-chat`，入口是 [aily-chat.component.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/aily-chat.component.ts:40)，会初始化宿主适配器、注册工具、启动会话。
- 构建执行层不直接塞在前端里，而是走 `child/scripts` 子进程脚本，预处理在 [preprocess.js](/Users/xiewendao/Documents/aily/aily-blockly/child/scripts/preprocess.js:34)，正式编译在 [compile.js](/Users/xiewendao/Documents/aily/aily-blockly/child/scripts/compile.js:33)。

**1. AI 如何生成硬件代码**
它现在的主路径不是“AI 直接输出 `.ino`”，而是“AI 操作 Blockly/ABS，再由生成器产出 Arduino/C++”。

- 会话启动时，聊天组件先注册工具，再通过宿主适配器暴露项目/文件/命令/Blockly 能力，见 [aily-chat.component.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/aily-chat.component.ts:218)。
- 启动会话时会把工具列表和 MCP 工具一起发给后端 LLM，会话生命周期在 [session-lifecycle.helper.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/helpers/session-lifecycle.helper.ts:258)，实际 HTTP 起会话在 [chat.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/services/chat.service.ts:240)。
- AI 的“工作规程”是显式写在提示词里的：先查项目和库、逐个读 `readme_ai.md`、安装库要先征求确认、优先编辑 ABS，再导回 Blockly，见 [stream-constants.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/services/stream-constants.ts:58)。
- AI 获取当前项目、开发板、已安装库、`readme_ai.md` 路径、工作区概览和生成出的 C++，靠 [getContextTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/getContextTool.ts:66) 和 [getProjectInfoTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/getProjectInfoTool.ts:34)。
- 真正改代码有两条路，但当前“主路”明显偏 ABS：
     - `sync_abs_file` 先把 ABI/工作区导出为 `project.abs`，再把改完的 ABS 导回 Blockly，见 [syncAbsFileTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/syncAbsFileTool.ts:84)。
     - 也保留了原子 Blockly 工具链，如 `create_single_block/connect_blocks_simple`，见 [atomicBlockTools.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/atomicBlockTools.ts:1)。
- 没有文档的库，AI 会退回做静态分析：`analyze_library_blocks` 调 [BlockAnalyzer.analyzeLibraryBlocks](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/blockAnalyzer.ts:126)，去读库里的 `block.json/generator.js/toolbox.json`，见 [registered/blockly-tools.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/registered/blockly-tools.ts:220)。
- 最终硬件代码由 Blockly 生成器统一产出。生成器先收集 `macros/libraries/variables/functions/setup/loop`，再拼出最终 Arduino 代码，见 [arduino.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts:126)、[arduino.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts:266)、[arduino.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts:827)。它还维护了 block 到代码行的映射，便于 AI/查看器定位代码。

**2. AI 如何编译验证**
编译验证链路也分层得很清楚：

- AI 调的是 `build_project` 工具，它只是包装层，负责触发预编译/正式编译，并把 stderr 摘成短错误，再缓存给 `get_errors` 用，见 [buildProjectTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/buildProjectTool.ts:77)。
- 上层 [src/app/services/builder.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/builder.service.ts:17) 不是实际编译器，它通过 `ActionService` 发 `compile-begin/preprocess-trigger/compile-cancel` 事件，把请求转给编辑器内的真正 builder。
- 真正的编译状态机在 [src/app/editors/blockly-editor/services/builder.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/services/builder.service.ts:133)。它会：
     - 监听依赖变化，做后台预编译；
     - 在 AI 正在操作、依赖安装中、上传中时延迟预编译；
     - 生成 `build-config.json`，调用 `preprocess.js`；
     - 正式编译前检查 `preprocess.json` 缓存，必要时同步预编译；
     - 跑正式编译并把日志、进度、错误同步回 UI。
- 预处理脚本 [preprocess.js](/Users/xiewendao/Documents/aily/aily-blockly/child/scripts/preprocess.js:60) 会把当前工作区代码写到 `.temp/sketch/sketch.ino`，把项目依赖中的 `@aily-project/lib-*` 复制到 `.temp/libraries`，解析开发板 `boardDependencies`，定位编译器/SDK/工具链，并展开 `projectConfig/macros/partition` 等参数。
- 正式编译脚本 [compile.js](/Users/xiewendao/Documents/aily/aily-blockly/child/scripts/compile.js:62) 读取 `board.json.compilerParam`，提取 `boardType`，再调用 `ailyBuilderPath/index.js compile ... --preprocess-result preprocess.json`。
- 一个容易误判的点：`CompileValidationService` 不是“编译器验证”，而是“编译成功后向服务端回传一次邀请用户验证状态”，见 [compile-validation.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/compile-validation.service.ts:22)。这个命名会误导维护者。

**3. AI 如何阅读库文档，如何安装库**
这块拆成“发现库”“读文档”“安装库”三段：

- 发现库：AI 用 [searchBoardsLibrariesTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/searchBoardsLibrariesTool.ts:98) 搜开发板和库，支持结构化过滤。
- 读文档：AI 先用 [getProjectInfoTool.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/getProjectInfoTool.ts:128) 拿到每个库的 `readme_ai.md` 路径，再用 [registered/file-tools.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/registered/file-tools.ts:52) 的 `read_file` 去读取；这个工具对 `@aily-project/lib-*` 路径有专门识别。
- 没文档时，退回 [blockAnalyzer.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/blockAnalyzer.ts:126) 直接分析库代码和块定义。
- 安装项目库时，AI 当前主要还是走 `execute_command` + `npm install`。这个执行包装在 [registered/project-tools.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/registered/project-tools.ts:67)，对 `npm uninstall` 做了“如果工作区还在用该库则禁止卸载”的保护，但 `npm install` 后自动 reload 库的逻辑目前被注释掉了。
- 安装开发板、SDK、编译器、工具链则不是 AI 自己拼命令，而是走 [npm.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/npm.service.ts:330)、[npm.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/npm.service.ts:358)、[npm.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/npm.service.ts:618)。这些安装发生在 `appDataPath/node_modules`，不是项目目录。
- Electron 主进程还对 `npm install` 做了流式日志、Busy-Rename 重试和 `--foreground-scripts` 注入，见 [electron/npm.js](/Users/xiewendao/Documents/aily/aily-blockly/electron/npm.js:55)、[electron/npm.js](/Users/xiewendao/Documents/aily/aily-blockly/electron/npm.js:181)、[electron/npm.js](/Users/xiewendao/Documents/aily/aily-blockly/electron/npm.js:256)。
- 本地源码库还有一条特殊链路：项目 `package.json` 里如果有 `ailyLocalLibrarySources`，会用 [local-library-sync.service.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/services/local-library-sync.service.ts:5) 把本机源码库镜像到项目 `local-libraries`，并轮询同步。

**可优化空间**
我认为最值得优先改的有 6 个：

- `TOOLS` 旧数组和 `ToolRegistry` 新注册体系并存，维护成本高，证据是 [aily-chat.component.ts](/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/aily-chat.component.ts:40) 还在导 `register-all`，而 `registered/*` 又在反查 `LEGACY_TOOLS`。这应该统一成一套 schema + 一套 runtime。
- 编译链路名字混乱：外层 `BuilderService`、编辑器内 `_BuilderService`、`CompileValidationService` 含义都不直观。建议拆成 `BuildFacade/BuildRuntime/PostCompileReporting`。
- AI“安装库前先确认”现在主要靠提示词约束，不是硬约束。最好增加一个专用 `install_library` 工具，把“搜索 -> 候选 -> 用户确认 -> 安装 -> reload -> 文档摘要”做成确定流程。
- `editBlockTool.ts` 和相关工具文件过大，已经接近“单文件子系统”；后续改动和测试都会很痛。建议按 `context/abs/block-ops/library-analysis/workspace-overview` 拆分。
- 现在同时存在“ABS 编辑流”和“原子 block 操作流”，语义层有重复。建议明确一个主 IR。按现状看，ABS 更适合作为 AI 主编辑接口，原子块工具更适合作为补丁型操作。
- 预编译缓存现在主要依赖 `.temp/preprocess.json` 是否存在和事件触发失效，建议改成内容哈希缓存，至少覆盖 `code + package.json + board config + local library fingerprint`。

如果你愿意，我下一步可以继续把这些内容整理成一张“模块-文件-调用链”表，或者直接给你画一张 Mermaid 架构图。
