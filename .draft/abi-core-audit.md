# ABI 模块 core 拆分审计

## 结论

`abi` 模块 **没有完整拆分到 `core`**。

更准确地说：

- `project.abi` 的 **文档模型、归一化、读写、页面生命周期变更、摘要读取** 已经基本进入 `core`
- 但 ABI 相关的 **ABS/ABI 双向转换、Blockly 工作区装载/回填、未保存比较、保存时的 used-library manifest 同步** 仍未完整在 `core` 闭环
- 当前 `packages/ui/src/pages/blockly-editor` 还是一个 **围绕 core ABI 状态的壳层/占位编辑器**，不是完整的 Blockly ABI runtime

## 已经进入 core 的部分

### 1. ABI 归一化与载荷生成

- `packages/core/src/abi/normalize.ts`
  - `normalizeProjectAbi`
  - `buildProjectAbiPayload`
  - `parseProjectAbiText`
  - `stringifyProjectAbi`
  - `countAbiBlocks`
- `packages/core/src/document/normalize.ts`
  - 负责 legacy 单页 workspace ABI -> 新文档模型
  - 负责多页文档 -> 单页 legacy payload 回写兼容

这说明 ABI 的“数据模型解释权”已经不在 UI，而在 `core`。

### 2. ABI 文件读写

- `packages/core/src/project/readDocument.ts`
  - 读取 `project.abi`
  - 支持 `project.abi.temp` fallback
- `packages/core/src/project/writeDocument.ts`
  - 回写 `project.abi`
  - 同步写入 `project.abi.temp`

这说明 ABI 的文件 IO 主路径也已经迁到 `core`。

### 3. 页面生命周期变更

- `packages/core/src/project/createDocumentPage.ts`
- `packages/core/src/project/openDocumentPage.ts`
- `packages/core/src/project/switchDocumentPage.ts`
- `packages/core/src/project/renameDocumentPage.ts`
- `packages/core/src/project/closeDocumentPage.ts`
- `packages/core/src/project/updateActiveWorkspace.ts`

这部分把 legacy 里 `BlocklyService` 内部页面状态变更的核心规则抽到了 `core/document` + `core/project`。

### 4. ABI 摘要 / 激活工作区读取

- `packages/core/src/project/readAbi.ts`
- `packages/core/src/project/readActiveWorkspace.ts`
- `packages/core/src/rpc/project/readAbiSummary.ts`
- `packages/core/src/rpc/project/readActiveWorkspace.ts`

当前 UI 读 ABI 详情、页签、共享变量/过程数，都是通过这些接口拿到的。

## 还没有完整进入 core 的部分

### 1. ABS <-> ABI 双向转换仍在 legacy / UI 侧

legacy 里完整转换器还在：

- `/Users/xiewendao/Documents/aily/aily-blockly/src/app/tools/aily-chat/tools/abiAbsConverter.ts`
  - `convertAbiToAbs`
  - `convertAbiToAbsWithLineMap`
  - `convertAbsToAbi`

当前 `core/src/abs` 只有少量辅助类型与语法糖工具，没有真正的转换实现：

- `packages/core/src/abs/index.ts`
- `packages/core/src/abs/portableState.ts`
- `packages/core/src/abs/syntaxSugar.ts`
- `packages/core/src/abs/types.ts`

也就是说，“ABI 服务模块”如果包含 ABS 同步/转换能力，这块 **没有迁完**。

### 2. Blockly 工作区装载逻辑仍不在 core

legacy 的 ABI 装载动作仍是 Blockly 运行时内部行为：

- `/Users/xiewendao/Documents/aily/aily-blockly/src/app/editors/blockly-editor/services/blockly.service.ts`
  - `loadAbiJson`
  - `applyProjectDocument`
  - `loadActivePageIntoWorkspace`

`core` 目前只负责“提供 normalized document/workspace payload”，不负责把它真正灌进 Blockly workspace。

这部分严格说属于 UI runtime，不一定必须进 core；但如果你的“abi 服务模块”定义里包含“可直接驱动 Blockly 编辑器状态”，那就 **还没完全拆完**。

### 3. save 时的 used-library manifest 同步没有形成 core 闭环

legacy `_ProjectService.save()` 不只是写 ABI，还会：

- 写 `project.abi`
- `syncUsedLibraryManifest()`
- 更新 `package.json.codeHash`

当前 core：

- `writeProjectDocument()` 只写 ABI 文件和 temp 文件
- `updateProjectActiveWorkspace()` 只做 workspace -> document 更新，并清理生成态
- `metadata/manifest/build.ts` 已有 manifest 构建函数，但当前没有看到在 ABI 保存链路里被调用

所以从“legacy ABI 保存副作用是否已迁移”来看，这块 **仍不完整**。

### 4. 未保存比较逻辑没有看到 core 版 ABI diff 能力

legacy `_ProjectService.hasUnsavedChanges()` 会把：

- 当前工作区 ABI
- 已落盘 ABI

都归一化后做比较。

当前新 UI 主要通过本地 signal 维护 `activeWorkspaceDirty`，但没有看到一个通用的 `core.project.hasUnsavedAbiChanges` 之类接口。

这意味着 ABI 层面的“规范比较”能力没有完全沉到 core。

### 5. 当前 Blockly UI 仍是壳层 / 占位

`packages/ui/src/pages/blockly-editor/components/workspace-shell.component.html` 明确还是状态壳层：

- 主要展示 ABI summary / page / viewState / counts
- `blocklyEditorWorkspaceHints` 里直接写了
  - `toolbox categories will land here`
  - `workspace snapshot and ABI lifecycle will bind here`

所以即便 ABI 数据模型已进 core，真正的 Blockly ABI 编辑 runtime 还没有完整重建。

## 建议判断口径

如果你问的是：

### “ABI 文件和文档模型是否已经拆到 core？”

答案是：**基本是，主干已经在 core。**

### “legacy 里整个 ABI 服务模块是否已经完整迁到 core？”

答案是：**没有，还差至少 4 块：**

1. ABS/ABI 双向转换
2. Blockly workspace 装载/回填 runtime
3. 保存链路里的 used-library manifest 同步
4. 统一的 ABI unsaved/diff 能力

## 后续迁移建议

建议把剩余 ABI 能力继续按下面方式收口：

1. `core/abs`
   - 补齐 `convertAbiToAbs`
   - 补齐 `convertAbiToAbsWithLineMap`
   - 补齐 `convertAbsToAbi`

2. `core/project`
   - 新增“保存 ABI 时同步 manifest”的明确入口
   - 新增 normalized ABI diff / dirty compare 能力

3. `ui/blockly-editor`
   - 只保留 Blockly 渲染适配与交互事件桥接
   - 不再保留 ABI 规则层

4. `agent/chat`
   - 未来若要支持 ABS 文件编辑，应直接调用 `core/abs` 与 `core/project`，而不是复用 legacy 工具实现
