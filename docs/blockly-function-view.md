# Blockly 函数视图

Blockly 主编辑器左上角可以切换“整个文件”、全局定义、`setup()`、`loop()`、自定义函数和“其他积木”。每个选项显示积木数量；单函数视图另显示当前可见数量和工作区总量。新增、粘贴及从当前函数断开的积木继续显示，切换后可从“其他积木”找回。默认仍为整个文件。

参考入口是 Coder 的 `src/features/cppBlockly/previewView.ts` 函数选择器。Coder 使用源码投影的局部加载；Blockly 主编辑器的动态函数、变量、撤销、AI 操作和生成器依赖完整原生工作区，因此这里采用完整模型加显示过滤，没有复制 Coder 的局部序列化替换方案。

## 影响及保全方式

| 路径 | 行为 |
| --- | --- |
| 画布、小地图、缩放和滚动边界 | 仅绘制当前函数及新增的临时积木；小地图复用可见根的原生 SVG，不建立第二份 Blockly 模型。可见积木超过 300 个时，分帧读取路径和位置，由 Worker 绘制颜色轮廓概览；不在概览中绘制文字及自定义字段细节。点击、拖动和键盘定位仍可用。长函数首次切入从函数名称和参数开始显示，各视图保留本次会话中的缩放和滚动位置。 |
| 保存、代码预览、构建输入 | 使用原来的完整工作区和项目文档；隐藏函数、变量、注释与调用仍在模型中，`project.abi` 格式不变。没有修改构建器或上传流程。 |
| 撤销、重做、函数参数和调用 | 切换不清空或替换积木实例、不清空撤销栈；函数注册表和变量模型始终可访问全部定义。 |
| 拖动、框选、全选、复制、删除 | 隐藏积木不能成为拖动吸附目标；快捷键和右键全选只选可见根，框选也排除隐藏内容。主动切换时清理旧选择；搜索、代码和执行定位自动切换时也清理已隐藏的多选，保留有效定位目标，避免随后复制或删除隐藏函数。程序式连接及撤销仍使用完整模型。 |
| 搜索、代码定位、执行定位 | 原生 `centerOnBlock` 和有效选中事件会先显示目标函数，再定位目标积木。搜索范围仍是完整工作区。 |
| 固定注释、警告和变形器气泡 | 原生气泡在独立 SVG 层，通过显示过滤同步隐藏；不关闭固定注释，避免改变序列化的 `pinned`、文字、尺寸及位置。显示过滤适配当前 Blockly 1.0.2 的内置气泡槽位，升级时须重新验证相关回归。 |
| AI/ABS、整页加载、切页、工程关闭 | 普通事件和抑制事件后的视觉刷新都更新函数选项及显示范围；选中函数被删除时回到整个文件；页面加载清理临时积木记录；关闭时释放监听、动画帧及原生方法包装。 |
| 完整工作区 SVG 导出 | 导出期间同步恢复全部根、气泡和完整边界，随后恢复当前函数视图。 |
| 输入焦点和后台刷新 | 主动切换后焦点回到画布，避免选择器或重新载入的注释编辑器让代码、小地图刷新一直等待输入结束。隐藏气泡不能持有输入焦点。 |
| 固定注释的保存重开 | 原生注释在初始渲染后异步恢复固定状态和坐标；载入后等待一帧并再次检查工程上下文，再进行原有完整状态校验，避免提前读回造成错误拒绝。没有放宽数据保全校验。 |

## 性能边界

优化的是 SVG 同时显示、画布内容边界和小地图重复绘制的成本。原生积木仍全部存在；首次完整加载、完整序列化、完整代码生成及模型内存占用没有按函数减少。结构变化时重建函数成员和根索引；坐标移动及普通字段变化复用索引，气泡事件只更新所属积木。函数自身很大时仍可能需要进一步优化。可见块数下降不等同于测得帧率或延迟改善。

同日拖拽优化还减少了整项目快照复制、宏配置父链遍历和代码行映射的重复工作。代码预览通过原有 200ms 合并发送，在拖拽、字段编辑或独占修改期间只保留最新待发状态；选择定位仍即时发送。小地图每个采集/回退绘制分帧都会检查交互，放弃过期的局部场景并在结束后重采。代码生成的 500ms 防抖、完整项目版本校验、保存和构建输入仍保留。详见 [拖拽卡顿修复及验证](2026-10-08/project-aug30a-拖拽卡顿修复及验证.md)。

同日后续的 `project_aug30a` 修复还消除了深积木链的结构复制失败，并对大项目批量测量原生字段文字、移除小地图的重复反序列化。详见 [项目打开及性能验证](2026-10-08/project-aug30a-打开修复及性能验证.md)。下面为先前函数视图实现的验证记录，后续验证以新记录为准。

## 验证记录：2026-10-08

环境为 macOS arm64、Aily Blockly 0.9.104、Electron 35.7.5、aily-project-blockly 1.0.2。真实 Electron 窗口截图为 3024 × 1768。

- 新视图及已有性能检查：20 项通过，覆盖完整序列化、变量、根顺序、完整生成代码、跨视图撤销重做、定位、临时积木、拖动约束、滚动边界、删除回退、SVG 导出、静默加载和固定子块注释的切换、重载。
- ABS 工作区同步、项目模型、标准及动态函数、预备代码、运行时引用、原生字段加载、生成器运行时：326 项通过。
- 工程载入、取消及示例载入回归：14 项通过。
- 已有真实 Electron 回归：AI 修改后的代码与小地图更新（小地图开/关）、连续拖动、文本/数字/下拉、注释编辑及保存均通过。
- 新真实 Electron 测试使用 `leg4-spider-V4` 的隔离副本及已安装库，构造 12 个函数、976 个积木。单函数主画布和小地图均为 81 个积木；完整模型仍为 976 个。验证真实字段编辑、跨视图撤销重做、两种全选、自动定位清理隐藏多选、全部函数及调用写入生成源码、隐藏函数的真实 ABS 修改和保存重开。重开后检查两个函数的字段以及固定注释的完整原生状态；源工程 `project.abi` 哈希保持不变。

最终生产构建及上述 4 个 Electron 用例整组通过。一次中间运行中，旧连续输入用例观察到生成次数为 3、预期为 2；随后单独组合重跑与最终原用例整组均通过，未放宽断言。该现象尚未复现，保留失败日志以便后续排查。

[单函数截图](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/blockly-function-view/single-function.png) · [整个文件截图](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/blockly-function-view/whole-file.png) · [验证记录及日志索引](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/blockly-function-view/verification.json) · [最终客户端日志](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/blockly-function-view/electron-tests.log) · [中间失败记录](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/blockly-function-view/interaction-transient-failure.log)

复现新用例：

```sh
node scripts/run-angular.cjs test --ts-config tsconfig.blockly-interaction.spec.json \
  --include 'src/app/editors/blockly-editor/utils/blockly-function-view.spec.ts' \
  --include 'src/app/editors/blockly-editor/utils/blockly-performance.spec.ts' \
  --watch=false --browsers=ChromeHeadless

AILY_E2E_PROJECT=/absolute/path/to/installed/project \
  node scripts/run-e2e.mjs test e2e/tests/blockly-function-view.spec.ts
```

E2E 项目需已安装 `lib-core-functions`、`lib-core-time` 和 `lib-core-math`。测试在临时副本及隔离应用数据中写入，结束后清理。此次没有进行 Windows 实机、正式安装包发布或硬件上传验收。

## 2026-10-09 路由布局与底部工具栏回归

页面切换时 Angular 动画可能暂时保留旧页面，`router-outlet.nextElementSibling` 因而仍指向旧宿主。原布局指令会把 `aily-routed-content` 标记加到旧页面，使新 Blockly 编辑器保持 `display: inline`，`clientWidth/clientHeight` 均为 0，浮动工具栏被限制在左下角。

指令现在从 `ViewContainerRef` 取得刚激活或重新挂载的视图根节点，不依赖相邻 DOM 顺序，保留原有窄范围布局选择器。

验证：带真实 Router 和动画提供器的页面切换用例在修复前复现 0×0，修复后首次加载、切页/父容器缩放、重新挂载全部通过；连同原有 DevTool Blockly/Coder 用例共 7 项通过，`tsconfig.app.json` 类型检查通过。

```sh
TMPDIR=/private/tmp node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless \
  --include=src/app/directives/routed-content.directive.spec.ts \
  --include=src/app/editors/blockly-editor/components/dev-tool/dev-tool-coder.spec.ts
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json
```

当前 macOS Electron 35.7.5 开发实例（localhost:4200）热更新后，编辑器实际尺寸从 0×0 恢复为 1918×1340（开发者工具打开时），工具栏从 x=0 恢复居中至 x=788。真实鼠标操作验证了横向/纵向拖动、松手后再次拖动、拖至右侧边界及移回底部。验证中误触的积木拖动已通过产品撤销恢复，工作区恢复为 7765 块、撤销栈为空；误触的架构图会话已停止。未做 Windows 或正式安装包验收。

同日后续优化：拖动区域及其图标使用 `grab`，拖动期间使用 `grabbing`。历史实现仅在组件内保存坐标，每次创建组件都会重新居中；现在完成拖动后通过 `ConfigService.save()` 将距编辑器左边、底边的偏移写入用户配置 `devToolPosition`，项目重载时恢复。窗口或面板缩小只限制显示位置，不覆盖保存的偏好；无效配置回退到底部居中，单击手柄、初始化和销毁不写配置。

新增位置回归 6 项，覆盖完成拖动才保存、最后一帧前松手、重建后恢复、缩小/单击/再放大、边界、失焦和销毁，连同上述用例共 13 项通过；应用类型检查通过。测试命令增加：

```sh
--include=src/app/editors/blockly-editor/components/dev-tool/dev-tool-position.spec.ts
```

真实 Electron 在 `leg4-spider-V4` 上拖动后，内存及磁盘配置均为 `{ "x": 660, "y": 56 }`。打开开发者工具压缩编辑器时，显示 x 临时限制为 527，保存值仍为 660；关闭面板后恢复。点击产品工具栏“重新加载项目”后核对旧工具栏宿主已断开、新宿主和积木实例均已重建，加载结束、积木数仍为 2800、保存位置保持不变。本次验证覆盖项目重载和本地配置写入，未重启整个应用进程。
