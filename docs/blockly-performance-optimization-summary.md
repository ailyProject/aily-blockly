# Blockly 大工作区性能优化总结

更新日期：2026-05-22

## 背景

当 Blockly 项目包含大量积木块时，编辑器容易出现拖拽、选择、页面切换、保存和代码查看器同步卡顿。主要原因不是单个算法错误，而是多个主线程上的全量操作叠加：工作区事件触发过宽、Minimap 全量同步、代码生成后的派生计算过多、历史保存过早序列化、保存时重复生成代码，以及工具箱 Angular 检测频率偏高。

本轮优化优先处理低风险、高收益的热路径，目标是在不改 Blockly 核心和渲染器架构的前提下，减少重复全量计算和频繁 IPC/预处理触发。

## 已完成优化

### 1. 工作区事件过滤

相关文件：

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`

原先工作区任意事件都会触发代码生成；除 `SELECTED` 外也都会触发 Minimap 同步。大量块场景下，选择、视口滚动、工具箱交互等 UI 事件会间接放大主线程压力。

现在引入了事件分类：

- 只有 `create`、`delete`、`change`、`move`、变量创建/删除/重命名等影响代码的事件会触发代码生成。
- Minimap 只响应块和注释的创建、删除、变更、移动等会影响结构或位置的事件。
- 页面切换等必须刷新派生状态的路径仍可显式触发代码生成和 Minimap 同步。

预期收益：减少无关 Blockly 事件引起的代码生成排队和 Minimap 同步排队，尤其改善频繁选择、拖动画布、工具箱操作时的响应。

### 2. Minimap 同步合并与防重入

相关文件：

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`

Minimap 仍沿用 XML 全量同步路径：`workspaceToDom -> clear -> domToWorkspace -> zoomToFit`。这个路径保留是因为现有注释说明 `serialization.load` 与部分 custom field 有兼容风险。

本轮在外层增加了调度保护：

- Minimap debounce 从 `300ms` 调整为 `500ms`。
- 使用 `minimapDirtyVersion` / `minimapSyncedVersion` 跳过无变化同步。
- 使用 `minimapSyncInProgress` / `minimapSyncQueued` 合并同步期间的新请求，避免上一轮 render/zoom 尚未完成时重入。

预期收益：大工作区连续变更时，Minimap 不再密集执行全量 XML 序列化和反序列化，降低长任务出现概率。

### 3. 自动保存延后序列化

相关文件：

- `src/app/editors/blockly-editor/services/history.service.ts`

原先历史服务在每次有效 workspace 事件发生时立即调用 `getProjectDocument()`，然后 3 秒 debounce 后才写入历史版本。这意味着即使用户连续编辑，系统也会多次提前做完整项目文档序列化和 clone。

现在改为：

- workspace 事件只标记待自动保存。
- 3 秒 debounce 到期、真正需要创建历史版本时才调用 `getProjectDocument()`。
- 连续变更只保留最后一次自动保存请求。

预期收益：减少编辑过程中的全量项目文档序列化，改善大量块下的持续编辑流畅度。

### 4. ABS 行号映射改为按需刷新

相关文件：

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`
- `src/app/editors/blockly-editor/services/blockly.service.ts`

原先每次代码生成后都会调用 ABS 转换并更新 `absBlockLineMap`。该转换需要序列化工作区并生成 ABS 行号映射，对大工作区成本较高。

现在代码生成成功后只清空 `absBlockLineMap` 缓存，不再立即重建。实际需要 ABS 行号时，`BlocklyService` 里已有降级逻辑会即时生成并缓存。

预期收益：把 ABS 行号转换从代码生成热路径移出，减少普通编辑后的同步计算压力。

### 5. 代码查看器 IPC 合并推送

相关文件：

- `src/app/editors/blockly-editor/services/code-viewer-ipc.service.ts`

原先每次代码生成都会立即把完整代码和 `blockCodeMap` 通过 IPC 推送到代码查看器，其中 `Array.from(blockCodeMap.entries())` 和 IPC 序列化在大项目下成本明显。

现在改为：

- 完整代码状态推送增加 `200ms` 合并。
- 只在 flush 时把 `blockCodeMap` 转数组。
- 选中块变化仍通过 `publishSelection()` 即时发送，保持代码查看器高亮响应。
- `clear()` 会取消待发送的完整状态，避免旧状态延迟写入。

预期收益：减少代码生成密集发生时的完整 IPC 消息频率，同时保留选择高亮的交互即时性。

### 6. 生成代码缓存与保存复用

相关文件：

- `src/app/editors/blockly-editor/services/blockly.service.ts`
- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`
- `src/app/editors/blockly-editor/services/project.service.ts`

原先保存项目时，`updateCodeHash()` 会再次调用 `arduinoGenerator.workspaceToCode()`。如果用户刚编辑完，代码生成防抖通常已经生成过一次，这会造成保存路径上的重复全量遍历。

现在新增代码生成 revision 缓存：

- 有效 Blockly 变更会调用 `markWorkspaceCodeDirty()` 递增 workspace code revision。
- 代码生成成功后通过 `publishGeneratedCode()` 记录代码和对应 revision。
- 保存更新 codeHash 时优先使用 `getReusableGeneratedCode()`。
- 如果保存时缓存已过期，则同步生成一次并更新缓存，保证保存正确性。

预期收益：减少保存大项目时重复 `workspaceToCode()`，降低保存延迟。

### 7. 保存流程复用项目文档

相关文件：

- `src/app/editors/blockly-editor/services/blockly.service.ts`
- `src/app/editors/blockly-editor/services/project.service.ts`

原先保存流程会先通过 `getProjectAbiForSave()` 取得 ABI，又在同步使用库清单时通过 `getProjectUsedLibraryManifest()` 再次取得完整项目文档。

现在保存时先取得一次 `projectDocument`，并传给：

- `getProjectAbiForSave(projectDocument)`
- `syncUsedLibraryManifest(path, projectDocument)`
- `getProjectUsedLibraryManifest(packageJson, projectDocument)`

预期收益：减少保存路径中的重复 `getProjectDocument()`、clone 和块类型遍历。

### 8. 依赖预编译触发节流

相关文件：

- `src/app/editors/blockly-editor/services/builder.service.ts`

原先 `dependencySubject` 一有变化就进入预编译处理逻辑，连续代码生成可能导致预处理进程频繁停止、重启或排队。

现在在订阅入口增加 `500ms` debounce。

预期收益：减少连续编辑后后台预处理抖动，降低与编译、上传、依赖安装等流程的冲突概率。

### 9. 语言切换批量渲染

相关文件：

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`

原先语言切换时会遍历所有块并逐块调用 `initSvg()` 和 `render()`，大量块时会造成多次重排。

现在改为：

- 临时禁用 Blockly 事件。
- 遍历已渲染块，仅调用 `initSvg()`。
- 最后统一调用一次 `workspace.render()`。

预期收益：降低语言切换时的全量重渲染成本。

### 10. Flyout 固钉位置更新合并

相关文件：

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`

原先 flyout 固钉的 `ResizeObserver` 回调会直接读取尺寸并写入 SVG 属性。

现在改为通过 `requestAnimationFrame` 合并位置更新，并在移除控件时取消待执行 frame。

预期收益：减少 resize 高频回调中的 DOM 读写次数。

### 11. 工具箱面板启用 OnPush

相关文件：

- `src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.ts`

工具箱面板已经在 `combineLatest` 订阅中显式调用 `markForCheck()`，适合启用 `ChangeDetectionStrategy.OnPush`。

本轮仅对工具箱面板启用 OnPush，暂未对 Blockly 主组件启用。主组件仍通过服务 getter 暴露页面列表等状态，直接启用 OnPush 需要更完整回归。

预期收益：降低工具箱列表、搜索、选中状态变化对 Angular 变更检测的影响。

## 涉及文件总览

- `src/app/editors/blockly-editor/components/blockly/blockly.component.ts`
- `src/app/editors/blockly-editor/components/blockly/components/blockly-toolbox-pane/blockly-toolbox-pane.component.ts`
- `src/app/editors/blockly-editor/services/blockly.service.ts`
- `src/app/editors/blockly-editor/services/builder.service.ts`
- `src/app/editors/blockly-editor/services/code-viewer-ipc.service.ts`
- `src/app/editors/blockly-editor/services/history.service.ts`
- `src/app/editors/blockly-editor/services/project.service.ts`

当前 diff 统计：7 个文件，约 213 行新增、62 行删除。

## 验证情况

已完成的验证：

- 对改动文件执行编辑器诊断，均无错误。
- 执行 Angular development build：

```powershell
npm run ng -- build --configuration development --base-href ./
```

构建结果：通过。

已知构建警告：

```text
Import "JavaScript" will always be undefined because there is no matching export in "node_modules/blockly/index.mjs"
```

该警告来自 `src/app/editors/blockly-editor/services/blockly.service.ts` 中既有的 `Blockly.JavaScript` 访问，不是本次性能优化引入的错误。

## 建议的手动回归场景

建议使用 100、500、1000 块规模的项目分别验证：

1. 拖拽、连接、删除、撤销重做是否正常。
2. 选中块后代码查看器高亮是否仍即时更新。
3. 修改字段后代码生成、依赖预编译是否正常触发。
4. Minimap 是否在块结构、位置变化后正确更新。
5. 页面切换、新增页面、关闭页面、重新打开页面是否正常。
6. 项目保存后 `project.abi`、`package.json` 的 `codeHash` 和使用库清单是否正确更新。
7. 自动历史版本是否仍会在连续编辑停止后生成。
8. 语言切换后积木文本是否更新，工作区是否正常渲染。
9. 工具箱搜索、分类选中、库管理入口、拖拽排序是否正常。

建议使用 Chrome DevTools Performance 对比以下指标：

- `workspaceToCode()` 总耗时和触发次数。
- `Blockly.Xml.workspaceToDom()` / `Blockly.Xml.domToWorkspace()` 触发次数。
- `JSON.stringify()` 和项目文档 clone 在编辑过程中的占比。
- `Array.from(blockCodeMap.entries())` 和代码查看器 IPC 消息频率。
- Long Task 数量和持续时间。

## 后续可继续优化方向

1. 项目文档 revision 缓存：让 `getProjectDocument()` 在 revision 未变化时复用缓存，进一步减少保存、历史、未保存检测中的全量 clone。
2. 大项目模式：当块数量超过阈值时，降低 Minimap 刷新频率，代码查看器未打开时暂停完整 `blockCodeMap` 推送。
3. 主 Blockly 组件 OnPush：需要先梳理页面列表、AI overlay、外部服务状态更新的检测触发点，再评估启用。
4. 工具箱 Sortable 初始化优化：只在容器集合变化时重新扫描，避免搜索和选中状态变化时重复检查 DOM。
5. 自定义字段局部缓存：如果火焰图显示位图、LED 矩阵等字段渲染占比高，再针对字段值、尺寸和 canvas 绘制做缓存。
6. 性能 fixture：增加生成 500/1000 块测试项目的脚本或 fixture，用于后续防止性能回退。
