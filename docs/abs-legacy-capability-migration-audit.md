# ABS 旧能力迁移审计与本轮实施记录

> 日期：2026-09-15；主线：[统一简洁语法落地方案](D:/codes/aily-blockly/docs/abs-unified-syntax-landing-plan.md)。
>
> 本清单保留历史迁移证据；当前状态以[原生执行主线第 20 节](D:/codes/aily-blockly/docs/abs-native-runtime-execution-plan.md)为准，历史简写与 README 格式的逐项结论见[一致性审计](D:/codes/aily-blockly/docs/abs-readme-syntax-closure-audit.md)。真实 LLM/正式编译仍引用第 16.6 节，不能把旧表中的“本轮/待迁移”直接当作当前状态。
>
> 语法基础批次仅修改主程序；后续声明批次同时修改主程序和 Agent。库仓库、用户工程保持只读；portable 状态以主线最新记录为准。

## 1. 先纠正问题定位

旧实现没有丢失“按定义顺序传参”的能力。

- [abs-parser.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-parser.ts) 的 `assignArguments` 已按 `argsOrder` 分配字段和值输入，保留交错顺序。
- [abi-abs-converter.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/abi-abs-converter.ts) 的块调用导出也已按 `argsOrder` 输出。这两处在当前 Git HEAD 中仍存在，不是本轮重新发明的规则。
- [block-definition.model.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/block-definition.model.ts) 的 `parseBlockDefinition` 已提取原始顺序，按数字排序全部 `argsN`。
- 新 generation 链路使用 `abs-syntax.ts`；此前生产候选准备没有接入声明形状的参数顺序。新导出也未消费同一顺序。因此“旧路径支持”不代表“新正式入口支持”。

修复方式是接回既有顺序来源，而不是重写第三套语法：声明形状直接消费 `parseBlockDefinition(...).argsOrder`，解析、规范导出、基线校验共用它。

两种“位置”必须区分：

- 函数调用参数位置：必须保留在 ABS 中，遵循实际 block 定义，不按字段/值输入重新分组。
- 图形坐标、块 ID、保护属性等编辑器状态：不写入 ABS。ABI 保留完整状态，map 关联原文范围、AST 槽路径和块身份；可信基线保存合同，map 的 `contractsHash` 绑定合同。没有新增 `@meta` 或第二套用户维护的元数据。

当前 core-variables 实际定义是 `VAR, TYPE, VALUE`，因此示例为 `variable_define("counter", int, math_number(7))`。如果一个块定义是 `NAME, VALUE, TYPE`，就应写成 `block("counter", math_number(7), int)`，不能以块名硬编码顺序。

## 2. 旧能力清单与迁移决策

“待迁移”表示尚未进入新 generation 链路，不表示旧源文件已删除。兼容写法应在可信上下文中归一为同一 AST，不能借兜底恢复猜槽、丢数据或重建全部 ABI 的行为。

| 能力 / 兜底 | 旧实现证据 | 新链路状态与处理 |
| --- | --- | --- |
| 原始参数交错顺序 | parser `assignArguments`；converter 的 `argsOrder` 循环 | **本轮接通**。声明元数据复用既有提取器；按基线冻结顺序，不采用 UI 展示顺序 |
| 已知具名参数与字段类型解析 | parser `parseTypedFieldValue`、字段定义解析 | 保留同一语言中的具名输入；拒绝重复绑定、具名后的额外位置参数和不合法字段值 |
| `$name` 选择变量字段 | parser 变量引用与模型解析 | **本轮接通**。引用绑定已有模型；字段不新增 getter 块 |
| 显式 `variables_get($name)` | parser 的普通块调用与变量参数解析 | **本轮接通**。规范输出保留显式 getter |
| 值输入中裸 `$name` 自动 getter | parser `parseValue` | **本轮接通**。仅在目标是 value 且 getter 合同明确时展开；先进入 AST，再匹配身份，不自动创建模型 |
| `$"显示名"` | parser 带引号变量引用 | **本轮接通**。支持特殊名字；字符串中的 `$` 不参与替换 |
| `$name:TYPE` 带类型引用 | parser 旧引用解析 | 待审计迁移。不得把 C++ dropdown 的 TYPE 当作 Blockly native model type；先解决普通声明闭环 |
| 单语句槽直接缩进 | parser `parseBody` 的默认槽分配 | **本轮接通有依据部分**。只有唯一已知 statement 槽可省略标记；不恢复“任选第一个槽” |
| 语句体内同级 next | parser 的块链构建 | **本轮接通**。同一已知语句体串联；顶层根仍独立，终结块后的语句不得丢失 |
| 同行命名值 `@VALUE: block()` | parser 命名输入解析 | **本轮接通**。槽种类必须明确；多槽仍接受准确命名 |
| 跨行参数、字符串、JSON | parser 词法合并、`parseFieldValue` | 复用新词法器；普通 JSON、大数据引用及引号保持数据语义。旧 `@json:` 字符串运输形式须另做需求/调用者审计 |
| `number(n)`、裸数字、裸字符串、`true/false`、`HIGH/LOW`、`var(...)` | parser `parseValue` 的别名与字面量分支 | **待迁移**。仅在输入类型和目标块合同明确时归一；当前先用真实值块，不能声称这些旧简写均已支持 |
| 可变缩进、无括号调用、未知表达式变文本 | parser 预处理、`parseValue` | 不整体照搬。当前四空格与括号规则保持；未知表达式不能靠猜测变成另一个程序 |
| 输入别名 `do/condition/setup` 等 | converter `normalizeInputNameForAbs`，parser 输入名大写化 | 待逐项对照。旧导出/解析并非全都互逆，例如 `condition → CONDITION` 不等于 `IF0`；新路径使用实际槽名 |
| controls_if / switch 的动态分支、函数参数及返回值 | converter 专用输出；parser mutator 推断 | 复用已有过程/函数合同；其余待具名协议迁移。不能仅凭参数个数推断任意 mutator 或删除多余实参 |
| `EXTRA_n`、`FIELDn`、`INPUTn` 和按字段名猜角色 | parser `smartAssignArguments`、`getBlockMeta`、额外参数归配 | 不恢复猜测。已知声明不足时明确拒绝，不把错误数据塞入伪字段 |
| 无元数据时“字段先、值输入后” | parser / converter 的无 `argsOrder` 回退 | 不作为通用规则迁移。有可信顺序用位置参数，没有则具名；不能假称符合原定义 |
| 运行时查询块形状 | `abs-live-block-shape.ts`，旧元数据查询入口 | 保留仅查询既有实例的隔离边界；不恢复执行库 init 的临时探测块。JS-only 新块无声明时仍可能缺能力 |
| 引用隐式创建变量、`@var` | parser / converter 的模型收集 | 不从引用拼写猜模型。**后续批次已实现**经验证普通全局声明的模型准备；`@var` 不进入普通流程 |
| 禁用、影子、extraState 与身份 | 旧 converter 的过滤/重建行为；新 reconciler / readback | 保留新链路的完整状态与保护校验；不恢复过滤禁用块、丢隐藏 shadow 或重建 ID/坐标 |

上表覆盖本次读取的主程序 parser/converter 的主要兜底类别，不等于任意库的动态行为已审计。Agent 复制实现仍需阶段 B 的完整调用者核对。

## 3. 本轮实际改动

### 3.1 一份顺序，两端消费

- `AbsArgumentDefinition` 直接引用既有 `BlockMeta.argsOrder` 元素类型，消除平行类型定义。
- `abs-declarative-contracts.ts` 继续负责形状、默认值和字段合法性，顺序交给已有 `parseBlockDefinition`，不再复制排序循环。
- `abs-runtime-contracts.ts` 捕获可信原始声明顺序到实例合同。不是从渲染后的 `inputList` 反推定义顺序。
- `abs-syntax-contracts.ts` 只做合同选取：同类型所有已捕获实例一致才允许共用位置顺序；缺失/冲突不借用另一个动态实例。
- `abs-workspace-sync.service.ts` 把同一形状目录的顺序和字段定义交给正式 prepare；`abs-reconciler.ts` 在候选中保留新块的语法合同。
- `abs-renderer.ts` 从 identity-map 提取规范输出职责，导出和 map 共用节点路径，不另写一套身份分配器。

### 3.2 变量语义与来源范围

词法器保留引用 token 的类型与原文范围。字段绑定先验证引用语义，再执行“值未变”的快速路径，避免把普通文本替换为非法变量引用时绕过校验。

裸引用值输入生成的 getter 与显式 getter 都参与原有身份合并。测试反复切换两种写法并导出再读取，验证变量字段不多生块、getter ID 不变、不会每轮新增一个 getter。空 value 的 `null` 只渲染一次，不再同时输出重复的命名输入段。

### 3.3 旧 map 的安全升级

内部投影版本由 `abs-v2.preview.3` 推进至 `abs-v2.preview.4`；公开 ABS Schema 2、Map Schema 1、Project Data Schema 1 不变。

- 正常 load / validate / apply / 新提交只接受当前投影。
- 旧 `.3` 仅在 inspect 和恢复路径中按旧格式严格重建、核对原始 ABS/map；未知版本和篡改不能升级。
- 复用现有 inspect → rebind token → export-only 事务。仅在无待恢复事务、ABS 未修改、保存 ABI 存在且上下文检查通过时重新导出。
- 升级不加载候选、不运行代码生成、不保存 ABI，不删除旧不可变记录；旧 pending 先按字节与 CAS 恢复，再重新 inspect。
- 历史格式只用于校验，不提供可选的旧格式导出模式，也不回接旧有损转换器。

### 3.4 清理边界

已删除旧 parser 中确认无调用的 `isShadowBlockType` 私有方法和未使用的 `commonInputNames`；没有按“旧文件”标签批量删除仍有消费者的代码。

## 4. 调用链审计与剩余缺口

| 入口 | 已确认情况 | 下一步 |
| --- | --- | --- |
| `AbsGenerationToolsService → AbsWorkspaceSyncService → prepare/reconcile` | 本轮正式工具集成测试覆盖 validate/apply/export 和第二次编辑 | 增加普通声明模型推导后，用真实 LLM 验证无需外层模型清单 |
| 主程序 `AbsAutoSyncService` / `prepareAbsCandidate` | 已移除；没有正式调用者，关键隔离/回滚场景迁入现行协调器测试 | 不恢复平行写入服务 |
| `BlocklyService` 选中块上下文 | 已改为读取正式提交的 ABS/map 来源范围，绑定 generation 和完整项目 revision | 陈旧、占用、重开或无映射时明确提示重新导出；不再猜测行号 |
| Agent `abs-core` | `abs-argument-parser.ts` / `abi-block-call.ts` 同样存在旧顺序循环；后续批次已修复 `block-meta.ts` 的 args10 截断，并修复宿主 capability 转签名的 fields-first 重排 | 正式入口已确认走 live 宿主；剩余离线/恢复消费者继续隔离，不整体删除 |
| Agent `services/abs/conversion.ts` | 同时有离线转换和 live-first 宿主入口；live-first 缺宿主返回 `ABS_HOST_REQUIRED`，不偷偷降级 | 继续追踪 import/recovery 和实际 registry，确认正式工具无旧写入路径 |
| 实际 embedded Chat / portable | 已有真实 LLM/编译闭环；源码输入、产物清单及执行 JS 代次校验已接入 | 最新构建和页面证据见执行方案第 11 节 |

此前阻止最小普通变量任务的根因是：生成器在生成期间创建模型，候选准备没有推导相同模型，导致完整读回出现额外模型。后续已在生成前确定性准备，并通过真实 LLM 两轮编辑、正式编译与重开验证；未放宽读回检查。不应再让 Agent 猜 `$`/引号写法。

## 5. 验证记录

本轮最终验证命令与结果：

| 验证 | 结果 / 证据 |
| --- | --- |
| `ng test --configuration=abs-sync --watch=false --browsers=ChromeHeadless --progress=false` | **553 项通过**；`.tmp-abs-unified-final.log` |
| `ng test --configuration=abs-project-load --watch=false --browsers=ChromeHeadless --progress=false` | **9 项通过**；`.tmp-abs-unified-load.log` |
| `tsc --noEmit -p tsconfig.app.json` | 退出码 0；`.tmp-abs-unified-types.log` |
| `ng build --configuration=development --preserve-symlinks=false --progress=false` | 退出码 0，Angular 构建成功；`.tmp-abs-unified-build.log`。参数用于本地链接依赖，不修改项目配置 |
| `node scripts/check-angular-service-architecture.mjs` | **未通过**，退出码 1。报告 `user-center/credit-contract.spec.ts` 三处、`credit-display.ts` 一处跨层深层导入，0 个环；均不在本轮 ABS 修改范围，未改动这些文件。见 `.tmp-abs-unified-architecture.log` |

关键新增证据：

- [abs-unified-syntax.spec.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-unified-syntax.spec.ts)：与旧 parser/converter 交叉核对顺序，真实 Blockly 定义的 `NAME, VALUE, TYPE`，数值排序 argsN、单槽/多槽、变量引用、空输入、合同冲突与 map 篡改。
- [abs-workspace-sync.service.spec.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-workspace-sync.service.spec.ts)：实际 generation 工具路径 validate/apply/export、二次修改、ID 和 `deletable:false`；显式旧投影重新导出不写 ABI。
- [abs-projection-upgrade.spec.ts](D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-projection-upgrade.spec.ts)：独立旧格式夹具、旧 map 原字节验证、编辑冲突、pending 恢复、未知版本及篡改拒绝。

已有符号测试中六处旧的具名/引号格式断言已更新为当前规范输出；引用重定向、缺失、歧义、类型和身份检查继续保留，不通过移除功能断言使测试变绿。

这些是 ChromeHeadless 中的真实 Blockly 与宿主服务集成测试，不是实际 Electron Chat 的 LLM 自主会话。本轮没有正式 C++ 编译、设备运行或用户原工程重开证据。

## 6. 下一步顺序

1. 已完成普通全局声明意图及其反例/真实工具闭环；不再改造位置参数规则。
2. Agent 规则及实际 portable 已统一；普通变量与真实动画副本各完成两轮真实 LLM 编辑/正式编译及保存重开。最新证据见[执行方案第 10 节](D:/codes/aily-blockly/docs/abs-unified-syntax-landing-plan.md)。不再将这些场景标为尚未运行。
3. 产品级构建输入/后端 JS 摘要门槛、实际旧消费者和启动拒绝处理已实施；验收以执行方案第 11 节为准，不重复改动普通声明与参数顺序。
4. 按本清单逐类补充有依据的字面量/别名和动态形状兜底，不把任意库全覆盖作为核心闭环的前置条件。

## 7. 真实会话后的补充审计（2026-09-15）

- `project_status` 只统计旧顶层 blocks/variables，曾向 LLM 报告“实际 4 块却为 0”。已复用既有计数模块覆盖分页所有者、共享定义和共享变量；不遍历 opaque 数据，不创建模型，不写项目。损坏/未知状态明确报告，不伪装为空工程。新 portable 中真实动画会话已验证 9 块、2 个变量。
- 交付规则原先无条件要求 blocks_tidy；已改为布局操作按需执行，字段小改不整理布局，正式编译在最后一次修改之后。新动画会话两轮均未调用 tidy，完整布局/身份保持。
- 主回归本批重跑 **565 项通过**；Agent ABS/分页状态 **66 项通过**；验收守卫 **5 项通过**。四轮 LLM 编辑、四次正式 ESP32 编译都成功，源工程及库未修改。
- 旧主程序 converter 仍被 `_getBlockAbsSnippet` 和空缓存行号回退使用，不能按“看似旧文件”整体删除；应改为消费当前规范投影及绑定范围，避免选中块上下文重新引入旧语法。`AbsAutoSyncService` / `prepareAbsCandidate` 当前仅有旧专项测试直接依赖，删除前需保留有价值的租约/回滚覆盖；Agent abs-core 另有元数据、受限离线初始化与恢复消费者。
- 动画测试启动时捕获一次连接断开导致的未处理 Promise，之后恢复且编辑/编译/重开无错误。详见执行记录，仍需在构建结束后独立复现；本批不把它隐去，也不按 Project Data 损坏处理。

## 8. 收敛清理结果（2026-09-15）

第 7 节是前批次快照，以下覆盖其中的待办状态：

- 已删除旧主程序同步服务、候选准备器和 60 项专属旧路径测试；新增/迁移 10 项上下文与协调器用例，现行主回归 515 项全部通过。队列隔离、编辑锁、board 配置失效、跨页预检、分块期间保存顺序均在正式入口测试，不再通过维护死服务来测试。
- `AbsBlockContextIndex` 是只读来源范围索引，不是第三个 renderer。BlocklyService 的旧 converter import、片段转换、父块行号猜测和 `absBlockLineMap` 均已清除。大值限制、generation 标签和跨页/runtime/revision 失效检查不改变 ABS 语法。
- 旧 converter/parser 仍用于历史比较测试/旧资料，Agent 旧解析器仍用于元数据和受限恢复；它们不是当前正式工程写入入口。当前正式写入唯一链仍为 generation tools → workspace coordinator → prepare/readback/commit。
- 构建输入封存、产物清单、执行 JS 内嵌代次、链接源码前置检查及实际服务 health 证据均已实现。拒绝源码/产物/执行代码不一致，不能仅凭最新 README 或磁盘清单声称后端已更新。
- 未处理拒绝定位在目录刷新中的四个并行读取未及时监听，而非 ABS/ABI 转换。修复后确定性断线测试通过；真实 Electron 结果汇总在执行方案第 11 节。
- 公开 ABS Schema 2、Map Schema 1、Project Data Schema 1 和 `$变量`/位置顺序语义不变；库、原工程继续只读。历史字面量/任意动态块兜底仍按第 2 节独立排期，不作为核心功能未落地的泛化理由。

## 9. 常用动态结构与值简写状态更新

后续字段驱动结构和 UI 分类的最新范围以第 10 节及主线第 14 节为准；本节保留上一批验收快照。

本节覆盖第 2 节对应旧状态：number(n)、var("name")、值槽裸数字/引号文本/true/false/HIGH/LOW 已接通有目标合同的归一化；普通字段字面量不转换。主程序五类结构 mutator 已接入共享规则，支持新建、配置变形和每实例参数顺序；if/switch 不再统一标为 preserve-only。generator 通过标准 JSON API 注册的声明也进入原目录。详见主线第 13 节。

仍未迁移的是无依据输入别名、带类型变量引用等其他历史拼写，以及未提供可准备结构的任意 JS-only init/模型副作用；猜 INPUT0/EXTRA_n、静默丢输入等旧缺陷不会恢复。不得把这些剩余项重新概括成“所有动态块都未适配”。

本批最终验证：主程序 539 项、Agent 98 项通过；真实 Electron + 实际 Agent 工具两轮创建/变形后，19 块、3 个受保护入口、代码及三文件保存重开一致，无页面错误。布尔大小写按已有字段解析器处理；实例 extraState 按 canonical JSON 比较，键重排不改变参数顺序。完整证据和本地依赖/并行构建干扰的处理见主线第 13.4 节。

## 10. 字段驱动结构与 UI 效果分类

43 库/116 个 extension 或 mutator 声明已盘点，数量不代表失败数。新增原生可整除/字符索引的字段条件输入准备，以及只读 tooltip、公共可见性机制的静态效果识别。规则按真实注册机制复用，不写库、不执行探针；同类型字段配置不混用顺序，原生 XML 冗余状态按实际 serializer 推导并完整回读。Agent 新增 `field-shape-v1` 能力，ABS/Map/Project Data 版本与变量规则不变。

主回归 547 项、Agent 99 项通过；真实页证据见主线第 14.3 节。下一批优先子串双 selector / 自定义 I2C 地址的纯结构证明，再独立处理硬件模型、端口配置、延迟自动子块及保存副作用。不要继续把这些具体缺口写成“所有动态块未适配”或直接放开全部 extension。

## 11. 库内条件结构与 shadow 状态更新

第 10 节中子串双 selector、自定义 I2C 地址输入的待办已完成，详见主线第 15 节。正常 Realm 注册观察获取实际 callback/mixin/helper 身份，有限完整 AST 证明后复用 field-shape-v1；dummy 锚点从原声明解析，保留交错顺序及精确原生 XML 命名空间。名称替换不能改变证据，额外副作用及依赖覆盖则使证据失效。

同步修复动态槽删除时的隐藏 shadow，以及无活动实例的 dormant shadow 干扰可见调用顺序。未放松完整 ABI/模型校验。主回归 556 项、Agent 100 项通过；两端构建通过。剩余为共享模型、全局配置、自动子块、保存副作用及新组合的 LLM/固件/硬件验收，不再将已完成的两个纯结构机制重复排期。

收尾增加注册装饰器反例并修复 Extensions API 方法表的跨项目恢复遗漏，最终主回归 **557 项通过**。等待所有构建/测试结束后，真实 Electron + 实际 Agent 三轮编辑、13 块/3 个保护入口、C++ 与三文件保存重开通过，errors=[]；完整证据与初始化/发现阶段失败记录见主线第 15.4 节。
