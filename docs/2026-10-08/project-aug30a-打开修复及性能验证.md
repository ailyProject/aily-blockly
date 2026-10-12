# project_aug30a 打开修复及性能验证

原工程：`/Users/downey/Documents/aily-user-project/project_aug30a`，工程名称“岩石测量装置”。运行源码位于 `/Users/downey/Projects/OutSource/aily--blockly`。环境为 macOS arm64、Aily Blockly 0.9.104、Electron 35.7.5、aily-project-blockly 1.0.2。

## 已确认的原因

工程包含 7,765 个结构积木、320 个变量、三个 Arduino 入口根。JSON 嵌套深度约 2,272，最长连续 next 链为 994 个积木。最初排查中通用对象遍历还计入了 298 个带 type 的变量模型，得到 8,063；此数不是积木数量，后续校验采用连接结构统计。

原生 Blockly 实际完成了全部 7,765 个积木的加载，但 `nativeLoadedStateView` 用 `structuredClone` 复制深工作区时，当前 Chromium 返回 null。随后完整性校验发现读回视图缺失积木，抛出 `Project block identities changed during loading`，工程激活被阻止，画布清空而加载状态滞留。独立的 ABI JSON Worker 也因传输深对象发生 RangeError，回退到主线程再次解析。这不是原项目文件损坏或缺少库。

## 修复及影响

- 完整项目快照使用迭代 JSON 写入和解析复制，避免深对象结构复制及递归规范化。完整文档仍有 32,768 层和 2,000,000 节点的复杂度上限。资源负载的 canonical-json-v1 仍保持原来的 512 层契约、编码及哈希规则。
- 深度超过 256 的 ABI JSON 不经 Worker 对象传输，先让出一帧，再完整解析；字符串和转义字符不计入结构深度。取消、工程上下文检查和完整性校验保留。
- 深快照用于原生兼容视图、DHT 兼容副本、干净基线、工程修订及预备代码比较。没有删除积木、放宽身份/字段/连接校验或修改项目 ABI 格式。
- 大工作区在原生 blocks serializer 内批量创建后一次刷新渲染。只为已知内置字段预热真实字体的文字宽度缓存；自定义字段和自定义 serializer 保留原路径。异常和重入时还原原 serializer。针对当前 1.0.2 原生加载器的异常清理缺口，恢复撤销记录、事件组、文字缓存及渲染尺寸批次；无渲染的测试工作区不调用 SVG 专用方法。
- 小地图使用一个权威工作区。小项目复制现有 SVG 和自定义 canvas 位图；大项目以约 4 ms 的分帧预算收集已计算的积木路径、位置和颜色，再交给 OffscreenCanvas Worker。Worker 不可用时分帧绘制。超过 300 个可见积木的概览省略文字和字段细节，以保留导航并降低渲染成本。
- 函数/整个文件切换仍只过滤显示，完整模型、生成代码、保存、撤销、注释、动态函数调用、AI/ABS 事务和 SVG 导出职责保留。小地图过滤范围跟随函数视图；拖动、输入、IME 和 AI 编辑期间延期内容刷新，视口导航继续更新；关闭时释放 Worker、监听和动画帧。

## 性能观测

修复打开失败后、替换小地图之前，一次实测原生载入为 10.699 秒，小地图另有约 8.819 秒的主线程整工作区重建。最终版本一次实测原生载入为 9.820 秒，工程运行时就绪为 14.193 秒，测试观察就绪为 15.137 秒；移除了第二份 Blockly 工作区和上述小地图重建步骤。其他优化后轮次的原生载入为 9.374 和 9.790 秒；一次绘制期间测试观察延迟至 22.584 秒，记录保留。

这些是排查期间的单次观测，早期还带完整性诊断和后台 SDK 下载，不能据此给出严格的整体性能改善百分比。CPU profile 采样也增加运行开销，其 13.149 秒原生载入不能与无采样结果直接比较。完整模型的初始加载仍有约 12 秒主线程长任务，保存、全量代码生成和很长函数仍可能停顿；本次没有验证大积木栈拖动已流畅。

## 数据保全与实测

真实 Electron 测试使用原工程的完整隔离副本，保留其依赖和本地库，验证打开 → loop 函数视图（715 块）→ 保存 → 返回首页 → 重新打开 → 再保存。对比全部积木 ID、类型、字段、属性、连接角色、根顺序和 320 个变量，保存及重开结构一致，函数切换不改变序列化数据。前后生成源码字节完全相同，SHA-256 为 `54f21dbea3d1dd2b87c913e78cb9fb7c47f3e4f1c665c26ecdaf0509be38232d`。

原工程 `project.abi` 的 SHA-256 仍为 `bf63caeca0330b09c7995038b3e152f782064ccc131c7db8c8858ed7eba1455c`；`project.abs` 仍为 `93645b4f66dddcf5245d3dd17d6da88cbda29bad962623cb27a6bdcac53c91b3`。测试只写临时副本和隔离应用数据，未写原工程程序文件。活跃开发客户端亦观察到原工程已打开，选择器显示“全局定义 · 45 块”和“45 / 7765 块”，URL 指向原工程。没有重启用户开发服务。

以下检查覆盖本次相关行为：

- ABS 数据/模型/读回、动态字段、生成器及小地图视觉刷新回归：1,591 项通过。
- 项目 JSON 深快照、深 ABI Worker 跳过、语法错误、载入和取消回归：15 项通过。
- 原生函数视图、小地图投影、文字测量与性能回归：31 项通过；包含 RTL 几何、字段及变量一致性、自定义 serializer、异常后再次加载和原生撤销恢复。
- 真实 Electron 的 AI 修改后小地图和源码更新（开/关）、点击/拖动/键盘导航、12 函数完整保存和重开、隐藏函数 ABS 修改、跨函数撤销重做、固定注释保全及连续拖动/字段/注释输入。
- 真实 Electron 启动与从模板新建时的工具箱、通知、拖动和输入保全。

最终同一生产构建下的五组 Electron 用例全部通过；启动与模板新建的两组用例另外通过。已查看最终 3024 × 1768 的 [大工程函数视图截图](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/project-aug30a-open/opened-project.png)，确认 715 / 7765 的 loop 视图及大项目小地图颜色轮廓实际可见。旧小地图 SVG 背景会遮住下层 Canvas，已改为透明覆盖层，背景由主题容器提供；真实用例同时检查最终计算样式。

最终结果和完整日志见 [验证目录](/Users/downey/.codex/visualizations/2026/10/08/01a1194d-8a6c-7dc3-8076-994d2825ed48/project-aug30a-open/verification.json)。保留中间失败记录：错误使用未安装函数库的工程作为函数测试输入；小地图复制测试标记导致全局定位器重复匹配；SVG 选中后的层序改变导致 textContent 顺序断言失效；异常加载残留撤销状态及无渲染工作区恢复问题。已分别纠正输入、限定真实主画布定位器、比较完整文字集合和积木变换、补足加载异常清理。未减少数据/生成代码/撤销保全断言。

这里验证的是当前源码的真实 Electron 编辑器流程。没有进行正式安装包发布、Windows 实机或硬件编译上传验收。

## 复现

```sh
node scripts/run-angular.cjs test --configuration=abs-sync --watch=false --browsers=ChromeHeadless

node scripts/run-angular.cjs test --configuration=abs-project-load \
  --include=src/app/services/domains/project/project-document-json.spec.ts \
  --include=src/app/editors/blockly-editor/blockly-editor-load.spec.ts \
  --watch=false --browsers=ChromeHeadless

node scripts/run-angular.cjs test --ts-config tsconfig.blockly-interaction.spec.json \
  --include=src/app/editors/blockly-editor/utils/blockly-function-view.spec.ts \
  --include=src/app/editors/blockly-editor/utils/blockly-performance.spec.ts \
  --include=src/app/editors/blockly-editor/utils/workspace-minimap.spec.ts \
  --include=src/app/editors/blockly-editor/utils/blockly-text-measurement.spec.ts \
  --watch=false --browsers=ChromeHeadless

AILY_E2E_PROJECT=/Users/downey/Documents/aily-user-project/project_aug30a \
  AILY_E2E_PLATFORM_SEED=/path/to/installed/exact-platform-versions \
  node scripts/run-e2e.mjs test e2e/tests/blockly-real-project-open.spec.ts

AILY_E2E_PROJECT=/Users/downey/Documents/aily-user-project/leg4-spider-V4 \
  node scripts/run-e2e.mjs test e2e/tests/blockly-function-view.spec.ts \
  e2e/tests/blockly-ai-minimap.spec.ts e2e/tests/blockly-interaction-continuity.spec.ts
```

大工程用例的 platform seed 只复制精确版本的平台元数据及实际 SDK/工具到隔离应用目录。缓存可能被其他活跃客户端更新；版本不匹配时测试在打开之前拒绝，不改用户缓存。可使用冻结的隔离 seed 复现。函数交互用例需要已安装 lib-core-functions 的工程。
