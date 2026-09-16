# project_aug30a 大工作区卡顿与爆栈修复

日期：2026-09-16。修复位于 Blockly 宿主与 aily-agent 源码；未打包或发布 Windows 安装包。

## 结论与证据边界

项目有 **2583 个块、162 个变量、3 个顶层块**。最长连续 `next` 链为 **974 个块**，输入/语句的语法嵌套只有 **8 层**，但 ABI 的 JSON 结构深度达到 **1984 层**。块总数不能单独决定调用栈用量，也没有证据证明存在“2500 块硬上限”。

本次在 macOS Electron 开发宿主中，真实项目可以打开、生成代码、整理和保存。旧 Arduino 生成器在 **6000 块连续语句链**上稳定复现 `Maximum call stack size exceeded`，调用栈反复进入 `blockToCode → scrub_ → blockToCode`；修复后同一链完整生成、顺序一致。这证明并修复了长链递归缺陷，但原 Windows 会话没有记录 JS stack，不能把本次复现宣称为原现场唯一触发点。

全部项目操作使用 `/tmp/aily-large-workspace-investigation/project` 副本。没有裁剪原项目的块，也没有执行硬件上传。使用独立测试用户目录；依赖沿用已安装的本机工具链。

## 会话文件分析

分析文件：`2026-09-15T06-30-36-237Z_01a0a3c2-9fcd-77e5-be11-020418974743.jsonl`，会话记录的 Aily Chat 版本为 `0.1.37`。以下均为实际 `toolResult`，时间转换为北京时间。

| JSONL 行号 | 时间 | 操作 | 直接错误 | 附带日志的问题 |
| --- | --- | --- | --- | --- |
| 164 | 09-15 16:22 | project_upload | Maximum call stack size exceeded | 附带当天 11:24 的旧日志，末尾实际有编译成功及空间占用数据，却被标为 compile_error |
| 266 | 09-16 09:37 | project_build | 预编译失败：Maximum call stack size exceeded | 附带前一天 18:03 的缺头文件日志，被标为 dependency_header_missing |
| 314 | 09-16 09:52 | app_close / project_close | 关闭前保存失败：Maximum call stack size exceeded | 保存阶段也能失败，不是只有编译器或串口上传阶段失败 |

截图中的“分批能成功、整体操作失败”与长链遍历问题相容；重启不会改变连接深度。但截图和会话中的历史结论属于待核实资料，不能替代调用栈。保存、代码生成、资源扫描之间存在共同的全量工作区处理路径，已对其中的递归遍历进行修复。

Agent 之前只读取“最新编译日志”，没有检查日志是否属于当前操作。现在 build/upload 传入操作开始时间及当前错误：

- 当前错误包含 JS stack overflow 时，返回 `host_stack_overflow`，不再用旧缺头文件记录覆盖诊断。
- 日志早于本次操作时，只返回 `no_current_compile_log` 与历史文件位置，不把历史日志当成本次编译失败证据。
- 当次的新编译日志仍保留原有依赖/头文件诊断。

## 卡顿定位与变更

实际使用的是 npm 别名包 `aily-project-blockly@1.0.2`，不是直接依赖原版最新 Blockly。运行配置开启了 Minimap。

CPU profile 中，旧版 `VariableModel.compareByName` 累计自耗时约 **5090 ms**。每个变量下拉框都会排序，比较器对每次比较调用带选项的 `localeCompare`；小地图 XML 重建又重复创建大量字段。另有整工作区重复渲染、文字测量、SVG 几何计算。单次工作区 JSON 序列化约 2 ms，不能把主要卡顿归因于这一步。

本次修改：

1. 变量排序复用一个 `Intl.Collator`，保留默认 locale、大小写不敏感及稳定排序语义。
2. 加载时在文本宽度缓存内完成队列渲染，删除加载完成后的重复整区重绘；工具箱刷新、已加载页面切换也不再无条件重绘全部块。
3. Blockly 原生输入监听和多选插件在 Angular Zone 外注册，减少指针移动导致的 Angular 检查。
4. 纯位置移动且顶层生成顺序不变时，不重新生成代码；连接变化、顶层顺序变化、字段和变量变化仍失效缓存。折叠、inline 布局变化不重新生成代码。
5. Arduino `next` 链生成使用显式迭代，保留嵌套输入、注释、disabled/insertion marker、缺失生成器、null 返回、thisOnly 和值块优先级语义；异常路径用 finally 清理追踪栈。
6. 资源引用扫描、内联资源策略检查、项目块类型收集改为显式遍历栈，保留资源校验及错误诊断。
7. 组装页面保存数据时复用已克隆的块，移除一次重复深拷贝。

[Blockly 官方渲染说明](https://docs.blockly.com/guides/contribute/core/core-architecture/render-management/)描述了队列与批量渲染；宿主额外增加的全量复制、排序和重绘仍需要单独优化。

## 验证结果

环境：macOS、本机开发 Electron、同一项目副本、Minimap 开启。下面是单次采样，不是跨平台性能保证。

| 检查 | 结果 |
| --- | --- |
| 旧/新代码生成器，6000 块连续链 | 旧版稳定爆栈；新版完整生成 6000 行，顺序一致 |
| 原项目代码 | 新旧生成结果逐字一致，79131 字符 |
| 原项目块到代码映射 | 新旧全部映射 JSON 一致 |
| 原项目打开、整理、保存及再次打开副本 | 通过，工作区 2583 块；保存返回 success |
| 纯位置移动 | code revision 保持 2 → 2 |
| 原生鼠标拖动值块，改变连接 | revision 2 → 3，选择状态正常更新 |
| 原生双击编辑数字，按 Enter | 0 → 1，revision 3 → 4 |
| 撤销数字编辑 | 恢复为 0 |
| 上述交互阶段 pageerror | 0；测试结束后强制清理隔离进程产生的关闭事件不计入交互错误 |
| Blockly 专项单元测试 | 6/6 通过，含 12000 层数据扫描、循环引用、冲突引用与排序语义 |
| Agent 诊断测试 | 9/9 通过 |
| 宿主与 Agent TypeScript 检查 | 通过 |
| Angular 开发构建、两个仓库 diff --check | 通过 |

同一采样流程（导航至项目、等待块出现，再固定等待 5 秒）CPU 采样窗口由 **20.94 秒降至 12.05 秒**。这个数字包含固定等待及调度开销，不能直接作为纯加载耗时。打开/操作观测中的最长主线程任务由约 **5.42 秒降至 2.67 秒**。代码生成热运行约 35–37 ms；这个优化主要减少加载和编辑外围工作，并没有宣称代码生成提速。

Minimap 目前仍使用全量 XML 镜像，剩余的首次 SVG 渲染及小地图结构重建仍可能产生长任务。Windows 原故障机器、发布安装包及 ESP32P4 实际编译/上传尚未验收。需要将这些源码补丁纳入 Windows 版本后，在原机器重测保存、整理、预编译和上传。

## 本机证据与复测

- `test-results/blockly-large-workspace-20260916/measurements.json`：采样摘要、逐项操作结果、代码与映射对比、交互结果。
- `test-results/blockly-large-workspace-20260916/stack-comparison.json`：旧版异常栈、新版 6000 行校验。
- `test-results/blockly-large-workspace-20260916/workspace.png`：2583 块项目成功打开及保存画面。
- `test-results/blockly-large-workspace-20260916/interaction.png`：鼠标拖动、数字编辑及撤销后的画面。
- `/tmp/aily-large-workspace-investigation/*.cpuprofile`：完整 CPU profile，仅存本机临时目录。

```sh
# aily--blockly
node node_modules/@angular/cli/bin/ng.js test --watch=false --browsers=ChromeHeadless --include=src/app/editors/blockly-editor/utils/blockly-performance.spec.ts
node node_modules/typescript/bin/tsc -p tsconfig.app.json --noEmit --pretty false

# aily-lex-pro/packages/aily-agent
node --test test/build-dependency-diagnostics.test.mjs
pnpm typecheck
```
