# Refactor Goal Todo List

## Purpose

This file is the durable module-by-module checklist for the ongoing migration.

Use it to avoid:

- re-auditing the same module repeatedly
- deleting RPC/API surfaces that were intentionally migrated but are not yet consumed
- forgetting partially migrated domains before the final review and legacy walkthrough

Status markers:

- `done`: migration mostly complete and already integrated into the current app flow
- `partial`: migrated enough to run, but still has known legacy gaps
- `audit`: keep during migration, but verify again before final cleanup/removal
- `todo`: not yet sufficiently migrated / aligned

## Package Status

### `packages/core`

- `done` `agent`
  - AI SDK runtime, session store, tool registry, Hono API skeleton, resumable stream helpers
  - `api/rstream` 已改成目录式结构 `api/rstream/{index,state,stream}.ts`
  - `AgentRuntime` 已拆成 `AgentRuntimeDefaults.ts` / `AgentRuntimeRun.ts`，`AgentRuntime.ts` 现主要保留类壳与会话控制入口
  - runtime 会话控制已拆成 `sessionControlsMutate.ts` / `sessionControlsSummary.ts` / `sessionControlsShared.ts`，`sessionControls.ts` 现为 barrel
  - `runCore` 已改成目录式结构 `runtime/runCore/{index,messages,session,start,types}.ts`
  - session 摘要规则已拆成 `turnsSummaryClear.ts` / `turnsSummaryAnchor.ts` / `turnsSummaryApply.ts`，`turnsSummary.ts` 现为 barrel
  - 当前已开始回收后端点号命名文件，agent runtime/session 这一组已率先切到无点号命名
  - todo 工具实现链已继续回收到目录式结构 `agent/tools/todo/{normalize/{index,assign,format,parse,status,summary},operations/{index,modify,report,update}}.ts`
  - turn response 提取链已继续回收到 `agent/session/turns/extract.ts`
- `done` `build`
  - project build planning, live/fallback build support, diagnostics and lint parsing
  - Arduino lint 已继续回收到目录式结构 `build/arduinoLint/{index,human,json,vscode,types}.ts`
  - compile error 解析已继续回收到目录式结构 `build/compileErrors/{index,clean,diagnostics,extract,staleness,types}.ts`
  - unified diagnostics 已继续回收到目录式结构 `build/diagnostics/{index,convert,format,types}.ts`
  - lint 已继续回收到目录式结构 `build/lint/{index,format,parsers,rules,run,types}.ts`
  - project build 主链已继续回收到目录式结构 `build/projectBuild/{index,filesystem,helpers,prepare,shared,types,resolve/{index,board,command},run/{index,command,execute,persist,prepare,results}}.ts`
- `done` `hardware.search`
  - board/library index, categories, legacy validation, structured search
  - 查询规则已改成目录式结构 `hardware/query/{common,legacy,structured/{index,boards,libraries,search}}.ts`
  - 搜索、开发板、库、分类相关类型已继续统一回收到单个 `hardware/types.ts`
  - legacy 模糊校验规则已继续回收到目录式结构 `hardware/fuzzy/validate/{index,board,library,shared}.ts`
  - 硬件索引解析与缓存构造已改成目录式结构 `hardware/indexData/{parse,build}.ts`，`indexData.ts` 现主要保留具体格式解析入口
- `partial` `hardware.upload`
  - serial / debugger / BLE planning and execution paths exist
  - serial/debugger terminal live path exists
  - BLE terminal live path exists
  - preferred BLE device ID is now persisted locally
  - already-authorized BLE devices can now be reloaded into `code-editor` / `terminal`
  - terminal now also merges chooser-discovered BLE devices into its unified upload target list
  - terminal BLE path now emits unified upload summary text, not only raw phase logs
  - BLE device list updates now auto-prefer the last device and fall back to the first available device
  - BLE 实现主链已继续回收到目录式结构 `hardware/upload/ble/{index,firmware,packets,plan,preparation,protocol}.ts`
  - 上传命令解析子域已继续回收到目录式结构 `hardware/upload/command/{index,parse,preprocess,resolve}.ts`
  - runtime 执行编排已继续回收到目录式结构 `hardware/upload/runtime/{index,execute,preflight,run,prepare/{index,build,ready,shared},results/{index,complete,preflight,shared}}.ts`
  - 上传相关类型已继续统一回收到单个 `hardware/upload/types.ts`
  - richer BLE device-list workflow and fuller recovery UX still pending
- `done` `hardware.probe`
  - probe-rs list/download/runtime normalization
  - probe runtime 已改成目录式结构 `probe/runtime/{index,shared,list,download}.ts`
- `done` `hardware.esptool`
  - detect / install / temp-dir resolution
  - esptool 逻辑链已改成目录式结构 `esptool/logic/{index,shared,detect,command,install}.ts`
- `done` `hardware.firmware`
  - 固件与模型远端访问子域已改成目录式结构 `firmware/remote/{shared,firmware,model}.ts`，`firmware/remote/index.ts` 现为 barrel
- `done` `project.lifecycle`
  - lock files, `.temp` fallback, lifecycle summary, open-session lock
  - lock 主链已继续回收到目录式结构 `project/lock/{index,openSession,paths,status,acquire/{index,shared,scoped,persistent}}.ts`
- `done` `project.regions`
  - 区域配置子域已改成目录式结构 `project/regions/{index,base,list,urls}.ts`
- `done` `project.config-mutations`
  - 配置 mutation 规则已拆成 `config/mutations.language.ts` / `config/mutations.ai.ts` / `config/mutations.version.ts` / `config/mutations.toolbar.ts` / `config/mutations.serial.ts`，`config/mutations.ts` 现为 barrel
- `done` `project.store-layout`
  - 布局规则已改成目录式结构 `project/store/layout/{index,shared,config,normalize,visibility,zones}.ts`
- `done` `project.source-resolution`
  - 项目源码读取子域已改成目录式结构 `readSource/{package,candidates}.ts`，`readSource.ts` 现保留类型、读取与最终解析出口
- `done` `project.abi-summary`
  - ABI 摘要组装辅助已继续回收到 `readAbi/helpers.ts`，`readAbi.ts` 现主要保留读取分支与顶层结果装配
- `partial` `project.open-flow`
  - `open-file`, initial `argv`, `second-instance`, `Project Open` page
  - release template now carries `.abi` file association metadata
  - root build scripts for `mac / win / linux` now execute through the trimmed release path
  - full packager-level registration workflow still pending
- `partial` `project.recent`
  - current recent/stored recent flows are migrated
  - dead/duplicate project RPC already trimmed once; re-audit again before final report
- `partial` `project.library-management`
  - status, install, remove, progress parsing exist
  - registry/version listing now exists via on-demand version queries
  - remote registry search now prefers Verdaccio-style `vc-package-versions.json` and falls back to npm search
  - polling-based live action status now exists
  - registry version/search requests now reuse short-lived in-memory caches
  - registry 子域已改成目录式结构 `libraryManage/registry/{index,shared,versionList,search/{index,api,version}}.ts`
  - library 管理类型已继续统一回收到单个 `project/types.ts`
  - 实现主链已继续回收到目录式结构 `project/libraryManage/{index,command,install,progress,remove,shared,status,versions}.ts`
  - true subscription-based streaming still pending
- `done` `project.sync-cloud`
  - archive packaging + sync + local `cloudId` writeback
- `done` `project.library-status`
  - Blockly 库就绪状态链已继续回收到目录式结构 `project/libraryStatus/{index,ready}.ts`
- `done` `project.package-archive`
  - 项目归档打包链已继续回收到目录式结构 `project/packageArchive/{index,command,shared}.ts`
  - 云项目归档导入链已改成目录式结构 `project/archive/{download,extract,import,package,types}.ts`，`archive.ts` 保留稳定入口
  - 资源源规则已继续回收到目录式结构 `project/resourceSources/{index,candidates,normalize,select}.ts`
  - project 级 build/config/create/document/lifecycle/lock/packageArchive/syncCloud 相关类型已继续统一回收到单个 `project/types.ts`
- `done` `document`
  - Blockly document and workspace normalization
  - 页面生命周期操作已重命名并拆成 `pageLifecycleActive.ts` / `pageLifecycleDocument.ts` / `pageLifecycleNormalize.ts`，`pageLifecycle.ts` 现为 barrel
  - 页面集合操作已继续拆成 `pageLifecycleDocumentFlow.ts` / `pageLifecycleDocumentMutate.ts`，`pageLifecycleDocument.ts` 现为 barrel
  - workspace 子域命名已回收为 `workspaceBase.ts` / `workspacePayload.ts` / `workspaceSharedModel.ts`，`workspace.ts` 现为 barrel
- `done` `abi`
  - `project.abi` normalization and summaries
- `done` `metadata`
  - block type 收集、used-library manifest 规范化与生成
  - Blockly 缺失库恢复规则已继续回收到目录式结构 `metadata/libraryRecovery/{index,missing,shared}.ts`
  - used-library manifest 规则已继续回收到目录式结构 `metadata/manifest/{index,build,normalize,shared}.ts`
- `done` `abs`
  - parsing helpers and portable state helpers
  - ABS 类型模型保持为单个 `types.ts`
- `done` `connection`
  - graph/aws/pinmap/catalog/workspace helpers + RPC
  - graph/pin/catalog/workspace 相关类型已继续统一回收到单个 `connection/types.ts`
  - pinmap 主链已继续回收到目录式结构 `connection/pinmap/{index,id,extract,summary,library,save,template,catalog/{index,document,variant},read/{index,board,catalog,id}}.ts`
  - 远端规整规则已改成目录式结构 `remote/normalize/{index,package,download,config,item}.ts`
  - catalog 读取子域已继续回收到目录式结构 `connection/catalog/{index,libraries,pinmaps,scan}.ts`
  - remote pinmap 同步子域已继续回收到目录式结构 `connection/remote/{index,fetch,shared,normalize/*,sync/{index,library,shared}}.ts`
- `done` `ffs`
  - image preview, inspect, mutate, export, runtime mounting skeleton
  - FFS 路径规则已继续回收到目录式结构 `ffs/paths/{index,normalize,upload}.ts`
  - 分区解析规则已继续回收到目录式结构 `ffs/partition/{index,detect,filename,parse,shared}.ts`
  - 镜像检查与变更链已继续回收到目录式结构 `ffs/imageWorkflow/{index,inspect,shared,mutate/{index,main,shared}}.ts`
  - runtime 文件系统操作已继续回收到目录式结构 `runtime/filesystem/{index,mutate,read,shared,types}.ts`
  - runtime 串口桥接探测已继续回收到目录式结构 `runtime/bridge/{index,catalog,parse,lookup,baud}.ts`
  - Node serial 适配器已继续回收到目录式结构 `runtime/nodeSerialPort/{index,open,close,signals,shared,types}.ts`
  - ESP session 已继续回收到目录式结构 `runtime/session/{index,connect,shared,types}.ts`
  - SPIFFS 客户端已继续回收到目录式结构 `runtime/clients/spiffs/{index,init,files,image,shared}.ts`
  - FATFS 客户端已继续回收到目录式结构 `runtime/clients/fatfs/{index,entries,files,image,init,memory,shared}.ts`
  - LittleFS 客户端已继续回收到目录式结构 `runtime/clients/littlefs/{index,directory,image,shared}.ts`
  - 当前 `ffs/runtime` 中仅剩 `wasm/littlefs/littlefs.d.ts` 这一类 Wasm 声明文件仍保留点号命名，不属于本轮后端业务文件整治范围
- `done` `model`
  - list/detail remote access and normalization
  - model 类型当前保持收敛在单个 `model/types.ts`
- `done` `tool`
  - child tool discovery/acquire/release/restart
  - child tool 发现链已继续回收到目录式结构 `tool/discovery/{index,list,runtime,shared}.ts`
  - child tool 进程管理链已改成目录式结构 `tool/process/{index,acquire,release,shared,start}.ts`
- `done` `cloud`
  - public/template/mine list, publish/update/template/delete, sync helpers
  - cloud 输入 DTO 与远端响应 DTO 保持为单个 `types.ts`
  - cloud 请求层已拆成 `request.shared.ts` / `request.list.ts` / `request.mutation.ts`，`request.ts` 现为 barrel
- `done` `serial`
  - connect/disconnect/send/drain/signal/session status
  - serial 类型模型保持为单个 `types.ts`
  - serial manager 实现已继续回收到目录式结构 `serial/manager/{index,connect,messages,send,signal,shared}.ts`
- `audit` `rpc`
  - router groups now mostly align to domain semantics
  - `rpc/config` 的 schema 子域已回收到目录式结构 `rpc/config/schemas/{index,app,model,recent,region,serial}.ts`
  - continue trimming dead surfaces only after confirming no UI/desktop consumption
- `audit` `type hygiene`
  - review-prep phase has started cleaning obvious `any` usage in migrated code paths
  - `agent/tools/todo/*` now uses explicit raw input typing instead of local `any` shortcuts
- `audit` `backend file naming`
  - 后端禁用 `a.b.ts` 命名的规则已写入 `.codex/GLOBAL.md`
  - 已回收 `agent/runtime/httpErrors.*`、`agent/runtime/sessionControls.*`、`agent/runtime/AgentRuntime.*`、`agent/runtime/runCore.*`、`agent/session/turns.summary.*`、`agent/session/turns.messages.*`、`agent/session/turns.shared.ts`、`agent/session/fileSessionStore.*`、`document/pageLifecycle.*`、`document/workspace.*`、`project/config/mutations.*`、`project/archive.*`、`project/readSource.*`、`project/regions.*`、`project/store/layout.*`、`project/libraryManage/registry.*`、`api/rstream.*` 这一批活跃文件
  - 新规则下优先使用目录分层表达子域，而不是统一前缀；`project/config/mutations/*`、`project/archive/*`、`project/readSource/*`、`project/regions/*`、`api/rstream/*`、`agent/runtime/runCore/*`、`hardware/firmware/remote/*`、`hardware/probe/runtime/*`、`hardware/query/*`、`connection/remote/normalize/*` 已按该方式回收
  - 本轮已继续回收 `desktop/ble/bridge.*`、`desktop/terminal/manager.*`、`desktop/core-service/manager.*`、`serial/manager.*`、`metadata/libraryRecovery.*`、`metadata/manifest.*`、`tool/discovery.*`
  - 本轮已继续回收 `ffs/runtime/{bridge,filesystem,nodeSerialPort,session}.*` 与 `ffs/runtime/clients/{fatfs,littlefs,spiffs}.*`
  - 本轮已继续回收 `rpc/config/schemas.*`
  - 本轮已继续回收 `connection/catalog.*` 与 `connection/remote*.ts`
  - 本轮已继续回收 `connection/pinmap.*`
  - 本轮已继续回收 `build/{arduinoLint,compileErrors,diagnostics,lint,projectBuild}.*`
  - 本轮已继续回收 `project/libraryManage.*`、`project/lock.*`、`project/packageArchive.*`、`project/resourceSources.*`
  - 本轮已继续回收 `project/libraryStatus.ready.ts` 与 `project/readAbi.helpers.ts`
  - 本轮已继续回收 `hardware/upload/{ble,command,runtime}.*`
  - 本轮已继续回收 `hardware/upload/{ble-execution.types,ble.types,workflow.types*}` 到单个 `types.ts`
  - 本轮已继续回收 `agent/tools/todo/{normalize.*,operations.*}`、`hardware/fuzzy/validate.*`、`ffs/{paths.*,partition.*,imageWorkflow.*}`
  - 本轮已继续回收 `agent/session/turns.extract.ts`
  - 本轮已继续回收 `connection/{catalog.types,graph.types,pin.types,workspace.types}` 到单个 `types.ts`
  - 本轮已继续回收 `hardware/{board.types,category.types,library.types,search.types}` 到单个 `types.ts`
  - `desktop/src` 当前已无 `a.b.ts` 命名残留
  - `ffs/runtime` 当前已无后端业务实现层 `a.b.ts` 命名残留
  - `connection` 当前业务实现层点号命名已清空
  - `build` 当前业务实现层点号命名已清空
  - `project` 当前业务实现层点号命名已基本清空，仅剩 `*.types.ts`
  - `hardware.upload` 当前业务实现层点号命名已清空
  - `ffs` 域的 `mount.types.ts` / `summary.types.ts` 已并回单个 `ffs/types.ts`
  - `core/src` 剩余点号命名当前仅剩 `ffs/runtime/wasm/littlefs/littlefs.d.ts` 这一类 Wasm 声明文件
  - 仍有大量历史点号命名文件待持续回收，后续优先在正在触及的子域内边改边收
  - 已回收 `agent/runtime/httpErrors.*`、`agent/runtime/sessionControls.*`、`agent/runtime/AgentRuntime.*`、`agent/runtime/runCore.*`、`agent/session/turns.summary.*`、`agent/session/turns.messages.*`、`agent/session/turns.shared.ts`、`agent/session/fileSessionStore.*`、`document/pageLifecycle.*`、`document/workspace.*`、`project/config/mutations.*`、`project/archive.*`、`project/readSource.*`、`project/regions.*`、`api/rstream.*` 这一批活跃文件
  - 新规则下优先使用目录分层表达子域，而不是统一前缀；`project/config/mutations/*` 已按该方式回收
  - `hardware/query/*`、`hardware/firmware/remote/*`、`hardware/probe/runtime/*`、`hardware/esptool/logic/*`、`connection/remote/normalize/*` 这一组已按目录分层方式回收完成
  - 仍有大量历史点号命名文件待持续回收，后续优先在正在触及的子域内边改边收

### `packages/ui`

- `done` root flattening
  - `src/app` is no longer the active structure
- `done` `utils/core` and `utils/desktop`
  - thin direct handlers replace old service/client wrapper style
  - desktop utils are now split by concern (`client/core/host/project-open/ble`); the old monolithic helper is no longer a hotspot
  - `desktop.ble` is now split into `shared/devices/chooser` parts; the old monolithic BLE helper is no longer a hotspot
- `done` `agent`
  - AI API path through Hono instead of RPC skeleton is in place
- `partial` `blockly-editor`
  - page state, page actions, lifecycle polling, manual reload, library mutation auto-refresh
  - generic project mutation events now also cover cloud-sync driven reload/prompt behavior
  - lifecycle watch now also keys off a stable dependency signature, not only library counts
  - in-editor missing Blockly library restore panel now exists, including `Restore` and `Restore All`
  - when the workspace draft is dirty, external library/cloud mutations now refresh non-destructive project state while preserving the current JSON draft
  - still not full legacy Blockly runtime parity
- `partial` `code-editor`
  - build/upload/BLE paths, lifecycle polling, library mutation refresh
  - generic project mutation events now also cover cloud-sync driven plan refresh/prompt behavior
  - lifecycle watch now also keys off a stable dependency signature, so same-count dependency swaps are no longer missed
  - external library/cloud mutations that land during build/upload/BLE prepare-run are now queued and auto-refresh build/upload plans after the current action finishes
  - non-busy external library/cloud mutations now refresh plans without reinitializing and overwriting the current source draft
- `partial` `terminal`
  - serial/debugger/BLE live paths exist
  - upload summary card and BLE retry/reconnect actions now exist
  - copy output / paste clipboard actions now exist
  - input now supports direct `Enter` send, `Shift+Enter` newline, and `Ctrl/Cmd + L` clear shortcuts
  - textarea-based command history recall now exists via `ArrowUp / ArrowDown`
  - output view now auto-scrolls to the latest terminal content
  - selected upload target is now persisted locally across serial / debugger / BLE
  - manual BLE device selection now also goes through the same target-persistence path
  - invalid BLE targets now auto-fallback to a preferred / available target instead of staying stale
  - BLE discovery/selection logic is now split out of the page component; main component file is no longer the primary terminal hotspot
  - command upload and BLE upload action branches are now split into focused action files
  - page-local signals/computed state are now split into `utils/state.ts`
  - xterm mount/effects and clipboard/BLE helper interactions are now split into page-local `utils/`, and `component.ts` has been reduced back to the 180-line limit
  - still no xterm-level parity and fuller BLE UX
- `partial` `lib-manager`
  - filtering, compatibility prompt, parsed progress events, source labels, project mutation events
  - `Core Libraries` 快捷筛选 now exists
  - on-demand version depth now exists
  - remote registry search results now exist alongside local catalog and prefer registry package-version indexes when available
  - polling-based live action status now exists
  - explicit local-library import entry now exists and reuses desktop directory picker + core inspection/install flow
  - component orchestration layer has been split; page handlers now live in `utils/handlers.ts` and `component.ts` is no longer the primary hotspot
  - helper layer has been split by concern
  - page-local types 保持为单个 `types.ts`
  - `component.ts` has been reduced back under the file-size limit
  - true subscription-based streaming still pending
- `partial` `cloud-space`
  - scope switching, import, sync, editor, sync summary/history, details panel
  - explicit cover removal intent is now wired through UI -> core request payload
  - editor now explicitly shows when the current save will remove the cover
  - `remove_cover=true` 透传已在 `core.cloud.updateProject` 请求层闭环，不再只是 UI draft 标记
  - current local project can now resolve and highlight its bound cloud item in the list
  - current project binding now also has a dedicated summary card above the list
  - editing the bound cloud item now immediately updates the local binding nickname view
  - current project binding card now reacts to project session changes without full page refresh
  - page / pageSize 分页控制 now exists for public/template/mine scopes
  - recent sync history is now persisted locally
  - richer cross-device / server-backed history currently treated as optional, not a legacy blocker
- `done` `project-open`
  - selection, resolution, lifecycle preview, conflict `Cancel / Focus / Force Open`
  - page orchestration has been split from async open/preview actions; main component file is no longer the hotspot
  - action layer is now split into preview/open/types files; no single project-open file remains a top hotspot
- `done` `settings`
  - lifecycle summary, recent project hooks, close project
- `done` `serial-monitor`
  - core serial runtime integration
- `done` `graph-editor`
  - workspace state and graph/aws persistence through core
- `done` `ffs-manager`
  - core-backed inspect/preview/edit flows
- `done` `child-tool`
  - core tool host integration
- `done` `model-store` / `model-train` / `model-deploy`
  - current pages consume core/model and hardware/runtime helpers

### `packages/desktop`

- `done` core bootstrap
  - `utilityProcess.fork`-style core startup manager exists
  - `core-service` 实现层已回收到目录式结构 `core-service/manager/{index,health,process}.ts`
- `done` desktop app entry
  - Electron 主进程已补主窗口启动链，默认开发态加载 `http://127.0.0.1:4200`
  - preload 入口已改为自动暴露 ERPC bridge
  - 根脚本已新增 `pnpm run start:electron`
  - `desktop#dev` 已切到 Electron dev runner，根 `pnpm run dev` 会尝试在 watch 构建完成后拉起 Electron
- `done` thin ERPC bridge
  - host / terminal / BLE / core status
- `partial` project-open desktop integration
  - OS-launched project path consumption exists
  - explicit file-association registration still pending
- `done` BLE chooser bridge
  - only chooser/permission/device-list responsibilities remain here
  - 当前代码层未发现 `window.ble` / `Window.ble` / `globalThis.ble` 暴露；UI 统一通过 `desktop.ble.*` 调用
  - bridge 实现层已回收到目录式结构 `ble/bridge/{index,devices,permissions,selection,shared,state}.ts`
- `done` terminal manager
  - session create/write/resize/interrupt/executeOnce/stream
  - manager 实现层已回收到目录式结构 `terminal/manager/{index,env,execute,kill,listeners,sessions,shared,stream}.ts`

### `release / packaging`

- `partial` `trimmed desktop release`
  - `scripts/trim_desktop_release.mjs` generates a minimal release app package
  - release app manifest now preserves:
    - `productName`
    - `build.appId`
    - `build.protocols`
    - `build.*.fileAssociations`
  - pack tasks now cover:
    - `desktop#pack:mac`
    - `desktop#pack:win`
    - `desktop#pack:linux`
  - root scripts now verified:
    - `pnpm run build:mac`
    - `pnpm run build:win`
    - `pnpm run build:linux`
  - generated release app manifest no longer leaks template `scripts / devDependencies / exports / files`
  - full packager integration beyond trimmed manifest generation is still pending

### `packages/shared`

- `done` common contracts
  - BLE, cloud, terminal, tool, upload, project/common types
- `audit` naming and field docs
  - keep checking new additions for field-level JSDoc compliance

## Current High-Value Remaining Gaps

- `partial` `lib-manager`
  - remaining risk is mainly final walkthrough confirmation, not basic install or version/search semantics
- `partial` `blockly/code dependency awareness`
  - lifecycle polling + dependency signature exists
  - still no true watcher parity
- `partial` `terminal BLE UX`
  - BLE live path exists
  - preferred device persistence exists
  - authorized device restoration exists
  - chooser-discovered list merge exists
  - still no fuller recovery-action UI parity
  - current evidence suggests the remaining delta is enhancement-level, not a proven legacy blocker
- `partial` `cloud-space`
  - local implementation is largely aligned
  - remaining work is a final live/backend sanity-check for additive cover-removal behavior
  - richer server-backed history is currently classified as optional
- `todo` final `review`
- `todo` final `legacy walkthrough`
- `todo` final `scc`-driven large-file diagnosis
- `todo` final root `refactor report`

## Next Focus Order

1. `terminal`
   - only continue BLE/xterm work if walkthrough evidence proves a real blocker; otherwise defer to review/final report
2. `cloud-space`
   - local implementation side is largely aligned; only keep a final backend/live sanity-check for additive behaviors
3. `legacy walkthrough`
   - prefer converting remaining uncertainty into explicit checklist items over adding more speculative UI polish

## Remaining Gap Triage

### Keep Fixing Now

- `lib-manager`
  - only targeted improvements that materially improve current usability without new infrastructure
- `cloud-space`
  - backend confirmation and any small UI clarifications around remove-cover / current binding
- `terminal`
  - only small BLE UX additions that reuse existing chooser/runtime pieces

### Defer To Final Review / Legacy Walkthrough

- full watcher parity for `package.json` / board dependency changes
- xterm-level terminal parity
- full packager/signing/installer pipeline proof
- server-backed cloud sync history
- any broad new transport/subscription protocol solely for polishing progress UX

## Legacy Walkthrough Matrix

Use this matrix as the authoritative final walkthrough tracker. Do not mark the goal complete until every `todo` item below is either proven complete with current evidence or fixed.

- `project lifecycle` : `partial`
  - verified:
    - `project.abi` / `.temp` fallback
    - open-session lock persistence
    - open-file / argv / second-instance consumption
    - manual project-open flow
    - lifecycle summary surface in `settings`
  - still verify:
    - packaged/runtime proof for `desktop.host.focusProcess`, especially Linux external tool availability (`wmctrl` / `xdotool`)
    - current `Force Open` is additive; legacy-visible proof is strongest for `Cancel / Focus`
    - file association end-to-end installer behavior in packaged builds; metadata-level `.abi` associations are already present in release template and trimmed app manifests
    - whether any remaining board-dependency watcher behavior is truly required beyond current signature polling

- `blockly/code dependency workflow` : `partial`
  - verified:
    - lifecycle polling exists in `blockly-editor` and `code-editor`
    - dependency signature detects same-count dependency swaps
    - project mutation bus refreshes build/blockly flows
    - `blockly-editor` missing-library restore panel exists
    - `blockly-editor` now blocks editable workspace entry while required Blockly libraries are missing
  - still verify:
    - whether dirty-workspace fallback prompt is sufficient versus legacy expectations

- `library management` : `partial`
  - verified:
    - declared/missing/catalog views
    - compatibility prompt
    - local import
    - `Core Libraries` quick filter
    - registry search
    - version list loading
    - polling-based live action status
    - legacy registry/version depth does not require more than current search + version APIs
    - legacy install progress was notice-driven, not terminal-coupled
  - still verify:
    - whether dirty-workspace library refresh prompting is sufficient versus any legacy hard-reload expectation

- `terminal / build / upload orchestration` : `partial`
  - verified:
    - desktop PTY session
    - xterm-based interactive shell surface is back in `ui`
    - build live path + fallback diagnostics
    - serial/debugger upload live path + fallback diagnostics
    - BLE target discovery, prepare, execution, and summary
    - terminal clipboard/history/basic send ergonomics
  - still verify:
    - whether BLE chooser/history/detail UX has mandatory legacy behaviors still absent

- `cloud-space` : `partial`
  - verified:
    - public/template/mine scopes
    - import flow
    - metadata editor
    - publish/template/delete actions
    - current-project binding card
    - local recent sync history
    - pagination
    - `remove_cover=true` request payload
  - still verify:
    - live/backend behavior for cover removal
    - whether server-backed sync history is required by legacy behavior or just an enhancement

- `release / packaging` : `partial`
  - verified:
    - trimmed release manifest generation
    - mac/win/linux root build scripts
    - tsflow-generated workflows present
  - still verify:
    - packaged app file-association behavior
    - any remaining signing/notarization/installer proof required by the objective

## Review Entry Gate

Before starting `review`, confirm all of the following are true:

- remaining backend naming debt is no longer in active business implementation paths
- remaining `*.types.ts` files are intentional runtime-local boundaries under nested subsystems, not root-domain type fragmentation
- active UI pages no longer rely on rejected `component.*.ts` / `page-actions.*.ts` helper naming for newly touched hotspots; helper logic should be converging toward page-local `utils/` layout
- current `packages/ui/src/pages` helper naming debt for non-Angular `.ts` files has been cleared under the current audit
- current `packages/ui/src` frontend helper naming debt for non-Angular `.ts` files has also been cleared under the current audit
- future page splits should keep using `utils/` and directory-based helper groupings instead of reintroducing multi-dot page helper files
- repo-wide re-scan of `packages/ui/src` after the latest cleanup still returns zero violating helper filenames
- legacy walkthrough matrix has no hidden unknowns in the currently active user flows
- `core` and `ui` builds pass on the current worktree
- `.draft/legacy-gap-audit.md` and this file agree on the top remaining risks

## Review-Prep Verdict

These are the current working verdicts before the final review phase starts.

- `project lifecycle`
  - sufficient to enter final review later
  - remaining gaps are mostly watcher parity, conflict UX depth, and packaging/file-association proof
- `lib-manager`
  - sufficient to enter final review later under current evidence
  - remaining gaps are mostly walkthrough confirmation and optional polish, not core install progress semantics
- `terminal`
  - sufficient to enter final review later if no low-cost BLE UX fix stands out
  - remaining gaps are mostly xterm parity and richer BLE detail/history UX, which currently look non-blocking
- `cloud-space`
  - sufficient to enter final review later, but `remove_cover` backend semantics must be explicitly verified
  - richer server-backed sync history can be deferred unless legacy walkthrough proves it mandatory
- `release / packaging`
  - sufficient to enter final review later as a trimmed-release pipeline
  - full packager/signing/installer proof is still explicitly pending

## Keep-For-Now Surfaces

These should not be removed merely because current UI consumption is limited:

- `core.onboarding.*`
  - still actively used
- `core.cloud.updateProject`
  - required by current cloud editor flow
- `core.hardware.prepareBleUpload`
  - used by both `code-editor` and `terminal`
- `desktop.ble.deviceList`
  - currently powers BLE target discovery, even if only in focused flows
- `ui/runtime/project-events.ts`
  - intentionally retained as a cross-page project mutation bus

## RPC Surface Audit Checklist

Before removing any RPC/API file, confirm:

- UI has no direct `core.*` / `desktop.*` usage for it
- desktop has no ERPC or bridge usage for it
- it is not intentionally kept as a migration compatibility shim still referenced by a `.draft` note
- there is no active plan item saying that consumption is pending

Audited router groups:

- `core.project`
  - active UI consumption confirmed
  - dead recent/config helper surfaces already trimmed
- `core.config`
  - retained surfaces are the ones still consumed by UI
  - write-only dead helpers already trimmed
- `core.store`
  - retained surfaces match current UI usage
- `core.document`
  - no active UI/desktop consumption remained
  - entire router surface removed
- `core.agent`
  - retained:
    - `getEnabledModels`
    - `getSecurityOptions`
    - `normalize`
- `core.build`
  - retained:
    - `cancelProjectBuild`
    - `planProjectBuild`
    - `prepareProjectBuild`
    - `runProjectBuild`
- `core.cloud`
  - retained:
    - list/query/mutate actions used by `cloud-space` and `project-new`
- `core.model`
  - retained:
    - `list`
- `core.tool`
  - retained:
    - `acquire`
    - `list`
    - `release`
    - `restart`
- `core.serial`
  - retained:
    - `connect`
    - `disconnect`
    - `drain`
    - `send`
    - `signal`
    - `status`
- `core.hardware`
  - retained:
    - upload/build/runtime actions used by UI
    - board validation/category helpers used by home/blockly/simulator
- `core.connection`
  - retained:
    - graph/aws/pinmap/workspace actions used by `graph-editor`
- `core.ffs`
  - retained:
    - image inspect/preview/mutate actions used by `ffs-manager`
- `desktop.ble`
  - retained:
    - `deviceList`
    - `setPreferredDevice`
    - `startDeviceListUpdates`
    - `stopDeviceListUpdates`
- `desktop.core`
  - retained:
    - `ensureCoreStarted`
    - `getCoreStatus`
- `desktop.host`
  - retained:
    - pending project open + runtime info + file/directory pickers
- `desktop.terminal`
  - retained:
    - create/write/executeOnce/interrupt/resize/close/stream

Already cleaned:

- removed duplicate `core.project.addRecentlyProject/removeRecentlyProject`
- removed unused `core.project.setRecentProjects/setRecentModelProjects/isSameProjectPath/regions`
- removed empty `core.rpc` directories:
  - `app`
  - `appConfig`
  - `appStore`
  - `modelProject`
- removed unused `core.config` router actions:
  - `clearSkippedVersions`
  - `setDevmode`
  - `setDevmodeAutoSave`
  - `setLanguage`
  - `setModel`
  - `setQuickSends`
  - `setSerialMonitor`
  - `setTheme`
  - `setToolbarApps`
  - `skipVersion`
  - `toggleTheme`
- removed unused `core.store` router actions:
  - `addApp`
  - `removeApp`
- removed unused `core.document` router surface entirely
- removed unused `core.agent` router action:
  - `getTools`
- removed unused `core.build` router action:
  - `parseArduinoLintResult`
- removed unused `core.model` router action:
  - `detail`
- removed unused `core.tool` router action:
  - `get`
- removed unused `core.cloud` router action:
  - `syncProject`
- removed unused `core.hardware` router actions:
  - `downloadProbe`
  - `getLibraryCategories`
  - `getModelAddress`
  - `getModelFile`
  - `installEsptool`
  - `needFirmwareUpdate`
  - `resolveEsptoolTempDir`
- removed unused `core.connection` router actions:
  - `generatePinSummariesForBoard`
  - `getBoardPinSummary`
  - `getPinSummaryById`
  - `hasAws`
  - `hasGraph`
  - `parse`
  - `resolvePaths`
  - `validate`
- removed unused `core.ffs` router actions:
  - `buildMountPlan`
  - `buildPartitionFileName`
  - `exportImage`
  - `getDefaultUploadPath`
  - `isPlausiblePartitionEntry`
  - `parsePartitionTable`
  - `previewBlankMount`
  - `summarizePartitions`
  - `validateUploadFileName`
- removed unused `desktop.ble` ERPC actions:
  - `cancelDeviceRequest`
  - `debugState`
  - `selectDevice`
- removed unused `desktop.core` ERPC action:
  - `stopCore`

Still worth auditing before final completion:

- `core.onboarding`
  - currently consumed from UI, keep
- remaining modules should be checked against `.draft/legacy-gap-audit.md` for behavior gaps, not just dead RPC cleanup

## Do-Not-Forget Walkthrough List

Before claiming completion, explicitly re-check:

- `legacy_deepwiki/3.1-project-lifecycle.md`
- `legacy_deepwiki/3.2-library-management.md`
- `legacy_deepwiki/3.3-library-editor.md`
- `legacy_deepwiki/5.2-hardware-upload.md`
- `legacy_deepwiki/5.3-terminal-integration.md`
- old repo `/Users/xiewendao/Documents/aily/aily-blockly/` for any behavior still referenced in the docs but missing here

## Final Exit Checklist

- confirm `review-prep-audit.md` final audit gate is satisfied
- run `review`
- fix review findings
- perform full legacy alignment walkthrough
- run large-file audit against current handwritten files
- write root refactor report
- only then consider final completion
