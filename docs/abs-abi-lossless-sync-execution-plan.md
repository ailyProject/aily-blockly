# ABS / ABI 简洁投影、身份映射与无损同步执行方案

> 日期：2026-09-15
>
> 状态：第二十七批真实 LLM 验收失败，未进入编译。本文件转为历史设计与验收档案；后续实施主线统一为 [ABS 统一简洁语法与无损同步落地方案](D:/codes/aily-blockly/docs/abs-unified-syntax-landing-plan.md)。已实现的身份/资源/回滚机制保留；不能将此前 710 项专项回归等同于实际 Agent 可用。第 41 节保留失败证据，不再以新增动态合同批次替代落地验收。
>
> 本次修订：取消逐块 @meta 和文件级 @workspace；采用“简洁 ABS + 完整 ABI 基线 + 宿主管理的独立身份映射”。
>
> 适用仓库：D:\codes\aily-blockly，当前分支 i3w-sim。
>
> 约束：aily-blockly-libraries 保持只读；由 Blockly 主程序统一适配字段、块状态和 Project Data。

## 1. 目标与范围

使“Blockly → ABI 基线与 ABS 投影 → 编辑 ABS → 合并回 ABI → Blockly”成为可验证的数据往返流程。这里的“无损”依赖匹配的基线和身份上下文，不承诺仅凭一个脱离项目的 ABS 文件恢复所有 Blockly 状态：

1. 保存并恢复块身份、删除保护、编辑属性、禁用状态及自定义状态。
2. 正确解释各字段的真实类型与合法值，不悄悄回退到默认值。
3. 所有 ABS 导入导出入口使用相同的 Project Data 外置、校验与还原规则。
4. 导入失败不得留下半加载工作区；旧项目或旧页面的异步操作不得提交到新上下文。
5. 为解析、持久化、Agent 操作及切片装载建立同一套验收标准。

本轮不修改音频库、底层播放队列或 on_finished 事件实现，也不要求库包新增配置或 i18n。相关音频业务问题以生成的 C++ 参数正确为平台验收边界，板端队列和完成事件另行验证。

本方案以当前 src/app/integrations/blockly/abs 下的生产入口为准。2026-08-04 文档中已经完成的旧路径不代表重构后的新入口仍然满足相同约束。

参考：

- [用户提供的音频问题分析](</D:/LENOVO/Documents/xwechat_files/wxid_2w2tco4xs3dl21_b5b9/msg/file/2026-09/ISSUE_ANALYSIS_MODE_QUEUE(1).md>)
- [已有通用 Project Data 方案](/D:/codes/aily-blockly/docs/project-data-generic-large-values-runtime-isolation-fix.md)
- [Generator Runtime 项目隔离方案](/D:/codes/aily-blockly/docs/blockly-generator-runtime-isolation-design.md)

## 2. 已确认问题及证据

### 2.1 运行时复现结果

以下结果来自当前转换器源码、仓库内真实 core-loop / chipIntelli_Audio 块定义、当前安装的 Blockly，以及音频 generator 的隔离调用。复现过程只读取项目及库文件，没有改写用户工程，也没有进行开发板音频测试。

| 编号 | 输入或动作 | 当前结果 | 修复要求 |
| --- | --- | --- | --- |
| F01 | 三个 Arduino 根块携带 deletable:false，往返 ABI/ABS | 属性丢失，加载后全部 isDeletable() 为 true | 属性与稳定 ID 往返保留 |
| F02 | 新 ABS 省略一个原先不可删除的根块 | workspace.clear() 清除旧块，导入成功后该块不存在 | 修改工作区前识别并拒绝未授权删除 |
| F03 | ABS 播放模式使用裸 false | 解析为 "FALSE"，下拉框拒绝，保留默认 "true"，生成打断播放 | 根据实际下拉选项解析并验证 |
| F04 | ABS 使用带引号的 "false"，然后再次导出 | 首次导入正确，导出移除引号，下一轮解析再次出错 | 字符串导出保留类型，不依赖人工引号补丁 |
| F05 | ABS 指定不存在的下拉值 | converter 返回成功且无 warnings；字段回退到默认值 | 非法字段值成为明确失败 |
| F06 | 块包含 movable、editable、collapsed、inline、data、icons | 往返丢失；ID 和坐标被重新生成 | 保留序列化状态 |
| F07 | 块包含 disabledReasons | 被导出器过滤，往返后可能整块消失 | 持久化 ABS 包含禁用块 |
| F08 | includeBlockIds:true 导出 ID 注释 | 示例行不能被当前解析器正确解析 | 身份由独立映射维护，普通注释不承载身份 |
| F09 | 40 KiB 普通字符串从当前 ABS 入口导出 | oversized inline field value 错误 | 转换前统一外置 |
| F10 | 通用 Project Data Envelope 直接导入普通文本字段 | 字段变成 "[object Object]" | 字段加载前还原原始值 |

### 2.2 根因对应代码

| 位置 | 当前缺口 |
| --- | --- |
| [abi-abs-converter.ts](/D:/codes/aily-blockly/src/app/integrations/blockly/abs/abi-abs-converter.ts:281) | 仅输出块调用、extraState 和可选调试 ID 注释；未承载完整块属性 |
| [abi-abs-converter.ts](/D:/codes/aily-blockly/src/app/integrations/blockly/abs/abi-abs-converter.ts:1223) | BlockConfig 转 ABI 时新建 ID/坐标，未透传块属性 |
| [abs-parser.ts](/D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-parser.ts:1168) | 无字段上下文地将 true/false 规范化为大写字符串 |
| [block-config.ts](/D:/codes/aily-blockly/src/app/integrations/blockly/abs/block-config.ts) | 中间结构缺少删除保护等状态 |
| [abs-auto-sync.service.ts](/D:/codes/aily-blockly/src/app/integrations/blockly/abs/abs-auto-sync.service.ts:257) | 直接转换并清空、装载工作区；未检查保护块；缺少通用 Project Data 边界和字段读回校验 |
| [blockly-live-operation-bridge.service.ts](/D:/codes/aily-blockly/src/app/services/integrations/automation/blockly-live-operation-bridge.service.ts:498) | ABS 写入与后续项目保存分开完成，失败状态不统一 |

deletable:false 是 Blockly 编辑交互属性，不是 workspace.clear()/dispose() 的访问控制。仅透传该属性能解决“导入后可以手动删除”，不能单独解决“ABS 省略块后被整体替换删除”。

### 2.3 方案编制时补充发现的边界

- 项目已有 pages / sharedModel，当前同步入口主要操作活动工作区。新实现必须明确页面范围，不能把单页 ABS 当作完整多页项目覆盖。
- project-data-abs.ts 的资源扫描仍只识别字符串形式的 "@json:"，而当前 converter 已输出原生 JSON 字面量。两者存在格式不一致；资源打包、校验和 GC 接入必须一并审计，不将此静态发现描述为已发生的资源删除事故。
- 当前同步接口包含绕过 isSyncing 的 forceImportFromAbs；加入异步资源处理后必须改为排队，不能继续解锁后并发导入。

## 3. 总体决策

| 决策 | 本轮选择 |
| --- | --- |
| ABS 定位 | 面向用户与 Agent 的可编辑代码投影，包含影响程序理解的语义，不承载完整 UI 状态 |
| ABI 定位 | 完整项目状态载体；身份、布局、保护属性和未显式修改的附加状态从可信 ABI 基线继承 |
| 块身份 | 宿主管理 project.abs.map.json，关联原始 ABS 节点与 ABI blockId；不要求 Agent 维护 ID |
| 格式版本 | ABS Schema 2、ABS Map Schema 1、Project Data Schema 1 分别版本化 |
| 导入方式 | 解析变化并合并可信基线；禁止将新解析结果直接作为全新工作区覆盖旧项目 |
| 无法确定身份 | 返回冲突，保留输入与原项目；不按行号、同类型或相似度强行认领 |
| 字段值 | JSON 字符串保持引号；根据字段定义处理布尔、数字、枚举、变量和自定义状态 |
| 大值存储 | 继续使用已有 AilyDataRef / AilyProjectDataValue，不另建一套资源文件协议 |
| 删除保护 | 由可信项目基线及当前工作区校验，ABS 和 map 都不能提供解锁权限 |
| 同步入口 | 由产品侧统一异步协调器处理；Agent、手动导入、恢复、切片装载调用同一路径 |
| 持久化顺序 | 资源和恢复记录就绪 → 校验后的 ABI 提交 → 同 generation 的 ABS/map 发布 |
| 兼容策略 | 不维持两套长期生产格式；已有内部工程从可信 ABI 重新导出 v2 |
| 库适配 | 不按库名、块类型或字段名建立生产修复白名单 |

### 3.1 为什么选择独立映射，而不是外置全部 meta

| 方案 | 结论 |
| --- | --- |
| 每块内联完整 @meta | 不采用：代码噪声大，Agent 需要维护与业务修改无关的状态 |
| 把全部属性复制到 project.abs.meta.json | 不采用：与 ABI 形成两份可变状态，需要额外解决谁覆盖谁 |
| 只凭修改后 ABS 和当前 ABI 猜测身份 | 不采用：缺少修改前文本，重复块、移动和删除无法可靠识别 |
| ABI 保存完整状态，sidecar 只索引身份和基线 | 采用：分离代码编辑和状态维护；将歧义显式暴露 |

map 是可校验、可重建的索引，不是第二份 Blockly 状态，也不是安全凭证。哈希用于识别版本与损坏，不能证明调用者有权修改保护属性。

### 3.2 三种操作模式，不得混用

1. 项目内编辑：必须提供匹配的原始 ABS、ABI 基线和身份映射，执行无歧义合并。
2. 从 ABI 重建投影：用于首次打开或镜像恢复。仅在没有待应用 ABS 编辑，或用户明确选择舍弃该编辑时执行。
3. 独立 ABS 导入：只能新建文档，或作为显式插入操作生成新身份。没有基线时不保证原布局、保护和隐藏状态；不能作为项目内合并失败后的自动降级路径。

活动工作区是当前编辑状态，磁盘 project.abi 是已保存状态，两者可以暂时不同。生成 ABS/map 不应顺便保存用户尚未保存的工程。

## 4. 文件职责、格式与身份合并

### 4.1 文件职责和基线生命周期

| 文件或记录 | 内容 | 维护方 |
| --- | --- | --- |
| project.abs | 可读代码、字段、连接、必要语义注解、Project Data 引用 | 用户/Agent 编辑；宿主在成功同步后规范导出 |
| project.abi | 完整已保存项目，包括多页、共享模型、全部序列化属性 | 项目保存服务 |
| project.abs.map.json | generation、页面范围、基线引用、内容哈希、节点到 blockId 的索引 | 同步协调器；不要求用户/Agent 编辑 |
| 不可变同步基线 | 完整项目/目标页 ABI、原始 ABS 字节及投影使用的字段契约/模型表路径，可由 baselineRef 读取 | 宿主快照存储；仅用于本次同步与恢复 |
| 既有 Project Data 文件 | 大文本、数组、图片等资源本体 | 现有 Project Data 服务 |

基线必须保留实际内容，不能只存 baseAbiHash/baseAbsHash。导出来源可能含未保存编辑，所以不能始终拿磁盘 project.abi 充当导出时基线。

- baselineRef 指向宿主管理的不可变快照；优先复用现有项目快照/文件事务能力，通过存储端口接入，不让 Project Data domain 依赖 Chat 服务。
- 如需本地落盘，限定在项目内 .aily/abs-sync/ 的同步缓存区，按 generation 存储；只保留当前基线、待提交/恢复记录及仍被操作引用的旧基线，不新建一套用户版本历史。
- 快照采用 external-only ABI，引用同一批 Project Data，不复制已解码的大值；不同 generation 可复用相同内容哈希的快照。
- 新 generation 发布成功且旧操作释放后，才释放旧基线及其资源 pin。存在未应用 ABS 编辑、恢复任务或历史引用时不得提前清理。
- 文件名和 baselineRef 由宿主解析；不得接受 ABS/map 提供的任意外部路径或跨项目资源访问。

### 4.2 简洁 ABS Schema 2

示例仍保持接近现有代码形式：

~~~text
# ABS Schema: 2
# Project Data Schema: 1 (external-only)

arduino_global()
arduino_setup()
arduino_loop()
~~~

不输出逐块 @meta、ID 注释、坐标、deletable、movable、editable、collapsed、inline，也不输出文件级 @workspace JSON。页面范围由 map 与调用方上下文共同绑定。

| 状态 | ABS 中的表达 | 合并规则 |
| --- | --- | --- |
| type、fields、可见连接 | 块调用、具名参数、命名输入和 @next 子段 | 按解析后的明确变化更新 |
| ID、布局、编辑/删除保护、data/icons、工作区附加状态 | 不输出 | 匹配块从 ABI 继承；未涉及工作区状态保持不变 |
| extraState / mutator 状态 | 必要时保留 @extra JSON；大值外置 | 按字段/块序列化契约处理，不能根据 Id/Ids 键名删数据 |
| 禁用状态 | 禁用块照常输出，附简短 @disabled 标记 | 保留基线 disabledReasons，不隐藏整棵子树 |
| 被真实块遮挡的 fallback shadow | 不重复输出整棵 ABI 子树 | 由基线保留；仅明确改变对应连接时按连接规则处理 |
| 变量和共享过程身份 | 可读引用；身份索引在 map，完整定义在 ABI | 不按名称重建所有 ID；重名歧义报错 |

具体语法边界：

1. 规范导出使用具名参数，例如 MODE="false"；保留字段名大小写。非标识符字段/输入名使用 JSON 引号，如 "arg-id/😀"="参数"、@"slot name":，不丢弃 mutator 动态名称。手写位置参数仅在定义能唯一映射时接受。
2. 根级每条非缩进行是独立根块；根的 next 链使用命名 @next: 子段，避免把相邻根块误连。
3. @extra 保留原始 JSON 类型；已有块省略该注解时继承基线，显式修改时根据实际 loadExtraState/saveExtraState 契约验证。清空状态必须使用该契约允许的显式值，不能把“没写”当作“删除”。
4. @disabled 是可见状态标记，不包含内部原因列表。本轮不通过删除标记隐式启用块；改变禁用状态走宿主显式状态操作，单纯修改标记返回 ABS_STATE_EDIT_REQUIRES_HOST。
5. 若一个 input 同时有 block 和 shadow，编辑 block 不删除 shadow；移除 block 后恢复 fallback。移除 input 必须由明确的结构变化支持。新增块的默认 shadow 由实际块定义及装载契约提供，不能凭文本伪造旧 shadow 身份。
6. 无法通过 ABS 表达的隐藏状态可由按节点查询的宿主接口读取、按明确操作修改；必要时返回“不支持”，不静默删除。不能借此隐藏程序生效所必需的语义。
7. 使用词法扫描器识别嵌套 JSON、字符串转义及普通行尾注释，不再以行尾正则切割注解。
8. 手写字段可用单引号字符串，支持 JSON 转义及转义单引号；非法转义、裸控制字符和未闭合字符串拒绝。不支持 JavaScript 求值、模板插值或额外的十六进制转义；规范导出仍为双引号 JSON，@extra 仍必须是合法 JSON。

### 4.3 身份映射的最小契约

以下为计划新增的核心类型。摘要统一使用 SHA-256：ABI/语义指纹采用版本化的规范化 JSON，ABS 内容采用原始 UTF-8 字节；哈希规则版本随 projectionVersion 固化。不能将 JSON 键顺序变化误判为状态变化，也不能将不同 ABS 字节内容当作同一编辑输入。

~~~typescript
interface AbsIdentityMap {
  schemaVersion: 1;
  absSchemaVersion: 2;
  generation: string;
  scope: { projectKey: string; pageId: string };
  baselineRef: string;
  baseAbiHash: string;        // 导出时完整项目快照，不等同于磁盘 ABI
  pageAbiHash: string;        // 经宿主 compose 后的目标页状态，独立验证页面投影
  savedAbiHash: string | null; // 导出时磁盘 ABI；null 表示尚无该文件
  baseAbsHash: string;        // 原始 ABS 的 UTF-8 字节哈希
  contractsHash: string;      // 不可变投影契约的规范化 JSON 哈希
  projectionVersion: string; // 固定解析/渲染规则
  nodes: AbsNodeBinding[];
  symbols: AbsSymbolBinding[];
}

interface AbsNodeBinding {
  nodeKey: string;            // 仅在该 generation 内唯一
  blockId: string;
  blockType: string;
  astPath: string;            // 原 AST 的父节点/输入槽/序号，不是永久身份
  start: number;              // 原始文本 UTF-16 偏移，含内联值节点
  end: number;
  fingerprint: string;        // 规范化语义指纹，用于候选匹配而非充当 ID
}

interface AbsSymbolBinding {
  nodeKey: string;
  astPath: string;            // 该节点中的引用位置
  kind: 'variable' | 'procedure';
  modelId: string;            // 指向 ABI 中的模型，不复制其可变属性
}
~~~

- map 不包含 deletable、坐标、fields、data、icons 或 extraState 副本；这些属性只从 ABI 读取。
- 符号字段输出普通具名字符串，例如 TARGET="计数"；是否是模型引用由实际字段契约决定，不新增逐字段 meta、ID 或 `$`/`&` 语法。普通 JSON 的 id/name 属性不构成引用证据。
- 基线 contracts 保存按 blockId 捕获的字段契约，以及宿主声明的模型表 JSON Pointer；模型名称、类型及定义仍只从 ABI 查找。map 只记录 contractsHash 和引用到 modelId 的绑定，不再复制模型目录。
- 过程的 extraState 也可声明名称、参数名及参数变量 ID 路径。定义节点的稳定 blockId 是旧式过程身份；调用签名必须与已存在定义一致。只校验和索引明确的序列化位置，不遍历任意 Id 后缀键。
- 原生变量使用 composed workspace.variables；其他模型表通过 kind/source/path/idPath/namePath/typePath 显式描述。相同显示名未编辑时保留已证明的 ID；更换引用必须唯一匹配类型约束；模型新建/重命名属于宿主操作，不由引用拼写隐式触发。
- 未投影的 fallback shadow 和工作区状态无需虚构 ABS 行号，随基线及父连接保存。所有实际块 ID 仍须在候选 ABI 全树内校验。
- 单纯行号不足以区分一行内多个值块。偏移针对保存的原始 ABS，CRLF/LF 变化先做受控位置映射；字节哈希不擅自忽略换行变化。
- 载入 map 后用基线重新校验节点范围、AST 路径、类型及 blockId 关联。被手动改写的映射不作为可信输入；禁止跨 generation 拼接节点。
- 同一快照只序列化/扫描一次，按完整项目 revision 和内容哈希复用结果。节点指纹自底向上计算，map 不嵌套复制子树全文；禁止为每个节点重新遍历整份 ABI 或重新解码大资源。

### 4.4 修改后文本的身份恢复与 ABI 合并

解析器输出 ABS AST；身份恢复器单独输出保留、更新、移动、新建、删除、冲突的 ReconcilePlan。只有计划无歧义并通过策略检查后，才能构造候选 ABI。不得让解析器“顺便”分配全部新 ID。

匹配顺序：

1. 未修改文本：验证哈希后直接复用基线映射，仍执行必要的状态/资源校验。
2. 宿主可验证的编辑记录：利用带 generation、修改前后哈希及原始范围的实际编辑记录追踪节点。移动/复制只有在操作明确记录时才能据此区分；Agent 自报的 nodeKey 不是凭证。
3. 只有最终文本：对原始 AST 与新 AST 做结构差异分析，以已确认父节点、输入槽、未变邻接节点和语义指纹缩小候选集。只有唯一且满足连接约束的对应关系才认领旧身份。
4. 重复节点、整段重写、跨父级移动后仍存在多个合法对应时，返回 ABS_IDENTITY_AMBIGUOUS。不得用“同一行”“第一个同类型”或最高相似度打破平局。

例如原有两个相同的 delay(1000)，其中一个不可删除；修改后只剩一个。从最终文本不能证明删的是哪一个，必须停止应用并给出两个候选的位置与状态，要求通过宿主的明确节点操作消歧。

构造候选时，以完整基线文档为起点：

- 匹配节点只应用显式字段/连接/语义变化，保留 ID、属性和未涉及状态；false 按属性存在性保留，不能用真值判断丢弃。
- 明确的新建节点只分配一次新 ID；明确复制生成新身份，内部变量/过程等引用按各自契约重映射，不能遍历所有 Id 后缀键猜测替换。
- 唯一确认的移动保留身份和状态；不能把移动一律实现为删除再创建。
- 普通块类型替换按删除旧块、新建新块处理；受保护块类型替换拒绝，不把同类型新块认作保护块替身。
- 原根块坐标保留，新根块才布局；根/子块角色改变时按 Blockly 坐标序列化规则处理。
- 未表达的工作区状态从 ABI 原样继承；当前 serializer 无法恢复时返回不支持诊断，不删掉以后继续。

第一版只实现“基线未发生并发变化时的确定性合并”。不同时引入通用三方自动合并、跨工程身份推断或全量 AST 最优匹配。工作区或磁盘 ABI 已变化时返回 ABS_BASELINE_STALE，保留输入供重新对照；不能按过期基线覆盖新状态。

## 5. 按真实字段定义解析和验证

### 5.1 保留词法类型

解析字段时保留原始 token、是否带引号、JSON 类型、块类型、字段名、行列位置，然后交给字段语义层。

新增纯函数模块 abs-field-values.ts；解析器不再直接对所有字段执行 true/false 大写转换。导出器不再根据 MODE、STATE 等常见名称猜测是否可以去掉引号。

| 字段类型 | 输入处理 | 规范导出 | 校验 |
| --- | --- | --- | --- |
| 普通文本/多行文本 | 字符串原样解码；不改变大小写、前导零 | JSON 双引号字符串 | 以字段持久化值比对 |
| field_dropdown | 匹配选项的实际 value，而非显示文案 | 选项 value 按实际类型输出，通常为带引号字符串 | 无合法匹配则失败 |
| field_checkbox | 仅该字段接受布尔形式与约定的 TRUE/FALSE 表示 | 以实际 Field.saveState() 契约规范化 | 不传播到其他下拉字段 |
| 标准逻辑下拉 | 按定义中的 TRUE/FALSE 选项处理 | 精确选项字符串 | 不假定所有 BOOL 字段相同 |
| field_number | 按字段定义转换；检查有限值、范围和精度 | 数字 | 会被截断/钳位的无效值给出诊断 |
| field_variable | 使用 ABI 模型和 map 的显式身份关联 | 可读变量引用，身份不内联进 ABS | 同名不同类型不得混同；无法唯一引用时走宿主操作 |
| 自定义字段 | 保留 JSON 类型；消费前还原 Project Data | 字符串或结构化 JSON | 按 loadState/saveState 或现有 Data Slot 契约校验 |

下拉匹配规则按顺序执行：

1. 精确匹配原始值与合法选项。
2. 对未加引号的布尔 token，允许转换为字符串 "true"/"false"；若定义只提供标准大写布尔枚举，则映射到该唯一合法值。
3. 不对一般枚举做全局大小写折叠，不将 1/0 猜测为布尔模式。
4. 无唯一合法结果时失败，报告 ABS 行列、节点、字段、原值及允许值；已确认的 blockId 放在结构化诊断中，未映射的新节点不编造旧 ID。

因此，定义值为 "false" 的播放模式，无论来源是手工 Blockly、ABS false 还是 ABS "false"，最终都保持字符串 "false"；不修改 chipIntelli_Audio generator。

### 5.2 元数据来源

- 静态字段类型和下拉选项来自加载的 block.json；扩充 BlockMeta 时同时保留 options，不能只存字段名。
- JS 注册字段、动态下拉和 mutator 产生的字段来自当前 Generator Runtime 的字段元数据或实际字段实例。
- 复用现有运行时元数据能力；不能为了推断参数结构在真实工作区任意创建临时块，触发库的 onchange 或项目写入副作用。
- 动态选项需要先满足父输入、extraState 和依赖字段。无法完成静态校验的字段标为待运行时验证；整个导入只有读回验证通过后才提交。
- 实例契约按 blockId 捕获，不能把同类型某个块的动态选项缓存给其他块或新块；当前实现每次操作采集，不增加跨 session 缓存。使用前后验证宿主上下文，失效后重新采集。
- 字段控件继承关系不等于持久化值类型。即使继承文本/下拉控件，只要实际序列化为结构化值，就按自定义 JSON 契约处理；未知字段不默认冒充普通文本。

### 5.3 导入后读回

工作区装载完成后，按合并计划确定的稳定 ID 对应候选块，比较实际 fields、extraState、连接、属性以及工作区 serializer 状态。

- 明确规范化的等价形式可通过；下拉回退、JSON 对象变成字符串、字段缺失、连接失败必须失败。
- 使用 saveState/序列化结果作为比较依据，不能统一 String(value)。
- 大资源比较内容寻址 ID 和一致的资源元数据；文本必要时按字节哈希比较。
- 删除候选块后资源不再被引用是合法编辑；候选仍存在的字段却丢失资源是导入失败。不能要求所有历史引用永久保留。
- 不靠拦截 console.warn 判断成功，必须检查实际结果。
- 传给库 loadState/loadExtraState 的对象与读回证据快照必须隔离，防止库修改入参后候选与读回一起变错。没有显式修改的字段直接继承基线持久值，不能因增加注释而触发新的类型转换。
- 原生 checkbox 的布尔与约定大写字符串可等价；原生变量完整字段状态中的 name/type 需核对实际模型表，再与精简 `{id}` 形式比较。未知成员仍精确比较，不能用删除所有 name/type 的通用规则掩盖丢失。

## 6. 受保护块的导入规则

导入前，从宿主管理的可信 ABI 基线和实际工作区获取所有不可删除块，建立 ID → 类型/范围/保护属性的约束。先确认当前项目仍与基线一致，再检查 ReconcilePlan。map 只协助定位，ABS/map 均不能自行撤销保护。

| 候选情况 | 处理 |
| --- | --- |
| 唯一匹配原块且类型不变 | 允许修改其可编辑内容，从基线继承 deletable:false |
| ABS 不出现任何保护属性 | 正常情况，属性本就不属于 ABS；不得因此使用默认 true |
| 导入参数或被篡改 map 试图解锁/重新认领 | 拒绝对应无效映射或 PROTECTED_BLOCK_UNLOCK |
| 计划删除保护块，或以新建同类型块替换 | 拒绝，返回 PROTECTED_BLOCK_MISSING |
| 对已确认的保护块替换 type | 拒绝，返回 PROTECTED_BLOCK_TYPE_CHANGED |
| 多个重复块中不能确定哪个保留 | 返回 ABS_IDENTITY_AMBIGUOUS，不替 Agent 选择 |
| 候选 ABI 重复 ID、多个父连接 | 拒绝，不能靠匹配第一个块继续 |
| 删除一个包含受保护后代的父块 | 在全树 ID 检查中拒绝 |
| 原本可删除的普通块被省略 | 按正常删除处理 |
| 明确的新建节点 | 生成新 ID；不据此认领原保护块身份 |

保护意味着保留该块身份及其保护属性，不意味着冻结其所有后代。setup/loop 内可删除的普通语句仍可按正常编辑规则增删。

适用范围包括任意库、值输入、语句链和禁用块，不限定 arduino_global/setup/loop。

普通 ABS 导入接口不暴露可由文件内容或 Agent 参数开启的 bypass。宿主状态操作也不能绕过原有编辑权限。产品将来若增加“重置工程”等操作，必须使用独立的产品操作与明确的范围。

若旧工程已经丢失 ID/保护属性，不能根据块名称自动猜回。优先使用原 ABI、备份或历史快照重新导出；无可信来源时明确报告不可恢复的信息。

## 7. Project Data 的统一边界

### 7.1 复用现有协议

继续复用：

- externalizeGenericProjectDataValues / materializeGenericProjectDataValues。
- projectDataRuntime 的 pending mutation、prepared cache 和 session guard。
- utf8-v1、canonical-json-v1、raw-v1，以及现有专用动画/图片 Codec。
- 32 KiB 通用阈值、资源完整性校验及内容寻址存储。

通用字段与专用 Data Slot 的职责不变。含已有 AilyDataRef 的大对象不能整体藏进另一份资源。

补充统一遍历路径：除 fields / extraState 外，需检查 ABI 中的 block.data、icons 自定义状态、备用 shadow 以及已登记的工作区 serializer 状态。文本与 JSON 在持久化时使用同一 Envelope，进入对应消费者前还原；移出 ABS 不等于可以跳过资源处理。未知 serializer 路径无法无损承载时应返回明确“不支持”，不能删除状态后继续。

阈值、Codec 与资源校验由主程序统一决定，不根据 field_multilinetext、库名或动画块类型决定是否外置。map 本身只保存索引和哈希，不存资源本体；同步快照与项目 ABI 使用同一外置规则。

### 7.2 出入口顺序

导出投影（不隐式保存项目 ABI）：

~~~text
等待字段异步修改完成
→ 捕获项目/页面/session/revision
→ 获取完整项目快照，限定目标页面投影
→ 外置通用大值并 flush
→ 校验内联阈值和全部引用
→ 纯 converter 输出 ABS 与原始节点绑定
→ 持久化不可变 ABI/ABS 基线，生成对应 map
→ 再次确认上下文/revision
→ 检查磁盘 ABS 未被编辑，按 generation 发布 ABS/map
~~~

导入：

~~~text
读取并验证基线、map、页面和当前项目状态
→ 解析编辑后的 ABS，建立无歧义 ReconcilePlan
→ 根据字段定义解析值，合并完整基线 ABI
→ 检查保护块/候选重复 ID/连接
→ 外置输入中的新大值
→ 校验所有引用和内联阈值
→ 还原通用 Envelope，prepare 专用字段资源
→ 装载实际工作区
→ 读回并重新外置、比较预期状态
→ 提交 ABI，再发布新 generation 的 ABS/map
~~~

纯 parser/converter/reconciler 不进行文件 I/O，也不配置全局 Project Data runtime。未准备的大内联值不能进入最终持久化输出；协调器在 AST/候选准备边界完成外置，再调用严格序列化/导出。支持新大值输入不能退回“先传给 Field 再外置”。

### 7.3 资源发现、打包和清理

抽离可共享的 JSON token 扫描器，使 converter、ABS 资源提取和校验理解同一种 v2 字面量及必要语义注解。纯扫描器放在 services/shared/abs/abs-json-tokens.ts；Project Data domain 与 ABS integration 都依赖该模块，禁止 domain 反向导入编辑器/产品集成层。

- ABS 扫描覆盖字段和 @extra；完整 ABI/基线扫描覆盖备用 shadow、data/icons、共享模型及 serializer 状态。二者分工，不能只扫描简化后的 ABS 就认定项目没有其他资源。
- 旧 "@json:" 仅在显式旧格式转换工具中识别，不作为 v2 唯一入口。
- GC roots 包含已保存 ABI、待应用 ABS、当前编辑快照、被 map 引用的不可变基线、待提交候选和回滚快照中仍需要的引用，以及既有历史/剪贴板规则。
- ABS 处于不完整编辑状态、无法可靠收集 roots 时跳过破坏性清理并报告原因，不能将解析失败当成空引用集合。
- 新外置但最终导入失败的资源允许暂留，不即时删除可能被其他引用共享的内容寻址资源。
- 云端导出、另存为、历史恢复等消费者逐一审计。普通项目包以完整 ABI 和资源为准，安装后重建本机映射；若要求携带未应用 ABS 编辑，则必须连同其基线和 map 作为显式编辑包导出，不能把脏 ABS 当已同步代码打包。

## 8. 同步协调器与提交语义

新增产品侧 abs-workspace-sync.service.ts，负责基线与映射验证、差异合并、资源准备、保护检查、装载、读回和提交；AbsAutoSyncService 保留对外门面及投影状态。

### 8.1 异步接口与串行化

- 所有会读取/写入资源的导入导出接口返回 Promise。
- getWorkspaceAbsContent 改为异步准备；同步消费者只能读取标明 revision 的缓存结果，不能临时内联大值。
- importContent、importFromAbs、forceImportFromAbs、exportToAbs、ensureWorkspaceExport 共用队列。force 表示要求执行，不能解除互斥。
- 运行上下文至少捕获 projectPath、pageId、workspace identity、Generator session、Project Data session、完整项目 revision、baseGeneration 及输入 ABS 哈希。每个异步边界、最终文件提交前验证。
- 镜像 revision 必须覆盖全部持久化变化，包括块属性、位置、禁用状态和页面/共享模型变化。当前 getWorkspaceContentRevision 读取 workspaceCodeRevision，实施时必须拆分“代码变化”和“持久化变化”，不能假定二者等价。
- 编辑发生在准备阶段时，旧导出不得覆盖新 revision；重新排队获取最新快照。
- 若 Blockly 与待应用 ABS 同时发生编辑，返回双向修改冲突，不以“重新导出最新 Blockly”为由覆盖磁盘 ABS。自动导出必须比较磁盘 ABS 与已知投影哈希。
- 导入应用阶段获取编辑互斥，阻止用户编辑或页面切换插入半完成装载；不能仅把 AI writing 遮罩当作实际互斥。
- chunk 与 non-chunk 使用完全相同的候选 ABI、校验和提交规则，仅装载方式不同。

### 8.2 快照、失败与恢复

1. 预检阶段不改动真实工作区和 project.abi。
2. 开始应用前保存完整项目模型、活动页、视图、编辑/撤销状态、原始输入 ABS 和回滚所需资源根；区分“导出时基线”“当前回滚点”“Agent 已编辑的输入”。
3. 静态可判断的错误必须在清空工作区前失败。
4. 动态字段装载、读回校验或提交前出错时，通过项目模型入口恢复快照，恢复事件/撤销设置。
5. 若库回调抛错使 Runtime 已污染或回滚失败，按照既有隔离方案恢复工作区与运行时，不在半失败 Realm 中继续执行。
6. 上下文已切换后，旧操作不得回滚或清空新工作区。

### 8.3 ABI、ABS 与 map 的持久化顺序

多个独立 rename 不是跨文件原子事务。采用“ABI 是保存提交点，ABS/map 是带 generation 的可恢复投影”，并记录单文件原子更新的同步日志/提交指针：

1. 候选资源全部落盘、读取校验成功。
2. 工作区读回验证成功，得到同一 revision 的完整项目候选；持久化候选 ABI/ABS/map 的不可变 generation 及原输入副本。
3. 原子写入 prepared 记录，包含旧/新 ABI 哈希、输入/输出 ABS 哈希、目标 generation 和恢复引用。提交前再次验证磁盘及工作区未变。
4. 通过项目保存端口原子提交 project.abi；保存端口接受已准备文档，不能在过程中再采集另一 revision。
5. 条件替换 project.abs 为同一候选生成的规范内容，再发布 project.abs.map.json；最后推进 committed 指针并更新 blockLineMap。任一读取方只有在内容、generation、基线均匹配时才认为投影就绪。
6. 返回 applied、abiSaved、absMirrored、mapPublished、generation、revision 和诊断。只有全部要求完成才报告同步成功。

导入成功发布的新 map 中，baseAbiHash 对应新完整项目快照，savedAbiHash 对应本次新写入的磁盘 ABI。保存统一采用完整 schemaVersion:3 项目文档，单页也保留 pages/sharedModel/视图及扩展信息，不再压平为工作区。快照与已准备的持久化产物仍分别计算摘要，不能因为页面数量或结构相似就假定摘要相等。

仅导出未保存工作区时复用 generation 发布机制，但不执行第 4 步：baseAbiHash 指向工作区快照，savedAbiHash 仍指向磁盘已有 ABI。两者不同本身不是损坏；磁盘原本无 ABI 时继续保持不存在。

失败和重启规则：

- ABI 尚未提交：恢复本操作改动的工作区和文件；磁盘原始输入及并发新编辑必须保留。只撤回仍属于该操作的写入，不覆盖外部已改变的文件。
- ABI 已提交但 ABS/map 发布失败：保留已保存 ABI 和对应工作区，返回 MIRROR_PENDING；从准备好的 generation 修复，不再次执行旧输入。磁盘 ABS 又有新编辑时转冲突并保留全部输入，不强行补写。
- ABS 写成而 map 未写成：不能视为就绪。根据 prepared 记录确认 ABS 是候选输出还是新编辑；只有前者允许补发对应 map。
- 进程退出后，不信任内存 revision 或单个阶段标记。核对实际 ABI 哈希与 prepared 中的新旧哈希判断是否已提交，再核对 ABS/map；不满足预期组合则进入 CONFLICT，禁止“最新文件覆盖其他文件”。
- 条件写入需接入宿主文件编辑事务/锁并使用期望内容哈希，覆盖 Agent 与产品写入入口；任意外部进程不遵守锁时仍可能竞争，应保存恢复副本并做写后校验，不能声称普通 rename 提供全局 CAS。
- 保存后的 C++/.h 生成复用当前 active generator 和既有 generated artifacts 写入流程；代码生成失败单独报告，不能误报 ABI 未保存。

Automation bridge 改为消费统一提交结果，移除当前“先写 ABS、再另外调用 save”的两段式编排。Undo/redo 通过产品快照恢复已知状态，不允许任意输入绕过保护检查。

### 8.4 map 缺失、损坏和过期的处理

| 情况 | 处理 |
| --- | --- |
| 初次打开只有可信 ABI，没有 ABS 编辑 | 生成新的投影、基线和 map |
| map 缺失，但宿主仍有对应 generation 和原始 ABS/ABI | 验证后重建索引；若输入已修改，继续对原始基线合并，不覆盖输入 |
| map 缺失且无对应基线，但存在 ABS | 返回 ABS_BASELINE_MISSING；保留文件，提供从 ABI 重建或独立导入的显式选项 |
| map 与其基线绑定不一致、范围非法或被修改 | 返回 ABS_MAP_INVALID；不能据此继承身份或删除保护块 |
| 当前工作区不同于 baseAbiHash，或磁盘 ABI 不同于 savedAbiHash | 返回 ABS_BASELINE_STALE；不以最新 ABI 冒充修改前基线 |
| 重启后只有磁盘已保存状态，旧投影来自未保存工作区 | 提示恢复旧工作区快照或保留 ABS 重新对照，不静默重放未保存编辑 |
| 页面切换、项目复制导致上下文不匹配 | 拒绝应用；显式重新绑定/重建必须先核对范围与待应用编辑 |
| map 正常但身份对应存在歧义 | 返回 ABS_IDENTITY_AMBIGUOUS，提供候选节点供宿主定向操作消歧 |

诊断至少包含 code、phase、pageId、generation、ABS 行列范围、已确认节点/候选及可行恢复操作。预检失败应明确工作区未改变，部分提交应明确 ABI 是否已经保存。

### 8.5 Agent 与文本编辑入口契约

- 读取/准备 ABS 时返回或由宿主会话保存 baseGeneration。应用请求必须绑定该 generation；Agent 不需要读取或重写整份 map。
- 普通字段修改继续编辑 ABS。同步结果给出保留/新增/删除块数和诊断，不能只返回解析成功。
- 遇到身份歧义时，宿主查询接口按 generation 和 ABS 范围返回候选节点的短期 nodeKey、类型及必要保护/隐藏状态；Agent 可发起明确的节点编辑、移动或复制操作。操作经宿主验证并形成编辑记录，不把 ID 填回 ABS。
- 对保护状态的查询不等于授予解锁权限。新增操作复用统一策略和事务，不能另建绕过保护的便捷入口。
- 自动搜索、上下文采集默认使用 ABS；map 与同步缓存不作为普通代码上下文全文注入。确需查询隐藏状态时按节点读取，避免把复杂度从代码文件转移到 Agent 的手工文件维护步骤。

## 9. Generator Runtime 与页面模型约束

- 普通字段及通用 Envelope 在进入 Field.loadState() 前还原；库 generator 始终读取原始值。
- 专用字段生成代码继续使用当前 active generator 的 Project Data 适配，不访问父页面 window.Arduino。
- 普通成功导入复用当前项目 Runtime，不能为每个块重建 iframe。
- Runtime 失效时遵守 workspace dispose → 宿主注册状态恢复 → iframe 销毁顺序。
- 动态库变化后字段元数据缓存必须按 session 失效，不能用旧项目的下拉选项校验新项目。
- 页面更新必须通过 BlocklyService 的项目模型入口；其他 pages/sharedModel 不因活动页 ABS 装载被丢弃。
- 本轮每份 ABS 只编辑一个页面，scope.pageId 必须与调用方捕获的页面一致。单页 converter 收到完整多页文档应报错，不返回空内容作为成功。
- 完整基线保留 pages、标题、viewState、openedPageIds、activePageId 和 sharedModel。目标页通过当前 compose/extract 规则更新，不因 ABS 未引用就删除共享变量、过程或工作区注释。
- 当前页面投影若包含共享过程，必须明确识别共享定义的来源与影响范围；共享状态修改按原模型规则校验其他页面的引用，不能将共享过程误变成该页私有新块。
- compose/extract 只处理所有权，不解释过程参数协议。定义由宿主当前实际块能力识别，调用归页，不按 procedures_ 等类型前缀判断；现有未知共享根保持原归属，待 Runtime 提供证据后再处理。旧共享调用只有单页、唯一一致的页面副本或显式宿主归属记录才能迁回页面，否则报告 BLOCKLY_SHARED_OWNER_REQUIRED，不猜测、不删除。
- 只为此次导入增加一次受控 revision 更新；中间块创建不发布可提交的镜像 revision。

## 10. 文件级执行清单

下列“新增”标识描述相对实施前的改造范围；已实现与仍待接线的边界见第 18 节，不表示这些模块都已在生产入口启用。

| 模块/文件 | 改造内容 | 依赖 |
| --- | --- | --- |
| integrations/blockly/abs/abs-state.ts（新增） | AST、上下文、generation、诊断和候选文档类型 | P1 |
| integrations/blockly/abs/abs-syntax.ts（新增） | 独立 v2 语法核，不依赖 Blockly 全局或文件 I/O | P1 |
| integrations/blockly/abs/abs-identity-map.ts（新增） | Map Schema 1、源范围/节点/符号索引、基线绑定验证 | P1 |
| integrations/blockly/abs/abs-reconciler.ts（新增） | 纯差异计划、确定性身份匹配、歧义诊断、基线合并 | P1、P3 |
| integrations/blockly/abs/abs-baseline-store.ts（新增） | 基线/恢复算法和存储端口；宿主文件事务适配尚待接入 | P4、P5 |
| services/shared/concurrency/serial-operation-queue.ts（新增） | 通用实例级 FIFO，供 ABS 与保存入口复用；原 abs-operation-queue.ts 已移除，不替代宿主文件锁或工作区编辑锁 | P5 |
| services/shared/abs/abs-json-tokens.ts（新增） | 纯 JSON token 扫描，供 domain 与 integration 单向依赖 | P1 |
| services/shared/public-api.ts | 导出共享扫描能力，遵循当前服务分层规则 | P1 |
| integrations/blockly/abs/abs-literals.ts（新增） | 旧解析器过渡期使用的字符串转义/顶层注解词法辅助；切换后审计剩余调用 | P1 |
| integrations/blockly/abs/block-config.ts | 区分解析 AST 与合并后候选，保留字段词法类型及完整 extraState | P1 |
| integrations/blockly/abs/block-definition.service.ts | 完整字段定义、下拉选项、session 缓存 | P2 |
| integrations/blockly/abs/abs-field-values.ts（新增） | 字段语义解析与规范化 | P2 |
| integrations/blockly/abs/abs-symbols.ts（新增） | 纯模型表查找、可读引用投影与类型约束；不创建/删除模型 | P1 |
| integrations/blockly/abs/abs-runtime-contracts.ts（新增） | 实际块实例到不可变字段契约的桥接，宿主上下文检查 | P2 |
| integrations/blockly/abs/abs-requested-state.ts（新增） | 显式请求 fields/extraState/变量模型的读回验证，不替代完整保护/隐藏状态比较 | P2、P3 |
| integrations/blockly/abs/abs-readback.ts（新增） | 统一请求值/完整快照读回，覆盖连接归属、属性、变量和自定义 serializer；仅原生规则规范化 | P3 |
| integrations/blockly/abs/abs-procedures.ts / abs-runtime-procedures.ts（新增） | 过程状态路径契约、参数模型/调用绑定验证；独立旧式 Blockly 能力适配器 | P1 |
| integrations/blockly/abs/abs-abi-index.ts / abs-state-path.ts（新增） | 全树身份索引及只读 JSON Pointer，避免过程/投影循环依赖和重复路径解析 | P1、P3 |
| editors/blockly-editor/services/prepared-project-save.ts（新增） | 固定项目快照的资源准备与精确 ABI 内容提交，独立文件端口供测试/宿主接线 | P5 |
| editors/blockly-editor/services/blockly-project-model.ts（新增） | 纯页面组合/提取、共享所有权、变量表冲突和跨页身份检查，保留文档扩展状态 | P1、P5 |
| editors/blockly-editor/services/blockly-root-role.ts（新增） | 当前实例/静态能力桥接，不创建探测块，不缓存跨 session 身份 | P1、P5 |
| integrations/blockly/abs/abs-project-references.ts（新增） | 按宿主完整契约验证其他页的变量/过程引用；无覆盖时拒绝共享状态编辑 | P1、P3 |
| editors/blockly-editor/services/blockly-project-revision.ts（新增） | 独立于代码生成的规范 JSON 内容观测 revision | P5 |
| editors/blockly-editor/services/blockly-workspace-edit-lease.ts（新增） | 显式租约所有权、失败隔离及不改变序列化属性的 DOM 输入边界 | P3、P5 |
| editors/blockly-editor/services/blockly-runtime-block-metadata.ts | 复用字段契约采集；保留选项值类型、数值范围、未知结构化字段 | P2 |
| integrations/blockly/abs/block-definition.model.ts（新增） | 同步/异步共用的纯块定义解析，任意自定义字段及字段契约 | P2 |
| integrations/blockly/abs/abs-parser.ts | 旧入口字段与状态修复；正式切换时迁移到独立 v2 语法核，清理旧猜测逻辑 | P1、P2 |
| integrations/blockly/abs/abi-abs-converter.ts | 导出 ABS 及映射；禁止现有项目走无基线全新 ID 重建；显式独立导入 | P1、P2 |
| integrations/blockly/abs/abs-import-policy.ts（新增） | 全树保护块检查、身份/连接校验、装载后差异检查 | P3 |
| services/domains/project/project-data/project-data-generic-values.ts | 共用序列化路径遍历、补齐通用大值路径及对应还原 | P4 |
| services/domains/project/project-data/project-data-abs.ts | 统一 v2 资源提取，不再只匹配 "@json:" | P4 |
| services/domains/project/project-data/project-data-runtime.ts | 提供只读上下文 token、操作范围内资源 pin/session 验证能力 | P4 |
| integrations/blockly/abs/abs-workspace-sync.service.ts（新增） | 唯一异步事务协调器，串联映射、合并、读回和提交 | P3～P5 |
| integrations/blockly/abs/abs-auto-sync.service.ts | 全部入口收口、异步缓存、generation/revision 队列和双向脏检查 | P5 |
| integrations/blockly/abs/abs-chunk-loader.ts | 保留候选状态、每批验证上下文、支持统一回滚 | P5 |
| editors/blockly-editor/services/blockly.service.ts | 活动页应用接口、完整项目快照、显式提交 revision | P5 |
| editors/blockly-editor/services/project.service.ts | 提交已准备文档、返回明确持久化结果 | P5 |
| services/integrations/automation/blockly-live-operation-bridge.service.ts | generation 绑定、节点状态查询/定向编辑、统一提交结果 | P5 |
| tools/cloud-space/cloud-space.component.ts | 资源提取调用和失败策略回归，保持打包用途边界 | P4、P6 |
| tsconfig.abs-sync.spec.json（新增）、相关 specs | 独立测试入口和真实字段回归 | P0、P6 |

文件表中的根目录均为 D:\codes\aily-blockly\src\app；tsconfig 文件位于仓库根目录。没有重新启用已退役的 Chat 专属 converter 或同步工具。

纯协议、匹配与字段模块不得直接读写文件。存储端口的底层实现沿用现有 Electron/宿主文件能力；实施时先确认实际接口，避免仅根据旧服务注释重建已经迁移的历史存储。

## 11. 分阶段实施与完成门槛

### P0：锁定基线与可运行测试入口

- [x] 复现 F01～F10，记录当前源码入口及行为。
- [x] 明确库只读、当前 Runtime 隔离及页面范围。
- [x] 新增最小缺陷回归与纯核心测试；首轮确认 4 项生产字段用例失败，修复后通过。
- [x] 增加仅收集 ABS/Project Data 相关规格的 tsconfig.abs-sync.spec.json 及 abs-sync 测试配置。
- [x] 用仓库已有 Angular/Karma/Jasmine 框架执行，不依赖手工抄写一套转换算法。
- [ ] 补齐真实库、完整 Runtime 装载及多页工程回归；纯函数测试不替代这些验收。

完成门槛：测试失败明确对应当前已确认缺陷；不能把历史全量测试阻塞当成本轮无需执行测试的理由。

### P1：简洁语法、身份映射与纯合并

- [x] 实现独立 v2 具名参数、内联值块、命名输入、@extra/@disabled/@next 和源范围；不输出完整元数据。
- [x] 实现节点 map、UTF-16 偏移、SHA-256 基线/文本哈希及预览版 projectionVersion。
- [x] 在纯核心中生成 ABS 与同 generation 的原始节点绑定；不隐式写入文件。
- [x] 实现基线对照、确定性匹配、候选合并和重复节点歧义诊断。
- [x] 合并时继承 ID、块属性、icons/data、fallback shadow 及未涉及工作区状态。
- [x] 实现新建、唯一根重排、保护类型替换拒绝、extraState 省略继承与禁用状态检查。
- [x] 处理准确字符串转义及普通行尾注释。
- [x] 原生变量字段和宿主声明模型表的字段引用投影/绑定，保留未引用模型、类型约束及重复名称歧义；map 校验绑定契约哈希。
- [x] 纯 v2 解析器支持带完整定义的位置参数；无定义、重复参数、混合顺序和输入种类不符明确拒绝，规范导出仍为具名参数。
- [x] 显式过程 extraState 路径契约、参数变量及调用定义绑定；旧式 Blockly 能力适配器与原生过程三轮装载/读回回归。
- [x] 纯页面 compose/extract 及生产模型接线；定义共享、调用归页、旧共享调用归属歧义拒绝、变量表合并和跨页 ID 冲突检查。
- [x] 按完整显式契约验证跨页变量/过程引用及原模型身份；生产 ABS 导入在预检/读回时检查共享变更，其他页无完整契约时拒绝应用。
- [x] 从已实际装载/访问的页面采集已验证原生字段及旧式过程引用契约；按工作区/Generator/Project Data session 和完整序列化状态复用有界证据，供页面不活动时校验共享变更。
- [ ] 覆盖未访问页、休眠 shadow、自定义字段/状态/serializer、model-backed 过程、候选新增/改形块契约及宿主显式移动/复制记录；能力识别所有权不等于理解过程序列化协议。
- [ ] 固化正式存储协议并移除预览版限制，才允许生产切换。

完成门槛：在匹配基线下，无编辑往返保持规范化持久状态；普通字段编辑不重建身份；重复块的多解情况明确失败。ABS 不包含 ID/布局/保护的完整注解，map 不复制可变块状态。

### P2：字段语义

- [x] 合并同步/异步静态块定义解析，保存真实下拉 options，识别任意 field_* 与 argsN。
- [x] 字段解析移除全局布尔大写转换和字段名猜测。
- [x] 导出保持字符串类型，按字段契约解析数字和结构化 JSON；普通对象不再按 name 属性认作变量。
- [x] 静态非法下拉与有损数值转换明确拒绝。
- [x] 按当前实际块实例采集动态字段契约，检查宿主 session；字段值解析仍使用本次操作采集的契约，覆盖同类型不同选项、依赖字段及选项回调异常。页面引用证据缓存不供新增块解析、动态默认值或另一实例借用。
- [x] 当前产品普通/分片装载后的显式字段、extraState、变量模型读回不符转为失败并回滚，不写 ABS 镜像。
- [ ] 新增/改形块的候选契约准备，以及接入 v2 完整读回与统一保存事务。

完成门槛：裸 false、带引号 "false" 和手工排队块经过两轮导出/导入后，三段音频 C++ 的 interruptCurrent 均为 false；标准复选框与逻辑块不退化。

### P3：保护块与语义读回

- [x] 新增独立全树保护策略，校验删除、替换、换类型及非法解锁。
- [x] 纯候选准备拒绝无效 map/基线、重复 ID 和身份歧义；提供独立宿主上下文过期检查。
- [x] 新增序列化读回比较器，覆盖值变化及对象字符串化；比较器本身不操作工作区。
- [x] 现有产品入口接入显式请求值读回；与库回调入参隔离，原生 checkbox/变量采用已验证的序列化等价规则。
- [x] 请求读回扩展连接归属、显式块属性和自定义 workspace serializer；完整模式拒绝额外状态，按显式新块集合允许库默认值，统一原生序列化规范化。
- [x] 当前生产 ABS 入口在清空前及原生装载后采集实际旧式过程协议，验证参数/定义绑定；新增孤立调用读回失败后回滚，不发布 ABS 镜像。
- [ ] 将保护、宿主上下文与读回检查接入所有真实工作区装载入口。
- [x] 当前产品入口预检失败不重载工作区；装载失败使用完整项目模型回滚，切换上下文后不触碰新工作区。
- [x] 在完整快照基础上限定回滚写集为活动工作区及其共享模型；保留其他页内容、最新页面标题/标签等模型元数据，不再直接重放旧的整份文档覆盖它们。
- [x] 修复项目模型装载的 Events.disable/enable 嵌套计数配对；显式失效静默装载后的代码缓存。
- [x] 当前 ABS 回滚使用原始独立工作区快照做完整读回；恢复抛错或静默丢状态时隔离工作区，拒绝继续保存/导出/Agent 访问，直至新 workspace 激活。
- [ ] 导入失败恢复快照，保留正常普通块的编辑能力。

完成门槛：所有保护违规在提交前失败；可编辑子块照常增删；绝不以三个 Arduino 类型作为判断依据。

### P4：资源边界

- [ ] 所有生产 ABS 入口先外置、验证，再消费。
- [x] 当前产品文件导出等待字段异步修改、外置和资源准备；导入在装载前 prepare 资源并还原通用 Envelope。
- [x] 统一 fields/extraState/block data/icons 的 payload 遍历，含 fallback shadow、多页和共享模型内的块；混合引用对象递归处理大值兄弟节点，不把已有引用藏进资源。
- [x] 当前服务预览 API 改为异步，与文件导出/导入共用资源准备；不发布 ABS/ABI、行号映射或 clean revision。
- [x] 当前导入在候选阶段外置具名 JSON 字段/@extra 大值，验证并还原后才 native load；只替换对应原文字面量，保留注释、声明及其他代码。
- [x] 自定义 workspace serializer、未活动页载荷和官方变量行扩展属性纳入同一外置/还原/超限检查边界；块图、变量身份表和文档/页面元数据不被整块替换。
- [x] v2 AST 为字段及 @extra 记录 UTF-16 字面量边界，合并后绑定候选 ABI payload 路径；具名字段、已绑定位置参数、单引号、嵌套输入/next 和混合大值可精确替换。
- [x] v2 异步准备复用现有合并和资源端口；普通纯合并仍拒绝超限值，草稿不能直接装载；原始文本与准备后的文本分别保留，不重复分配块 ID。
- [x] 资源准备回调、返回结果与后续还原使用独立快照；外置不得隐藏已声明的字段符号、过程签名及模型表身份路径。
- [ ] 将上述 v2 准备能力接到统一宿主事务及所有生产入口；推导值/隐式状态仍需明确的反向语义适配，不能按相同文本猜测替换。旧生产入口的位置参数/单引号大值限制尚未移除。
- [x] ABS 资源发现复用通用 JSON 扫描器，覆盖原生 JSON 字段和 @extra；严格模式拒绝损坏/截断 JSON。
- [ ] 补齐完整 ABI/基线附加路径扫描；GC 必须结合完整语法与所有快照根，不能只依赖 token 扫描结果。
- [ ] 准备阶段、基线保留、回滚和 GC 的资源生命周期完整。

完成门槛：超限文本/数组往返哈希一致；缺失和损坏资源不能进入工作区；引用不变的重复保存不产生新资源 ID。

### P5：统一同步与提交

- [x] 当前产品的文件导入、文本导入、force、chunk 和导出共用 FIFO 与单一装载实现；Automation 已调用该入口。
- [x] 新增项目/页面/工作区/Generator 实例/Project Data session 检查；每个分片修改前再次验证。
- [x] 新增不可变基线存储算法、原始输入保留、prepared/committed 发布与恢复分类；通过带字节哈希 CAS 的内存宿主端口故障测试。
- [x] 拆出已准备保存端口，普通产品保存提交固定 ABI 内容；保存 FIFO、完整项目快照检查、session/page 检查及磁盘内容冲突检查已生效。
- [x] ABS 导入/导出与普通保存共用 BlocklyService 的 renderer FIFO；导入/导出准备后增加完整文档内容检查，阻止代码 revision 未变的持久状态编辑被忽略。
- [x] 工程快照读取与状态发布分离；单页同样保存完整工程文档，未保存检测按规范化 JSON 比较，避免元数据键顺序造成误报。
- [x] 文件导出缓存与保存/导入准备检查使用内容观测 revision；布局、保护、其他页及 serializer 状态变化不再依赖代码事件，flushPending 先于导出缓存命中判断。
- [x] 当前 ABS 普通/分片导入持有编辑租约，服务级页面/装载/快照访问要求所有权；原生输入被短时阻断；Agent 四种积木写入及 tidy 修改段与 ABS/保存排队，拒绝陈旧上下文。
- [x] 库装载、块注册及 Generator 入口检查编辑门禁，注册前失效页面引用证据；采集期间工作区/模型元数据/注册上下文变化不得发布旧快照，移除未使用的主页面脚本装载入口。
- [x] 当前生产入口在资源准备/工作区修改前拒绝带 ABS Schema 声明的文本，避免 v2 或未知版本被旧转换器误解释；保留原有 Project Data Schema 1 入口。
- [x] 普通 ABI 保存、ABS 导入后镜像及文件导出共用 preload 宿主单文件提交：工程写锁、预期字节哈希、独占临时文件、原子 rename 和精确回执；不确定结果隔离当前工作区，不盲目回滚。
- [x] 项目初始化/打开时的 ABI 规范化接入宿主 CAS、原始备份及精确回执；逐资源检查上下文，未变化 ABI 也校验磁盘版本；删除固定 project.abi.tmp 旧写入实现。
- [x] Blockly/Coder 另存为使用只过滤宿主写入临时状态的目录复制接口；复用路径校验，保留空格，Blockly 校验期间换会话或外部改写 ABI 时停止复制。
- [x] 云端参数按块身份纯更新，和通用大值外置共同进行一次宿主规范化提交；云端/Playground/Blockly 板卡和用户模板采用统一导入、实际根目录识别、准确临时状态过滤及独占目标目录。
- [x] 当前独立 Agent（aily-lex-pro）的 workspace-history 最终落盘、写穿及历史恢复接入共同工程锁；整批写前校验、提交读回、条件恢复和已提交日志清理隔离已实现。
- [x] Agent 离线 ABS 初始化/导出及普通工具、Code Mode 的工程镜像写入复用既有事务；候选生成前固定源/目标版本，动态工具共享会话读版本，不能表达的数据明确拒绝。
- [x] Agent abs_export、project_save、blocks_tidy 消费主程序权威投影回执；绑定请求、工程、活动页、revision、ABI/ABS 精确字节，拒绝回执不符及 live 失败后的离线覆盖。legacy 结构查询统一只读实际实例，无临时积木/变量及跨项目类型缓存。
- [x] Agent abs_validate/abs_apply 接入候选哈希、ABI 基线、页面/runtime/revision 绑定的主程序能力；共用解析/资源准备，实际请求状态读回及保存回执，不自动重放超时导入，不用 headless 投影冒充候选验证。
- [x] v2 内核接通真实 preload generation 存储，锁回调传递可撤销读写能力，ABI/ABS/map 与基线/指针共用工程锁；普通 Blockly/Agent 镜像写入识别 prepared 持久化屏障，真实 Electron 重建 renderer 恢复通过（第 32 节）。此项不代表生产协调器已启用。
- [ ] 直接外部命令、追加、删除和补丁路径逐入口收口。过滤复制不是一致性快照，文件写锁不等于完整 generation 多文件事务；候选语法/资源检查不等于全部 C++ 语义和旧身份合并证明。
- [ ] 导入/导出/force/chunk/Automation 共用协调器。
- [ ] 全链路上下文与 revision 验证、页面范围和编辑互斥。
- [ ] 完整项目模型快照、基线存储和未保存工作区恢复。
- [ ] ABI 保存提交点、ABS/map generation 发布、prepared/committed 恢复记录。
- [ ] 实现 map 丢失/过期/损坏、双向编辑冲突及 MIRROR_PENDING 恢复。
- [ ] 接入宿主编辑记录与节点消歧操作；更新 Agent 示例及查询/结果契约。

完成门槛：所有入口通过同一组行为用例；失败不会覆盖新项目、新页面或更新后的文件。

### P6：集成验收与切换

- [ ] 执行下表全部相关场景，记录结果和构建版本。
- [x] 当前生产协议的两个用户工程副本已完成真实 Electron 通用大文本导入、打开、编辑、保存、重开专项验证（见 26.3）；原始工程不写入。
- [ ] v2/map 统一切换后，用用户工程副本在 Electron 中验证完整 ABS/ABI 往返及打开、编辑、保存、重开。
- [ ] 从可信 ABI 重新生成内部旧工程 ABS、基线和 map；移除正式入口的旧格式分支。
- [ ] 审计云端/另存为/历史恢复与 Agent 文件筛选，区分普通项目包和待应用编辑包。
- [ ] 记录大项目的导出、合并、保存耗时与峰值内存，检查快照保留量及回收。
- [x] 在本文件附录登记已完成项、命令结果和仍存在的限制，随批次更新。

完成门槛：自动化与 Electron 数据往返均通过；不以单独 TypeScript 编译通过替代数据无损验收。

执行顺序：P0 → P1/P2 → P3/P4 → P5 → P6。P1/P2 可按模块推进，但所有阶段通过前不得局部启用新生产协议；不把“不兼容旧内部格式”误解为允许混用新旧入口。

## 12. 验收矩阵

| 编号 | 场景 | 必须断言 |
| --- | --- | --- |
| T01 | 用户提供的三个 protected 根块 | ID、坐标、deletable:false 不变，界面仍不可删除 |
| T02 | 自定义未知库的 protected 值块/后代块 | 不依赖类型名，删除/替换或身份歧义均不能成功应用 |
| T03 | 保护块下增删普通语句 | 合法编辑成功，保护属性不变 |
| T04 | false / "false" / TRUE / 非法枚举 | 对应真实字段选项；非法值失败且原状态不变 |
| T05 | 三段音频，连续两轮往返 | 三处 C++ interruptCurrent 均为 false |
| T06 | 文本 "false"、"001"、逗号、括号、引号、反斜杠、换行、# | 字节/类型一致，注释解析不吞字段内容 |
| T07 | checkbox、标准逻辑、数值范围、动态下拉 | 规范化符合各自字段契约；回退不能静默成功 |
| T08 | movable/editable/collapsed/inline/data/icons | 无需内联 meta，匹配块序列化状态保留 |
| T09 | 禁用根块、禁用语句、禁用子块 | 块和子树保留，状态可见；删标记不隐式启用 |
| T10 | block + fallback shadow、根级 next、多语句输入 | 连接、shadow 状态和 ID 保留 |
| T11 | extraState 含数组、false、ID、资源 | 不删除原状态，不把数组变成键值对象 |
| T12 | 32 KiB 边界及 40 KiB/大数组/多字节 Unicode | 阈值按字节；超限值外置；还原哈希一致 |
| T13 | 专用动画/图片字段与通用大字段混合 | 库 generator 获得原契约，资源引用及生成文件正常 |
| T14 | 缺失/损坏资源、未知 Codec、无效 Envelope | 预检失败，不清空或写坏项目 |
| T15 | 资源仅被待应用 ABS/旧基线/回滚点引用、GC | 需要的资源不被清理；无引用的旧基线释放后才允许回收 |
| T16 | 导出过程中继续编辑、切项目、切页、重建 Runtime | 旧任务不能提交；新状态保持完整 |
| T17 | chunk/non-chunk、中途异常、动态字段回退 | 最终结果一致；失败恢复完整项目模型 |
| T18 | 两页项目、共享过程/变量、未引用变量 | 目标页正确更新，其他页面与共享状态无误删 |
| T19 | ABI/ABS/map 各阶段写失败、任意提交边界进程退出 | 区分未提交和 MIRROR_PENDING；不混用 generation，不重复应用输入 |
| T20 | 非法 v2 / 未标版本旧 ABS / 候选 duplicate ID | 明确诊断，不按成功空文档应用 |
| T21 | Generator Runtime 下生成 C++ 与 src 中的 .h | 引用与文件匹配；跨项目无旧 session 状态 |
| T22 | 云端资源提取、另存为、重开项目 | 同一引用协议，资源复制与恢复完整 |
| T23 | ABS 增删空行/注释、CRLF↔LF、Unicode、一行多个值块 | 源范围定位正确，不靠行号认领身份 |
| T24 | 两个完全相同块删除其一，其中一个受保护 | 无编辑记录时报告歧义；经宿主指定删除普通块可成功 |
| T25 | 相同文本但 data/icons/shadow 不同的普通块 | 歧义不得导致隐藏状态串到另一个块 |
| T26 | 字段修改、独立根块排序、跨输入移动、明确复制 | 可确定的保留/移动继承 ID；复制生成新 ID；不确定则冲突 |
| T27 | map 缺失/损坏/篡改 ID、基线丢失、跨项目/page 混用 | 按 8.4 处理；不能凭修改 map 解锁或覆盖工作区 |
| T28 | 导出包含未保存编辑，随后保存/重启/恢复 | 导出不偷存 ABI；基线可读取；过期恢复有明确选择 |
| T29 | Blockly 与 ABS 同时修改、Agent 写入途中自动导出 | 保留两边修改；旧任务不能覆盖新文本 |
| T30 | 宿主编辑记录过期/伪造 generation/输入哈希不符 | 拒绝记录，不把未经验证的 nodeKey 当身份依据 |
| T31 | 独立 ABS、普通项目包、携带待应用编辑的工程副本 | 新建身份与无损合并明确区分；待应用编辑包包含匹配基线 |
| T32 | 1,000/10,000 块与大文本/数组混合，连续导出和保存 | 记录耗时/内存/文件大小；ABS/map 无大值展开，基线不无限累积 |

建议执行命令（专用测试配置为 P0 计划新增）：

~~~powershell
pnpm exec tsc --noEmit -p tsconfig.app.json
pnpm run test:abs-sync
pnpm exec ng build --configuration development --no-progress
node scripts/check-angular-service-architecture.mjs
git diff --check
~~~

专用测试配置同时限定 tsconfig 和 Angular include，避免无关历史测试被意外收集。若包管理器包装层阻止启动，可直接调用仓库内 Angular CLI，实际命令见第 15 节。Electron 验收复用现有 E2E 启动方式，仅对工程副本操作。

## 13. 旧格式处理与发布顺序

1. 先完成 P0～P5 并通过自动化测试，再切换所有生产入口到 v2/map v1；不能在解析器、映射器、导出器和资源扫描器版本不一致时部分发布。
2. 同时更新 Agent 示例：只编辑业务 ABS，按 generation 应用，使用具名字段和字符串引号；不维护 ID/meta/map；身份歧义用宿主操作解决。
3. 对现有内部工程，用完整可信 ABI/当前确认的工作区重新导出 v2 并建立基线/map。先保留原 ABS；发现未应用编辑时不能自动覆盖，也不能把旧文本直接绑定新基线。
4. 旧 ABS 不能证明其缺失块或属性本来就不存在。若只剩旧 ABS，提供显式离线导入诊断，不宣称已恢复原 ID、保护属性或禁用块。
5. 本轮不为兼容旧 ABS 修改所有库包，也不自动将 MODE 枚举改成新值。
6. 普通工程分享包含完整 ABI 和资源即可重建投影；要求保存未应用 ABS 编辑时额外携带匹配的基线/map。文档不得再承诺仅单个 ABS 文件即可恢复完整工程。
7. 回退使用执行前的工程副本和匹配的软件版本；不清理用户资源文件，不让不认识 v2 的版本继续保存 v2 工程。

## 14. 完成定义与当前进度

交付修复必须同时满足：

- v2 生产入口只有一套投影、身份、字段和资源语义；库保持只读。
- ABS 不包含完整 @meta/@workspace；ABI 保存完整状态，map 只索引身份与基线。
- 在匹配基线下，无编辑及无歧义编辑往返可证明字段值、保护属性、禁用块和必要连接状态保持一致。
- 无基线、身份歧义或并发修改明确冲突，不以重建新 ID 静默降级。
- 受保护块不会被普通 ABS 导入移除或解锁。
- 导入失败、保存失败、ABS/map 发布失败和重启后的状态真实可恢复。
- 测试、类型检查、构建和 Electron 工程副本回归均有实际记录。

当前进度以第 11 节复选项和第 18 节最新执行记录为准；第 15～17 节保留前三批的历史状态，不代表当前状态。不得以“纯核心已通过测试”替代“新协议已接入产品并可安全保存”。

## 15. 第一批实施记录（2026-09-14）

### 15.1 本批实际交付

1. 建立专用测试配置及生产缺陷回归，使用仓库原有 Angular/Karma/Jasmine 工具链。
2. 提取纯块定义模型，删除同步/异步两套重复解析，取消固定字段类型列表和 args0～args10 上限。
3. 旧生产入口修复：枚举 false 不再误变为 FALSE，字符串保持引号，具名字段保持大小写，非法静态下拉拒绝；普通 JSON 中的 name 不再冒充变量引用。
4. 旧生产入口修复：完整保留 extraState 的数组、false、null 和含 :: 的值；删除 makePortableExtraState 的启发式数据清理，修复注解/行尾注释和反斜杠结尾字符串的解析。
5. 删除重复的 ABI→ABS 导出实现及 isIdentifier/isEnumValue 名称猜测。原有旧协议仍服务现有入口，未提前切换到 v2。
6. 新增 v2 纯语法、节点 map/基线校验、候选合并、保护策略、宿主上下文检查和严格读回比较模块；依赖通过参数传入，不读取 Blockly 全局、不访问文件系统。
7. Project Data 资源发现接入共享 JSON 扫描，修复当前原生 JSON 输出与旧资源扫描器不一致的问题。
8. 修复规范化 JSON 对 __proto__ 等特殊键的保真，验证合并产物可连续三轮再导出/编辑；重复类型分组使用线性追加，不反复复制分组数组。

### 15.2 明确尚未完成的边界

- 新 v2 核心当前为 abs-v2.preview.1，仅由测试调用；AbsAutoSyncService、Automation 和项目保存端口尚未切换。现有产品入口中的整体身份/保护丢失问题还不能宣称解决。
- 节点 map 已实现；变量/过程符号表与可读引用尚未实现。预览导出对结构化字段保持原始 JSON，不冒充已完成符号投影。
- 同 owner/输入范围的确定性对应和唯一根重排已实现；跨 owner 移动、重复块复制或删除的歧义要求宿主操作，相关操作记录适配尚未接入。
- 宿主负责完整项目的 compose/extract。核心分别哈希完整文档与目标页快照，但不自行编排多页/共享模型保存。
- 当前核心只接受 external-only 的已准备候选，超限内联数据仍明确拒绝。各入口统一外置、资源还原、异步 pending mutation、GC pin 和附加状态路径覆盖仍属 P4/P5。
- map/基线落盘、prepared/committed 恢复、编辑互斥、session/revision 队列、实际工作区读回和回滚尚未实现。
- 严格读回比较器尚未加入经验证的 Blockly 默认值等价规范化；正式接入前必须用真实 Runtime 验证，不能简单放宽为字符串比较。
- 未改写用户工程或 aily-blockly-libraries，未进行 Electron 工程副本或开发板音频验收。

### 15.3 验证记录

| 检查 | 实际结果 |
| --- | --- |
| 首轮生产字段回归 | 4 项失败，确认原缺陷可由测试重现；资源扫描修复后的 2 项通过 |
| node node_modules/@angular/cli/bin/ng.js test --configuration=abs-sync --watch=false --browsers=ChromeHeadless --no-progress | 57 项通过；覆盖生产字段/extraState 与纯语法/身份/保护/资源扫描，不是完整 T01～T32 的产品级验收 |
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过，包含尚未接入生产的 v2 核心 |
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json | 通过 |
| node scripts/check-angular-service-architecture.mjs | 156 个服务文件，0 baseline violations，0 cycles，无新增架构债务 |
| 默认 development 构建 | 未通过：mermaid 的 es-toolkit/compat 在 preserveSymlinks:true 下解析失败；包存在于其 pnpm 传递依赖路径，未修改依赖/构建配置绕过 |
| development 构建临时附加 --preserve-symlinks=false | 通过；仅用于确认代码可构建，未改写默认配置，不能替代默认构建问题的后续处理 |
| git diff --check | 通过；只有仓库自动换行提示 |

本机 pnpm 包装层在测试启动前自动执行依赖核对/安装，并因 ignored build scripts 退出；未放开构建脚本权限，也未修改依赖版本或锁文件。测试改用仓库内 CLI 直接执行。构建环境问题与默认构建结果单独记录，不能以专项测试通过宣称完整构建通过。

下一批主线：完成符号/动态字段适配 → 接入基线存储与统一准备/提交端口 → 统一切换所有生产入口 → 真实工程和故障注入验收 → 删除失去调用方的旧解析/同步实现。

## 16. 第二批实施记录（2026-09-14）

### 16.1 本批实际交付与模块边界

本批优先落地可独立修复的资源准备/并发边界，并实现基线提交的存储算法。符号适配仍是正式协议切换的前置条件，没有为了增加完成数量提前混用新旧语法。

| 模块 | 实际实现 | 生效范围 |
| --- | --- | --- |
| project-data-payloads.ts | 按序列化位置识别字段、extraState、block data/icons，统一 JSON Pointer 和引用检查；不按库名、字段名或控件类型分支 | 已供当前 Project Data 外置、还原、策略检查使用 |
| project-data-generic-values.ts | 混合引用载荷递归外置大值兄弟节点；还原任意嵌套 Envelope；还原对象与 prepared 缓存隔离，避免库回调修改缓存 | 已供现有项目及 ABS 文件路径使用 |
| abs-operation-queue.ts | 一套不被失败任务阻断的 FIFO，无 force 绕锁通道 | 已接入当前产品同步服务 |
| abs-auto-sync.service.ts | 所有导入共用单一装载实现；导出等待 pending mutation、外置与 prepare；导入 prepare/还原后才装载；预检失败不清空；装载失败走完整项目模型回滚 | 当前旧协议入口已生效，非 v2 切换 |
| abs-chunk-loader.ts | 初始清空、每批/每个片段、最后完成前验证上下文；进度回调不再兼任唯一安全检查 | 当前 chunk 入口已生效 |
| blockly.service.ts | 修复嵌套 Events.disable 计数泄漏；静默 ABS 装载显式标记代码缓存失效 | 当前产品路径已生效 |
| abs-baseline-store.ts | 保留完整外置项目快照、目标页、原始投影和精确编辑输入；不可变 generation；prepared/committed、字节哈希条件写和重启恢复 | 算法与存储端口已实现；目前通过内存宿主测试，尚未接入真实宿主文件事务 |

清理：删除没有调用方的 AbsVersion/VersionManifest、5 个版本历史空接口、无效 saveVersion 参数、重复的文件导入/工作区装载路径，以及资源外置/还原/策略各自维护的重复位置扫描。没有恢复已退役的 Chat 专属同步器，没有修改 aily-blockly-libraries。

### 16.2 提交与恢复契约的明确化

1. stage 只创建不可变 generation，不写 project.abi/abs/map；导出未保存工作区不会偷存 ABI。
2. 存储键由宿主使用受限 generation 构造，不使用 ABS/map 提供的任意路径。实际宿主适配必须约束目录及符号链接，不能仅依靠字符串校验。
3. map.savedAbiHash 是规范化 ABI 哈希；文件条件写使用原始字节哈希，两者用途不同，不混用。
4. commitAbi 端口只能提交传入的已准备保存形态；完整项目快照与单页兼容 ABI 的形态由页面模型/保存适配负责，存储算法不重新采集工作区。
5. 原子发布 prepared → ABI 保存提交点 → 条件发布 ABS/map → committed → 清理 prepared；各次 rename 不是跨文件原子事务。
6. 返回 NOT_COMMITTED、MIRROR_PENDING、CONFLICT 或 COMMITTED，并单独给出 abiSaved/absMirrored/mapPublished。即使保存回调在 ABI 已写入后抛错，也根据实际文件识别部分成功。
7. 恢复不调用解析/装载/保存输入；只核对基线、日志和真实文件，修复仍属于该 generation 的镜像。发现新的 ABS、ABI 或提交指针时保留并报告冲突。
8. 无法读取提交点时抛出 ABS_COMMIT_UNCERTAIN，禁止调用方假定未保存并回滚。未提交取消为显式操作，取消后仍保留不可变原始输入。
9. 存储端口 withLock 必须最终与 Agent/产品文件写入共用宿主事务锁；当前服务的 FIFO 不是跨进程文件锁，不能宣称已实现全产品 CAS。

### 16.3 自动化验证

| 检查 | 实际结果 |
| --- | --- |
| 专项 Karma/ChromeHeadless 测试 | 89 项通过，较第一批新增 32 项；包含真实 Blockly 普通文本 Field 的大值 Envelope 装载、事件嵌套恢复、资源路径、同步 FIFO 和基线故障注入 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 158 个服务文件，0 baseline violations，0 cycles |
| 默认 development 构建复测 | 仍失败于 mermaid 的 es-toolkit/compat 解析；与第一批相同，未改写依赖配置掩盖 |
| development --preserve-symlinks=false | 通过，用于独立核对本批代码的可构建性；默认配置未修改 |
| git diff --check | 已清理本批新增的文件尾空行；保留仓库原有换行策略 |

测试故障覆盖：prepared 写失败、ABI 保存前失败、ABI 保存后回调抛错、ABS/map/committed 写失败、重建 store 实例后的恢复、外部新编辑、跨项目基线、基线损坏、generation 覆盖及路径穿越。存储测试使用真实字节哈希条件替换的内存宿主模型，**不是 Electron 崩溃恢复验收**。

### 16.4 仍待完成的边界与下一批入口

- **生产保护/身份无损合并尚未完成**：当前 AbsAutoSyncService 仍用旧 converter；v2 内核和新存储模块尚未连到真实导入事务。不能把本批资源/队列修复理解为 deletable:false 整体问题已关闭。
- P1/P2：变量/过程符号绑定、完整定义的位置参数、宿主定向移动/复制、按实际块状态捕获的动态字段契约及读回规范化仍待实现。
- P3/P5：当前上下文检查覆盖项目、页面、工作区、Generator 实例、Project Data session；仍缺少完整持久状态 revision、工作区编辑互斥和 Runtime 污染后的隔离重建。普通回滚会报告失败，但尚无自动 Runtime 重建流程。
- P4：同步只读预览尚未切成异步准备；大值手写输入的候选外置边界、自定义工作区 serializer 载荷、GC 对基线/回滚/未应用 ABS 的 pin 与释放尚待接入。
- P5：新存储端口还需对接真实宿主文件锁、已准备项目保存入口、活动页 compose/extract 和统一读回事务。Automation 当前仍是“导入后另行保存”，尚未改为消费新提交结果。
- 当前服务只对已知镜像后的外部编辑做覆盖保护；首次启动已有 ABS 的来源核对、map 丢失恢复和跨重启双向脏检查必须由 v2 基线机制完成，不能用首次导出推断磁盘 ABS 无待应用编辑。
- P6：未操作用户工程、未跑 Electron 工程副本/多页/真实库 generator 验收，未发布新协议，也未清理任何用户资源或推送库改动。

下一批按主线继续：符号与 Runtime 字段契约 → 真实工作区读回/完整 revision/编辑互斥 → 将本批存储算法接入宿主保存事务 → Automation 消费统一结果 → 一次性启用 v2/map → 真实工程验收及旧转换器清理。以上是实施顺序，不是对未完成部分的完成承诺。

## 17. 第三批实施记录（2026-09-14）

### 17.1 本批交付与生效范围

本批沿 P1 → P2/P3 推进。设计以“ABI 是完整持久状态、ABS 只表达编辑意图、实际装载结果必须验证”为边界，未增加库级适配清单，也未把新的预览投影混入旧产品语法。

| 模块 | 实际交付 | 生效范围 |
| --- | --- | --- |
| abs-symbols.ts | 统一的模型 ID/名称/类型查找；原生变量与宿主声明的过程等模型表共用；更换引用只选择已有唯一模型，保留未引用行 | v2 核心，尚未接入产品模型协调器 |
| abs-state.ts / abs-identity-map.ts | 基线携带按块字段契约与模型表路径，map 增加 symbols 和 contractsHash；重新投影校验身份及契约，ABS 使用普通带引号名称 | 预览升级为 abs-v2.preview.2；未启用正式新协议 |
| abs-syntax.ts / abs-reconciler.ts | 显式完整定义约束的位置参数；不允许无定义推测、重复绑定或把语句输入当值参数；未编辑字段精确继承，改变的原生 checkbox 使用布尔保存形态 | v2 核心；规范导出继续具名参数 |
| blockly-runtime-block-metadata.ts / abs-runtime-contracts.ts | 提取复用字段契约能力；按实际现存块采集动态选项、数值约束和变量类型；结构化 serializer 不默认冒充文本；回调错误明确失败 | 字段元数据能力与当前产品读回已使用；没有新增探测块或跨 session 缓存 |
| abs-requested-state.ts | 纯读回检查器，比较显式 fields、extraState 和变量模型；只接受验证过的原生 checkbox/变量序列化等价形式 | 已接入当前产品普通/分片导入；不替代 v2 完整连接/隐藏状态/保护比较 |
| abs-auto-sync.service.ts | 装载前保留独立请求快照；装载后采集真实字段契约并读回；不符返回 ABS_READBACK_MISMATCH，调用完整项目模型回滚，不发布 ABS | 当前文件导入、文本导入、force、chunk 共用的装载路径 |
| project-data-codec.registry.ts | 规范化 JSON 接受 Blockly 的无原型字典，保留特殊键；仍拒绝 Date/Map/普通类实例、循环与非法成员 | Project Data 与 ABS 共用 JSON 边界 |

清理与复用：删除旧 runtimeFieldOptions 的强制字符串化/吞异常实现；静态定义复用既有纯模型，动态契约只通过实例桥接模块进入核心；未引入第二套同步服务、字段名白名单、元数据编辑文件或库 i18n 改动。旧 converter 仍有生产调用，暂不删除。

### 17.2 本批确认的边界

1. **模型引用不是模型创建。** 相同显示名但不同类型时，未编辑引用保留既有 ID；更换引用按显式类型约束唯一匹配，否则返回 ABS_SYMBOL_MISSING/AMBIGUOUS。普通 `{id,name}` 载荷不被识别为变量。
2. **实例状态不是类型全局配置。** 同类型的两个块可能有不同动态选项。契约按 blockId 捕获，查询时验证项目/页面/工作区/Generator/Project Data session；新块不能借用另一个块的选项。
3. **库入参不是可靠的读回证据。** loadState/loadExtraState 可以原地修改对象；产品入口使用加载前独立快照比较，避免“候选和读回一起变错”被当成成功。
4. **字段保存值不等于控件展示值。** 实测原生 checkbox.saveState() 返回 boolean；原生变量可能只保存 `{id}`。只对这类经验证契约做规范化，变量的 name/type 另核对实际模型；结构化自定义状态仍精确比较。
5. **当前读回是请求值防护，不是完整无损证明。** 它允许块产生未显式请求的默认字段，但请求的字段、extraState 或模型不能丢失。全部连接、保护属性、布局和工作区 serializer 的等价校验仍属于 v2 接线前置项。

### 17.3 验证记录

| 检查 | 实际结果 |
| --- | --- |
| node node_modules/@angular/cli/bin/ng.js test --configuration=abs-sync --watch=false --browsers=ChromeHeadless --no-progress | 126 项通过，较第二批新增 37 项 |
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过，覆盖尚未接线的 v2 模块 |
| node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json | 通过 |
| node scripts/check-angular-service-architecture.mjs | 158 个服务文件，0 baseline violations，0 cycles，无新增架构债务 |
| development --preserve-symlinks=false | 通过；未修改默认构建配置或依赖锁文件 |
| 默认 development 构建 | 复测仍因 mermaid 的 es-toolkit/compat 解析失败；不能以临时参数构建通过宣称默认构建已修复 |
| git -c core.safecrlf=false diff --check | 通过 |

新增覆盖包括：Unicode 变量名称、类型约束/重名歧义、未引用模型保留、伪造符号绑定/契约拒绝、宿主声明过程表、定义约束的位置参数、同类型不同动态选项、依赖字段最终值、数值范围/精度、未知结构化字段、原生变量/checkbox 连续三轮往返、fallback shadow 读回、库原地改写 extraState、无原型 JSON 字典。

产品入口测试通过真实 Blockly 装载执行：普通路径使用 headless workspace 并替代 render；分片路径使用浏览器实际注入的 WorkspaceSvg。验证非法动态选项失败后恢复原 ID/删除保护、完整模型回滚入参未丢其他页/共享数据、事件计数配对且磁盘 ABS 未写入。文件服务与项目模型宿主仍使用测试替身；这些结果不等同于 Electron 多页工程验收。

### 17.4 下一批明确顺序与未完成项

1. 原生/旧式过程定义及调用的 extraState/共享模型适配：本批通用过程表只覆盖宿主显式声明的**字段引用**，未假定所有库都用同一过程存储形式。
2. 完成候选新增/改形块的契约准备、全部隐藏状态/连接的读回规范化、完整持久 revision 与编辑互斥；错误污染 Runtime 时接入既有 teardown/rebuild，不在半失败会话继续。
3. 将不可变基线存储接到宿主文件编辑锁和已准备项目保存端口，完成活动页 compose/extract；Automation 消费统一提交结果，保留 MIRROR_PENDING 恢复语义。
4. 接入明确节点移动/复制与歧义消除、异步预览/手写大值外置，以及 GC 的基线/回滚/待应用 ABS pin。
5. P0～P5 条件满足后统一切换 v2/map，再用用户工程副本做 Electron 打开/编辑/保存/重开、真实库 C++/.h 与性能验收，最后清理已无调用方的旧转换器。

**仍不能关闭的原问题：生产入口尚未使用 v2 基线合并，deletable:false 及完整身份/隐藏状态丢失尚未整体修复。** 本批读回与回滚防护已生效，但不宣称 P1～P6 全部完成。未写用户工程、未修改或推送 aily-blockly-libraries、未进行开发板测试。

## 18. 第四批实施记录（2026-09-14）

### 18.1 交付与模块职责

本批沿 P1/P3/P5 推进，不改变“完整 ABI 为状态源、ABS 为代码投影、宿主负责提交”的总体决策。

1. **统一读回比较器。** 新增 abs-readback.ts，移除请求字段比较器的重复实现；abs-import-policy 保留策略职责并导出统一比较器。请求模式已经作用于生产导入，新增连接归属、根顺序、显式块属性及任意 workspace serializer 检查。完整模式额外拒绝意外块/模型/状态，只有宿主明确标记的新块允许补入默认值。
2. **明确序列化等价范围。** 原生默认布尔属性、空 data、null extraState、enabled:false 与 MANUALLY_DISABLED、无序变量模型、坐标取整及 checkbox/变量字段按实际 Blockly 行为规范化。未知字段、extraState 成员、连接扩展状态、data/icons 和自定义 serializer 不做字符串化或广泛忽略。连接检查覆盖真实块、next 与 fallback shadow，不仅比较块是否仍存在。
3. **过程签名与身份约束。** abs-procedures.ts 接受宿主声明的状态路径，验证定义、调用、返回形态、参数名/变量 ID，生成 map 符号绑定；v2 合并后校验仍被引用的定义不得消失、调用签名不得漂移。abs-runtime-procedures.ts 单独适配已验证的旧式 Blockly JSON 协议，通过 getProcedureDef/getProcedureCall 能力识别角色，不按块类型名分支。未适配的 model-backed 协议明确拒绝，不静默套用旧式路径。
4. **动态名称语法。** 非标识符字段及输入名称使用 JSON 引号，支持 mutator 参数 ID、Unicode、斜线等真实序列化键；普通名称仍保持原来简洁形式。没有新增 @meta 或模型定义副本。预览版本推进到 abs-v2.preview.3。
5. **固定快照保存端口。** prepared-project-save.ts 将资源外置/校验与文件提交分开；准备产物只包含冻结对象中的字符串，提交不重采工作区。当前 _ProjectService.save 已使用该端口：排队 → 采集完整文档 → 异步准备 → 检查完整文档和磁盘未变 → 唯一临时文件/rename 提交 → 派生代码与元数据更新。
6. **保存上下文与提交点。** 普通保存捕获项目、活动页、workspace、Generator 和 Project Data session；准备期间其他页标题等持久状态改变也会拒绝。rename 前再次检查磁盘，失败只清理本次临时文件。宿主回调在 rename 后抛错时核对实际 ABI 内容，不把已提交当成未提交；提交后上下文过期则保留已保存 ABI、停止派生更新。

清理：将纯 FIFO 移到 shared/concurrency，删除 ABS 专用队列文件及重复字段读回逻辑；抽出全树索引和 JSON Pointer，消除过程适配与投影器的运行时循环依赖；移除保存链中从未实现任何行为的 createHistory 参数，并同步 Automation 端口/适配器/调用方。未删除仍在使用的旧转换器。

### 18.2 实际验证

| 检查 | 结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 151 项通过，较第三批新增 25 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过，包含保存端口及 Automation 调用链签名检查 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；未修改默认构建配置/依赖锁文件 |
| 默认 development 构建 | 上一批已确认 Mermaid 的 es-toolkit/compat 解析故障；本批未将其纳入修复，不宣称默认构建通过 |
| git diff --check | 通过 |

新增测试覆盖：连接断开/跨输入移动但 ID 不变、隐藏属性与 serializer 丢失、根顺序、额外块/模型、原生默认值及禁用原因规范化；原生旧式过程连续三轮加载、定义删除与签名不一致拒绝、参数模型 ID 和不透明 argId 保留、动态名称引号；固定快照、资源准备后 revision 变化、磁盘并发编辑、rename 失败/提交后回调异常、其他页修改、切页/session 失效、保存 FIFO 失败恢复及提交后停止派生写入。

测试没有写用户工程或库包。文件提交测试使用内存文件端口；真实 Blockly 过程测试在浏览器工作区执行。它们不替代 Electron 文件锁、多页真实工程、崩溃恢复或实际库生成 C++ 的验收。

### 18.3 尚未完成的事务边界

- **生产 v2/map 仍未启用，原 deletable:false/完整身份丢失问题仍未整体关闭。** 当前生产导入使用的是请求模式；完整比较、过程路径契约和 v2 合并仍需由统一协调器接线。
- prepareSave/commitPreparedSave 已是实际产品保存端口，但尚未与 AbsBaselineStore 的 prepared/committed 日志、宿主 Agent 文件编辑锁及 MIRROR_PENDING 返回契约连接。Renderer 内容比较和单文件 rename 不是跨进程 CAS。
- 普通保存现在对完整文档做内容检查，但 ABS 导入仍缺少跨全部页面的统一持久 revision 与工作区编辑互斥；检查不能替代阻止并发 UI/Agent 修改。
- 旧式过程适配器不覆盖所有 model-backed/自定义过程 serializer；新增/改形过程块的契约准备和跨页共享引用验证仍需补齐。本批没有更改库或补造过程模型。
- 静态核对发现 BlocklyService 当前以 procedures_ 前缀归入 sharedModel.procedureBlocks，范围也包含调用块。后续页面模型接线应明确“定义共享、调用归页”，并先处理旧快照中已共享调用的归属；不能直接过滤或删除来源不明的共享调用。此项为源码发现，未改写用户现有项目。
- Runtime 污染后的隔离重建、任意自定义 workspace 大载荷外置、异步预览/手写大值准备、GC pin、显式节点移动/复制及 Electron 性能验收仍待执行。

下一批顺序：页面/共享模型的 compose/extract 与所有权 → 新增/改形块及过程契约 → 导入完整 revision/编辑互斥和 Runtime 失败恢复 → 保存端口接宿主文件事务/基线发布 → Automation 统一提交结果 → 整体启用 v2 并做真实工程副本验收。不要再扩展另一套保存或同步实现。

## 19. 第五批实施记录（2026-09-14）

### 19.1 本批交付与边界

本批落实上一批发现的页面归属问题，并贯通现有模型和保存入口。仍以“ABI 保存完整状态、ABS 表达目标页编辑、宿主负责事务”为边界，没有增加库适配清单或 ABS 元数据语法。

1. **纯页面模型。** 新增 blockly-project-model.ts，集中实现 normalizeBlocklyOwnership / composeBlocklyPage / replaceBlocklyPageWorkspace。合并官方变量表时保留未引用行和扩展属性；相同 ID 的冲突模型明确拒绝。检查范围覆盖所有页面、共享根、子块、next 和 fallback shadow 的重复身份。函数不操作 Blockly、文件或 UI，输入保持不变。
2. **能力与所有权解耦。** blockly-root-role.ts 从当前实际实例采集旧式 getProcedureDef/getProcedureCall 或 model-backed isProcedureDef/getProcedureModel 能力，静态注册定义仅作已有直接能力的补充。不创建探测块，不按库名/类型前缀判断，不复用跨 session 缓存，实例匹配同时检查 ID 和类型。识别 model-backed 定义/调用角色不代表已支持其 ABS 参数协议。
3. **历史归属处理。** 定义共享、调用归页；旧共享调用可以由单页、唯一一致的页面副本或显式 owner 记录恢复归属。多页且无证据时返回 BLOCKLY_SHARED_OWNER_REQUIRED，原输入不变。未知共享根保留；冲突副本、错误列表和重复身份不再被过滤成“正常空数据”。显式归属参数已在纯模块提供，尚无产品归属选择 UI。
4. **完整文档保存。** BlocklyService 接入纯模型；getProjectDocument 只返回快照，不再顺带更新页面 Subject。显式切页/装载才发布模型；非法目标页在修改前拒绝。单页也保存完整 schemaVersion:3 文档，保留标题、视图、标签以及项目/页面/sharedModel 扩展信息。旧工作区形态仍可读入，但后续保存不再压平。未保存比较统一使用规范化 JSON，防止重开后的键插入顺序误报。
5. **同一 renderer 操作队列。** ABS 文件/文本导入、force、chunk、导出和普通保存统一使用 BlocklyService.runProjectOperation；删除两个服务各自维护的队列实例。排队任务仍使用入队时捕获的 project/page/workspace/Generator/Project Data session，不能在旧任务排队期间自动改绑新上下文。导入和导出在异步准备后补充完整文档内容检查，覆盖不影响代码 revision 的其他页元数据变化。
6. **回滚限定写入范围。** restoreProjectWorkspaceSnapshot 用原完整快照恢复活动页工作区及其共享模型，再与当前存储模型组合；不会重放旧标题、标签或其他页内容。跨页恢复明确拒绝。它已接入当前 ABS 装载失败路径，不是只在测试中使用的辅助函数。

清理：删除 procedures_ 前缀策略、旧 normalizePageContent / extractSharedModel / stripSharedModel / composeWorkspacePayload 等重复实现和单页压平分支；模型类型移到纯模块并保留原入口的类型导出。没有新增第二个同步服务，没有修改 aily-blockly-libraries，也没有改写用户工程。

### 19.2 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 171 项通过，较第四批新增 20 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；默认配置和依赖版本未修改 |
| 默认 development 构建 | 未作为本批修复项；前批确认的 Mermaid/es-toolkit 解析问题仍单独保留，不宣称默认构建通过 |
| git diff --check；本批相关未跟踪文件单独检查 | 通过 |

新增覆盖包括：纯模型两页/共享变量/定义/调用三轮组合提取；旧共享调用的单页、显式归属、页面副本、歧义及冲突；未知根保留；嵌套块/备用 shadow 跨页身份冲突；完整单页保存与重开；快照读取不发布状态；实际 Blockly 原生过程跨服务切页三轮且定义删除保护不变；其他页元数据准备期并发编辑；130 个真实渲染块分三批导入时普通保存等待读回完成；回滚保留并发页面重命名；保存键顺序变化不误报脏状态。

测试使用真实 Blockly headless/WorkspaceSvg，UI 周边及文件端口仍有替身。上述结果不等同于 Electron 工程副本、真实库 C++/.h 生成、宿主崩溃恢复或性能验收。用户项目和库均未写入。

### 19.3 仍未完成及下一批主线

- **生产入口仍使用旧 converter；v2/map 尚未启用，原 deletable:false/完整身份丢失问题仍不能整体关闭。** 本批已修复页面模型及当前并发边界，不宣称新协议已正式接线。
- 共享定义/变量改变时仍需检查其他页的引用；单独完成 compose/extract 不能证明跨页语义一致。候选新增/改形块、model-backed 过程参数/serializer 契约及显式移动/复制仍待实现。
- 共用 FIFO 只串行化这组 renderer 入口，不阻止 UI 直接改块、页面操作或宿主 Agent 文件修改。完整持久 revision、工作区编辑租约、回滚期间共享模型并发修改检查及 Runtime tainted 后 teardown/rebuild 仍是统一事务的前置条件。代码 revision 驱动的镜像缓存也尚未替换为完整持久 revision。
- prepareSave/commitPreparedSave 还需连接 AbsBaselineStore、宿主文件编辑锁、prepared/committed 和 MIRROR_PENDING；Automation 仍为导入后另行保存，尚不构成一个原子操作。
- Project Data 的异步预览、手写大值准备、自定义 workspace serializer 外置及基线/回滚/未应用 ABS 的 GC pin 仍待完成。本批完整文档保留不等于这些载荷已全部外置。
- 完整快照内容检查目前仍有重复序列化/复制成本；后续以持久 revision 统一采集与缓存，需以大项目实测验证，不能仅凭架构调整宣称性能改善。

下一批依次推进：候选新增/改形块与跨页过程引用契约 → 完整持久 revision/编辑租约和 Runtime 恢复 → 复用现有保存端口接宿主事务及基线发布 → Automation 统一结果 → 整体切换 v2/map 并执行真实工程副本验收。继续保持库只读，不并行扩展另一套转换器或保存实现。

## 20. 第六批实施记录（2026-09-14）

### 20.1 交付及职责划分

本批沿 P1/P3/P5 推进，先明确两个事实：代码生成事件不能代表全部持久状态；FIFO 不能替代工作区编辑所有权。未活动页也不能通过临时创建探测块来猜测模型引用。

1. **跨页引用校验器。** abs-project-references.ts 复用 AbsSymbols、过程路径契约和完整块索引。宿主提供明确的字段/过程引用契约、块 ID/type 覆盖和已证实不含模型引用的 serializer 清单后，检查其他页变量删除/类型改变、过程删除/改名/签名漂移，以及同名模型被替换成不同 ID 的隐式改绑。备用 shadow 也参与校验，普通 JSON 中的 id 不会自动变成引用。原生空变量表、缺省 type 和变量行顺序按已验证语义比较。
2. **生产共享变更门禁。** 当前 ABS 导入在 native load 前及实际读回后，使用页面模型构造完整候选并验证共享变更。现阶段尚未采集其他页的完整契约，因此影响一个有内容/serializer 页面所依赖的共享状态时，返回 ABS_SHARED_CONTRACT_REQUIRED，不冒险加载。共享状态不变的目标页编辑不需要其他页契约；只有空 blocks 且无其他载荷的页面才可视为无引用。
3. **独立持久状态 revision。** blockly-project-revision.ts 通过规范化 JSON 观测完整文档内容；布局、保护、视图、其他页和 serializer 变化均可使 revision 前进，不再借用代码生成计数。captureProjectSnapshot 统一返回文档与 revision，ABS 与普通保存复用。文件导出先 flushPending 再判断缓存；隔离/装载中的镜像不会报告 clean，也不对中间分片采集可提交 revision。该实现仍按内容采集，不能宣称已实现事件驱动增量缓存或性能优化。
4. **显式工作区租约。** blockly-workspace-edit-lease.ts 提供唯一 owner、过期验证、幂等释放和隔离状态；BlocklyService 持有并管理 native 输入边界。ABS 普通/分片导入从准备到读回/回滚持有租约；切页、建页、重命名、公开装载和完整快照访问要求正确所有权。输入边界不修改 block.deletable/movable/editable 或 workspace.readOnly，避免锁本身污染保存结果。锁只阻断工作区鼠标/触摸/快捷键输入，不阻断其他文本编辑器。
5. **Agent 积木操作收口。** Automation 的 abi_add/delete/connect/set_field 及 tidy 修改段复用同一个 renderer FIFO。适配器在排队前捕获工程/页面/workspace/Generator/Project Data session，执行前及异步返回后验证，直接取得工作区也受门禁保护。只将变更段排队，保存留在外层，避免重新进入同一队列造成死锁；因此普通 Agent 修改与后续保存仍不是一个原子事务。
6. **回滚读回与隔离。** ABS 装载前另存原始工作区独立快照及字段契约。回滚函数返回后必须通过完整读回比较，不能以“未抛错”证明恢复成功。恢复异常或静默丢失身份/保护/状态时，保留输入 ABS，不发布镜像，并隔离当前 workspace：后续保存、导出、Agent 访问和公开工程快照被拒绝。新 workspace 激活才清除隔离；旧租约不能释放或污染新 workspace。代码缓存失效移到最终装载/回滚之后，防止中间分片的生成结果继续被当作最新代码复用。

清理与复用：移除 ABS/保存入口重复的 JSON 字符串比较，统一使用快照 revision；内部镜像计数明确命名为 project revision，保留既有外部字段名；Agent 排队包装抽成一个方法，tidy 恢复原事件组而非强制设为 false。继续使用现有页面模型、读回器、符号表、FIFO 和保存端口，没有新增平行的转换器或同步服务，没有修改库包。

### 20.2 行为变化及边界

- **安全限制是有意的。** 旧 converter 会重建部分共享模型身份；若其他页契约尚不完整，这类多页 ABS 编辑现在可能被明确拒绝。正确后续工作是完成宿主契约采集和 v2 基线合并，不是按类型/字段白名单放行，也不允许关闭引用检查来恢复旧行为。
- 当前输入租约覆盖 native UI、页面服务、ABS 和接入端口的工作区访问，不是对任意 JavaScript 回调的沙箱。库 timer、保存了原始 workspace 引用的旁路代码、自定义弹窗异步回调及宿主文件编辑仍需完整生命周期/宿主事务审计。普通 Agent 变更主要通过 FIFO 隔离，不把它与 ABS 专用租约混为一谈。
- 隔离后的产品恢复方式目前是关闭再重新打开工程；尚未自动执行 Runtime teardown/rebuild，不能在当前 Realm 内简单清空错误标志继续。此时未保存内存状态尚无独立宿主恢复包，仍是下一阶段恢复机制的前置项。
- 显式跨页契约校验算法已完成，但未活动页/model-backed/自定义 serializer 的完整契约采集未完成。serializer 清单只允许宿主证明无模型引用的载荷，不能把任意未知 serializer 标为“已支持”。

### 20.3 验证记录

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 198 项通过，较第五批新增 27 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；默认构建配置、依赖版本和锁文件未修改 |
| 默认 development 构建 | 未修复/未重新宣称通过；前批 Mermaid/es-toolkit 解析问题仍单独保留 |
| git diff --check 及本批未跟踪文件单独检查 | 通过 |

新增测试覆盖跨页变量/过程引用、同名不同 ID 替换、契约空洞、未知 serializer 和备用 shadow；布局/保护/自定义载荷 revision、缓存前 pending flush；租约重入/伪造/失效、native 输入及其他编辑器、页面门禁、序列化保护不被锁改变；Agent 排队及开始前/异步结束后上下文变化；回滚异常/静默丢保护后的隔离，重新激活及旧租约清理。既有 130 块三批导入用例补充验证代码缓存只在最后失效，普通保存等待读回完成。

浏览器测试包含真实 Blockly headless/WorkspaceSvg；文件、UI 周边及部分宿主服务使用替身。没有运行用户工程副本的 Electron 验收、真实库 C++/.h 生成、宿主崩溃恢复或性能基准；没有写用户工程、修改或推送 aily-blockly-libraries。

### 20.4 下一批明确主线

1. 补齐新增/改形块和未活动页的引用契约，特别是 model-backed/自定义过程 serializer；不靠临时 probe 或复制另一实例的动态字段契约。
2. 把不可变基线存储接到既有 prepareSave/commitPreparedSave 和宿主文件事务，绑定准确的提交点、prepared/committed、MIRROR_PENDING 与恢复资源根。
3. 完成 Runtime 自动恢复、未保存快照保全、旁路异步写入审计、Project Data 异步预览/手写大值/自定义 serializer 外置及 GC pin。
4. Automation 消费统一提交结果，补齐节点显式移动/复制，再一次性切换 v2/map，执行真实工程副本与性能验收。

**生产同步仍使用旧 converter；本批没有正式启用 v2/map，也不能整体关闭原完整身份/deletable:false 往返问题。** 已完成的是当前入口的并发、跨页安全门禁与失败恢复验证；后续应复用这些边界继续接线，而不是再增加一条保存/转换路径。

## 21. 第七批实施记录（2026-09-14）

### 21.1 实施顺序与设计依据

本批推进 P4 以及相关的 P3/P5 准备边界。第 20.4 节所列完整契约采集和宿主事务仍有前置项：当前仓库未确认可直接复用、覆盖 Agent 写入的统一宿主文件锁，不能用 renderer FIFO 冒充跨进程 CAS；未活动页/自定义模型也不能借另一个实例的动态契约放行。因此先落实已有保存/加载入口可以独立使用的资源能力，不提前切换 v2，也不新增平行保存服务。

第一性原理边界：**资源层负责保存原值，不理解库业务；语法层只修改有证据的代码字面量；宿主在准备完成后才允许库消费；无法表达的状态必须拒绝丢弃。** 原始值和引用是同一值的两种存储形态，不是另一份可独立修改的模型。

### 21.2 本批交付

1. **结构化 payload 遍历。** project-data-payloads.ts 按完整项目的 pages/content、sharedModel、工作区 serializer 和块连接进入对应边界，替换原先在任意对象里寻找 fields/extraState 的遍历。自定义 serializer 被视为不透明载荷，内部恰好出现 type/id/fields 不会被误认成块。继续覆盖无 ID 的未装载块、独立剪贴板块、next 和 fallback shadow。
2. **统一 ABI 外置/还原。** 工作区 blocks、官方 variables 身份表和 Project Data marker 保留结构；其他顶层 serializer 可按 UTF-8/规范 JSON 字节阈值外置。官方变量行仅扩展属性可外置，id/name/type 保持内联。项目/页面标题、视图及未知元数据不冒充 serializer。保存、项目打开时的通用还原和未保存比较复用同一遍历；混合引用载荷继续保持已有资源根可见。
3. **异步 ABS 资源准备。** abs-project-data.ts 只协调已有资源端口，不操作 Blockly 或镜像文件。预览/导出/导入共用外置、flush、prepare、按需还原，所有异步资源读写前后验证上下文。getWorkspaceAbsContent 返回 Promise，失败不再吞成空内容；预览不发布文件、行号映射或 clean revision，但可能生成内容寻址的不可变资源。仓库当前无该旧同步 API 的生产调用方，未新增预览 UI。
4. **手写大值在装载前处理。** 纯 converter 默认仍拒绝超限候选；只有宿主导入准备显式获取待外置 draft，随后必须经过统一资源准备及原生读回。普通、文件、force 和 chunk 路径没有另设分支。原始草稿、库入参及读回证据保持独立；资源失败、上下文失效或装载失败时不发布压缩后的 ABS。
5. **最小原文替换。** 复用现有 JSON token 扫描和 JSON Pointer，只把本次外置的具名字段 JSON 或 @extra 字面量替换成 Envelope。匹配按规范化值及出现次数核对，不做全文字符串替换；注释、CRLF、空行、未引用 @var 声明和其他代码原样保留。混合对象和显式旧 @json 字段传输也可处理。大值位置参数、单引号和无法定位的推导值返回 ABS_DATA_LITERAL_REQUIRED，不能通过整份重新导出来“修好”源位置。小值原有语法不受此限制。顺带修复旧 parser 将 TEXT = value 误作位置参数的问题。
6. **防止 serializer 静默丢失。** 源码确认旧 converter 不输出自定义 workspace serializer。现在直接 ABI→ABS、服务导出/预览及导入前检查实际工作区；发现无法表达的 serializer 时返回 ABS_WORKSPACE_SERIALIZER_UNSUPPORTED，在资源写入/清空工作区/写 ABS 前停止。ABI 保存和图形编辑不因此禁用。这里只判断存储边界，不添加字段、块类型或库白名单。
7. **保存与反馈补齐。** prepareBlocklySave 每次资源写入前后也检查当前工程/页面/revision，避免一轮外置跨越上下文后继续处理后续资源。Automation 将成功外置时的提示带入操作结果；不把已有“导入后再保存”的流程宣称为统一原子提交。

清理：删除同步预览的独立直转和吞错路径，移除导出/导入重复资源准备代码；没有新增 serializer 注册表、临时探测块、库包配置或 i18n。旧 converter/parser 仍有既有能力探测与协议限制，不宣称本批已经移除整条旧路径。

### 21.3 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 226 项通过，较第六批新增 28 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；未更改默认构建配置、依赖版本或锁文件 |
| 默认 development 构建 | 本批未修复/未复测此前 Mermaid/es-toolkit 解析问题，不宣称默认配置通过 |
| git diff --check 与本批相关未跟踪文件检查 | 通过 |

新增覆盖：自定义 serializer 无 blocks/未知内部结构、完整多页与共享模型扩展属性、2000 块和变量表不被当作大载荷、混合引用发现、真实 Blockly serializer 三轮保存/还原/加载；准备中每个异步阶段失效、首个资源后停止后续写入；普通/分片导入大文本与数组、压缩后再次导入、预览不发布、资源失败不清空、装载失败恢复保护块并保留输入；具名参数等号空白、原文注释/换行/声明保留、重复字面量出现次数、无法定位的输入明确拒绝。

资源和文件端口使用测试替身，工作区和 serializer 使用真实 Blockly。测试没有覆盖 Electron 宿主文件锁、崩溃恢复、真实库 C++/.h 或性能基准；没有改写用户工程、修改或推送 aily-blockly-libraries。

### 21.4 尚未完成与下一步

- **生产 v2/map 尚未启用，原身份/deletable:false 的整体往返问题仍不能关闭。** 本批的资源保真与显式拒绝不替代基线合并。
- 新增/改形块、未活动页、model-backed 过程和自定义 serializer 的**引用语义契约**仍待采集。能外置/还原某个 JSON 不代表已经理解其中的模型关系；旧转换器的 serializer 门禁只能在 v2 完整保留、读回和跨页引用验证接线后移除。
- 精确的 v2 AST 源绑定需覆盖大值位置参数、单引号和推导状态。当前命名 JSON 路径已可用，但不能据此勾选“所有语法/所有生产入口已统一”。
- 不可变基线、prepareSave/commitPreparedSave、prepared/committed、MIRROR_PENDING 和 Agent 宿主文件锁仍需接线；恢复包、Runtime 自动恢复及旁路异步回调审计没有完成。
- 基线/回滚/待应用 ABS/预览候选的 GC pin 与释放仍未实现。失败或预览产生的不可变资源不会在本次操作中主动删除，但这不是 GC 生命周期保证；完整根集合和并发删除隔离必须在启用破坏性回收前补齐。
- 内容观测 revision 与逐资源断言仍可能重复序列化完整文档；本批没有大项目性能数据，不宣称保存卡顿已彻底解决。

下一批回到核心接线：实际实例契约与候选覆盖 → 宿主共享文件事务/不可变基线及资源根 → 恢复与 Automation 统一提交结果 → v2/map 整体切换和用户工程副本验收。继续只改主程序，复用已建立的模块与端口。

## 22. 第八批实施记录（2026-09-14）

### 22.1 本批范围与设计边界

沿第 21.4 节主线，先推进 P1/P3 的实际实例引用契约及 P5 的注册生命周期边界。第一性原理：**只有实际实例和已验证的序列化协议，才能证明模型引用覆盖完整；保存了 JSON、识别了块类型或当前 getter 返回空，都不能单独作为证明。** 不创建临时探测块、不修改库包，不用某个库的字段名推断引用。

宿主共享文件锁、候选新增/改形实例准备仍未完成。本批不提前接通 v2/map，不把 renderer FIFO、内容检查或页面契约缓存当作跨进程事务。

### 22.2 已完成的模块与接线

1. **实际页面引用采集。** 新增 abs-runtime-references.ts，复用字段、符号表及旧式过程适配器。核对真实工作区与输入快照的块状态、变量表和连接；只对已验证原生字段构造器及明确的旧式过程序列化协议声明完整覆盖。变量字段绑定模型 ID，过程定义参数及调用绑定定义中的参数 ID；getVars/getVarModels 的结果必须与已解析引用一致。非过程块覆写这两个 getter 时，即使当前返回空也不宣称理解其协议。
2. **纯证据缓存。** 新增 abs-reference-contract-cache.ts，只存规范化快照和可序列化契约，不保留 Blockly 实例或回调。作用域绑定 workspace、Generator 实例和 Project Data session；匹配要求完整 composed workspace 相同，包含共享变量/定义。每块另存状态指纹，修改字段、形状或共享定义后不能借用旧实例证据。页面标题和打开标签不在该工作区指纹中，单独修改它们不会使引用证据失效。
3. **有界保留及保守降级。** 缓存字符串合计最多 4 × 1024 × 1024 个 UTF-16 代码单元；单项超限不保留，容量不足淘汰最早保留项，删除页面时清理证据。返回值反序列化为独立副本，调用者无法污染缓存。证据缺失或被淘汰后，共享变更恢复为明确拒绝，而非跳过校验。此限制仅约束保留字符串，不包含瞬时序列化副本及对象开销，不是保存性能已优化的结论。
4. **复用页面持久化边界。** BlocklyService 在实际页面装载/访问及离开前持久化时采集证据；ABS 共享变更的预检和读回消费匹配证据并要求正确租约。已访问且协议覆盖完整的其他页面，可以证明某共享变量/定义没有被引用，从而允许删除；仍有引用、同名不同 ID 替换、候选块状态变化或契约缺失继续拒绝。共享状态变化会使旧页面证据保守失效，需要重新采集。
5. **生产过程读回。** ABS 清空前校验实际旧式过程契约；候选原生装载后再次采集并验证定义、调用和参数关系。真实原生过程新增定义与调用可通过；没有匹配定义的新增调用返回 ABS_PROCEDURE_INVALID，经完整回滚后不发布 ABS。它不替代新增/改形块的完整装载前候选契约，也不等于已支持 model-backed 过程。
6. **采集副作用防护。** 即使字段/模型 getter 抛错，也在 finally 中复核工作区序列化结果和上下文；发生修改时禁止继续发布较旧的页面快照。采集期间页面元数据变化同样阻止覆盖新模型，保留最新标题；库注册导致缓存代次变化时，旧采集不得重新填充过期证据。原生保存回调执行后再次验证上下文。
7. **注册入口与清理。** loadLibrary、loadLibBlocks、loadLibGenerator 在对应入口检查编辑门禁，块/Generator 注册前清除页面契约证据；忙碌错误不进入 Generator 失败销毁分支。移除全仓库无调用的 loadLibBlocksJS 主页面 script 注入入口，继续使用现有隔离 Runtime 加载路径。未引入新的注册器、同步服务或库端配置。

### 22.3 支持范围与失败策略

- 本次覆盖是“实际访问过的页面 + 已验证原生字段/旧式过程协议”，不是任意未活动页。没有访问过的页以及仅在序列化中存在、没有实际实例的休眠 shadow，仍不能取得完整证据。
- 自定义字段子类、额外变量 getter、未知 extraState、非空 data、icons、变量扩展属性及自定义 workspace serializer 需要显式引用适配器。未知能力不阻止普通图形编辑和切页，但不会产出可用于放行共享 ABS 变更的完整契约；检测到采集实际改变了状态时，则停止本次发布。
- 生产 ABS 过程检查也可能拒绝尚未适配的过程协议；不能通过略过读回来兼容。原始旧转换器和 dormant shadow 的能力限制未在本批整体解决。
- 页面引用缓存仅用于相同状态的引用安全证明，不能作为动态字段值/默认值的跨操作缓存，更不能为另一实例或新增块提供契约。
- 注册入口门禁不等于已审计所有异步回调、任意持有 workspace 引用的代码或宿主文件写入；Runtime 自动恢复与完整保存事务仍待实现。

### 22.4 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 255 项通过，较第七批新增 29 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；未更改默认构建配置、依赖版本或锁文件 |
| 默认 development 构建 | 未修复/未复测此前 Mermaid/es-toolkit 解析问题，不宣称默认配置通过 |
| git diff --check 与本批相关未跟踪文件检查 | 通过 |

新增覆盖实际原生字段/过程参数引用、未知状态与自定义模型能力、休眠 shadow、快照块/模型不一致、getter 修改后抛错；缓存会话隔离、共享状态失效、独立副本、容量淘汰与页面清理；已访问页未使用变量/定义删除和仍有引用的拒绝；注册入口租约、Project Data session 失效、采集期间工作区/页面元数据/注册变化，以及生产新增有效过程和孤立调用回滚。

测试使用真实 Blockly 工作区，文件和部分周边宿主服务使用替身。未执行 Electron 用户工程副本验收、真实库 C++/.h 生成、宿主崩溃恢复或性能基准。没有写用户工程、修改或推送 aily-blockly-libraries。

### 22.5 剩余主线与完成判定

1. **补齐候选与协议覆盖。** 未访问页、休眠 shadow、自定义字段/模型/serializer、model-backed 过程及新增/改形块，需要宿主明确的实例准备和引用协议；不能把本次保守缓存扩展为按类型猜测的通用契约。
2. **接通真实提交点。** 确认 Agent 与应用共同遵循的宿主文件锁，连接不可变基线、prepareSave/commitPreparedSave、prepared/committed、MIRROR_PENDING 和恢复记录；同时实现基线/回滚/待应用 ABS/预览候选的资源根及 GC pin。
3. **闭合恢复及调用链。** 保全未保存工作区、实现 Runtime 自动恢复、审计旁路异步写入；Automation 消费统一原子提交结果，补齐显式移动/复制以及大值 v2 AST 源绑定。
4. **最后切换生产并验收。** 所有入口接入 v2/map 后，以真实工程副本验证 ID、deletable:false、保护删除、跨页引用、大值往返及生成文件；另行执行性能基准。

**生产同步仍使用旧 converter，原完整身份/deletable:false 往返问题尚不能整体关闭。** 本批交付的是实际实例引用证据及生产过程/注册安全边界，不是 v2 正式切换或宿主事务完成。

## 23. 第九批实施记录（2026-09-14）

### 23.1 本批推进范围

沿第 22.5 节推进大值 v2 AST 源绑定及 P4/P5 准备边界。再次核对现有写入接口后，仍未确认可复用、覆盖 Agent 和应用写入的共同宿主锁；未访问页/自定义模型完整实例契约也尚缺前置能力。因此本批完成可以独立验证的合并与资源准备衔接，不另建文件事务或提前切换生产转换器。

设计原则：**ABI 中哪个值变成资源，必须由它的语法来源决定改写哪里；相同文本、字段名相似或出现次数不能替代来源绑定。** 语法层只提供字面量位置，合并层提供候选身份/路径，资源层保存原值，宿主仍负责实际读回和提交。

### 23.2 已完成

1. **字面量位置来自解析器。** AbsSyntaxNode 增加本次源文件的 fieldRanges/extraRange，精确记录 UTF-16 起止位置；不写入 ABS 或持久 map。位置参数按明确的 argumentOrder 绑定字段，具名参数、带 JSON 引号的字段名、内联输入、语句链和 @next 使用相同路径。空输入不被误记成字段字面量。
2. **单引号采用严格词法语义。** 复用共享词法模块新增的 readAbsSingleQuotedToken，支持 JSON 转义及转义单引号，不执行 JavaScript。换行必须转义，不接受未知转义、裸控制字符或未闭合字符串。规范导出仍用 JSON 双引号；@extra 保持严格 JSON，不添加另一种对象格式。
3. **严格合并与未准备草稿分开。** 原 reconcileAbs 仍在返回前检查超限；资源协调器使用 reconcileAbsDraft。草稿已经完成基线/map 校验、身份匹配、删除保护及已知过程检查，但允许暂时存在待外置大值，禁止直接加载/保存。候选字段/extra 的源绑定复用 collectProjectDataPayloads 遍历，不新增 ABI 图扫描器；保留本次实际使用的显式字段契约，供后续资源语义检查。这不等于采集了新增块的完整动态 Runtime 契约。
4. **独立纯源替换器。** abs-source-edits.ts 以候选 ABI JSON Pointer 定位对应字面量，检查位置、原值、字段转换差异以及重复/重叠替换。混合载荷内的资源替换通过相对 JSON Pointer 定位，正确处理数组、空字段名、斜杠、波浪号和 __proto__ 键。相同文本的其他参数、参数名称、注释和继承的隐藏状态均不是目标。只重写受影响的字面量，其余源字节不变；被重写 JSON 字面量内部的空白/键顺序不承诺保留。
5. **v2 异步准备衔接。** abs-prepared-reconciliation.ts 复用现有合并算法与 prepareAbsProjectData，产出压缩工作区、原始 inputAbs、替换后的 abs、身份变化集合及按需 materialize。先完成保护/身份预检，才开始资源 I/O；每个异步资源边界沿用上下文检查。压缩时不再次合并或分配 ID；不操作 Blockly、ABI/ABS/map 文件、提交 generation 或 clean revision。
6. **准备证据隔离接入现有产品路径。** prepareAbsProjectData 在资源准备前保存紧凑文档字符串；prepareValue 回调、返回 document/externalized 和每次 materialize 不共享可变证明。准备回调改参数、调用方改返回对象或原生加载修改上一份还原结果，都不能改变随后还原的原值。原始大文本不额外写入另一份文件；此调整仍可能增加紧凑快照复制，不宣称已解决大工程卡顿。
7. **模型路径不能被通用外置吞掉。** abs-resource-contracts.ts 依据已声明的字段符号、过程 name/parameters 路径和工作区模型表 id/name/type 路径，检查外置前后可见状态；包括本次显式提供给新增字段的符号契约。若资源 Envelope 遮挡这些语义路径，返回 ABS_DATA_MODEL_PATH，需要模型感知的存储适配再放行。它是独立纯检查，不按库、块名或字段名判断，不把未知模型协议宣称为已覆盖。
8. **生产格式门禁。** 当前 ABS 普通、分片及文件导入在准备资源/清空工作区前拒绝 ABS Schema 声明；v2 和未知版本不能误走旧 converter。现有仅含 Project Data Schema 1 的生产源仍按原流程处理。此门禁是防误用，不是 v2 生产接线。

模块复用与清理：把原合并核心提取为可复用的草稿准备，严格入口只增加超限断言；AST/ABI 路径使用现有索引和 payload 遍历，字段单引号解析共用词法实现。未新建转换器、库适配白名单、资源格式或保存服务。旧版按字面量内容匹配的 compactAbsProjectDataLiterals 仍有生产调用方，暂时保留，待整体切换后删除，不能提前移除。

### 23.3 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 291 项通过，较第八批新增 36 项 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 159 个服务文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；默认构建配置、依赖及锁文件未修改 |
| 默认 development 构建 | 未修复/未复测此前 Mermaid/es-toolkit 解析问题，不宣称默认配置通过 |
| git diff --check 与本批相关未跟踪文件检查 | 通过 |

新增回归覆盖：UTF-16/中文/emoji/CRLF 与复杂转义；位置参数、单引号、连续块、重复大值、混合嵌套数组和 @extra；精确路径与过期/重复/重叠绑定拒绝；原生 Blockly 文本字段三轮资源准备/投影/合并/装载并保持 ID 与 deletable:false；可见 shadow、隐藏 fallback 和工作区 serializer 保留；基线损坏/保护删除在 I/O 前失败、资源各阶段失败与上下文失效；准备回调与返回对象篡改隔离；已声明模型路径被隐藏的拒绝；旧生产入口的格式门禁。

大值准备测试的资源端口使用内存替身，原生字段装载使用真实 Blockly；这不是磁盘资源哈希、Electron 宿主事务或真实库生成验收。没有写用户工程、修改或推送 aily-blockly-libraries，也没有运行 C++/.h、开发板或性能基准。

### 23.4 尚未完成及下一批主线

- **生产仍使用旧 converter。** 本批 v2 位置参数/单引号大值能力仅接到内部准备 API；旧生产入口仍有第七批的语法限制，完整身份/deletable:false 问题尚不能整体关闭。
- 推导值、缺省值及没有对应原文字面量的状态，不能用反向猜测改写；新字段契约不代表已完成新增/改形块或未访问页的真实实例协议。model-backed 过程、自定义模型、休眠 shadow 的完整引用覆盖仍待实现。
- 当前可保留不透明载荷，但不能把模型路径所在整个容器外置后继续假定路径可读。模型感知的外置/投影适配属于后续契约工作；本批先明确拒绝。
- 资源准备失败可能留下未被提交引用的不可变文件，本批没有删除这些文件，也未完成 GC pin、跨进程回收隔离和完整恢复根。词法扫描并非完整 GC 根集合。
- 宿主共同文件锁、不可变基线真实存储、prepareSave/commitPreparedSave 提交点、prepared/committed、MIRROR_PENDING、未保存快照及 Runtime 自动恢复仍需闭合。
- 下一步优先落实共同宿主写入边界与恢复资源根，并补齐候选/跨页契约；随后让 Automation 消费统一提交结果，整体切换 v2/map，移除旧转换/替换入口，执行真实工程副本及性能验收。

## 24. 第十批实施记录（2026-09-14）

### 24.1 本批范围与依据

本批直接推进第 23.4 节的宿主写入边界。现状确认：普通保存仍在 renderer 辅助函数中写临时 ABI 并 rename，ABS 镜像仍经 ElectronService.writeFile 直接覆盖；独立 Agent 已不在当前主程序的旧 Chat 文件写入服务中，旧 workspace-mutation 测试引用的历史服务不存在，不能拿它当作共同锁实现。

第一性原理：**文件提交由持有文件能力的一侧验证原始字节并完成；是否已提交以回执/实际字节判断，不以 Promise 是否抛错判断。** 本批建立主程序可实际使用的单文件提交边界，不假称已经锁住独立 Agent、所有项目写入或任意外部进程。

### 24.2 已交付及清理

1. **宿主单文件写入器。** 新增 electron/project-file-writer.js，经既有 preload fs 桥暴露 replaceProjectText。只接受绝对工程路径和 project.abi / project.abs / project.abs.map.json 三个固定镜像名，不接受任意相对路径或删除操作。工程根使用 realpath，拒绝链接的内部存储目录、链接/多硬链接的目标文件和超限镜像；输入及已有镜像均限制为 128 MiB。它不是通用文件管理 API，也没有另建 Project Data 格式。
2. **协作进程共享工程锁。** 主程序通过工程内 .aily/project-files.write.lock 的 wx 独占创建获取锁；不同镜像、不同 preload/进程使用同一位置。默认等待上限为 5 秒，等待期间检查上下文。锁包含 PID 和随机 owner token，释放前检查归属；不按年龄、不可读内容或 PID 猜测自动抢锁，避免双写。该锁仅约束接入此协议的写入者。
3. **固定字节提交。** 按预期 SHA-256 检查初始磁盘内容，异步写独占随机临时文件并 sync，在锁内再次检查上下文和实际字节，最后原子 rename 并核对结果。最终 guard → 字节检查 → rename 段没有 await，避免 renderer 上下文检查与本次实际写入之间再次让出事件循环。只有自己的临时文件被清理；不删除资源、基线或其他操作的临时文件。不宣称具备目录元数据 fsync、断电一致性或完整多文件原子性。
4. **窄客户端端口。** project-file-publication.ts 只负责请求哈希、上下文断言和 COMMITTED / CONFLICT / NOT_COMMITTED / UNKNOWN 回执解释，通过 platform public-api 暴露。COMMITTED 必须携带匹配输出字节的哈希；未知回执、错哈希或丢失宿主响应均视为提交不确定。宿主缺失时明确报错，不回退为原来的直接覆盖。
5. **产品入口接线。** 普通 prepareSave/commitPreparedSave 改为等待宿主回执；ABS 普通/分片导入后的镜像及文件导出复用同一接口。首次导出也在资源准备前保存预期 ABS 内容，准备期间新增或修改的外部文本由宿主 CAS 拒绝覆盖。已知待应用外部编辑在准备资源前拒绝；纯预览不增加镜像文件读取或发布。
6. **提交结果与工作区隔离。** 明确未提交时保留原失败/回滚规则；ABI 或 ABS 回执不确定时，保留当前内存工作区，隔离保存/导出/Agent 访问，不把“响应失败”误当作“未写入”再覆盖磁盘。ABS 不确定发布不重放旧工作区。旧上下文的确认或不确定结果不得标记新工程 clean，也不隔离新工程/页面。已确认提交后的清理警告不再报成 ABI 回滚；普通保存仍只在当前上下文更新派生代码/清单。
7. **去除旧重复实现。** 删除 prepared-project-save.ts 的 renderer 临时路径、写入、rename、清理分支及旧 BlocklySaveFilePort，改为一个宿主端口委托；ABS 移除两处直接 writeFile。原生文件故障用例迁到真实 Node 文件测试，浏览器测试保留调用/回执/上下文边界，没有保留第二套提交实现作为降级路径。

### 24.3 验证结果

| 检查 | 实际结果 |
| --- | --- |
| 专项 ChromeHeadless 测试 | 305 项通过，较第九批新增 14 项 |
| node --test electron/project-file-writer.test.cjs electron/project-file-writer-bridge.test.cjs | 18 项通过，其中 17 项真实文件/独立进程测试，1 项真实 Electron contextBridge 测试 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json | 通过 |
| tsc --noEmit -p tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 160 个服务目录文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；未更改默认构建配置、依赖或锁文件 |
| 默认 development 构建 | 未修复/未复测此前 Mermaid/es-toolkit 解析问题，不宣称默认配置通过 |
| git diff --check 与本批新增文件检查 | 通过 |

真实文件测试覆盖 BOM/中文/emoji/CRLF 精确字节、首次创建、无改动提交、12 个并发写入者、4 个独立 Node 进程竞争、准备期间外部编辑、未知/遗留锁不抢占、上下文失效、临时文件清理、rename 前失败/后抛错、提交后无法检查、越界路径、目录 junction 和多硬链接目标、清理警告及锁归属变化。Electron 测试使用隐藏测试窗口和隔离临时 profile，验证 contextBridge 回调确实可在原生提交前同步检查 renderer 上下文。

浏览器新增覆盖精确请求/回执、缺失宿主、不确定或非法响应、异步哈希期间失效、首次导出期间外部 ABS 改写、确认提交后切换上下文、ABI/ABS 不确定结果隔离及不回滚。测试只写自行创建的临时目录；未改用户工程或库仓库。Electron 测试不是完整应用 preload/打包验收，未运行真实用户工程、C++/.h 或性能基准。

### 24.4 已知边界与下一步

- **需要完整重启 Electron 应用。** preload 增加了新桥接方法，单独 Angular 热更新不能更新它；旧宿主会返回 PROJECT_FILE_HOST_UNAVAILABLE，不会偷偷改用无条件写入。
- **遗留锁采用保守策略。** 进程在持锁的短临界段崩溃，可能留下锁文件；默认 5 秒后明确报 PROJECT_FILE_BUSY。必须核实 owner 和所有写入进程后显式处理，当前没有自动抢锁、恢复 UI 或自动删除。不要仅按锁年龄删锁，也不要因此清空工作区或资源目录。
- **尚非所有写入共用锁。** domains/project/project.service.ts 的 initializeProjectDataSchema / ensureProjectDataSchemaForLoad 仍调用 writeProjectAbiAtomically，尚未迁入；项目复制/导入、通用 fs 桥及独立 Agent 也可绕开该接口。下一批应优先收口这两个 ABI 规范化入口及其上下文/备份语义，审计复制是否携带锁，再与独立 Agent 的真实写入端对接。
- **单文件提交不能替代 generation 事务。** 当前接口不实现 AbsSyncStoragePort.withLock 跨多次操作的语义，不得直接把几个独立 CAS 拼成“完整事务”。不可变基线、prepared/committed、MIRROR_PENDING、原始输入及未保存恢复包仍需绑定同一宿主事务边界。
- **资源根仍待闭合。** 基线、回滚、待应用 ABS 和预览的 GC pin、释放及跨进程删除隔离未实施；没有启用或执行破坏性 GC。锁恢复和工程复制规则必须与这些根一起设计，不能复制一份旧锁作为新工程的活跃锁。
- **v2/map 尚未生产启用。** 候选/未访问页/自定义模型完整契约、Automation 原子提交结果、Runtime 自动恢复及真实工程往返验收仍在主线中；完整身份/deletable:false 问题仍不能整体关闭。
- 最后阶段的字节检查和 rename 仍是同步临界段；本批没有大工程耗时/内存数据，不宣称已解决保存卡顿。

## 25. 第十一批实施记录（2026-09-14）

### 25.1 范围与原则

本批执行第 24.4 节的初始化/加载规范化收口及复制审计。核心约束：**规范化必须基于本次读取的字节与本次资源会话；任何持久化前先完成所需资源准备，已提交的数据不能因旧页面迟到而回滚；工程副本不能继承另一工程的活跃写入锁。** 不改变 ABS、map 或 Project Data 的文件格式，不修改库包，不接管未知外部写入者。

### 25.2 已完成

1. **复用统一宿主提交。** initializeProjectDataSchema / ensureProjectDataSchemaForLoad 共同使用 project-data-normalization.ts。该模块只组织现有外置、校验、还原与 publishProjectText；不依赖 Angular、Blockly 或全局 runtime，不另建保存服务。删除 domains/project/project.service.ts 中 writeProjectAbiAtomically 和 renderer 的备份写入分支。
2. **逐资源与上下文边界。** put、flush、引用校验、resolve 前后检查本次 guard；第一次失效即停止后续 I/O 和提交。初始化绑定显式工程目录，可接收调用方取消断言；加载绑定路径固定的独立 store、活动路径与 Project Data session，不在 await 后重新选择全局 store。输入在既有外置算法中同步克隆；没有变更时也不再返回调用方可变原对象。
3. **还原先于提交。** 加载所需的通用载荷先还原，再提交紧凑 ABI。资源/codec 失败不会发布本次迁移；磁盘冲突或不确定回执会中止加载，不返回候选、不用原内容覆盖磁盘。没有 originalContent 的板卡模板仅准备内存文档和资源，不读取/发布项目 ABI。此边界不等于预先验证所有自定义 Blockly 装载回调。
4. **原始迁移备份。** 宿主 v2 接受限定为 project.abi 的 backup: project-data 请求；原始字节存入 .aily/project-data-backups/<原始 SHA-256>.abi。先独占写临时文件并 sync，再在同一工程锁内以 hard-link 独占发布、去掉自己的临时链接、验证内容，最后再次检查 ABI 并提交。已有同哈希文件必须字节一致；损坏、路径链接、异常多硬链接或备份失败均拒绝 ABI 写入。旧 project.abi.pre-project-data.bak 保持原样；不同原文有独立备份，同原文复用，不覆盖第一份备份。
5. **能力协商与无变化校验。** preload 暴露 projectFilePublicationVersion=2；请求备份前客户端检查能力，提交回执同时验证输出 hash 与 backupHash。不能把会忽略新参数的旧宿主当作支持备份。已符合 schema 的磁盘文档仍走锁内字节校验，但保持原格式/换行，不创建数据临时文件、不重写 ABI、不新增迁移备份。
6. **加载生命周期。** 编辑器为路由加载绑定序号与数据会话；读取、worker 解析、规范化、模板回退及工作区应用前后检查上下文，主加载流程的依赖/库异步阶段也检查。旧加载成功不标记新工程已加载，旧加载失败不调用新工程的 reset/destroy；组件销毁释放路由订阅并失效加载。沿用 workspace dispose → Runtime 恢复/销毁的既有顺序，不新增 Realm 或浏览器刷新。未宣称已审计所有 service 内部异步副作用和后台定时器。
7. **另存为的明确复制策略。** 新增宿主 copyProjectDirectory，供 Blockly/Coder 另存为使用；要求绝对路径及预先保留的空目标目录，拒绝目标位于源目录内、目标目录链接或合并覆盖。仅排除工程根的 .aily/project-files.write.lock 及本写入器 UUID 命名的临时 ABI/ABS/map/backup；Windows 按路径大小写等价匹配。保留 .aily 内的基线/恢复/迁移备份、Project Data、普通 *.tmp 和未知文件；不删除源目录文件，也不递归猜测嵌套项目的锁。
8. **路径与复制前置清理。** 两类另存为复用 resolveSaveAsTarget；移除 Blockly 分支替换整条路径空格的代码。Blockly 在保存、资源 flush/校验后验证活动会话，并在复制前核对 ABI 仍是已校验字节；失效或外部改写时不创建目标/复制。旧宿主缺少复制能力时在保存/建目录前明确失败，不回退通用 copySync。

迁移备份是完整的迁移前原始 ABI，可能仍包含旧内联大值；它是恢复材料，不是新资源格式或同步 generation 基线。备份只新增/验证，本批没有自动清理、配额淘汰或恢复 UI。原文件 sync 与同文件系统 hard-link 需要宿主文件系统支持；不支持时保留原 ABI 并明确失败，不降级为不完整备份。若进程在发布备份链接后崩溃，可能遗留额外链接/工程锁，仍需核实所有者后显式恢复，不自动抢锁或删除。

### 25.3 验证结果

| 检查 | 结果 |
| --- | --- |
| ng test --configuration=abs-sync --watch=false --browsers=ChromeHeadless --no-progress | 344 项通过，纳入规范化/另存为产品入口回归 |
| ng test --configuration=abs-project-load --watch=false --browsers=ChromeHeadless --no-progress | 5 项通过，独立测试编辑器组件加载和迟到路由失败 |
| node --test electron/project-file-writer.test.cjs electron/project-file-copy.test.cjs electron/project-file-writer-bridge.test.cjs | 28 项通过，包含真实文件、独立 Node 进程及隐藏 Electron contextBridge |
| tsc --noEmit -p tsconfig.abs-sync.spec.json / tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 162 个服务目录文件，0 baseline violations，0 cycles |
| development --preserve-symlinks=false | 通过；应用默认构建配置、依赖和锁文件未修改 |
| git diff --check 与本批新增文件检查 | 通过 |

新增覆盖迁移原始字节/复用/损坏/硬链接/路径链接、备份失败和不确定提交、旧宿主能力拒绝、无变化文档及外部竞争、每个资源阶段失败或换会话、模板不发布、输入对象隔离、旧路由失败不销毁新会话、另存为路径/会话/外部 ABI 改写，以及只排除准确临时文件名称的复制。资源 store 在浏览器单测中使用替身，磁盘与备份/复制故障在 Node 中使用真实临时文件；Electron 使用隐藏窗口和独立临时 profile 验证真实桥接，没有打开或改写用户工程。

测试隔离说明：直接把编辑器组件导入原生 Blockly 协议测试页，会在模块加载时注册主程序自定义过程块，污染原生过程用例。已独立为 abs-project-load 配置运行；该配置采用 preserveSymlinks=false，以处理既有 Mermaid/es-toolkit 经链接路径解析的问题。原 abs-sync 配置及应用默认配置的路径解析规则未改变。没有放宽生产引用检查；主程序自定义过程参数的额外状态仍属于未适配契约，不能用本批原生过程回归替代其验收。

### 25.4 剩余写入审计与下一批执行顺序

1. **先收口新发现的主程序旁路。** example-list 在初始化之后调用 utils/blockly_updater.ts 的 updateBlocksInFile；该文件的单块/多块 helper 仍直接 writeFileSync，超限新参数也没有接入本次通用准备。将其拆为纯文档更新与统一规范化提交，并让调用方 await。云端、Playground、板卡/用户模板仍使用 CrossPlatformCmdService.copyItem，含通配符/外层包装目录的复制语义；需明确 actualProjectPath 后过滤活跃状态，不能全局修改通用 copyItem 或删除未知锁。
2. **独立 Agent 对接点已确认。** child/aily-lex 是指向 D:/codes/aily-lex 的 junction，本批仅只读审计。FileWriteTool / FileEditTool 进入 tools/common/trackedWorkspaceWrite.ts；其 performTrackedWorkspaceWrite 先读回比较，再调用 host.fs.writeFile，时间线记录失败时再次无条件写回 beforeContent。NodeFileSystem.writeFile/writeFileBytes/appendFile 使用原生异步文件 API；workspaceSafety 的默认协调器是进程内 Map，并不是本工程磁盘锁。下一批应在真实宿主文件事务端连接期望字节、统一锁与明确提交回执，并一起处理时间线失败的条件回滚、删除/恢复/补丁/追加写入，不能只改 write_file 工具或提示词，也不要从 Lex 直接相对 require 主程序 preload 实现。
3. **再闭合事务、恢复与资源根。** 当前单文件锁加备份不是 AbsSyncStoragePort.withLock 的跨文件 generation 事务；复制过滤也不是多文件一致性快照。Agent/应用共同边界完成后接不可变基线、prepared/committed、MIRROR_PENDING、原始 ABS/未保存快照和备份资源引用 pin，再设计遗留锁显式恢复与安全释放；本批未启用破坏性 Project Data GC。
4. **补齐模型/候选后整体切换。** 主程序自定义过程参数、model-backed 过程、未访问页、休眠 shadow 和自定义 serializer 的完整契约仍待完成；生产仍使用旧 converter，v2/map 未启用，完整身份/deletable:false 往返问题不能整体关闭。之后执行真实用户工程副本打开/编辑/保存/重开、C++/.h 生成与性能验收。

使用要求：**完整重启 Electron** 才能加载宿主 v2 与复制接口，Angular 热更新不足以生效。不确定提交保留磁盘与备份并停止本次加载，不建议手工覆盖 ABI 或按时间删除锁。本批没有修改 aily-blockly-libraries、独立 Lex 源码或用户工程，也没有执行 C++/.h、开发板或大项目性能测试。

## 26. 第十二批实施记录（2026-09-14）

### 26.1 范围与原则

沿第 25.4 节第一项，收口已确认的云端参数写入旁路与项目复制入口。第一性原理：**参数是项目候选状态的一部分，必须先合成候选、准备资源，再按原始字节提交；目录复制不能继承源工程的活跃写入状态，也不能覆盖目标工程。** 复用既有 Project Data 遍历与宿主提交，不增加字段类型或库名白名单，不引入第二套保存事务，不提前启用 v2/map。

### 26.2 已完成

1. **通用字段更新的纯模块。** 新增 domains/project/project-block-field-updates.ts，只接收文档及按 block ID 索引的更新，返回隔离候选与 changed。复用 project-data-payloads.ts 的单一序列化边界遍历，覆盖单页、多页、共享过程、input block/shadow 和 next；不把 opaque serializer 内恰好同名的 id/type 当作块。支持原有 TEXT 简写和显式 field/value 形式；数组、对象及 null 使用显式形式。重复/未知块 ID、非法 JSON、错误参数结构明确失败，保留输入对象、未编辑状态和 deletable 等属性；原型同名键按普通数据处理。
2. **参数与外置一次提交。** initializeProjectDataSchema 读取一次原 ABI，先应用纯更新，再统一规范化、flush/校验资源并进行既有宿主 CAS 与原始备份。sourceChanged 只表示候选相对原文发生字段编辑，避免“已符合 schema 且仅修改短文本”被当作无变化而丢弃。新增超限文本、数组和对象继续由通用 Project Data 机制处理，不在云端组件中处理 codec/资源路径。缺少 ABI 却请求参数更新时明确失败；无参数的 Coder 等项目保留原有无 ABI 行为。
3. **云端调用链收口。** 下载发起时快照参数并绑定加载序号，等待单次规范化提交成功后才打开工程。新请求/销毁使旧 guard 失效，旧成功、旧错误和迟到的网络失败不覆盖新加载状态。移除初始化后的 updateBlocksInFile 二次直接写盘、固定等待及组件内重复包装目录探测。目标目录名不允许通过云端 name 携带路径分隔符，随机重名明确失败，不递归删除已有目录。
4. **宿主项目导入。** electron/project-file-copy.js 新增 importProjectDirectory，先确认根 package.json；仅云端压缩包允许一个唯一的直接包装目录，先确定实际工程根再复用准确的活跃锁/临时文件过滤。解析已有父目录和 junction 后检查目标不能位于源内，再创建缺失父目录并独占创建目标；既有目录不合并、不删除。未知/歧义包装格式在创建目标前失败。普通备份、资源、恢复记录及未知文件仍复制；失败的新目录保留，不自动清理用户数据。
5. **各导入入口复用与清理。** 云端、Playground、本地用户模板、Blockly 板卡模板统一调用 ProjectService 的薄宿主适配；不修改通用 shell copyItem 的含义。Coder 板卡专用模板仍沿用已有专用生成逻辑。删除无调用方的 utils/blockly_updater.ts 及其单块/批量/多文件直接写盘、示例代码，移除三个调用组件/服务内不再需要的 shell 服务依赖。旧 preload 缺少新导入能力时明确提示完整重启，不回退无过滤复制。
6. **可复现实机页面用例。** 新增 scripts/project-data-electron-smoke.cjs，启动真实 main.js、完整 preload 和可见 Angular/Blockly 页面，使用独立 profile、app-data 及临时工程副本；当前 development 构建由应用自身 loopback renderer server 提供，避免把旧 dev-server 页面当作本次代码。打开与保存通过真实页面上的产品服务及 Blockly 字段 API 驱动，关闭登录提示通过真实界面操作。沿用项目关闭/重开的 Runtime 生命周期，没有用刷新作为产品修复逻辑。

参数错误由原来的静默跳过变为明确失败，这是为了阻止例程带着缺失参数继续打开。复制过滤仍不是多文件一致性快照；package.json 元信息更新尚非 project.abi/ABS/map 的 generation 事务。本批不删除源工程锁、不抢未知锁、不启用破坏性资源 GC。

### 26.3 验证结果与真实 Electron 证据

| 检查 | 结果 |
| --- | --- |
| ng test --configuration=abs-sync --watch=false --browsers=ChromeHeadless --no-progress | 361 项通过，新增字段纯更新与初始化参数提交回归 |
| ng test --configuration=abs-project-load --watch=false --browsers=ChromeHeadless --no-progress | 9 项通过，新增云端参数快照、失败不打开、迟到请求和路径名称回归 |
| node --test electron/project-file-writer.test.cjs electron/project-file-copy.test.cjs electron/project-file-writer-bridge.test.cjs | 31 项通过，包含实际根目录过滤、碰撞不覆盖、缺失父目录与 junction 检查，以及真实隐藏 Electron 桥接 |
| tsc --noEmit -p tsconfig.abs-sync.spec.json / tsconfig.app.json | 通过 |
| check-angular-service-architecture.mjs | 164 个服务目录文件，0 baseline violations，0 cycles |
| ng build --configuration=development --preserve-symlinks=false --no-progress | 通过；未修改应用默认构建配置或依赖锁文件 |
| git diff --check 与本批新增文件检查 | 通过 |

真实可见 Electron 使用两个已安装依赖的工程副本：project_jul13d_353995、ESP32S3_DHT22_HTTP。为通用性验证，在各副本加入标准 text 块，通过参数注入 **61,200 字节 UTF-8 文本（含中文、换行、emoji）**，并在模拟压缩包内放入旧写入锁。验证了：

- 包装目录按实际根导入，旧锁未带入目标，源锁保持不动；参数更新产生外置引用，原 ABI 的精确哈希备份存在且字节相同。
- 真实 Blockly 工作区读回完整文本，三个 Arduino 根块原 ID 存在且 isDeletable() 为 false。
- 在实际字段追加文本，经产品 save 提交后磁盘 ABI 不包含新内联大文本；关闭再打开后内容逐字一致。
- 两个原始用户工程的 project.abi SHA-256 前后相同；捕获的页面异常及 console.error 均为空。只退出测试启动的 Electron，保留已有开发服务和用户窗口。

证据文件（临时目录保留供核查，不作为源代码或恢复基线）：

- project_jul13d_353995：[测试报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-2w6diN/result.json)。
- ESP32S3_DHT22_HTTP（最终复测）：[测试报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-3Gu9xU/result.json)、[重开后的真实工作区截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-3Gu9xU/project-data-page.png)。

复现前准备已安装依赖的工程、当前 development 构建与 localhost:4200 开发服务（main.js 的正常开发启动仍需要它），然后执行：

```powershell
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\ESP32S3_DHT22_HTTP"
```

脚本仅复制指定工程到唯一临时目录，不下载云端包、不登录账号、不修改源工程或库仓库。当前原始例程内容不等于历史动画故障时的完整现场；本批使用额外标准文本块验证通用大值链路，没有验证动画播放、C++/.h 编译、真实硬件或完整 ABS v2 往返。数组/对象及多页边界由本批纯模块/既有资源回归覆盖，不冒充这些场景已逐一通过可见页面验收。

### 26.4 下一批主线与未完成边界

以下为第十二批结束时的对接判断；第 27.1 节依据当前实际产品入口修正了旧 aily-lex 路径，不再向已退役运行链路实施新事务能力。

1. **独立 Agent 的真实宿主写入事务。** 按 25.4 已确认的 trackedWorkspaceWrite → host.fs → NodeFileSystem 链路对接统一锁、预期字节与明确提交回执，同时消除时间线失败后的无条件 beforeContent 回写。一次审计 write/edit/append/delete/restore/patch，不从 Lex 相对引用 Blockly preload、不只改提示词。本批未编辑 aily-lex。
2. **完整 generation 与恢复。** Agent/应用共同边界完成后衔接 ABI/ABS/map 发布、不可变基线、prepared/committed、MIRROR_PENDING、恢复资料及资源 pin；设计遗留锁显式恢复、备份保留和 GC 安全释放。参数导入成功不能替代这部分跨文件一致性。
3. **补齐实例与模型契约。** 主程序自定义过程参数、model-backed 过程、未访问页、休眠 shadow、自定义 serializer 引用覆盖仍按原计划推进。通用参数遍历能定位这些明确块边界，不意味着已获得所有模型引用契约。
4. **整体切换后扩展实测。** 生产仍为旧 converter，v2/map 未启用；本批保护属性在普通加载/保存链路上的验证不能关闭完整 ABS 身份/deletable:false 问题。前置完成后统一切换，并补真实动画数组、C++/.h、硬件和大项目性能测试。

使用要求：**完整重启 Electron** 才能获得新的 importProjectDirectory 宿主接口，单独 Angular 热更新不足。aily-blockly-libraries 保持只读；原始用户工程未写入。

## 27. 第十三批实施记录（2026-09-14）

### 27.1 当前主线修正与范围

重新核对产品入口后发现，25.4 / 26.4 的 `aily-lex/trackedWorkspaceWrite → NodeFileSystem` 已不是当前 Aily Chat 主线。主程序的 `scripts/guard-aily-chat-mainline.js` 将旧 Angular Chat、旧 Electron Lex runtime 视为退役实现；当前独立子应用位于 `D:/codes/aily-lex-pro`，其 `packages/aily-agent` 使用 operations/filesystem、overlay/write-through 与 workspace-history 最终事务。残留旧源码/测试不能作为仍被产品调用的证据。

因此本批没有修改旧 aily-lex，而在当前 Agent 的**实际最终落盘边界**实施。原则是：编辑工具只生成候选；持锁核对原版本、提交和恢复由事务层负责。不同应用通过小型磁盘协议协作，不从 Agent 相对 require Blockly preload，也不把协议锁扩展成新的通用文件系统或修改库包。

### 27.2 已完成

1. **共同锁协议。** 新增 [Project File Lock v1](../contracts/project-file-lock-v1.md)；Agent 的 `operations/project-file-lock.ts` 使用与 Blockly 相同的 `.aily/project-files.write.lock`、独占创建及 pid/token 所有权。工程镜像共用工程锁，物理目录去重，多工程按顺序获取；忙时 Agent 的同步事务明确拒绝，Blockly 保留异步等锁/会话检查。不抢旧锁、不删除未知锁，失败释放已获取的锁；检查根/锁目录/锁身份，拒绝符号链接锁目录。
2. **实际历史事务接线。** `pi-workspace-history/transaction-controller.ts` 的 executeTransaction 在计划含 ABI/ABS/map 时获取共同锁，锁覆盖整批写入、元数据提交及本次失败恢复。计划中其他文件随该事务在同一持锁区完成；普通非工程镜像事务继续沿用既有 history store 锁，没有为每个文件建立另一种锁。finalization、write-through、navigation 均复用此入口。
3. **整批校验与提交读回。** 写入任何计划文件或发布恢复记录前，核对全部 before 字节/不存在状态及平台可表达权限；逐文件写前再检查，元数据提交后再次读回整个结果，随后才能标记 committed。拒绝工程镜像硬链接；普通依赖文件不因这一专用限制被一并禁止。Windows 权限比较只使用实际支持的只读/可写位，不能拿 POSIX 位造成假冲突。
4. **条件恢复。** 当次失败和启动恢复都使用共同锁。整个恢复计划先验证当前文件必须等于该事务的 before 或 after；第三种内容或权限冲突即保留磁盘和恢复记录、明确失败，不无条件写回旧内容。每个实际恢复前再次核对；包含新建失败删除、删除失败还原、反向 rollback 和正向 complete。冲突时不能宣称已完整恢复，也不删除恢复记录。
5. **落盘及清理边界。** 文件独占临时写入，恢复权限、fsync 后再 rename，提交前与临时清理前检查锁上下文。工程镜像使用双方共同约定的 UUID 临时名；history ignore-policy 排除这些准确临时名称和既有 `.aily` 活跃状态，不屏蔽普通 `*.tmp` 或 Project Data 资源。确认 committed 后的事务日志删除失败只警告并保留日志，不再进入旧内容回滚。
6. **真实跨进程验证设施。** 新增 Blockly 的 `electron/project-agent-publication.test.cjs` 及测试进程入口；直接加载已构建的当前 Agent history controller，与既有 Blockly writer 双向竞争。扩展既有 Electron 页面 smoke，设置 AILY_AGENT_ROOT 后由独立 Node Agent 历史事务持锁，真实可见页面经完整 preload 发起 Project Data 提交，验证等待及释放后继续完成。没有调用模型、发送聊天消息或修改用户原工程。

这不是统一 ABS generation 发布协议，也没有把所有 Agent 写入者标为已完成。Agent 自身 history store 锁仍承担原有会话/历史存储职责；新的共同锁只解决工程文件协作，二者不混用恢复规则。

### 27.3 验证结果

| 检查 | 结果 |
| --- | --- |
| 当前 Agent rslib build（含声明生成）/ tsc --noEmit | 通过 |
| Agent project-file-publication、workspace-history-diff-safety、multi-project-write、workspace-history-navigation、multi-project-workspace-history、subagent-command-recovery | 39 项通过；新增 14 项提交/恢复专项 |
| Blockly project-file-writer、project-file-copy、project-file-writer-bridge、project-agent-publication | 33 项通过，包含两个真实独立进程互操作场景 |
| 主程序服务架构检查 | 164 个文件，0 baseline violations，0 cycles |
| 两仓库变更及新增文件空白检查 | 通过 |

Agent 的既有 subagent-command-recovery 测试会输出测试替身缺少 recordRelatedChangeFailureNotice 的警告，但 13 个用例均通过；本批未修改这部分无关替身。large-project.integration 需要专门 fixture，本批未提供并跳过，不把其计入通过数。主程序业务代码本批未修改，浏览器 370 项与 development 构建仍是第十二批结果，本批不冒充重新执行；可见页面加载该 development 构建及当前完整 preload。

真实 Electron 工程副本专项已通过：

- `ESP32S3_DHT22_HTTP`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-EDArTW/result.json)。
- `project_jul13d_353995`（最终构建复测）：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-Gozcbw/result.json)、[工作区截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-Gozcbw/project-data-page.png)。

除第十二批的 61,200 字节通用文本导入/编辑/保存/重开断言外，本批增加：**当前独立 Agent 的实际历史事务持锁时，页面中的规范化提交尚未结束；Agent 提交并释放后，真实 preload 提交继续成功。** 两个原始 ABI 的 SHA-256 不变，捕获的页面异常/console.error 为空。测试持锁事务使用 ABI 精确相同字节以隔离锁行为，不等于实际 LLM 完成一次 ABS 编辑；没有启用 v2/map、没有验证动画或 C++/.h 编译。

复现需先构建 `aily-lex-pro/packages/aily-agent`，准备上一节所述主程序页面环境，然后在 Blockly 仓库执行：

```powershell
$env:AILY_AGENT_ROOT = 'D:\codes\aily-lex-pro\packages\aily-agent'
node --test electron/project-agent-publication.test.cjs
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\project_jul13d_353995"
```

本批重建了 Agent dist，未另行发布分发包。第十五批补充核实：本机已安装子应用通过开发链接直接指向 aily-lex-pro，Agent 入口为该仓库 dist，因此不需要另装发布包；须重建 Agent 后重启对应 Chat 进程。此前“未部署”不是指当前 Agent 未接入 Blockly，也不代表开发链接不可用；仅更新 Blockly 页面不会刷新旧 Agent 进程的模块缓存。

### 27.4 当前写入审计与下一步

| 当前入口（aily-lex-pro/packages/aily-agent/src） | 本批结论 / 下一步 |
| --- | --- |
| operations/filesystem.ts 的 edit/write → workspace overlay | 候选最终经过 history transaction 时已覆盖；无活动 turn 或额外获准写目录时可能直接写物理文件，仍需按明确路径和预期版本接入 |
| extensions/pi-workspace-history 的 finalization、write-through、navigation/恢复 | 已接入共同锁、提交读回和条件恢复；不代表完整 ABS generation 事务 |
| blockly/services/abs/import.ts | 离线导入有独立临时 ABI、固定 .backup 与可选 ABS 写入；需要替换为统一准备/提交并确认候选 Project Data，不允许用离线导入绕过活动工作区 |
| blockly/services/abs/conversion.ts 的 writeRenderedAbs/exportLiveAbs/absExport | 仍直接写 ABS；应在转换前固定 ABI/ABS 预期版本，不能在写盘前才读取“最新原文”冒充 CAS |
| blockly/services/abs/live-source.ts | 写入唯一临时目录以传递已验证 ABS，不是工程镜像旁路；保留当前临时源固定及生命周期策略 |
| 外部命令、追加/删除/补丁 | 通过 overlay/history 最终提交的部分已覆盖；直接 canonical 或外部路径写入必须分别审计，不靠工具名称/提示词宣布安全 |

下一批优先收口表中的**离线 ABS 与直接物理写入旁路**；明确空闲/活动工程、候选生成时的预期字节、资源校验和提交结果，不复制主程序 converter 的未完成状态契约。之后推进共享恢复资料/资源 pin、基线与 ABI/ABS/map generation，补齐自定义过程/未访问页/休眠 shadow/serializer 引用契约，再统一切换 v2/map。完整身份及 deletable:false 的 ABS 往返问题仍不能关闭。

保持约束：aily-blockly-libraries 与原用户工程只读；保留用户已有改动，不清理退役目录中的未知文件，不修改旧 aily-lex 来替代当前产品修复。

## 28. 第十四批实施记录（2026-09-14）

### 28.1 设计依据与发现

沿第 27.4 节继续处理当前独立 Agent 的直接写入路径。必须分别证明三个条件：**候选内容可表达、候选所依据的版本未变化、实际落盘结果可确认**。只加锁不能修复有损转换，也不能把提交前重新读取的最新文件当成候选生成时的基线。

本批确认了两个语义缺口及一个接线缺口：

- Agent headless ABS → ABI 仅重建 blocks/variables/schema，并重新生成身份；不能用它替换已有非空 ABI，否则保护属性、模型身份和其他文档状态仍可能丢失。
- Agent `abi-value-formatter.ts` 对无法表示的对象/数组返回 null，导致整项参数被省略；Project Data Envelope 正是这种对象。仅在这种输出外加事务会让缺数据的 ABS 被可靠地写入。
- 主 Agent 的 `createTools` 在每次 read/edit/write 调用时重新创建 operations。仅把版本缓存在单个 operations 实例里，会让正常的 read → write 无法共享可信版本。Code Mode 原先的 bounded reader 也绕开该记录。

不把这些问题交给库配置或新字段白名单解决，也不复制主程序资源 codec。当前不能证明安全的 headless 路径先明确拒绝，主程序权威投影的协议对接列为下一批优先项。

### 28.2 已完成

| 模块（Agent src 下） | 本批职责 |
| --- | --- |
| operations/project-file-publication.ts | 捕获精确字节/不存在状态、模式及物理根身份；薄适配既有 HistoryTransactionController，提供准备态发布与读回结果 |
| extensions/pi-workspace-history/transaction-controller.ts | 在已有写入事务中增加只读依赖观测，源文件同样参与共同锁、提交前/后校验；无变化输出仍校验，不改写目标 |
| blockly/services/abs/conversion.ts | 转换前固定 ABI 源和 ABS 目标；使用固定源生成候选，提交时同时核对两者；移除直接写盘的 writeRenderedAbs |
| blockly/services/abs/import.ts、offline-policy.ts | 只初始化缺失/明确为空且无未知状态的 ABI；ABI 与可选 ABS 使用同一事务，移除固定 .backup、独立 temp rename 和后续裸写 ABS |
| blockly/services/abs/headless-data-policy.ts、abs-core/abi-value-formatter.ts | 泛型检查大字符串、序列化载荷及资源 Envelope；无法表达的结构化字段不再静默省略，返回 ABS_HOST_REQUIRED |
| operations/filesystem.ts | 工程镜像已有文件必须先读；edit/write 复用读到的版本，冲突保留外部内容；普通非镜像文件维持既有行为 |
| tools/create-tools.ts、tools/code-mode/* | 通过显式会话上下文共享读版本，覆盖动态工具重建和跨 Code Mode 调用；Code Mode 镜像读取接入同一记录并保留大小限制 |

具体约束：

1. 不另建事务引擎。直接发布在工程 `.aily/file-publications` 使用既有日志/内容 blob 机制，与 Agent 会话历史目录分开；原 `.backup` 不覆盖。原始文件字节作为 before blob 保留，不新增资源 GC。
2. 共同锁内先检查是否存在未完成直接发布，再核对整批版本；不得在锁外检查后假定状态不会变化，也不得把自身新日志误认成旧待恢复记录。有未完成记录时保留磁盘/日志、要求显式恢复，不自动覆盖继续。
3. 双文件失败时复用既有条件回滚。只有读回全部目标仍等于 before 才报告 NOT_COMMITTED；无法确认或出现第三方内容时为 UNKNOWN，不能宣称完整回滚。成功返回 COMMITTED、文件字节数和 SHA-256；不宣称跨文件瞬时可见或断电原子性。
4. 路径须在显式工程根内，拒绝逃逸、符号链接和硬链接镜像；根身份变化即停止。镜像默认上限 128 MiB，Code Mode 读取继续限制为 8 MiB。输出 outFile 相对工程根解析，不能逃逸或覆盖作为源的 ABI。
5. 已有块、变量、自定义文档状态或未知 schema 的离线导入，在写文件前拒绝。候选含未经主程序准备/验证的资源引用或超限值也拒绝；这不是资源 codec 的替代实现，不声称已完成无损离线合并。
6. headless 导出遇到上述 Project Data 或无法表达的对象/数组时保留已有 ABS，返回明确能力错误。同步更新 abs_import/abs_export/write 工具说明；提示不能替代对外部命令的实际拦截。
7. direct write/edit 只解决字节版本和文件提交，不自动验证任意手写 ABI/map 的语义，也不把它们视为经过 Project Data 准备的文档。

### 28.3 验证结果

| 检查 | 结果 |
| --- | --- |
| 当前 Agent rslib build（含声明生成）/ tsc --noEmit | 通过，最终生成 1749 个 dist 文件 |
| Agent 14 个相关测试文件 | 77 项通过，包含新增 22 项 prepared publication / ABS 能力 / 实际动态工具 / Code Mode 测试 |
| Blockly writer / copy / full-preload bridge / Agent 互操作 | 33 项通过 |
| 主程序服务架构检查 | 164 个文件，0 baseline violations，0 cycles |
| 主线退役代码守卫 | 未通过：工作区仍有既有 src/app/tools/aily-chat 和 electron/chat-runtime-lex-execution-runtime.bundle.mjs；本批未删除用户工作区中的退役目录/产物 |

新增自动化覆盖：源/目标生成期间被改写、no-op 仍校验源且不改变目标 mtime、两文件第二次 rename 失败恢复精确 BOM/CRLF、恢复遇第三方内容保留并阻止后续发布、不存在与空文件区别、路径逃逸/硬链接、直接写入未读拒绝、返回 Buffer 不污染基线、关联工程锁、overlay 不写穿物理工程、异步期间切换工作区、真实动态 read/write 定义间版本共享、Code Mode 跨调用读写/edit，以及大值/资源对象/未知状态的通用拒绝。

既有 subagent-command-recovery 测试替身仍输出缺少 recordRelatedChangeFailureNotice 的警告，相关断言通过。没有启动模型或子 Agent。主程序业务代码本批未改动，浏览器 370 项及 development 构建仍为第十二批结果，不记作本批重跑；本批真实页面加载该构建与当前完整 preload。

真实 Electron 最终构建复测（全部使用新建临时副本）：

- `project_jul13d_353995`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-LUFucp/result.json)、[工作区截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-LUFucp/project-data-page.png)。
- `ESP32S3_DHT22_HTTP`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-OG5BbV/result.json)、[工作区截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-OG5BbV/project-data-page.png)。

真实页面验收延续 61,200 字节通用文本导入、还原、编辑、保存、关闭/重开与共同锁等待；新增独立 Node 进程直接加载当前 Agent 的真实 ABS services 和 createTools：有损导出/非空离线导入被拒绝且 ABI/ABS 不变；真实 read 工具固定版本后，页面保存更新 ABI，再执行真实 write 工具的旧版本替换，必须失败且保存结果不变。两个源工程 ABI 的 SHA-256 不变，页面异常与 console.error 为空。截图保留在临时证据目录，不删除用户工程。

这不是实际 LLM 对话、完整 ABS 编辑往返、动画播放或 C++/.h 编译验收。本机开发链接可以直接加载重建后的 Agent dist，不要求替换已安装分发包；需要重启对应 Chat 进程。实际链接检查见第 29.1 节，不能将此前尚未确认进程更新表述为 Agent 尚未接入或必须重新部署。

复现：先构建当前 Agent，保持 localhost:4200 开发入口可用并准备主程序 development 页面，然后在 Blockly 仓库运行：

```powershell
$env:AILY_AGENT_ROOT = 'D:\codes\aily-lex-pro\packages\aily-agent'
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\project_jul13d_353995"
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\ESP32S3_DHT22_HTTP"
```

### 28.4 下一步与不能关闭的问题

1. **优先对接主程序权威投影/验证回执。** 当前 Agent 的 project_save、blocks_tidy 后置校验和 abs_apply 反向验证仍调用 headless renderer；对含 Project Data 的工程现在会明确失败，而非写入缺字段的 ABS。主程序已经完成的 ABI 保存不因该后置失败而回滚。下一批应让 Agent 消费绑定工程会话及版本的主程序投影/验证结果；不能把本批临时能力拒绝当成长期功能完成，也不能读取一个未绑定版本的现存 ABS 冒充验证成功。
2. **剩余写入入口。** shell/外部命令、追加、删除、补丁的直接 canonical/外部路径仍须逐个审计；经 overlay/history 最终提交的部分已覆盖。不能靠本批工具提示宣称所有写入者均被拦截。
3. **恢复材料和资源根。** 为直接发布未完成日志提供明确检查/恢复入口、共享恢复资料及资源 pin；现阶段保留日志并停止覆盖，不执行自动清理或猜测恢复。
4. **继续完整协议。** 补齐未访问页、自定义过程/模型、休眠 shadow 和 serializer 引用契约；之后完成 ABI/ABS/map generation 与基线事务，统一切换 v2/map。完整 ID、deletable:false 及所有状态的 ABS 往返问题仍不能关闭。

保持 aily-blockly-libraries、旧 aily-lex 和原用户工程只读；本批清理仅涉及已替换且确认无调用方的直接写盘实现，不大范围删除工作区未知文件。

## 29. 第十五批实施记录（2026-09-14）

### 29.1 开发链接核实与设计依据

本批沿 28.4 第一项推进，不把 Agent headless 能力拒绝当作功能完成。第一性原理是：**谁拥有真实工作区、库运行时和资源还原规则，谁负责生成/验证该投影；消费者必须核实本次产物来自哪个源版本，而非相信一个 success 标志。**

本机只读检查确认：

```text
AppData/Local/aily-project/npm-global/app/node_modules/@aily-project/subapp-aily-chat
  -> D:/codes/aily-lex-pro/packages/aily-chat
aily-chat/node_modules/@aily-project/aily-agent
  -> D:/codes/aily-lex-pro/packages/aily-agent
Agent package main -> ./dist/index.js
```

因此当前项目的 aily-lex-pro 已是可连接 Blockly 的实际开发 Agent，之前“新 Agent 尚未部署”的表述不准确。此次已经重建 Agent dist；使用最新实现需要重启相应 Chat 子应用进程，不能假定现有 link-dev watcher 会热重载 Agent 源码。宿主 renderer/main 也须加载本批代码。测试使用独立 Agent 进程和隔离 Electron profile，没有擅自重启用户的现有会话，不宣称用户原进程已经更新，也未安装/发布新分发包。

### 29.2 本批实现

线协议见 [ABS Host Projection v1](D:/codes/aily-blockly/contracts/abs-host-projection-v1.md)。继续复用既有 FIFO、Project Data preparation、宿主 writer 和 Agent prepared publication，不创建平行的转换/资源/事务系统。

| 模块 | 本批职责 |
| --- | --- |
| 主程序 abs-host-projection.ts | 定义有版本的请求与回执，明确 legacy-syntax-and-project-data 范围，复制异步请求前验证参数 |
| 主程序 abs-auto-sync.service.ts | 在原导出队列上增加 saved ABI 校验、生成文本的解析/资源检查、上下文/revision 及源字节绑定；规范输出复用宿主 CAS 发布 |
| 主程序 blockly-live-operation-bridge.service.ts / electron/main.js | 增加 abs_projection 现有认证 RPC 操作，检查项目/加载状态与内存已保存；采用同 ABS apply 的长任务超时，不重复套队列 |
| 主程序 abs-live-block-shape.ts | 只读已有实例结构，按 ID 读取动态输入，无 ID 时仅接受同类型一致的结构；没有跨项目缓存，不执行库 init |
| 主程序 abi-abs-converter.ts / abs-parser.ts | 共用只读结构模块，删除临时 newBlock/dispose 与四组类型缓存；关闭说明性 header 时仍保留必要的数据协议头 |
| Agent blockly/services/abs/host-projection.ts | 捕获调用前源/目标，调用宿主并验证请求标识、工程、源、scope、输出及真实磁盘字节；自定义 outFile 以 readonly 投影接已有发布事务 |
| Agent conversion.ts / project/workspace.ts | abs_export、project_save、blocks_tidy 消费主程序回执；移除已无调用方的 exportLiveAbs 和重复 headless 保存后校验 |
| Agent 三个工具说明 | 与实际能力一致：主程序负责投影，live 失败不转离线覆盖，保存后的回执不是完整身份往返证明 |

重要边界：

1. 保存状态校验比较规范化完整工程快照，字节版本绑定比较物理 ABI 原文，两者不能混为一谈。投影仅覆盖当前活动页，不声称其他页或 serializer 已完整表达。
2. Agent 为每次请求生成随机标识；验证回执之后重新读取 ABI/ABS。没有 live host 才允许原有受限 headless 回退，旧宿主不支持操作或结果不符时明确失败。
3. 自定义输出不由宿主按任意路径写盘：宿主只生成/验证 readonly 文本，Agent 用调用前捕获的目标版本和 ABI 源观测发布，阻止生成期间的目标/源冲突。
4. 只读投影不装载反向解析得到的 ABI，不改块、变量或镜像缓存；资源准备可以生成不可变载荷。规范发布仍尊重未应用的 ABS 外部编辑。
5. 发布成功后的验证异常不能声称没有写入；保存/整理的后置失败不自动撤销已完成操作。普通非回执导出保留原有的已提交成功语义。
6. 新模块不依赖 u8g2、DHT、field_multilinetext 或任何库特定字段白名单；aily-blockly-libraries 保持只读。

### 29.3 真实测试发现并修复的根因

第一次 DHT22 工程实测在回执准备阶段稳定报“ABS 导出准备期间工程状态已修改”。操作前后文档相同，不能据此放宽 revision 检查。临时只读诊断进一步观察到 revision 连续 1→2→3，变化路径均为 `/sharedModel/variables/3`。

根因是旧 converter/parser 为查询参数结构，在**真实工作区**调用 `newBlock` 后 `dispose`。FieldVariable 初始化会创建临时变量，被完整项目快照观察到后再删除，导致投影本身改变了源状态。此问题也可能被仅按类型缓存掩盖，并在不同项目/动态形状间串用结构。

修复删除了上述探测与缓存，查询实际实例及静态定义；没有实例、静态定义或结构存在歧义时，不靠执行库初始化猜测。遵守 Generator runtime 隔离方案，不新建探测 Realm、不调用任意 generator getter、不缓存旧 session。诊断期间的快照包装已从 smoke 删除，最终测试在未插桩的真实页面运行。

此外，`includeHeader=false` 原先连带丢弃 Project Data schema；现在只省略说明注释，协议声明仍保留，并覆盖默认/简洁两种真实 Agent 导出。

### 29.4 验证与复现

| 检查 | 本批结果 |
| --- | --- |
| Agent rslib build / tsc --noEmit | 通过，1750 个 dist 文件 |
| Agent 15 个相关测试文件 | 83 项通过；新增回执、篡改、版本冲突、readonly 自定义输出等 6 项 |
| 主程序 abs-sync 浏览器测试 | 373 项通过；含新增 host projection 5 项、只读结构 6 项及简洁 header 1 项 |
| 主程序 abs-project-load 浏览器测试 | 9 项通过；与 abs-sync 共 382 项 |
| 主程序 writer / copy / full-preload bridge / 独立 Agent 互操作 | 33 项通过 |
| 主程序 ABS typecheck / 服务架构检查 | 通过；架构 164 个文件、0 baseline violations、0 cycles |
| development 页面构建 | 使用 --preserve-symlinks=false 通过，未修改正式构建配置或依赖锁文件 |
| 退役代码主线守卫 | 仍未通过：已有 src/app/tools/aily-chat 及旧 Electron runtime bundle；未删除用户工作区未知文件 |

默认 development 构建受本机根 node_modules/es-toolkit 旧 Junction 指向不存在的 1.51.0 影响；Mermaid 自己的 pnpm 依赖链正确指向已安装的 1.52.0。本批没有改写该链接，采用标准构建选项解析真实 pnpm 依赖链完成页面验收。这是本机构建环境问题，不把带选项构建通过报告成默认构建已修复。

Agent 既有 subagent-command-recovery 测试替身仍有缺少 recordRelatedChangeFailureNotice 的警告，断言通过；没有启动模型或子 Agent。

最终真实 Electron 测试使用当前 development 构建、真实 main/full preload/Angular 页面及实际 Agent dist，通过已认证 CLI bridge 运行产品 services，不替换 converter 或写入实现：

- `ESP32S3_DHT22_HTTP`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-YRu4Fp/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-YRu4Fp/project-data-page.png)。
- `project_jul13d_353995`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-kUuOZp/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-kUuOZp/project-data-page.png)。

覆盖 61,200 字节通用文本导入、工作区还原、编辑、保存、共同锁等待、旧 Agent 写入版本拒绝、默认和无说明头的 abs_export、project_save、blocks_tidy、关闭/重开。两份原用户 ABI 哈希不变，最终报告 errors 为空。场景使用工程临时副本，不改库及原项目。

这不是 LLM 对话、完整用户候选 ABS 编辑往返、动画播放或 C++/.h 编译验收；截图中的编译器依赖安装提示不代表编译已完成。

复现：在 Agent 包目录先构建，在 Blockly 仓库保持 localhost:4200 可用，执行：

```powershell
node node_modules/@angular/cli/bin/ng.js build --configuration development --preserve-symlinks=false
$env:AILY_AGENT_ROOT = 'D:\codes\aily-lex-pro\packages\aily-agent'
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\ESP32S3_DHT22_HTTP"
node scripts/project-data-electron-smoke.cjs "C:\Users\LENOVO\Documents\aily-project\project_jul13d_353995"
```

### 29.5 下一批优先项及未关闭范围

1. **候选绑定的主程序验证。** abs_validate 和 abs_apply 预检/反向校验仍使用 Agent headless 能力。下一步定义绑定输入 ABS 精确字节哈希、工程基线及资源准备结果的验证入口；先验证候选、再应用、消费对应提交结果。不能复用本批“当前已保存工作区投影”冒充用户候选的验证证据。
2. **剩余外部写入与恢复。** 继续逐入口审计外部命令/追加/删除/补丁；提供直接发布未完成日志的显式检查/恢复入口和资源 pin，不自动清理未知恢复数据。
3. **无损协议生产切换。** 补齐自定义模型、未访问页、休眠 shadow、serializer 引用契约，完成 ABI/ABS/map generation 与基线发布，再统一开启 v2/map。完整 ID 和 deletable:false 的 ABS 往返仍未关闭。

保持各模块单一职责；本批只删除确定已替换的探测、缓存和无调用方函数，不清理用户的其他工作区改动。

## 30. 第十六批实施记录（2026-09-14）

### 30.1 设计原则与实现范围

沿 29.5 第一项推进候选绑定的宿主验证。**候选文本、源基线、实际应用结果是三个不同的证据对象。** 当前工作区能导出，不能证明用户提供的另一份 ABS 有效；导入返回成功，也不能证明实际字段/连接已按请求落地。相反，超时后工作区 idle 只说明操作停止，不证明操作未提交，因此不能自动重放。

新增 [Host Candidate v1](D:/codes/aily-blockly/contracts/abs-host-candidate-v1.md)，明确两个验证范围：

- `legacy-syntax-and-project-data`：候选通过宿主解析和资源准备/还原，不装载积木，不替换 ABI/ABS。
- `legacy-requested-state-and-project-data`：候选已应用，通过实际请求状态读回、保存后内存/磁盘一致性以及精确 ABI/ABS 字节确认。

两者都不是旧状态的完整基线合并证明，也不是 C++ 编译或全部业务语义证明。本批不启用 v2/map，不以这两个回执关闭 ID、deletable:false、多页及 serializer 的完整往返任务。

### 30.2 已完成的模块改造

| 模块 | 职责与边界 |
| --- | --- |
| 主程序 abs-host-candidate.ts | 请求、验证回执、应用回执及参数验证，绑定协议/requestId、工程、候选字节、ABI 基线与 scope |
| 主程序 abs-candidate-preparation.ts | 验证和导入共用的解析、警告拒绝、通用资源准备/还原与可定位大值替换；不装载工作区、不发布镜像 |
| 主程序 abs-auto-sync.service.ts | 复用现有 FIFO/编辑租约/loader/writer；应用前重新核对候选绑定，装载后保留独立请求副本作实际读回；保存后通过局部确认闭包出具回执，无全局候选缓存 |
| 主程序自动化 bridge / electron main | 接入 abs_validate；abs_apply 必须提供绑定回执，继续复用既有认证、状态管理、进度和保存反馈；缺回执的旧 RPC 请求不执行导入 |
| 主程序 _ProjectService.getAbiRevisionSnapshot | 固定磁盘 ABI 后异步读取资源，校验等待期间的项目、页面、runtime、revision 和源字节；不再要求 prepared 缓存命中 |
| 主程序 abi-abs-converter.ts | 静态 argsOrder 外的动态字段按真实字段名导出，不再丢成 EXTRA_N；不写任何库特定规则 |
| Agent host-candidate.ts / live-source.ts | 捕获物理 ABI/工程根；固定同一候选文本/临时文件，核对宿主回执和磁盘精确输出；每个请求只发送一次 |
| Agent live.ts / conversion.ts | abs_validate 直接请求宿主；abs_apply 保存当前工作、获得本次候选验证、应用、验证实际保存回执；不再独立解析/反向导出和比较块数 |

清理已确认无调用方的 `renderAbs`/`renderLiveAbs`、`chunk-retry.ts`、`live-host-compatibility.ts`，替换含旧宿主重试的 applyAbsSource。保留显式离线 import/export 所需的受限 headless 解析器，不为本批删除其仍在使用的函数。两个工具说明同步为实际契约，移除自动重试、分片预检范围及完整语义校验的过度承诺。

### 30.3 关键安全边界

1. **同一份候选。** Agent 以原始 UTF-8 字节计算哈希；验证和应用均发送相同文本，不改布尔枚举、不分片替换整个工作区、不回写用户 ABS 源文件。大于 256 KiB 或显式文件/分片模式使用唯一临时文件。
2. **重验而非信任票据。** 主程序复制收到的绑定，在应用队列内重新核对工程、scope、ABI 原文哈希、候选哈希/字节数，再调用同一准备模块。候选回执不是一次性服务器缓存或跳过预检的授权令牌。
3. **真实运行时失效。** scope 的 contextEpoch 在观察到 workspace/page/Generator/Project Data session 替换时递增，并使导出缓存失效；进行中的操作继续检查实际实例，不能仅因 ABI/revision 恰好未变而接受旧 session 验证。
4. **实际状态证明。** 使用既有 assertAbsRequestedState 比较字段/连接及请求状态，不以递归块数相近代替读回。装载 callbacks 操作的文档与保留的请求基准分开。
5. **保存后确认。** 本地确认闭包检查实际应用 revision、上下文、已发布 ABS 原文、保存后的内存/磁盘一致性及 ABI/ABS 哈希。Agent 再读取磁盘、核对物理根身份，不把一个 verified 标志当成证据。
6. **不重放未知结果。** 超时、断连、旧宿主、回执异常都不切 headless 或自动分片重试。应用可能已改变内存/磁盘时按失败或 UNKNOWN 保留现场，不盲目回滚。
7. **未变成多文件事务。** 现有 ABS 发布与 ABI 保存仍分两阶段；中间失败可有部分结果，不能宣称跨文件原子提交。完整 generation/恢复工作继续保留。

### 30.4 真实测试驱动修复的三个通用遗漏

**冷缓存版本比较。** 在 DHT22 工程关闭/重开后，页面大文本已恢复，但再次导出时旧 getAbiRevisionSnapshot 调用同步 getPrepared，报“Project data has not been prepared”。这不能解释为载荷文件不存在。新异步路径固定原始 ABI 并按需 resolve，再核对内容与上下文；增加缓存缺失以及等待期间磁盘/revision/session 改变的回归。同步关闭窗口的 hasUnsavedChanges 仍保持原有保守行为，本批不扩张其 UI 异步协议。

**动态字段位置丢失。** 候选真正装载后，严格读回拒绝 `/fields/EXTRA_0`。旧导出器把静态 argsOrder 之外的字段追加为位置参数，解析器不能恢复真实名字。修复为按字段名导出，覆盖任意动态字段；DHT 的 PIN 只是触发例，不新增特例。动态值输入的旧 mutator 映射仍保留，完整名称/身份合同随 v2 主线继续。

测试启动也出现过独立 Agent 冷加载工具注册表超过原 smoke 15 秒上限；只将测试进程 readiness 等待改为 45 秒并输出 stderr，未放宽产品状态检查或重试规则。后续真实测试未跳过该旧版本写入保护步骤。

**序列化可选成员。** 动画字段的原生 saveState 返回了可选 `sourceName: undefined`；实际 ABI JSON 会省略该成员，但旧导入的严格内部 canonical JSON 会拒绝它。新增独立 abs-serialized-workspace 模块，导出/导入快照/实际读回/回滚统一使用持久化 JSON 边界：省略可选 undefined 对象成员，仍拒绝函数、Symbol、BigInt 和非有限数。测试使用任意字段名和嵌套状态，不新增动画特例，也不放宽新内核自身的严格 JSON 契约。

### 30.5 验证记录

| 检查 | 结果 |
| --- | --- |
| Agent rslib build / TypeScript --noEmit | 通过，1749 个 dist 文件 |
| Agent 16 个相关测试文件 | 88 项通过；新增候选/应用 7 项，将旧文件回退测试替换为 4 项不重放/固定字节测试 |
| 主程序 abs-sync | 388 项通过；新增候选 8 项、冷缓存版本检查 4 项、动态字段 1 项、序列化边界 2 项 |
| 主程序 abs-project-load | 9 项通过；浏览器合计 397 项 |
| 宿主 writer/copy/full-preload/独立 Agent 互操作 | 33 项通过 |
| 主程序 TypeScript / 服务架构 | 通过；164 个文件，0 baseline violations、0 cycles |
| development 页面构建 | 使用 --preserve-symlinks=false 通过；未修改依赖链接、锁文件或正式配置 |
| 退役主线守卫 | 仍报告已有 Angular Chat 目录和 Electron runtime bundle；没有删除用户未知改动 |

相关自动化合计 518 项通过。Agent 测试替身原有 recordRelatedChangeFailureNotice 警告仍存在，断言通过；不是实际启动子 Agent 或模型。默认构建的本机旧 es-toolkit Junction 问题沿用 29.4 说明，未宣称已修复。

真实 Electron 用两个原工程的新建临时副本，加载本批 renderer、真实 main/full preload 和当前 Agent dist，通过认证 CLI bridge 执行产品 services。继续覆盖导出/保存/整理、61,200 字节通用文本、锁竞争和陈旧写入拒绝；新增：

1. 工程重开后导出，构造“保留原投影并新增一个普通文本块”的完整候选。
2. 主程序验证候选且 ABI/ABS 字节不变；缺失资源验证失败；修改候选后复用回执的应用在装载前失败，两份镜像不变。
3. 真实 Agent 分片应用合法候选，核对候选绑定的实际保存回执。
4. 页面检查原大文本完整及新增块存在，关闭/重开再次检查；原用户工程 ABI 哈希不变。

这不是所有旧块 ID/保护属性对比、实际 LLM 对话、动画播放或 C++/.h 编译验收；截图中的编译器依赖安装提示不能作为编译成功证据。失败调试报告保留在各自临时目录，不删除原工程。

复现方式沿用 29.4 的两条 smoke 命令；本批扩展了同一脚本，没有新增另一套页面启动/写入模拟器。最终报告如下，成功与未通过分别保留：

- `ESP32S3_DHT22_HTTP`：**通过**，[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-6ujidU/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-6ujidU/project-data-page.png)。最终构建下候选验证、资源缺失/候选篡改拒绝、分片应用及再次关闭/重开全部通过，`success=true`、`errors=[]`。
- `project_jul13d_353995`：**最终保存确认未通过**，[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-nKd88n/result.json)、[失败现场截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-nKd88n/project-data-failure.png)。`success=false`，应用结果为 `partialMutation=true` / `UNKNOWN`；大文本和新增块仍在，内存比已保存 ABI 多出一个 `TFT_eSPI` 类型变量。不能把应用前的导出/保存验收或 `errors=[]` 解释为完整候选应用成功。

两份报告使用临时工程，原工程 ABI 哈希未变。以上不是两份工程完整应用均已通过的声明。

**动画工程尚未通过的最终确认：** 实际装载/请求状态读回通过，保存后的回执校验发现 revision 4→5，`mirrorChanged=false`，路径 `/sharedModel/variables/1`。只读源代码追踪表明 `_ProjectService.save` 在 ABI 提交之后调用 `updateCodeHash`，其中 `generator.workspaceToCode` 执行 Seeed GFX 初始化生成器的 `registerVariableToBlockly(varName, 'TFT_eSPI')`；该辅助函数用默认变量类型查找，未命中已存在的 TFT 类型模型，转而创建额外变量。不能忽略这个变化或把已保存 ABI 与随后改变的工作区宣布为同一结果。

当前保护正确返回失败/UNKNOWN，不重试、不删除额外模型、不改库来绕过检查。动画 smoke 保留严格成功断言，仍以非零退出；失败报告附有内存/磁盘变量及大文本/新增块是否存在，供下一批回归。此问题列为下一批首项，而非误报为资源缺失或本批已解决。

### 30.6 下一批主线

0. **先处理保存后的 Generator 副作用。** 在主程序内明确“模型准备 → 固定应用文档/读回 → ABI 提交 → 派生产物”的边界。审计 `_ProjectService.updateCodeHash`、`runWithPreparedActiveProjectGenerator` 与代码缓存：需要注册模型的工作只能在提交前的受控准备阶段完成，随后重新核对候选请求状态并固定 revision；提交后的 artifact/codeHash 阶段只能消费该版本已准备的生成结果，不能再次调用会改工作区的 Generator。不能仅删除 TFT_eSPI 变量、按库名白名单忽略 revision，也不能无界反复生成直到“看起来稳定”。先用当前动画失败用例证明 ABI 与内存一致、无额外写入，再继续后续完整协议。
1. **完整身份与状态合并。** 基于已准备候选推进新内核与真实模型/serializer/未访问页契约；不把 legacy 请求状态读回误认为已保留原 ID、deletable:false 或休眠 shadow。
2. **统一语义诊断。** 当前候选协议只声明语法/资源及实际请求状态，不覆盖全部 C++、循环控制和对象作用域规则。必要规则应进入独立的宿主共享验证模块，避免恢复 Agent 与主程序两套互相矛盾的解析器。
3. **共同提交与恢复。** 继续收口外部命令/追加/删除/补丁、直接发布未完成日志的显式恢复入口及资源 pin，完成 ABI/ABS/map generation 与基线发布后统一启用 v2/map。

继续保持 aily-blockly-libraries、旧 aily-lex 和原用户工程只读；不替换已安装分发包，不擅自重启用户现有 Chat 会话。开发链接使用最新 Agent dist 时须重启对应子应用，宿主也须运行本批代码。

## 31. 第十七批实施记录（2026-09-14）

### 31.1 第一性原理与本批主线

沿 30.6 第 0 项修复动画工程失败。**持久化版本必须包含该版本生成所需的模型；派生代码不能在版本提交之后反过来改变源模型。** 简单提前一次 `workspaceToCode` 仍不够：页面防抖、保存、构建和上传若各自重复生成，或者跨 await 读取可变 Generator 头文件/映射，依然可能发生不同版本混用。

本批时序收敛为：

```text
工程 FIFO / 编辑租约
  → 固定调用上下文、ABI 物理基线
  → Project Data 异步准备（等待期间禁止源版本漂移）
  → 同步 Generator 准备，捕获代码 + 头文件 + 映射
  → ABS 重新检查请求状态 / 共享引用，固定文档 revision
  → 发布 ABS / 保存 ABI（既有两个阶段，不冒充共同事务）
  → 消费已固定派生输出、校验保存回执
```

通用模型注册继续使用库原行为。没有修补 `registerVariableToBlockly`、删除 TFT_eSPI 模型、按类型忽略 revision，也没有“生成直到稳定”的循环。完整身份合并仍是下一阶段，不借本次顺序调整宣称已解决旧 ID/保护属性。

### 31.2 模块与清理

| 模块 | 单一职责 |
| --- | --- |
| `prepared-project-code.ts` | 编辑器拥有的一份生成准备缓存；绑定完整文档 revision、workspace/page、Generator 实例/配置版本、Project Data session；只缓存字符串和冻结头文件值，不持有可变生成器产物或整份源文档 |
| `BlocklyService.prepareProjectCode` | 在已有编辑所有者内准备，不另建队列；供 ABS 应用和保存共享 |
| `BlocklyService.runWithPreparedProjectCode` | 页面/构建/上传的统一 FIFO、编辑租约、上下文及消费者后置检查，不允许异步消费者把旧输出当成当前结果 |
| `_ProjectService.save` | 在任何资源/生成 await 之前固定 ABI 物理基线；准备后才固定持久化文档，继续用宿主 CAS 提交；提交后只发布已准备代码与 hash |
| `AbsAutoSyncService` | 普通/分片装载后执行生成准备，再检查独立候选的实际请求状态与共享引用，最后固定 applied revision；最终回执检查未放宽 |
| Generator Runtime | 配置、库注册、库 i18n 更新推进运行时配置版本，已有 Project Data 屏障也检查该版本；仍使用现有项目 iframe 和生命周期 |
| `generated-code-artifacts.ts` | 同步捕获经过文件名/文本校验的头文件值；发布只消费这些值，按既有规则写 `project/src`、按需建目录，仅清理宿主生成命名空间 |
| Blockly 页面 / Builder / Uploader | 共用准备结果；页面只读序列化映射快照，构建映射不再跨 await 读取 Generator 的可变 Map |

删除已无调用方的 `writeArduinoGeneratedArtifacts(generator)` 入口；删除保存后的 `updateCodeHash` 重生成分支及各消费者重复的 `workspaceToCode`/可变 Generator 传递。替代方法 `publishPreparedCode` 不执行生成器；旧 UI 代码字符串缓存仅继续服务其既有显示用途，不作为保存/构建版本证据。原 Builder 测试去掉已失效的全局 singleton Generator 替身，改验当前准备输出契约。

### 31.3 失败边界

1. 只允许**同步生成阶段**贡献模型变化，异步资源准备前后和异步消费者续接均检查源版本/上下文。结果自身携带已固定的 revision；包括缓存命中后的 await 返回间隙，消费者也必须验证这一 revision，不能重新观察最新状态后给旧输出换上新版本。库改变请求字段或连接时，ABS 在镜像发布前拒绝；普通与分片路径同规则。
2. 同一版本生成失败保留诊断但不发布部分代码、头文件或映射，不自动重放。编辑中的 ABI 仍可保存，代码生成失败不等于用户文档不能持久化；资源或版本冲突则在提交前失败。
3. ABI 外部修改在准备期间发生时，最终宿主 CAS 拒绝，不把“准备完成后读到的外部版本”冒充调用基线。提交结果 UNKNOWN 继续隔离当前工作区，旧上下文不能隔离新页面。
4. ABS 最终确认仍要求 applied revision 未变、内存/磁盘一致和精确文件字节。同步新增的默认模型纳入已保存 ABI，不代表原 ID 已保留，也不将这些额外状态伪装成 ABS 文本本身完整表达。
5. ABI、ABS、package 元数据和生成文件尚不是跨文件原子事务；代码/头文件发布失败不能声称已保存 ABI 回滚。完整 generation 提交与恢复仍保留。
6. 不证明任意库的异步副作用被沙箱化，也不证明 C++ 编译、板端动画播放、LLM 对话或所有业务语义通过。

### 31.4 验证记录

| 检查 | 结果 |
| --- | --- |
| 主程序 abs-sync | 419 项通过；相比上批新增 26 项边界回归，另纳入现有 Builder 3 项、runtime 2 项 |
| 主程序 abs-project-load | 9 项通过；浏览器合计 428 项 |
| Agent 16 个相关测试文件 | 88 项通过；本批未改 Agent 源码或分发文件 |
| 宿主 writer/copy/full-preload/独立 Agent 互操作 | 33 项通过 |
| TypeScript / 服务架构 | 通过；164 个服务文件，0 baseline violations、0 cycles |
| development 页面构建 | 使用 `--preserve-symlinks=false` 通过；不改依赖链接、锁文件与正式配置 |

相关自动化合计 **549 项通过**。新回归覆盖同步模型注册后的复用、异步版本漂移及缓存命中返回间隙、运行时替换/配置/库变化、失败结果不重放、不可变头文件/映射、普通及分片 ABS 请求状态保护、保存编辑所有权、准备期间外部 ABI 冲突。Agent 测试替身既有 `recordRelatedChangeFailureNotice` 警告仍存在，断言通过；没有启动子 Agent 或模型。默认构建旧 Junction 与退役主线守卫的既有问题沿用 29.4/30.5，未作为本批已修复项。

真实 Electron 沿用同一 smoke，保留实际 main/full preload/Angular 页面与当前 Agent dist。测试两个原工程的新建临时副本；本批新增连续保存检查：ABI 字节和 revision 不变、内存/磁盘哈希相同、每个生成 include 在 `src` 中有非空文件、package.codeHash 与实际代码一致。

最终构建（包含缓存命中 await 间隙保护）下两份工程均通过，`success=true`、`errors=[]`，原工程 ABI 哈希未变：

- `project_jul13d_353995`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-NxvepG/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-NxvepG/project-data-page.png)。候选应用后重复保存 revision 6→6、ABI 原文不变、内存/磁盘哈希相同；`src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节，SHA-256 为 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`。
- `ESP32S3_DHT22_HTTP`：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-ixTnz5/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-ixTnz5/project-data-page.png)。候选应用、再次保存和关闭/重开通过，原大文本和新增块完整，内存/磁盘一致。当前代码没有需外置的生成头文件，报告如实记录 `headers=[]`，不要求无关工程生成头文件。

首次修复及加强验收的临时报告保留，不替代上述最终构建验收。30.5 的失败用例在本批已转为通过，未删除失败断言；这是保存/生成边界修复，不是放宽最终回执。截图中的编译器依赖安装提示仍不代表 C++ 编译或板端播放已完成。复现命令沿用 29.4，无需改库或部署新的 Agent。

### 31.5 下一批主线

1. **身份合并与生产切换。** 回到 30.6 第 1 项，落实已准备候选到新内核的身份映射/基线合并及真实模型、serializer、未访问页契约；重点验收原块 ID、`deletable:false`、休眠 shadow。旧 requested-state 校验不替代完整基线合并。
2. **共同提交与恢复。** 补全 ABI/ABS/map generation、基线共同发布与直接写入未完成日志的显式恢复/资源 pin；进一步收口元数据和派生产物的版本化提交。
3. **统一语义诊断。** 必要的循环控制、对象作用域和业务约束进入独立宿主共享模块，不恢复 Agent/主程序两套解析校验。

aily-blockly-libraries、旧 aily-lex 和原用户工程保持只读。只关闭测试创建的 Electron 实例，不重启用户当前 Chat 会话；本批主程序需加载新构建生效，无需再次安装或发布 Agent 包。

## 32. 第十八批实施记录（2026-09-14）

### 32.1 主线与先决条件

继续 31.5 的身份合并主线。检查调用图确认，`createAbsProjection` / `reconcileAbs` 的身份合并和 `AbsBaselineStore` 的 generation 恢复已有内核测试，但实际存储仍只有 `MemoryHost`；生产 `AbsAutoSyncService` 仍是 legacy 协议。先把 v2 文本接到旧导入，再单独保存 map，会制造 ABI 与身份基线不同代的问题，不能通过更多类型特例补救。

本批完成生产切换的**真实持久化先决条件**，同时推进 31.5 第 2 项：不另写事务状态机，把现有内核接到实际宿主文件能力；把单文件 writer 的锁与路径规则抽成公共模块。未取消 `abs-v2.preview.3`，未移除当前生产入口的 v2 拒绝保护，也未新增逐块 `@meta`。

### 32.2 实现与清理

| 模块 | 本批职责与变更 |
| --- | --- |
| `electron/project-file-access.js` | 公用工程物理身份、普通文件/链接检查、同步 guard、Project File Lock v1 获取/归属/释放；单文件 writer 与 generation 使用同一实现 |
| `electron/project-sync-storage.js` | 工程绑定读能力与锁回调读写能力；白名单 key、精确 UTF-8/CAS、append-only 基线、临时文件 flush/rename、超时不抢锁、未知结果保留现场 |
| `AbsSyncStoragePort` / `AbsBaselineStore` | 删除外层无作用域 `replace`；锁回调显式传入 capability，私有读回/结果分类/恢复均消费同一能力；ABI commit 回调取得同一 capability，不嵌套加锁 |
| `abs-host-storage.ts` / preload | 检查 `projectSyncStorageVersion=1`，打开物理工程绑定能力并验证 await 前后上下文；不降级到不带锁的文件写入 |
| 单文件 writer / Agent `project-file-lock.ts` | prepared 存在即阻止普通镜像发布，包括 no-op、空/损坏日志；只等待宿主显式恢复/放弃，不解析或删除其他写入者的日志 |
| 工程复制 / Agent 历史临时文件过滤 | 仅补充明确的 `.abs-sync-<UUID>.tmp` 目标目录命名空间；工程复制保留正式基线、prepared/committed、Project Data 和未知用户文件，不把嵌套目录中同名普通文件一并过滤 |

删除单文件 writer 内重复的路径/锁/guard 实现，没有增加第二套状态机、全局 active lock、可复用 IPC 锁 token、库白名单或字段特判。新接口仅暴露固定三个镜像及 `.aily/abs-sync/` 中的基线/指针；其余文件和跨路径请求拒绝。

### 32.3 失败与生命周期边界

1. 外层能力只能读；写入方法仅存在于持锁回调。回调结束立即撤销，逃逸函数不可继续写；未 await 的写入排空/在最终 guard 失败后才释放锁，防止异步尾部越过锁边界。
2. 每个最终 CAS/rename 前核对同步上下文、工程根/内部目录身份和锁归属；等待期间变化不能发布旧文本。节点/指针完整性继续由原有内核校验，不由宿主猜测字段语义。
3. `prepared.json` 是跨进程退出仍有效的写屏障；删除进程内锁不等于事务完成。普通 Blockly/Agent 写入返回 `ABS_TRANSACTION_PENDING`，generation 内部才可显式 `recover` / `abandon`。
4. 可确认实际 bytes 已提交时不伪报未提交；无法读回、第三方字节介入或锁清理不确定时报告 UNKNOWN 类错误、保留日志，不盲目回滚或重放 ABS。
5. 真实 Electron 暴露了 Windows 运行时 `fstat.dev` 与 `lstat.dev` 不同（路径 API 为 0）的差异。锁身份统一用同一 `lstat` API 捕获/比较，并继续核对独占创建、inode、单链接普通文件及随机 owner 内容；没有忽略所有权变化。尝试不同原生 fs 入口并不能消除该运行时差异，相关尝试代码已删除。
6. 突发进程退出仍可能留下未知锁，需要显式核验；本批不抢锁、不新增自动后台恢复、不做资源 GC。共同回调与恢复日志不是断电下跨文件原子 fsync 证明，也不覆盖任意外部程序。

完整端口契约见 [ABS Generation Storage v1](../contracts/abs-generation-storage-v1.md)，共同锁协议同步补充 generation 屏障。

### 32.4 验证记录

| 检查 | 结果 |
| --- | --- |
| 主程序 abs-sync | 425 项通过；新增宿主版本/上下文能力 5 项与内核锁能力贯穿 1 项 |
| 主程序 abs-project-load | 9 项通过 |
| 宿主 writer/copy/新存储/两个 Electron 桥接/独立 Agent 互操作 | 48 项通过；新增存储 13 项、完整 preload generation 恢复 1 项、独立 Agent 持久化屏障 1 项 |
| Agent 16 个相关测试文件 | 90 项通过；新增 pending 日志及链接存储拒绝 2 项 |
| 主程序 TypeScript / 服务架构 | 通过；164 个服务文件，0 baseline violations、0 cycles |
| Agent build / TypeScript | 通过；1749 个 dist 文件，未替换已安装子应用包 |
| development 页面构建 | 使用 `--preserve-symlinks=false` 通过；沿用 29.4 的本机依赖链接绕行，不改锁文件或正式配置 |

相关自动化合计 **572 项通过**。旧迁移备份、单文件 save 的真实 Electron 桥接及 Agent 双向锁互操作一并回归，未仅运行新增测试。Agent 测试替身既有警告不作为模型/子 Agent 测试证据。

新的完整 preload 测试创建全新临时工程并直接加载当前 v2 内核源码构建的 bundle：

1. 导出 generation，不创建 ABI；保留任意根类型原 ID、`deletable:false`、`movable:false`、collapsed、opaque data、可见子块及休眠 shadow。
2. 编辑普通字段并合并，在共同锁内落盘基线及已准备 ABI，注入“ABI 提交后中断”；确认 `MIRROR_PENDING`，原始输入含 CRLF/Unicode 精确保存在不可变记录，普通保存被屏障拒绝。
3. 销毁 renderer、重建完整 preload 页面，仅通过磁盘记录恢复；验证 ABS/map/committed 属于同代，ABI 字节完全不变，原 ID/保护属性及 shadow 仍在；重复 recover 无操作。
4. 验证过期 capability 不可重用。测试只关闭自己创建的窗口；测试用临时文件按已验证的根范围清理，不动用户原项目和库。

这证明**真实 Electron 宿主持久化与内核身份数据**贯通，不是生产 Blockly 工作区已全面采用 v2 的验收。没有把内核构造的状态冒充真实库动态字段/原生工作区加载结果，也没有声称 C++ 编译、动画播放或模型对话通过。

另外，以本批主程序新构建/完整 preload 和含 pending 屏障的 Agent dist，再次运行既有两个真实用户工程副本 smoke，验证宿主锁重构没有回归 legacy 生产路径。两份均 `success=true`、`errors=[]`，导入/通用大文本/实际 Agent 候选应用/重复保存/重开通过，原用户 ABI 哈希未变：

- 动画工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-GBmwzl/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-GBmwzl/project-data-page.png)。重复保存 revision 6→6，内存/磁盘一致；`src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节，内容哈希与第十七批一致。
- DHT22 工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-dUKLlB/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-dUKLlB/project-data-page.png)。重复保存 revision 5→5，内存/磁盘一致，`headers=[]` 符合该工程实际生成结果。

页面截图已检查；测试副本与报告保留，不删除原工程。上述 smoke 结束后仅补充 Agent 对 generation 临时文件的历史过滤并重新构建/跑自动化；没有把这条不涉及页面数据路径的最终过滤修改冒称为另一次完整 smoke。

复现：

```powershell
node --test --test-reporter=tap electron/project-file-writer.test.cjs electron/project-file-copy.test.cjs electron/project-file-writer-bridge.test.cjs electron/project-sync-storage.test.cjs electron/project-sync-storage-bridge.test.cjs electron/project-agent-publication.test.cjs
```

### 32.5 下一批的明确接点

1. **编辑器统一协调器。** 基于本批 `openAbsHostStorage` 与 `AbsBaselineStore`，把 editor FIFO/租约、完整 document/page revision、运行时配置、资源准备、v2 身份合并、native/chunk 完整读回、已准备 ABI 提交连成一个入口。不要再停留于单独增加存储机制；ABI 回调消费同一持锁能力，保存后 clean revision 只能在实际提交证明之后标记。
2. **生产启用的剩余合同。** 为新建/变形块、真实自定义字段/serializer、未访问页及共享符号补齐明确合同；无法验证者拒绝，而非猜测 ID 或忽略 opaque 引用。用两个用户工程副本验证实际工作区原 ID/保护属性/休眠 shadow。
3. **显式恢复与资源生命周期。** 提供 pending 的只读诊断及显式 recover/abandon 入口，处理陈旧/损坏 map、双向编辑、项目复制 scope 重绑定和资源 pin；继续收口 Agent 外部命令/追加/删除/补丁和其独立 file-publications 日志。所有必要入口完成后才统一启用 v2/map、清理退役生产分支。

aily-blockly-libraries、旧 aily-lex、原用户工程保持只读。本批 Agent 源码含新的 pending 屏障，已正常构建供开发链接使用；实际运行需完整 Electron 新 preload 与更新后的 Agent 进程配套，不擅自重启用户现有会话，也不宣称发布/安装包已自动更新。

## 33. 第十九批实施记录（2026-09-14）

### 33.1 主线与启用范围

落实 32.5 第 1 项，推进第 2、3 项：不再停留于纯内核或 MemoryHost 验证，新增 `AbsWorkspaceSyncService`，把实际 editor FIFO/租约、全工程快照、Generator 配置版本、Project Data、身份合并、原生/分片完整读回和同代文件发布连接起来。

该服务通过现有 `AbsAutoSyncService.generation` 显式取得，提供 `exportGeneration`、`applyGeneration`、`inspectRecovery`、`recoverGeneration`、`abandonGeneration`。这不是生产工具已自动切换 v2 的声明。`abs-v2.preview.3` 保持不变；未带 generation 的 legacy 工具仍使用原协议。项目中已有 map 或 committed 标记（包括空/损坏文件）时，legacy 路径返回 `ABS_GENERATION_PROTOCOL_REQUIRED`，不能在重开或自动导出时把身份投影改写回旧语法。

### 33.2 模块边界与实现

| 模块 | 职责 |
| --- | --- |
| `abs-workspace-sync.service.ts` | 编排现有能力；绑定排队前的工程、页面、workspace、Generator/配置版本、Project Data session；验证 revision、基线及物理文件，区分提交前回滚与提交后隔离 |
| `abs-workspace-state.ts` | 实际 Blockly 序列化、运行时字段/过程合同捕获、原生/分片装载、已有形状预检、完整工程外壳保护；传入库回调的是分离副本 |
| `AbsBaselineStore` | 延用原有 stage/commit/recover/abandon 状态机；增加 authoritative committed 读取与只读 pending 诊断，校验指针/记录哈希，不信任用户编辑的公开 map |
| `abs-host-storage.ts` / preload | 将 Angular 异步结果安全传过真实 contextBridge；同一宿主持锁能力贯穿已准备 ABI 提交，不调用普通 save、不重入工程锁 |
| `_ProjectService.publishPreparedSaveOutputs` | 普通保存和 generation 提交共用准备好的 package/code/头文件发布；不再重复这段编排，不重新运行 Generator |
| `BlocklyEditorAutomationAdapter` | 补齐排队前 Generator 配置版本捕获；同实例配置漂移也拒绝旧操作 |

没有新增库白名单、`field_multilinetext` 等字段名特判、探测块、全局 active lock、另一套保存队列或事务状态机。身份和 opaque 属性保留在 ABI/不可变基线；ABS 不增加逐块 `@meta`。通用文本/数组继续复用 Project Data 的资源准备与验证。

### 33.3 提交、回滚与恢复原则

1. **导出不保存 ABI。** 已有旧 ABS 必须显式 `initialize:true`，其精确原文保存在不可变 generation 记录；孤立 map 不覆盖。已有代的 ABS 未应用编辑或公开 map 被改动时拒绝导出。磁盘 ABI 已离开原基线时，只有其规范化保存内容与当前工作区一致才能重新建立基线；否则返回 `ABS_DUAL_EDIT_CONFLICT`。
2. **装载前验证。** 核对 authoritative generation、完整 document/page 与实际已保存 ABI 哈希、运行时合同、资源完整性、跨页共享模型约束和固定文件快照。无法验证的新建/变形块在 workspace clear 前拒绝，不猜 ID，也不沿用另一块的动态选项。
3. **完整读回。** 装载后先完成项目 Generator 的必要模型注册，再核对完整实际序列化结果。被忽略字段、额外变量、库回调修改保护属性等不能用 legacy requested-state 检查放行；同时检查未访问页及工程元数据没有变化。当前页面 viewport 属于 UI，内容/共享模型由完整 workspace 检查负责，其余页面外壳必须原样保留。
4. **唯一 ABI 提交点。** 保存形状准备完成后才 stage；`commit` 将同一 locked capability 传给 ABI 回调，后者只做已准备原文 CAS。仅 `COMMITTED` 且上下文/revision 仍匹配时返回 `appliedRevision`。后续派生产物错误只形成 warning，不宣称 ABI 回滚。
5. **失败按阶段处理。** 装载前失败不清空；装载后、确定 ABI 未保存时恢复旧工程并完整读回。回滚使用上下文而非旧 revision 守卫，因为 revision 单调增加；回滚失败仅尝试一次，返回 `ABS_ROLLBACK_FAILED` 并隔离。ABI 已保存而镜像未完成、宿主回执丢失或提交结果未知时保留当前内存和日志，禁止盲目回滚；新工程/页面上下文绝不被旧操作恢复或隔离。
6. **恢复是磁盘操作。** `inspectRecovery` 不写文件；显式 recover/abandon 即使编辑器已隔离仍可调用，但只在宿主文件锁内核验/补镜像或撤销未提交指针，不重放 ABS、不保存 ABI、不生成代码、不解除隔离或标记 clean。恢复后应显式重开。损坏日志、冲突和不可变输入保留，未加入自动重试、锁抢占或资源 GC。

### 33.4 真实 Electron 暴露的桥接缺口

初次实际 Angular 工程测试中，导出的 `publication` 变成 `{"__zone_symbol__state":null,"__zone_symbol__value":[]}`：renderer 返回的是 `ZoneAwarePromise`，contextBridge 将其当普通对象复制，宿主会过早结束持锁回调。第十八批无 Zone 的内核页面测试不足以覆盖此边界。

已将宿主 API 升为 `projectSyncStorageVersion=2`，磁盘协议仍为 v1。renderer 回调同步返回 void，异步结果通过显式 `settle({ok,value/error})` 交付；Promise 留在所属环境，宿主原生 Promise 等待实际完成后才撤销能力。旧 API 不降级兼容。真实完整 preload 测试加入 Zone.js，并断言实际 `ZoneAwarePromise` 异步写读返回普通结果，之后继续执行中断、renderer 重启及磁盘恢复验证。

### 33.5 验证记录

| 检查 | 结果 |
| --- | --- |
| 主程序 abs-sync | 455 项通过，较第十八批增加 30 项；包含实际原生/分片 workspace、保护根/休眠 shadow、大文本、双向冲突、完整读回、未访问页、回滚失败、提交不确定性、显式恢复及旧协议屏障 |
| 主程序 abs-project-load | 9 项通过 |
| 宿主 writer/copy/storage/真实 Electron 桥接/独立 Agent 互操作 | 48 项通过；最后串行运行测试文件，避免多个 Electron smoke 并发启动造成测试启动超时 |
| Agent 16 个相关测试文件 | 90 项通过；本批未修改 Agent 源码或重新分发子应用 |
| 主程序 TypeScript / development 构建 | 正常类型检查与构建通过；构建沿用 `--preserve-symlinks=false` 的本机 Junction 绕行 |
| 服务架构 | 165 个服务文件，0 cycles；当前全库检查另报 user-center 信用额度相关文件的 4 处 deep-import，不属于本批同步修改，保持原状 |

相关自动化合计 **602 项通过**。过程中认证模块曾暂时出现 3 处 unknown 类型错误；当时仅对运行验收使用命令级 `NG_BUILD_TYPE_CHECK=0`，未改配置。随后工作区该错误消失，已重新执行正常类型检查、正常构建及不带此变量的 455+9 项浏览器测试，上表不以跳过类型检查的结果代替正常验证。

实际工程页面验收使用现有 smoke 加 `AILY_ABS_GENERATION_SMOKE=1`，从真实 Angular injector 取得当前服务，不把另一个打包 runtime/替身注入生产页面。先保留原有导入/资源/Agent 投影/保存/锁回归，再显式导出 generation、修改通用大文本、校验陈旧 generation 被拒、实际分片应用、检查全体原 ID/保护属性/opaque 属性及变量身份、保存哈希、头文件和关闭/重开。

两个实际工程副本均 `success=true`、`errors=[]`；导出不保存 ABI，应用结果 `COMMITTED`、`appliedRevision=5`、`requiresReload=false`、`warnings=[]`。保存后和重开后的规范化内存/磁盘哈希相同，重开没有改写 ABI 或降级重写 ABS。结束时再次直接核对原工程 ABI 哈希，均未改变：

- 动画工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-RVLSuo/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-RVLSuo/project-data-page.png)。9 个实际块（含 smoke 文本块）及 2 个变量模型身份保留；最终 generation 为 `618af0bf-f0a5-481a-a050-12ffd21fd766`；`src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节，哈希 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`，与前批一致。
- DHT22 工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-MOB7e7/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-MOB7e7/project-data-page.png)。33 个实际块（含 smoke 文本块）及 3 个变量模型身份保留；最终 generation 为 `571e0cea-40df-41f8-be64-b49118106299`；该工程没有生成头文件需求，`headers=[]` 如实保留。

截图已检查：原图形及动画字段正常显示，页面中的依赖安装提示不代表编译验收。通用 `text` 块的大文本通过 v2 改写并全量验证，不以动画字段的单个特例代替通用路径测试；已有库字段随完整工作区原样保留。休眠 shadow 另由原生/分片单元测试及真实宿主内核恢复用例覆盖，不声称两个原工程都自带该测试形状。

初次 Zone 桥接失败及 smoke 错把 map 的扁平 `start/end` 当作 `range` 的失败报告均保留，后者只修正测试脚本，不更改身份 map 格式。宿主测试在多实例启动时出现过一次测试超时，最终按文件串行全部通过，未放宽超时或删除断言。最终页面测试后仅删除一条未使用的 smoke 全局服务引用，不改产品实现。

复现（每次在新的临时副本运行，不向原工程写入）：

```powershell
$env:AILY_AGENT_ROOT='D:\codes\aily-lex-pro\packages\aily-agent'
$env:AILY_ABS_GENERATION_SMOKE='1'
node scripts/project-data-electron-smoke.cjs 'C:\Users\LENOVO\Documents\aily-project\project_jul13d_353995'
node scripts/project-data-electron-smoke.cjs 'C:\Users\LENOVO\Documents\aily-project\ESP32S3_DHT22_HTTP'
```

### 33.6 下一批明确接点

1. **补齐准备态运行时合同。** 在不执行试探性库副作用的前提下，为新建/变形块及自定义 serializer 提供明确准备合同；补齐动态过程、共享符号及未访问页引用覆盖。当前拒绝限制不能在没有合同的情况下放开。
2. **统一生产 dispatch 与恢复 UI。** 基于本批实际协调器接入 Agent 的 versioned generation 请求/回执和用户可见诊断；设计显式初始化、陈旧/损坏 map、项目复制 scope 重绑定。所有入口完成前不自动切换整个工程，也不删除仍在服务 legacy 项目的解析分支。
3. **资源与外部写入生命周期。** 为不可变基线/pending/历史做资源 pin，再考虑 GC；补齐 Agent 外部命令/追加/删除/补丁及独立 file-publications 日志的协调，派生产物继续使用已准备版本，不引入第二次 Generator 执行。

aily-blockly-libraries、旧 aily-lex、原用户工程只读；本批修改位于主程序、验证脚本及契约文档。主程序需重启加载新 preload；不擅自重启用户当前 Electron/Chat/Agent，不宣称 C++ 编译、硬件播放、模型对话或正式安装包发布已验收。

## 34. 第二十批实施记录（2026-09-15）

### 34.1 主线选择与不变量

推进 33.6 第 1 项的新建块准备合同、共享变量引用和第十九批协调器的实际验收。第一性约束是：**默认值属于输入合同，不是装载后忽略新增状态的理由；块定义必须来自当前实际注册，不能把磁盘 JSON 或其他实例的动态选项当作当前形状。**

本批使已验证的声明式新块可以通过 v2 实际协调器应用，不再全部拒绝新 ID。含未知 extension/mutator、自定义字段工厂、动态变形 serializer 的新形状仍在 clear 前拒绝；没有因为某个库名或某个字段名临时放行。生产 Agent 的 generation dispatch、恢复 UI 和全量 v2 启用不在本批冒进切换。

### 34.2 已实现的模块与清理

| 模块 | 实现 |
| --- | --- |
| `BlocklyDeclarativeBlockCatalog` | 记录经过当前 i18n/boardConfig/静态路径/Project Data 装饰后的真实注册 JSON、注册对象及 init 来源；按操作返回分离快照，使用过的定义被覆盖、源 JSON/原型改变或目录 reset/rebuild 时失效 |
| `BlocklyService` | 在既有 `loadLibBlocks` 注册后记录来源；在现有项目 reset 和原地 runtime rebuild 时清空目录。目录不负责字段语义，不创建试探块或第二个 runtime |
| `abs-declarative-contracts.ts` | 纯声明式语义编译：标准文本、数字、复选框、静态下拉、可序列化标签、显式变量引用及输入/输出/语句连接种类；未知 factory/extension/mutator 不编译为静态合同 |
| `AbsReconcileOptions.blockContract` | 宿主为新 ID 提供字段及默认值，字段值继续复用现有规范化和符号解析；默认值与候选一起进入资源准备，而非在装载后补一套规则 |
| 形状预检 / workspace coordinator | 核对新块字段集合、输入名称、next 能力及已知连接种类；声明来源守卫贯穿异步资源、装载和同锁 CAS；已有块继续保留实例合同、原 ID 和 opaque 状态 |
| `abs-new-root-layout.ts` | 唯一授权装载后按实际整栈边界布局新增根块，避开保留根块并将坐标写入待读回候选；不整理旧块、不二次装载、不改变字段或模型；布局失败沿用协调器回滚 |
| `abs-readback.ts` | 删除没有生产调用的 `allowDefaultsFor` 开关及其放宽分支。新块和旧块都必须通过完整状态读回；legacy requested 模式仍只服务未迁移的旧入口 |

变量字段不自动造默认模型；必须显式解析已有、类型允许的模型，未知名称在装载前拒绝。实际 native 回归确认新变量字段绑定原模型 ID、不新增或重命名模型。数字范围/精度、复选框布尔序列化和静态下拉继续使用已有字段语义，不新增转换器。

### 34.3 覆盖与限制

1. 新块的标准默认值在准备阶段固定；遗漏必填模型字段、未知字段/输入和明显不兼容的已知连接提前拒绝。真实装载产生额外模型、字段、serializer 或改写已准备值时仍失败并按第十九批规则回滚/隔离。
2. 图形库不需要修改。标准字段类型的语义适配不同于库白名单：同样 JSON 结构的任意库均走同一路径；复杂扩展需要未来明确的 host adapter，不能从一次 probe 的结果推断所有形状。
3. 现有块修改 `extraState` 或字段集合仍不能未经动态合同放行。此阶段不宣称任意新自定义块、任意变形块和过程 serializer 已全部支持；无扩展、可证明的声明式形状是已经打通的范围。
4. 保持已有 iframe/session/revision 生命周期，不引入新的全局块定义缓存。声明快照不能在重建后继续使用，也不读取另一工程的磁盘 JSON 代替当前注册表。
5. 原子提交、pending 恢复、Project Data 资源存储格式和 Agent 包均不重写。不可变基线的资源 pin/GC、复制 scope 重绑定和用户可见恢复入口仍属于后续主线。

### 34.4 验证记录

| 检查 | 结果 |
| --- | --- |
| 主程序 abs-sync | 475 项通过，较第十九批增加 20 项；包含声明编译、注册来源漂移、真实变量模型、新块完整读回、原生/分片应用及 LTR/RTL 新根布局 |
| 主程序 abs-project-load | 9 项通过 |
| 宿主 writer/copy/storage/真实 Electron 桥接/独立 Agent 互操作 | 按文件串行运行，48 项通过 |
| Agent 16 个相关测试文件 | 按文件串行运行，90 项通过；未修改或重建 Agent 包 |
| 主程序 TypeScript / development 构建 | 正常类型检查与构建通过；构建沿用命令级 `--preserve-symlinks=false`，不改本机 Junction 或正式配置 |
| 服务架构 | 165 个服务文件，0 cycles；仍有 user-center 信用额度相关的 4 处 deep-import，属于现有独立改动，未在本批修改 |

相关自动化合计 **622 项通过**。最终真实页面验收报告在下面单独记录，不把自动化数量当作 C++ 编译或硬件播放验收。

扩展既有真实页面 smoke：在编辑大文本的同时新增实际安装库的 `string_add_string()`，要求恰好一个新 ID，所有原 ID/保护/opaque 属性与变量模型不变，新块关闭重开后仍为同一 ID；该块不是测试注册的替身。新声明式大文本字段的默认值及原生/分片加载由原生 Blockly 单元测试覆盖，不将字符串拼接块冒充大文本字段覆盖。

两份首次并发页面测试均在独立 Agent 工具注册冷启动阶段超时，尚未进入新块应用验收；失败报告保留于 `aily-project-data-ui-SfEEWH`、`aily-project-data-ui-iCQhlg`。随后改为串行重跑，不放宽 45 秒冷启动超时，不关闭用户进程，不把失败归类为产品新块验证通过。

串行首轮另发现 smoke 仍依赖 `--serve` 默认的 localhost:4200 页面，但当前没有运行该开发服务器（报告 `aily-project-data-ui-QQFFS9`）。已在 smoke 自己的 BrowserContext 内将该启动请求重定向至测试自己托管的已构建 renderer；不更改产品 main/preload、端口配置，也不启动用户开发服务器。

重跑报告 `aily-project-data-ui-pB1Ex2` 与 `aily-project-data-ui-AmKMAQ` 的身份/大文本/保存重开检查通过，但动画工程截图暴露新增根块沿用转换器固定坐标、与旧块重叠。随后增加独立新根布局模块及几何不相交验收，旧块位置仍逐项原样比较。布局结果是宿主生成的 UI 状态，必须在完整读回和保存 revision 固定前纳入候选；不能在提交后悄悄整理工作区。

最终 development 产物已核对包含上述布局实现，使用 33.5 中的两条命令串行重新验收，两个报告均 `success=true`、`errors=[]`：

- 动画工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-uCpPRm/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-uCpPRm/project-data-page.png)。10 个块（含通用文本测试块与本批新增块），原有 2 个变量模型不变；新增 ID 为 `cacc000c-6d40-442e-9a4f-8cc65054d90a`，generation 为 `4f0c8a4c-1a5c-4afa-948b-0c242f560068`。`src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节，哈希仍为 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`。
- DHT22 工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-4v6dCx/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-4v6dCx/project-data-page.png)。34 个块（含上述两种测试块），原有 3 个变量模型不变；新增 ID 为 `b2441f4f-e844-4632-9846-fa93a08b3989`，generation 为 `de8a3a59-87e5-4157-83e0-e6e4235d7bae`。该工程没有生成头文件需求，`headers=[]`。

两工程导出均不保存 ABI，应用均为 `COMMITTED`、`appliedRevision=5`、`requiresReload=false`、`warnings=[]`，完成后没有 pending。大文本仍由 Project Data 资源引用承载，不内联进 ABS。保存和重开后的规范化内存/磁盘哈希分别一致：动画工程 `333ab37c8709b5df5befb2ca79fa18a1781ad7d6547fc85713fa83f080be1f7a`，DHT22 工程 `96510f88db956027219144d3ed86180c17c47918c621dd6189d12c617a46247f`。重开不另存 ABI、不降级重写 ABS，新块身份保留。

已实际检查两张最终截图：原图形正常显示，新增根块位于旧块下方且不重叠；同时通过运行时几何不相交断言，不只依赖截图。结束时再核对原用户 ABI：动画工程哈希 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`，DHT22 工程哈希 `b2e5ef1dd126aaa825ed3297acbe2774ef1659a3bb8b275ba53804544050c5cb`，均与测试开始前一致。截图中的依赖安装提示不等于编译通过；本批不宣称 C++ 编译、硬件动画播放、正式 Agent v2 dispatch 或安装包发布已验收。

### 34.5 下一批主线

1. **动态合同。** 沿用本批已准备字段/默认值/连接结构，提供受控的 host-owned extension/mutator/自定义 serializer 合同；覆盖新建和变形、动态过程及跨页共享引用。禁止试探性调用库代码来猜合同。
2. **生产与恢复接入。** 在新协议请求/回执中明确 generation、source hash、scope 和应用状态；接入 Agent dispatch 与恢复 UI，处理初始化、损坏 map 和工程复制重绑定。未完成前保留显式 preview 及 legacy 屏障。
3. **资源生命周期。** 为基线、pending、历史建立可验证 pin，再考虑实际 GC；继续协调外部命令、追加/删除/补丁与独立历史日志。不存在生产调用的宽松分支可继续移除，但不删除仍承担旧协议入口的必要实现。

原用户工程、aily-blockly-libraries 与旧 aily-lex 保持只读。本批只修改主程序、测试及文档，不发布 Agent 包、不改用户依赖链接和正式构建配置。

## 35. 第二十一批：日常 Agent 工具落地（2026-09-15）

### 35.1 交付目标与取舍

交付“实际 abs_export → 文件工具编辑 → abs_validate → abs_apply/abs_import → project_save”的连续两轮闭环，并验收关闭重开后的完整状态。原先待办的所有未知动态块、自定义 serializer、资源 GC 不再与这个有限且安全的可用范围捆绑。

仍遵守 Runtime 隔离文档的同一 iframe/session、队列、租约和已准备 Generator 输出。库及原用户工程只读；本批允许修改并正常构建工作区中的 aily-lex-pro Agent，不重启用户现有会话、不发布远端包。

### 35.2 生产接入与模块边界

- 新增纯 `abs-generation-protocol.ts`，绑定显式 generation、项目/页面、ABI 原文字节哈希、基线 ABS 哈希、map 原文字节哈希和候选哈希/字节数。map 仍非可信权限来源，宿主再核对 authoritative committed 基线。
- `AbsWorkspaceSyncService` 抽取唯一候选准备流程，供 validate/apply 共用；校验不装载或发布镜像，可准备不可变资源。apply 重新检查准备 revision，不保存掉用户后来的编辑。成功输出来自同一已提交投影。
- `AbsGenerationToolsService` 只适配请求/回执；实际生产 bridge 转调它，删除旧 importContent 后普通 save/confirm 的重复提交段。导出支持显式初始化和自定义文件的只读投影，不另起事务内核。
- Agent 原 host-projection / host-candidate / live 模块替换为 version 2；删除 apply 前 project_save、固定等待和离线降级。generation 必须来自调用者当前编辑的导出结果，不能从新的 map 偷换基线。
- abs_import 复用 abs_apply 注册实现，不再从正常工具执行离线整体重建。保存/整理后的投影也使用 v2，因此不是只接通一个 abs_apply。
- project_recover 改为 explicit inspect/recover/abandon 工具，复用现有宿主磁盘 API。恢复不重放 ABS、不生成/保存块、不解隔离、不伪造 workflow 成功；必要时显式关闭重开。
- 清理过期语法、自动重试和恢复重建指引，使工具描述、ABS 指引与变量/验证参考一致。保留 Project Data Schema 1；ABS Schema 2 与 wire version 2 独立，已有 projectionVersion 标识不因为接线而改写。

### 35.3 首版边界

已有 unversioned ABS 需要显式 initialize=true；旧原文作为恢复输入保留，不是自动舍弃。已建立 v2 后有未应用 ABS 编辑、map 损坏、项目复制/切页 scope 不匹配时继续拒绝，不自动覆盖或重绑定。

复杂动态新块/变形、自定义 serializer 和模型创建能力仍受合同限制。资源 GC 不自动启用。完整恢复 UI、复制/切页重绑定、历史导航与基线资源 pin 仍待后续实现；本批先提供可调用、可诊断的恢复工具，不声称任意坏工程都能从 ABS 重建。

### 35.4 验收

| 检查 | 最终结果 |
| --- | --- |
| 主程序 abs-sync | 482 项通过，较前批增加 7 项；覆盖 wire 初始化、严格准备/应用、旧协议拒绝、候选/map/page 漂移、校验后用户编辑及显式恢复 |
| 主程序 abs-project-load | 9 项通过 |
| 宿主 writer/copy/storage/真实 Electron 桥接/独立 Agent 互操作 | 48 项通过 |
| Agent 17 个相关测试文件 | 94 项通过；包括新增 3 项恢复回执测试及 generation 必填/陈旧拒绝、三镜像字节验收 |
| 类型与构建 | 主程序正常 TypeScript、development 构建通过；Agent 正常 rslib 构建及声明生成通过。未跳过类型检查；主程序仍仅在命令上使用 --preserve-symlinks=false |
| 服务架构 | 165 files、0 cycles；现有 user-center 信用额度的 4 处 deep-import 保持原状，本批未新增 |

上述测试执行数合计 **633 项通过**。真实页面测试不再通过 Angular injector 调用协调器完成变更：独立 Agent 子进程使用实际 `createBlocklyToolCatalog`、`WorkspaceHistoryRuntime.begin/finalize` 和实际 read/write 工具，走认证 CLI bridge 完成导出、两轮文件编辑/校验/应用/保存及恢复诊断。第一轮 abs_apply，第二轮 abs_import；页面侧仅检查全量字段、ID/保护/opaque 属性、变量、布局、代码/头文件与关闭重开。

第一次该完整链路已走过两轮应用与保存，但恢复诊断回执失败（报告 `aily-project-data-ui-kdh8au`）：工具请求 ID 放在顶层，被外层 IPC 路由请求 ID 覆盖。已改为与其他工具相同的嵌套 receipt，并补充外层 ID 不同的回归；不放宽请求身份检查、不自动重试。修复并重新构建后，两个工程串行完整重跑均为 `success=true`、`errors=[]`：

- 动画工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-d1tqIj/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-d1tqIj/project-data-page.png)。10 个块（含通用大文本测试块与新建声明式块）、2 个原变量模型；新增 ID 为 `bc8d1bd9-bc94-429f-ac65-729288e837d8`，最终 generation 为 `76ca4c08-f38f-49bc-8a16-fc1068d7d679`。两次候选分别为 65,674 / 65,673 字节，提交后 ABS 恢复为紧凑资源引用。`src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节，哈希仍为 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`。
- DHT22 工程：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-w8aNOQ/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-w8aNOQ/project-data-page.png)。34 个块（含上述两种测试块）、3 个原变量模型；新增 ID 为 `1b0225b5-c53b-4b2d-bdde-c50d6c75d015`，最终 generation 为 `c1476102-2783-49d6-b836-184b46313c61`。两次候选分别为 66,938 / 66,937 字节；该工程无生成头文件需求，`headers=[]`。

两工程均由实际工具注册表执行，并在真实 history 事务中记录 ABI/ABS/map 和两份不可变 payload；动画工程还记录派生代码关联的 package 变化。两轮均取得 `complete-generation` 回执，最后实际 project_recover inspect 返回 `pending=null`、`requiresReload=false`。过期 generation 被拒绝且未改镜像；所有原块 ID、保护与 opaque 属性、原变量模型保持不变，新根块通过几何不相交断言。

保存与重开后，规范化内存/磁盘四份哈希一致：动画工程 `6fbcac2ec02452d1e6e421c64932a94cd4d26f9e7487e233786800aec2bbb8d6`，DHT22 工程 `02a9d39b18a36a964dd24452957c8742e15a538de46f912badf7f2f8a1194cf4`。重开不另存 ABI、不降级重写 ABS，大文本内容以完整哈希校验，不仅检查截断预览。已实际查看两张最终截图，原图形和新增根块显示正常。

结束后再次核对原用户 ABI，动画工程 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`，DHT22 工程 `b2e5ef1dd126aaa825ed3297acbe2774ef1659a3bb8b275ba53804544050c5cb`，均未改变。原工程、库仓库和旧 aily-lex 保持只读。本批完成工作区主程序与 aily-lex-pro Agent 构建，不重启用户现有进程、不发布安装包；未验收 LLM 自主对话、C++ 编译和硬件播放。

### 35.5 使用与下一阶段

1. **当前即可接入的范围。** 主程序与工作区 Agent 需一起重新加载。已有 unversioned ABS 首次用 `abs_export({ initialize: true })` 显式建立基线；后续编辑携带该次导出的 `generation` 调用 validate/apply/import。保存/整理返回的新 generation 替代旧值；冲突须诊断，不能自动改用最新 map 或先保存来消除冲突。线协议见 [abs-generation-tools-v2.md](../contracts/abs-generation-tools-v2.md)。
2. **优先处理工程身份边界。** 为工程复制、页面切换与损坏映射设计显式重新绑定/恢复入口，保持旧候选与新 scope 的隔离；配套真实工具及页面测试，避免普通使用操作触发不可解释的拒绝。
3. **按能力扩展动态合同。** 为动态新块、变形及共享模型创建分别提供宿主管理的合同和拒绝原因；每项必须覆盖准备、完整读回及回滚，不能用宽松 serializer 回填来假装无损。
4. **随后补齐生命周期。** 在历史导航、基线/pending/历史资源 pin 和完整恢复 UI 验收前，不启用自动 GC。旧离线诊断 helper 和仍被测试引用的旧恢复 API 不算正常 Agent 工具，后续按调用图单独收敛，不与生产 fallback 混用。

## 36. 第二十二批：工程复制、切页与公开映射修复（2026-09-15）

### 36.1 第一性原理与交付范围

ABI 和实时工作区承载工程状态；ABS 只是某个页面、某次完整基线的编辑投影。文件复制不等于基线已获得新工程身份，切页不等于旧页面候选可以应用到新页。公开 map 可以从完整 authoritative 基线重新投影，但丢失/损坏 authoritative 基线时不能凭公开 map 猜回身份。

本批交付一个共同入口：`project_recover(action="inspect")` 只读诊断 → 确认目标 scope/修复意图 → `abs_export(rebind=diagnostics.rebind.token)` 显式重新投影。复制、切页和公开 map 损坏不分别建立事务系统；不自动修改库、原始 ABI 或旧候选。

### 36.2 模块与协议

- `AbsBaselineStore.inspectCommitted` 允许跨 scope 的只读校验，验证 immutable record 与 committed pointer 的校验和。load/apply/commit/recover 的 scope 屏障不放宽；scope 错误不再被包成“数据损坏”。
- 新增纯 `abs-generation-inspection.ts`：整合磁盘状态、pending、权威基线和目标 scope，返回状态、原因、三镜像哈希及可选 rebind token，不暴露巨大原始字节。令牌绑定三镜像字节、committed pointer 哈希和目标工程/页面；不作为 apply 权限。
- 唯一 workspace 协调器复用 export 路径：持有原队列/租约/runtime session，复查 token、ABI 与内存冲突、镜像和指针；新的 generation 仍由同一个内核发布，不保存 ABI、不装载块、不生成代码。
- stage 增加可选 expectedCommitted 检查；rebind 记录精确 `inputMap`，校验其哈希等于旧 map 字节。原 inputAbs、旧 immutable baseline 均保留，公开 map 缺失与空字符串也不混淆。中断仍按既有 export journal 恢复。
- Agent 的现有 abs_export 增加可选 rebind，project_recover inspect 验证实际磁盘哈希、scope 与状态。回执绑定所请求 token，仍验证新 ABI/ABS/map 的字节与 generation；不增加自动诊断后写入、重试或旧候选换 generation 的分支。
- 更新正常工具描述、语法与项目生命周期指引；旧 journal 恢复 API 与新的 projection rebind 各司其职。Runtime Realm 和库注册机制保持原设计。

### 36.3 明确拒绝与后续边界

只有 authoritative baseline 完整、没有 pending、ABS 与基线原文一致、ABI 已存在，且问题仅为 scope/map 不匹配时，才提供 token。存在未应用 ABS 编辑时，即使 map 也损坏，仍不允许覆盖。token 不能与 initialize 或自定义 outFile 混用；任何文件、committed pointer 或目标 scope 变化都要重新诊断。

缺失/损坏 authoritative baseline、孤立 map、损坏 ABI、复制来的 pending journal 不在重绑定范围。复制来的 pending 必须回原 scope 先恢复/处理，再重新复制；不手动删日志。诊断是磁盘证据，不宣称工作区已保存；新投影仍允许现有 export 语义下的内存编辑，并受 ABI/内存冲突检查。新页面未保存时，重绑定不会代替页面保存。

复杂动态块/共享模型创建、完整恢复面板、历史导航与资源 pin/GC 仍独立推进。原用户工程、库仓库与旧 aily-lex 只读；本批不发布远端包、不进行硬件或 C++ 编译验收。

### 36.4 验收记录

主程序 492 项相关回归（新增 10 项）、Agent 99 项相关回归（新增 5 项）、宿主 48 项、项目加载 9 项全部通过，合计 **648 项**。主程序正常类型检查、development 构建与 Agent rslib 构建/声明生成通过；未跳过类型检查，主程序仅在命令上使用 --preserve-symlinks=false。架构检查仍为 165 files、0 cycles；原 user-center 的 4 处 deep-import 未动，本批无新增。

真实测试在第 35 节工具链后追加：用正式工程复制入口复制已生成 v2 的临时工程，通过实际 Agent 工具诊断/重绑；在副本注入公开 map 损坏并修复；用页面服务创建、保存新页并双向切页重绑，随后对新 generation 的原样投影再次 validate/apply 和关闭重开。每次重绑核对 ABI 未写、原始 map 已保留、旧 generation 被拒绝；最终核对原页面完整序列化和源工程三镜像未改变。不是通过协调器注入调用绕过正常工具，也不把 scope 迁移说成自动合并旧候选。

动画工程已通过：[报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-jc81kg/result.json)、[页面截图](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-jc81kg/project-data-page.png)。路径由同一临时目录下 `Imported Project` 绑定到 `Generation Copy`，切换到新增页 `page-1789408436915-takzqd` 后回到 `page-1`；最终 generation 为 `b42ce3be-6f39-4ac3-b27e-c2463de817f7`。复制/公开 map 修复两次 history 各仅改变 map；两次切页重绑各仅改变 ABS/map，没有 ABI 写入。最终原页面完整序列化哈希 `d632073c012774c79abdc3c1bbf887c90708690ede10084c681aef45169e5b9a` 一致，诊断为 ready、pending 为空。已检查截图与副本头文件，1,530,987 字节的动画 `.h` 哈希仍为 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`。

DHT22 首次测试在建立 Agent history 快照时遇到 `ENOSPC`（[失败报告](C:/Users/LENOVO/AppData/Local/Temp/aily-project-data-ui-AWziMg/result.json)），尚未进入本批重绑定步骤。保留失败目录及所有历史，没有清理用户数据；将重跑进程的 TEMP/TMP 临时指向 D 盘独立测试目录，未修改全局环境配置。测试 helper 同时保证 begin 失败也 dispose 自己的 history worker。

DHT22 完整重跑已通过：[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-JaPrYa/result.json)、[页面截图](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-JaPrYa/project-data-page.png)。原页面 34 个块、3 个变量模型；新增页 `page-1789408986149-w7i6bc` 双向切换并绑定成功，最终回到 `page-1`，generation 为 `6e9dbad0-7a92-4a1e-837a-973bddbe1141`。四次重绑的 history 变化范围与动画工程相同，最终 complete-generation 应用成功、诊断 ready、pending 为空；原页面完整序列化哈希 `0bee430e8859f74938957d01f9c12fb26ca5cd0e80a5f4357420b3f05b9313d9` 一致，没有额外头文件需求。

两个报告均为 `success=true`、`errors=[]`，已实际查看最终截图。原页面的字段、ID、保护属性、变量及布局在复制/修复/切页/再次应用/重开后保持原样，新增页仍保存在 ABI 中。源临时工程三镜像及原用户工程 ABI 均未改变；结束时原动画工程哈希仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`，原 DHT22 工程仍为 `b2e5ef1dd126aaa825ed3297acbe2774ef1659a3bb8b275ba53804544050c5cb`。

主程序与工作区 Agent 构建已更新；现有用户进程未重启，需一起重新加载使用新诊断/重绑参数。没有发布安装包或远端 Agent 包，不将上述结果等同于 LLM 自主对话、C++ 编译或硬件播放验收。

### 36.5 下一阶段落地主线

优先补齐“从空工程创建普通变量/过程并引用”的宿主管理模型合同，再扩展常用动态块的新建/变形。模型创建、引用重绑定和运行时 serializer 读回分别负责自己的不变量，不能通过允许未知 extraState、自动创建同名变量或放宽完整读回来混合解决。验收继续走实际 Agent 工具与真实页面，覆盖创建后再次编辑、保存重开、跨页共享和失败保留旧状态。

完整恢复面板、历史导航资源 pin 和 GC 保持独立，不阻塞上述有限范围；GC 在所有基线/pending/历史引用有可靠 pin 前保持关闭。本批交付的是明确操作的绑定修复，不是自动忽略冲突，也不是任意坏工程恢复器。

## 37. 第二十三批：普通变量创建与引用落地（2026-09-15）

### 37.1 收敛目标与设计原则

本批将第 36.5 节拆成可独立验收的普通变量闭环。变量模型、C++ 声明块和变量引用是三个不同概念：仅添加声明块会让部分 Generator 临时注册模型；仅创建模型又不会生成 C++ 存储。应在同一候选事务中显式准备模型、声明和引用，不能放松完整读回来容忍副作用。

交付目标：空白开发板模板 → 实际 Agent 创建模型并添加声明/读写块 → 再次编辑 → 保存重开，原保护根不变、模型与引用 ID 一致、生成的 C++ 同时包含声明与使用。既有动画/大文本、复制/切页/映射修复回归继续保留。

### 37.2 实现范围

1. `createVariables:[{name,type?}]` 作为 abs_validate/apply/import 的可选工具参数，不新增 @var/@meta，不额外维护可变模型 sidecar。主程序的纯准备模块检查格式、上限及不区分大小写的共享命名空间；ID 由宿主按 requestId/序号固定。模型类型默认空字符串，与 C++ TYPE 不混用。
2. 在校验原始 authoritative baseline 后，为独立候选准备变量表；符号解析使用候选表，基线身份匹配仍用原基线。无 ABS 文本变化的纯模型创建同样走完整事务。validate 不装载模型；apply 原生/分片装载、生成、完整读回、ABI 提交及失败回滚仍复用唯一协调器。
3. 请求/回执绑定创建意图。Agent 在异步传输前分离参数，拒绝宿主漏回/改写/额外返回创建意图；另要求宿主生成 preparedVariables 的明确模型身份，并核对保存 ABI 的字节哈希与实际模型。不能仅因旧宿主原样回显未知参数就推断其支持创建。apply 自己执行同一轮准备，不将单独 validate 的 ID 当作预留身份；比较不依赖 JSON 对象键序。
4. 普通变量读写块的内置 `contextMenu_variableSetterGetter` 只负责右键菜单，数字块的 `parent_tooltip_when_inline` 只设置提示回调。增加单独的、与当前 Blockly 版本绑定的注册身份适配器；编译合同不执行扩展探测。当前版本只有 TEST_ONLY.allExtensions 暴露注册函数身份，访问缺失或被替换即拒绝；不把同名未知扩展列入白名单、不修改任何库。接口升级时在此适配器单点处理。未知形状错误带实际块类型，避免只返回无法定位的笼统提示。
5. 清理 block_info/blocks_list 中残留的 `$变量名` 旧语法描述，同步工具描述、统一变量指导和使用参考。测试复用渲染工作区初始化，避免为新功能另建加载/保存/发布路径。

### 37.3 边界与验收计划

不自动创建未声明模型、不支持本批之外的重命名/删除/动态过程签名、不接受调用者模型 ID。重复创建必须明确失败；后续编辑省略创建清单。其它有内容的页面仍须有当前引用覆盖证明；未知 serializer 或额外 Generator 模型继续触发失败与原有回滚/隔离。

过程参数还包含动态 argId、字段、输入和共享定义，不能复用普通变量列表冒充实现；按独立模型/形状合同留到下一批。完整恢复 UI、资源 pin/GC 保持之前边界。原用户工程、库与旧 aily-lex 只读，不发布包或重启用户进程。

验收包括：纯准备/错误意图/大小写冲突/异步变更；原生和真实渲染分片加载；新模型与引用读回、额外 Generator 副作用回滚；Agent 请求/回执错配与不重试；正常类型与构建；实际 Electron 空模板创建、二次编辑、代码生成、保存重开。结果与失败修复证据在完成后记录，不能将测试代码编写等同于验收通过。

### 37.4 自动化结果与真实验收记录

主程序 abs-sync **505 项**（较前批增加 13 项）、项目加载 **9 项**、宿主 writer/copy/storage/独立 Agent 互操作 **48 项**、Agent 17 个文件 **105 项**（增加 6 项）通过，合计 **667 项**。主程序正常 TypeScript 与 development 构建、Agent 正常 rslib 构建/声明生成通过；主程序沿用命令级 --preserve-symlinks=false，未改配置或依赖链接。架构检查仍为 165 files、0 cycles，现有 user-center 的 4 处 deep-import 未动，不将整体架构检查标为通过。

日志：主程序 `.tmp-abs-batch23-tests.log`、`.tmp-abs-batch23-load.log`、`.tmp-abs-batch23-host.log`、`.tmp-abs-batch23-build.log`；Agent 包下 `.tmp-abs-batch23-agent.log`。首轮分片新增用例误用 headless workspace，在 resizeContents 处失败；改为复用真实 WorkspaceSvg 测试初始化后通过，不修改产品加载器来满足测试。另覆盖旧宿主仅回显新参数、准备 ID 变更、保存 ABI 缺失模型和 JSON 对象键序差异。

首次真实 DHT22 执行已通过原大文本/复制/修复/切页链路，在新增测试步骤因 write 前未通过实际 read 工具建立文件版本而被 Agent 安全检查拒绝，尚未应用变量候选。失败报告保留在 [aily-project-data-ui-CGUCpv/result.json](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-CGUCpv/result.json)，没有关闭文件版本保护、删除历史或修改原工程；测试改为正常 read → write 后重新完整执行。

第二次完整执行的既有链路同样通过；空模板新建 `math_number` 因其 UI 提示扩展未纳入准备合同而被拒绝（[aily-project-data-ui-xBoWa9/result.json](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-xBoWa9/result.json)），没有提交变量候选。核对当前 Blockly 实现仅调用 setTooltip 后，补入同一个注册身份适配器及替换身份回归；错误消息同时携带块类型。测试增加 `AILY_ABS_VARIABLE_ONLY=1` 的独立入口，仍用真实 Electron、完整 preload、实际安装开发板空模板、实际 Agent 工具与 history，只跳过此前的大文本/重绑定步骤，便于针对新增闭环迭代；不将此入口结果冒充全量 smoke。

首次变量专项执行 `aily-project-data-ui-vx5xip` 已成功提交两轮变量候选且生成代码检查通过，但重开后立即读取 getGeneratedCode 得到空缓存，使测试失败。该方法只读取按需生成缓存，不是工程装载完成凭证；没有改产品自动生成/加载行为。验收改为在实际 Agent 编辑/保存后核对 C++，重开后比较完整 native state、模型/引用及内存/磁盘哈希，并核对三镜像没有被重写。

变量专项最终通过：[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-vW8p07/result.json)、[真实页面截图](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-vW8p07/variable-generation-page.png)，`success=true`、`variableOnly=true`、`errors=[]`。使用 DHT22 工程已安装的 XIAO ESP32S3 库与真实空白开发板模板，仅预置 3 个保护根、无变量；实际 Agent 创建 `abs_counter` 模型、声明、两处赋值及一处读取，再通过 abs_import 修改赋值为 3 并保存。模型 ID 为 `abs-variable:5faa5022-3252-45ab-a96f-3516c6ce178c:0`，省略创建意图返回 ABS_SYMBOL_MISSING，重复创建返回 ABS_VARIABLE_EXISTS，两个拒绝均不改三镜像。

实际保存后生成的代码包含 `int abs_counter = 1;`、setup 中的 `abs_counter = 3;` 和 loop 中的 `abs_counter = abs_counter;`；不等同于编译或硬件验收。重开后 9 个实际库块、同一模型及 3 处引用均保留，原保护根不可删除；保存/重开的内存与磁盘四份规范化哈希均为 `2764c40109a7e92a0f756cd28e1df06b2fce20c6942a68d764caba09bdf517de`。history 记录 package/ABI/ABS/map，pending 为空。已查看截图，声明与读写块正常显示。

动画工程最终全量通过：[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-eYnfHo/result.json)、[原动画页面](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-eYnfHo/project-data-page.png)、[空模板变量页面](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-eYnfHo/variable-generation-page.png)，`success=true`、`errors=[]`。覆盖独立 Agent writer 互斥、原大文本两轮编辑、声明式新块、复制/损坏 map 修复、双向切页及保存重开，再用该工程安装的库从真实空模板完成相同变量闭环。两个页面截图均已实际检查。原动画头文件 `src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 实际存在，1,530,987 字节、哈希 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`，未改变。

动画页保存/重开的四份规范化哈希均为 `af0aae5a237c1bc3ae11ef238aa32af438500190b5fd7513ea228a619cfba437`；重绑定后的最终 generation 为 `9032a7ac-46df-49b0-aca6-86e1588f0b5d`。新增空模板模型 ID 为 `abs-variable:b848de6f-dd80-4206-bd4c-33069a2ee0c3:0`，变量工程最后 generation 为 `2ba3bde2-3125-4e4d-94a8-ee9140de9025`，保存/重开的四份哈希均为 `0e7203cc722c508576d3d2cecb4e31d9841517aca0afd2ea788c7c723365be10`。重开不写三镜像，最后返回原动画副本页面，两个项目状态相互隔离。

最终再次核对原用户 ABI：动画工程 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`，DHT22 工程 `b2e5ef1dd126aaa825ed3297acbe2774ef1659a3bb8b275ba53804544050c5cb`，均未改变。库与旧 aily-lex 只读，主程序/工作区 Agent 已构建，测试自有进程已结束；未重启现有用户进程、发布远端包、验收 LLM 自主对话、C++ 编译或硬件播放。

### 37.5 接入与下一步

1. 一起重新加载主程序和工作区 aily-lex-pro Agent。保留 abs_export 的 generation；创建普通变量时在候选中写声明/引用，并向 abs_validate 与 abs_apply/import 传相同 `createVariables:[{name:"counter"}]`。后续编辑省略创建清单、使用新导出的 generation；不要传 C++ 类型作为默认 native model type，不通过 @meta/@var 或修改 map 创建模型。
2. 下一批集中处理实际打包的过程定义/调用与参数合同：明确 definition/call、参数模型 ID、argId、动态字段/输入的各自身份及共享引用，走现有纯准备 → 完整读回 → 同一提交。至少完成空模板定义并调用、参数变更、二次编辑、跨页和失败回滚，不通过试探性执行库代码或允许任意 extraState 绕过合同。
3. 恢复 UI、历史/基线资源 pin 和 GC 继续独立推进；可靠 pin 前不启用 GC。当前已验收的是普通变量及声明式已知形状，不把模型创建清单当作任意库对象/动态 serializer 的通用放行开关。

## 38. 第二十四批：打包过程合同与主程序 / lex-pro 联调（2026-09-15）

### 38.1 本批实施边界

沿第 37.5 节补齐主程序实际打包的 +/- 过程定义和原生 legacy 调用。过程定义 ID、参数变量 ID、界面 argId、调用参数输入是不同身份：纯准备阶段显式解析，实际加载后完整读回，不依赖 Blockly 或 Generator 自动补数据。不同库的 custom_function_* 或模型式过程不是相同协议，不按名称泛化放行。本批不修改库仓库或用户原工程。

- 注册模块在项目库执行前记录宿主实现与依赖回调身份；声明目录提供可验证的过程能力。替换实现、变更回调、切换 runtime 时失效，不创建 probe workspace。
- `abs-bundled-procedures.ts` 是纯准备模块。定义使用 NAME，新增参数仅写 `@extra:{"params":[{"name":"amount"}]}`；变量模型须已存在，或通过同一请求的 `createVariables` 显式创建。argId 由宿主生成，保留参数沿用既有 ID。删除参数不会删除共享变量；不接收伪造/重绑定的参数 ID。
- 调用使用 `@extra:{"name":"work","params":["amount"]}` 和实际 `ARG0` 输入。改变签名须同时显式调整当前候选的所有调用；未知 extraState、重复参数、不匹配的定义/调用、派生字段直接重命名在加载前拒绝。原有 ABS 导出仍可包含原生 extraState / 动态字段，不新增 @meta；隐藏这部分原生细节不在本批伪称完成。
- 准备扩展复用原协调器的租约、原生/分片加载、完整读回、生成、保存与 journal。新定义在装载前即分类为共享根，避免前置跨页检查漏掉共享变化。参数 argId 的引用覆盖只对已验证宿主实现开放，不把同名未知字段当作普通文本。
- 只读 core-functions 的 legacy caller Generator 读取 INPUT<n>，宿主实际原生 caller 使用 ARG<n>。主程序在现有项目级 Generator 加载边界提供只读 block view，将缺失 INPUT<n> 读取映射到 ARG<n>，保留库原命名/生成逻辑；不改变原块、全局 Generator 或库文件，不处理 custom_function_*。

### 38.2 真实联调与验收计划

用户级安装目录已有 `subapp-aily-chat -> D:/codes/aily-lex-pro/packages/aily-chat` 开发链接；主程序并非无法连接新 Agent。新增可选隔离联调入口复用该包、构建产物和正式 iframe 启动链路，不替换用户链接、不复制历史。用户授权复用 C 盘登录配置；只在隔离 profile 中复制指定凭据，报告不含令牌，结束清除测试凭据。

首次使用 `auth/blockly.json` 被服务端返回 401（[失败报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-pzYk0w/result.json)）。本机 `.aily` 是更新记录；显式选用它写入测试副本 auth 文件后，真实主程序登录和右侧 lex-pro 加载通过（[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-53wyFB/result.json)）。只调用子应用自身受认证的只读 E2E session.list 验证连接，变量写入仍使用既有独立 Agent 工具专项；不能将连接测试声称为 LLM 自主对话验收。原配置/凭据未改，没有改变生产迁移策略或自动回退旧凭据。

新增空模板 helper 供变量和过程测试共用。过程测试将只读函数库复制到独立工程，走实际工具完成无参数创建、增加参数、二次修改实参、错误签名拒绝、保存重开，核对定义/参数/调用 ID、保护根和生成代码。单元回归另覆盖伪造身份、完整引用合同、注册替换、额外 Generator 模型触发精确回滚。尚未执行完的检查不得标为通过。

跨页共享签名修改仍须满足现有完整引用覆盖与未编辑页面不变约束；不能悄悄修改其它页调用。完整恢复 UI、资源 pin/GC、任意动态库协议仍为独立边界；不把本批有限适配称为全部 ABS 功能完成。

### 38.3 回归与迭代证据

主程序 abs-sync 最终 **516 项**（较第 37 批新增 11 项）、项目加载 **9 项**、宿主 **48 项**、Agent 17 个文件 **105 项**通过，合计 **678 项**。主程序 development 构建、Agent rslib 构建/声明生成通过，未跳过类型检查。架构检查仍为 165 files / 0 cycles，user-center 的 4 处既有 external-deep-import 未改；不把整体检查标记通过。日志为主程序 `.tmp-abs-batch24-tests-final.log`、`.tmp-abs-batch24-load.log`、`.tmp-abs-batch24-host.log`、`.tmp-abs-batch24-build-final.log`，Agent 包下 `.tmp-abs-batch24-agent-full.log`、`.tmp-abs-batch24-agent-build.log`。

首轮单测发现原生 caller 在零参数时省略 params，且现有引用覆盖未覆盖宿主 +/- 参数的 argId；按实际 serializer 输出修正纯准备，并仅对注册身份已验证的宿主参数补全引用覆盖。另修正测试 requestId 长度，不放松生产协议。新参数 argId 使用定义内部的短标识 `abs_arg_0` 等，不拼接冗长全局模型 ID；保留参数继续使用原 ID，重排不会重建身份。

真实过程首轮 [Slty1v](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-Slty1v/result.json) 已提交无参数定义/调用，第二轮尚在进行时被整个脚本共用的 90 秒上限终止。以磁盘基线时间戳确认不是停滞后，给三轮独立事务的场景设置 270 秒总上限，同时保留每步 90 秒无进展 watchdog；记录 start/done 工具名，超时清理自有进程树，不重放已提交候选。其它场景原总上限不变。

第二轮 [5gmvQg](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-5gmvQg/result.json) 三次 ABS 事务及错误签名拒绝均完成，完整 ABI 参数/实参正确，但代码检查仍发现 `abs_work(NULL)`。根因是原生 CodeGenerator 同时使用 getInput 和 getInputTargetBlock，最初只适配了前者。补全同一只读 view 的目标块读取，并增加实际 CodeGenerator.valueToCode 回归（产出 work(9)，原工作区不变），保留失败报告。

联调同时发现 Chat 历史目录独立于主程序 app-data；测试进程现显式设置 PI_CODING_AGENT_DIR 到独立 agent-state，避免读取默认用户历史。早期连接验证只浏览了默认历史列表，未发送对话或操作历史；早期 53wyFB 的测试凭据副本删除被环境拦截，仍需手动删除该目录下 `app-data/auth/blockly.json`，不要将整个早期测试目录对外分享。后续测试在自己的完成路径清除凭据并检查原登录记录未变，不回退生产认证机制。

真实过程专项最终通过：[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-9Gs2BD/result.json)、[真实页面截图](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-9Gs2BD/procedure-generation-page.png)。`success=true`、`errors=[]`；登录状态 authenticated，主程序右侧为工作区 lex-pro，独立 Agent 状态目录为空历史。没有发送 LLM 对话，三轮编辑由实际 Agent 工具注册表和正式宿主桥接完成。

定义 ID `a48f9935-9085-4700-b9b5-edd6cc9a9264`、调用 ID `6688bce5-4f29-4ae5-9d18-ffdde16dde5b`、参数模型 `abs-variable:fa3368ce-913f-4650-965d-53e1ba5536a5:0` 和界面字段 `abs_arg_0` 保持一致。真实代码包含 `void abs_work(int amount)` 和 setup 中的 `abs_work(9);`，已查看截图确认 UI 参数为 9；不等同于 C++ 编译或硬件执行。

新增页 `page-1789433879944-t5w1mg` 中尝试更改共享签名，被 ABS_SHARED_CONTRACT_REQUIRED 在加载前拒绝，三镜像未改；双向切页重绑定后回到 page-1，最后 generation 为 `592ec274-eb5f-4217-87b1-5ec7117f157e`。原页面完整 workspace 在切页与重开后相同，保存/重开的四份规范化 ABI 哈希均为 `af6b0cd9a73ae4041fd7261532ba7c3f2c7d6c62359e03de186633c7e03d9910`。最终测试凭据副本已清除，原配置和登录记录未变，测试自有进程正常退出。主程序正常 TypeScript 检查亦通过（`.tmp-abs-batch24-types-final.log`）。

### 38.4 接入与明确剩余项

最终动画全量复测通过：[报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-FbZaAG/result.json)、[动画页面](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-FbZaAG/project-data-page.png)、[变量页面](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-FbZaAG/variable-generation-page.png)。主程序同屏登录并加载 lex-pro，`success=true`、`errors=[]`，覆盖导入外置数据、独立 writer 互斥、拒绝陈旧写入、两轮大文本编辑、完整生成提交、复制/map 修复/双向切页、空模板变量创建/二次编辑及保存重开。两张截图已实际检查。动画头文件 `src/variables_seeed_gfx_animation_a538eec171dc8cc1-d179ecaf.h` 为 1,530,987 字节，SHA-256 仍为 `fb69112ad244078797dafa1de083fd7ee1a90fd924c2c907c9a69168e5398302`；变量保存/重开的四份 ABI 哈希均为 `3b2c86aa9f7bd40b9bec3f74d3be691161c31730d9d63f1a503ebfcee03a463c`。日志 `.tmp-abs-batch24-animation.log`，最后宿主 48 项复测日志 `.tmp-abs-batch24-host-final.log`。

测试自有主程序和子应用均已退出，本轮登录副本已删除；原动画工程 ABI 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`，原 DHT22 工程仍为 `b2e5ef1dd126aaa825ed3297acbe2774ef1659a3bb8b275ba53804544050c5cb`。原库与原登录配置未写入。没有进行 LLM 自主编辑、C++ 编译、硬件执行或远端包发布。

主程序现有开发链接已指向工作区 lex-pro，无需另部署远端 Agent。重新打开使用新构建的主程序 / Aily Chat 即可使用本批合同；没有强制重启用户原窗口。本批没有新增工具参数，参数模型创建继续复用 createVariables，下一轮编辑省略已创建的模型清单。

下一阶段优先公开“当前宿主可新建 / 可变形 / 仅可保留”的能力证据，接入 block_info / blocks_list，避免 Agent 把库示例当作当前 ABS 合同；随后对实际常用 custom_function_* 等动态协议逐个补充明确合同与真实验收。跨页批量重写需单独的多页意图与完整事务，当前继续明确拒绝，不能借此放宽单页隔离。模型式过程、任意未知 serializer、恢复 UI、历史资源 pin/GC 尚未完成；本批不将这些边界隐藏为“ABS 全面完成”。

过程专项复现（在主程序目录运行，环境变量只作用于该终端；先完成主程序 development 和工作区 Agent 构建）：

```powershell
$env:TEMP='D:\codes\.abs-generation-smoke-20260915'
$env:TMP=$env:TEMP
$env:AILY_AGENT_ROOT='D:\codes\aily-lex-pro\packages\aily-agent'
$env:AILY_ABS_AUTH_SOURCE='C:\Users\LENOVO\AppData\Local\aily-project'
$env:AILY_ABS_AUTH_FILE='.aily'
$env:AILY_ABS_VARIABLE_ONLY='0'
$env:AILY_ABS_PROCEDURE_ONLY='1'
$env:AILY_ABS_PROCEDURE_LIBRARY='D:\codes\aily-blockly-libraries\core-functions'
node.exe scripts/project-data-electron-smoke.cjs 'C:\Users\LENOVO\Documents\aily-project\ESP32S3_DHT22_HTTP'
```

动画全量将 PROCEDURE_ONLY 设为 0、AILY_ABS_GENERATION_SMOKE 设为 1，并将末尾源工程改为 project_jul13d_353995。不需要登录时省略 AUTH_SOURCE / AUTH_FILE；测试仍使用原有正式 Agent 工具，不打开聊天子应用。

## 39. 第二十五批：当前宿主能力发现与 Agent 指引收敛

### 39.1 本批目标与根因

第 38.4 节的下一步不是再扩展 ABS 文本语法，而是让 Agent 在写入前区分“库里有这个块”和“当前宿主有可验证的准备合同”。排查发现 block_info / blocks_list 只合并磁盘 block.json 与动态探测元数据，没有公开新建/变形边界；其精简模型输出还残留 `$name` 变量规则。旧元数据补全会创建临时 workspace 并实例化动态库块，不能作为无副作用的能力证明。

本批完成四个相互解耦的交付：纯能力描述、独立只读宿主入口、Agent 证据校验与简洁投影、指引/真实页面验收。继续保持库和原始用户工程只读，不增加 @meta，不新增生成器 Realm，不改变任何写入事务的放行条件。

### 39.2 设计与实现

1. `abs-block-capabilities.ts` 复用声明式编译合同和已验证 bundled procedure 注册来源，不建立平行白名单、不运行 init / mutator / serializer。声明式字段只输出约束，不输出可能很大的默认文本。
2. `AbsWorkspaceSyncService.describeCapabilities` 在当前项目/page/Generator revision/Project Data session 内同步读取，返回独立 v1 的 abs_capabilities 报告。请求支持精确 type 或 library/type filter，校验两者互斥及参数长度；不写 ABI/ABS/map、不建立基线、不获取文件 writer、不运行代码生成。
3. 四个宿主级别为 create（仅固定形状）、reshape（仅具名内置适配合同）、preserve-only（没有新建/变形合同）和 unavailable（未注册）。preserve-only 不等于所有既有字段都不可编辑：既有编辑仍基于导出实例合同由 abs_validate 判定；它也不承诺未知 serializer 一定能保留成功。发现结果不证明生成器存在或代码编译通过。
4. Agent 新增独立解析器，校验协议、项目映射、page/runtime、条目唯一性、请求 type 和合同结构。无宿主、旧宿主、加载失败或错误证据返回 unknown，不从 block.json 或旧缓存推断支持。执行根到真实项目根的映射沿用既有 workspace context。
5. block_info / blocks_list 改走该只读入口，不再调用会实例化块的 block_metadata_snapshot。固定字段元数据取当前已验证合同；磁盘库元数据明确标记 installed-library。JS-only 动态块可发现其能力，但不伪造参数签名。列表精简输出保留能力级别，省略冗长 shape；单块输出保留所需约束。
6. 修复 block_info 精简输出和 library_docs 附加提示的旧 `$name` 规则，后者原本还会主动把旧变量写法转换成 `$name`。工具描述、通用语法提示及 Agent 项目/库生命周期指引统一明确：库文档解释行为，当前宿主解释新建/变形能力，generation-bound 校验/应用才是最终写入门槛。同步撤回“所有 block_info 元数据天然就是可写合同”的过时指引。

### 39.3 验收计划与当前状态

主程序新回归覆盖无构造器执行、大默认值不泄漏、任意未知 mutator/JS 注册、内置注册被替换、项目/page 范围与非法请求；abs-sync 521 项已通过。Agent 新增 9 项通过，覆盖错误/缺失宿主、错误项目/版本/runtime/type、重复或非法合同、磁盘旧字段被宿主约束覆盖、动态签名不猜测、模型投影、执行根映射及库文档的变量/能力提示。

真实 Electron 过程专项新增前置能力查询：通过实际 Agent 工具查询固定块、四种原生过程、custom_function_def 和不存在类型，核对三镜像与完整 workspace 不变。随后继续执行原有三轮过程编辑、生成、跨页拒绝、保存重开。真实验收已完成，调用栈定位和最终证据见 39.5；不把工具箱正常后台初始化混同于 ABS 查询副作用。

### 39.4 明确边界与后续

本批将 custom_function_* 的缺口转为可查询证据，并未放宽或假装实现其自定义 mutator/registry 协议。下一阶段按实际使用需求选一个该类协议，先整理模型归属、参数身份与调用同步合同，再实现纯准备适配和真实验收；不能借用原生过程的名字/参数格式直接套用。跨页批量重写、模型式过程、恢复 UI、资源 pin/GC 仍独立推进，GC 继续关闭。当前发现快照不是长期许可，应用时继续重新检查完整上下文和合同。

### 39.5 真实验收与迭代记录

首轮 [WMBXH8](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-WMBXH8/result.json) 的实际工具查询均得到预期能力，三镜像未变，但测试将整个外部 Agent 启动/查询期间的所有 Workspace.newBlock 都禁用，记录 728 次而失败。保留失败报告及 `.tmp-abs-batch25-procedure.log`，没有修改生产门槛来通过测试。

第二轮对查询调用链与后台 UI 初始化分别记录调用栈，同时显式禁止 ABS 工具回退到旧的 getRuntimeBlockMetadataSnapshot。证据确认全部 728 次后台创建均来自 `BlockSearcher.indexBlocks → ToolboxSearchCategory → updateToolbox`，ABS 查询创建次数为 **0**。不修改工具箱搜索功能，也不把后台计数掩盖成 0。

最终 [CBPDmN 报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-CBPDmN/result.json)、[真实页面截图](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-CBPDmN/procedure-generation-page.png) 通过，截图已实际检查。`success=true`、`errors=[]`；当前宿主报告 page-1/runtimeRevision=32，原生过程为 reshape、math_number 为 create、custom_function_def 为 preserve-only、不存在类型为 unavailable。能力查询完整 workspace 不变，三镜像不变，historyChangedPaths 为空；没有创建基线或发布编辑。

真实主程序保持登录并嵌入工作区 lex-pro。随后三轮定义/参数/实参编辑、跨页共享签名拒绝、切回及保存重开均通过，生成代码包含 `void abs_work(int amount)` 和 `abs_work(9);`。参数 ID 为 `abs-variable:b02e6526-97c3-4bfa-acc0-41375e3fbbc3:0`，argId 为 `abs_arg_0`，调用块 ID 为 `b6e8901f-149d-41b5-a01c-bb0e644a4b19`。保存/重开的内存与磁盘四份规范化 ABI 哈希均为 `5ce219162fac27d320db4cf7d06a966e3d9e1f9b5a6148da8fe1d63103fbd373`。日志 `.tmp-abs-batch25-procedure2.log`。

测试自有应用已正常退出，本轮临时登录副本已清除，原配置/登录记录通过测试内哈希检查未变；原 DHT22/动画工程 ABI 保持第 38 节哈希，原库只读。该验收使用实际 Agent 工具注册表与正式宿主桥接，没有发送 LLM 自主对话，没有执行 C++ 编译或硬件测试。本批未重跑动画全量真实链路，上一批的大文本/头文件证据仍见 38.4。

最终回归合计 **692 项通过**：主程序 abs-sync **521**、项目加载 **9**、宿主文件事务 **48**、Agent 18 个文件 **114**，较上一批新增 14 项。主程序 development 构建和 Agent rslib/声明生成均通过；未跳过类型检查。日志为主程序 `.tmp-abs-batch25-tests.log`、`.tmp-abs-batch25-load.log`、`.tmp-abs-batch25-host.log`、`.tmp-abs-batch25-build.log`，Agent 包下 `.tmp-abs-batch25-agent-final.log` 和 `.tmp-abs-batch25-build-final.log`。新文件与本批涉及文件的空白检查无错误。

架构检查仍为 165 files / 0 cycles，user-center 的 4 个既有 external-deep-import 违规未改；`.tmp-abs-batch25-architecture.log` 返回非零，不将整体架构检查标为通过。本批不强制重启用户原有窗口，不修改现有开发链接，不发布远端包；使用新的本地主程序/Agent 构建即可获得能力发现与指引修复。

## 40. 第二十六批：有类型自定义函数的完整宿主合同

### 40.1 根因与范围

沿 39.4 推进实际 lib-core-functions 协议。它与原生 procedures_* 不同：定义通过 FUNC 类型变量标识函数，参数通过独立 paramVarIds 引用普通变量，调用使用 FieldVariable 和 INPUT<n>，额外状态还依赖当前 iframe 内的 customFunctionRegistry。仅允许更多 extraState 键，或仅恢复工作区而不恢复派生注册表，都不足以保证一致性。

本批目标为已审计协议的定义/调用创建、参数及类型修改、返回值、显式模型准备、共享根归属、完整引用检查、生成后读回及失败回滚。继续复用三镜像事务、现有项目 Realm 和 createVariables；不改库、不新增 @meta、不实现隐式模型创建/重命名、不放宽其它页保护。

### 40.2 模块与边界

1. `blockly-custom-function-contract.ts` 负责实际加载脚本的来源确认和运行时派生状态。当前审核脚本为 core-functions 1.0.1，规范化 LF 后 SHA-256 为 `4d3a8f44d8fbeffc76bdfe6648fa076e2474505ab359a81cd64bfa98aaef592b`。名称和版本号不是许可；未知源码继续 preserve-only。记录实际 mutator、调用定义、相关函数和 extension 的注册身份，并绑定项目 session；同名替换或 session 结束使合同失效。
2. 哈希确认在已有 generator 加载边界完成，加载调用等待确认结果；公开 loadLibGenerator 仍先同步检查工作区租约。异步期间若项目 runtime 已替换，旧结果不能登记到新实例，也不能销毁新实例。
3. `abs-custom-functions.ts` 是纯候选适配器：验证实际声明式定义的静态骨架；名称/类型是意图，模型 ID、计数、PARAM_NAME/TYPE 派生字段由宿主准备。新函数须显式声明 `{name,type:"FUNC"}`；参数须已有普通模型或同请求 createVariables。保留函数和存活参数身份，移除参数不删除模型。函数重命名/重新指向不在本合同内。
4. 过程引用合同增加明确的模型路径、并行参数 ID 路径和参数类型路径。定义/调用必须在同一过程协议内匹配，不能把 legacy 调用误连到 custom 定义；返回值调用不能引用 void 定义，语句调用可显式丢弃返回值。跨页引用仍通过原覆盖缓存及共享事务检查。
5. 实际装载后和失败回滚后，重建函数注册表并恢复定义的已提交名称缓存；这只是工作区的派生查找信息，不创建/重命名/删除变量、不调用库初始化或工具箱同步函数。完整原生读回继续检查实际模型和 serializer 输出，不以“适配过”豁免额外状态。
6. 能力发现增加具名 `library-custom-functions-v1` 合同，Agent 独立校验其角色与参数类型列表；新增 custom-functions.md，与原生 procedures.md 分开，不互相套用语法。现有库文档的旧位置参数示例不构成 ABS Schema 2 写入依据。
7. 普通加载/重开、工程快照和 ABS 运行时采集也进入派生状态准备边界。序列化调用块前，仅读取已审计定义的 serializer 并重建查找表，避免库的延迟监听器清空注册表后遗漏调用参数；不依赖 500ms 完成事件。普通快照保留尚未提交的函数名称缓存，只有已完成装载或显式回滚才提交名称缓存，不干扰图形编辑器的 onFinishEditing_ 重命名逻辑。
8. `normalizeBlocklyViewState` 统一规范化磁盘文档与实时快照中的 scrollX/scrollY，保留六位小数（微像素精度）并消除负零。它不作用于缩放、块坐标、代码数值、模型或扩展字段；实际可感知的视图移动仍推进项目 revision，不放宽文件 CAS 或数据读回比较。

### 40.3 验收计划与进度

纯准备测试覆盖显式 FUNC/参数模型、ID 与引用路径、参数类型修改/移除、伪造身份和未知状态拒绝、返回值/语句调用及未知来源拒绝。首轮测试暴露同步租约检查被 async 包裹、测试对象未初始化声明目录以及测试默认参数问题；保留同步门槛、补齐测试夹具后，主程序 abs-sync **528 项通过**，两端构建及 Agent 能力专项 **10 项通过**。

真实 Electron 复用上一批独立工程、登录副本和实际 Agent 注册表，增加 `AILY_ABS_CUSTOM_FUNCTIONS=1`：创建无参数返回函数 → 增加 int 参数 → 改为 float 参数并传入 9；核对代码/模型/共享根；注入额外生成器模型触发精确回滚；检查跨页签名冲突、切回和保存重开。最终 ABS 链路验收已完成，结果及控制台保留问题见 40.7。

### 40.4 仍保留的边界

本适配为已审计的自定义函数协议，不是任意库或任意 serializer 的通用许可。今后源码变化须重新审核合同和真实验收；不要求库作者增加 Project Data 专用字段。跨页批量重写、函数/模型重命名、模型删除、恢复 UI 和资源 pin/GC 不在本批，GC 保持关闭。代码生成成功不等于 C++ 编译或硬件运行通过。

### 40.5 真实迭代与失败证据

1. `qa7hp2` 首轮在能力发现时返回 preserve-only。根因是 generator.js 先于 block.json 执行，而初版来源验证同时要求尚未注册的声明式定义存在。现已明确分离两阶段：脚本来源只验证脚本持有的 mutator/调用注册；定义由随后注册的声明目录和使用时快照校验。不调整加载顺序，也不凭包名放行。
2. `f9ZW85` 已完成真实能力查询和首次函数创建；测试夹具把内联调用外层右括号当成 extraState JSON 而失败。仅修正夹具 JSON 匹配，不改生产解析器。
3. `CpukqS` 在第二轮候选被 ABS_IDENTITY_AMBIGUOUS 拒绝：同请求删除定义返回常量并在调用参数处新增常量，存在跨归属身份歧义。保持拒绝规则；将新增参数与替换返回表达式分别放到第二、三轮。此限制继续对真实 Agent 生效，不使用隐藏 ID 或放宽匹配来绕过。
4. 增加运行时注册生命周期测试，覆盖 generator-before-JSON、未知源码、回调/extension/选项替换、旧 session 晚到、清理归属及派生数据复制。公开加载方法保留同步租约检查；destroy 支持期望 Generator 身份，因此脚本已失活时仍能清理所属 session，晚到失败不会销毁新项目。

5. `CFrXZM` 完成三轮编辑、保存、代码检查和伪造 ID 拒绝；故障夹具提前在后台生成时创建了模型，因此导出基线和候选均包含该模型，应用正常提交。已核对基线 `ed921991-c2de-49e0-bd9c-28fc42adc373` 的变量表，不将此误报为读回漏洞。注入改为仅在候选的 int 参数签名出现后触发，并核对触发次数为 1，避免后台生成污染基线。
6. `pMXHw2` 未进入 ABS 工具阶段即外部测试进程 startup 超时；增加目录加载/历史初始化阶段日志，能力查询的有限总时限由 90s 调为 180s，单步停滞仍为 90s，不改生产工具超时。独立 Agent 目录加载实测约 8.4s、RSS 158MB，不能据旧的粗粒度日志断言具体启动原因。
7. `kiy2zH` 已触发预期读回拒绝并恢复 ABS，但随后的完整工程检查失败。只读 ABI 夹具专项 `XJAQEJ` 进一步通过回滚、跨页拒绝、切回，在重开时明确定位到调用块 extraState.params 丢失；不是坐标或视图误差。库调用 serializer 从 customFunctionRegistry 取参数，而延迟监听器先清空该表、再等 FINISHED_LOADING 初始化。原实现仅在 ABS 装载/回滚时重建，遗漏普通重开及延迟清空后的序列化。现已统一准备边界，并补充清空后重建、调用 serializer 不参与重建及未提交名称不被推进的回归。
8. `FmMfGH` 在上述修复后，三轮编辑及精确回滚仍通过，但完整工程比较明确记录另一处差异：`/pages/0/viewState/scrollX` 的内存值 0 与磁盘值 -1.1368683772161603e-13。原生滚动恢复无法保留此浮点噪声，产生假脏状态。新增双侧视图规范化，保持其它数据精确；回归同时检查幂等、负零、原对象不变和有意义的滚动仍推进 revision。没有把此次差异与此前的参数丢失混为一谈。

`AILY_ABS_CUSTOM_FIXTURE=<已有测试 ABI 的绝对路径>` 只读加载已保存函数，单独验收回滚/跨页/重开，不测试创建或能力查询；完整验收必须清除此选项。夹具首轮 `UBDUQF` 的脚本参数遮蔽 document 已修正，不改产品代码来适应测试。

回滚测试同时修改 float→int 签名及实参后注入额外模型，确保派生注册表内容确实变化，再核对回滚后的完整状态与再次导出；只改常量不足以证明注册表恢复。最终验收见 40.7。

### 40.6 最终自动化回归

本批自动化合计 **710 项通过**：主程序 abs-sync **538**、项目加载 **9**、宿主文件事务 **48**、Agent 18 个文件 **115**；相比上一批新增 18 项。日志分别为主程序 `.tmp-abs-batch26-tests-final5.log`、`.tmp-abs-batch26-load-final.log`、`.tmp-abs-batch26-host.log`，以及 Agent 包 `.tmp-abs-batch26-agent-final.log`。主程序 development 构建、独立 tsc、Agent rslib/声明生成均通过，见 `.tmp-abs-batch26-build-final5.log`、`.tmp-abs-batch26-types-final2.log` 和 Agent `.tmp-abs-batch26-agent-build.log`。较早的 535 项轮次有 ChromeHeadless 退出清理超时警告；最终 538 项轮次及加载专项均成功、退出码 0。视图规范化初测捕获负零不幂等，已将负零统一为 0，保留失败日志 `.tmp-abs-batch26-tests-final4.log`。

架构检查为 165 files / 0 cycles / 4 个既有 user-center external-deep-import 问题，仍返回非零，不将整体检查标为通过。涉及文件空白检查无错误。上述结果不代替真实页面事务验收。

### 40.7 最终真实页面验收与交付

最终 [H8zTtB 报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-H8zTtB/result.json)、[重开截图](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-H8zTtB/procedure-generation-page.png) 已核对，截图实际可见 float 参数、实参 9 和返回 amount。日志为 `.tmp-abs-batch26-custom8.log`，测试进程退出码 0，`success=true`，未设置 ABI 夹具选项，完整三轮创建/编辑均实际执行。

能力查询不实例化块（probes=0），完整 workspace 不变；728 次后台构造来自既有工具箱搜索流程。原生过程和当前已审计 custom_function_def 均报告 reshape，math_number 为 create，缺失类型为 unavailable。三轮正式 Agent 工具覆盖显式 FUNC/参数模型、分块应用及 abs_import；定义、参数和调用身份保留，三个受保护入口仍不可删除。

伪造函数 ID 返回 ABS_CUSTOM_FUNCTION_INVALID；改变签名后故障注入恰好触发 1 次，额外模型导致 ABS_READBACK_MISMATCH。失败应用本身三镜像不变、pending 为空；再次导出及完整 workspace/模型比较恢复成功。该子场景 historyChangedPaths 只有 project.abs.map.json，来自显式 export 发布投影，不是失败 apply 改写文件。跨页签名变更返回 ABS_SHARED_CONTRACT_REQUIRED，切回和重开均通过。

保存/重开的内存与磁盘四份规范化工程 ABI 哈希一致，均为 `437c9135f0bb459cb934c7c228dcc59a6c8746e910024b61956540484380263b`，changed=false。参数 ID 为 `abs-variable:306386b3-bb1e-489b-87ac-000c11420a09:0`，函数模型 ID 为 `abs-variable:738567ff-bbf7-475d-9787-c4a2fde97f05:0`。生成代码包含 `int abs_custom(float amount)`、`return amount;` 和 `abs_custom(9);`。

主程序启动时已验证 copied login authenticated、工作区 lex-pro 嵌入及只读 session.list（空测试会话）。原配置/登录信息通过测试内哈希保护未变；本批 10 个临时根的登录副本均已清除，最终聊天后端端口已不再监听。两个原始工程 ABI 和只读 core-functions 源码保持此前哈希。测试自有应用已退出，没有重启用户窗口或发布远端包。

**控制台保留项：** 最终报告还包含 5 条 aily-chat 服务连接断开输出，其中 1 条 unhandled promise rejection；没有将 errors 改为空。现有采集未区分运行阶段与应用退出阶段，因此无法据此确定断连发生时机。本批 ABS 事务/回滚/重开断言通过，但不宣称聊天连接稳定性已通过专项验收；该问题单独记录，不扩大本批修复范围。未执行 LLM 自主对话、C++ 编译或硬件测试，也未重跑动画全量真实链路。

本批主线完成：有类型自定义函数合同、显式模型、运行时与序列化生命周期、跨页保护、能力发现/Agent 指引及真实验收。后续仍按 40.4 的边界推进，不把此协议扩展为任意动态库许可；恢复 UI、资源 pin/GC 和跨页批量重写仍未交付。

## 41. 第二十七批：真实 LLM 自主会话与编译闭环

### 41.1 验收边界与实施计划

本批先验证落地链路，不新增 ABS 语法或放宽事务合同。通过主程序嵌入的真实 lex-pro Chat 输入任务，由 LLM 自主发现规则、选择并执行工具；受认证 E2E 接口只观察会话，不替代模型生成工具调用。复制用户已授权登录到独立 profile，工程、平台 SDK/工具和 Agent 历史均隔离，结束清除临时登录。库与原工程保持只读，不上传硬件。

1. 空板模板加入通用大文本哨兵，使用正式保存外置；模型自主添加变量声明、赋值、读取及循环延时，验证 `$name` 旧提示不会参与 Schema 2 编辑。
2. 要求正式 `project_build` 完整编译；同时核对当前会话工具证据、新的 buildInfo、实际 sketch 源码及 ELF，不能以旧成功标记、预处理或纯代码生成代替。
3. 核对大文本完整值、原入口 ID/保护、变量模型/引用、内存与磁盘一致；真实保存重开后比较三镜像与完整工作区。
4. 控制台按运行/重开/退出阶段记录时间，不把退出断连伪装为运行期错误，也不忽略真实错误。失败保留会话、截图及报告；有限时限内无进展停止，不自动重放候选。

当前 Schema 2 导出仍使用可读名字（例如 `variables_get(VAR="counter")`）；模型创建由工具参数 createVariables 表达，元数据继续由宿主管理。`$name` 是此前 Agent 提示残留的旧约定，不是本批引入的新规则。不能将“本批不改规则”误解为旧版 ABS 与 Schema 2 完全相同；旧版迁移/语法边界应以 Schema 标头区分。

### 41.2 完成标准

一项工程编译成功只证明该工程在当前库/板卡/工具链下通过 C++ 编译链接。v2 核心受支持范围还须同时满足身份/元数据/资源无损、代次与冲突保护、失败回滚、持久化和重开；任意动态协议、跨页批量改写、模型重命名/删除、恢复 UI、历史资源 pin/GC、硬件行为不是编译能证明的。本批不承诺全功能覆盖，实际结果完成后追加。

### 41.3 本次真实失败：两套规则与真实交付产物不一致

[DPnEH7 报告](D:/codes/.abs-generation-smoke-20260915/aily-project-data-ui-DPnEH7/result.json) 为真实主程序、嵌入式 Chat、aily-services/auto 的模型会话，非手写工具序列。任务是增加普通变量、赋值、读取和延时，并保留 72,000 字节通用大文本。模型提示及会话记录在同一隔离根，主程序日志为 `.tmp-abs-batch27-llm1.log`。

实际顺序：abs_export 成功 → 两次 ABS_SYNTAX_INVALID（Expected @.）→ 两次 ABS_SYMBOL_MISSING → 一次 validate 成功 → apply 在 /variables 返回 ABS_READBACK_MISMATCH → project_recover inspect 返回 pending=null、status=ready、requiresReload=false。失败已充分复现后，通过真实 Chat 的停止按钮结束测试，没有自动重放候选。报告 success=false，没有 project_build 调用，不能宣称编译通过。

已确认三层问题，不能全归咎于模型：

1. **构建交付不一致。** 用户级开发链接指向 Chat 工作区，但实际启动的是 `aily-chat/dist/aily-chat` 中的 portable bundle。该包自带 Agent JS 和规则资源；只构建 aily-agent 不会更新它。会话实际读取 `runtime/resources/skills/aily-blockly-project/references/variables.md`，缺少源码中已有的 createVariables；实际 block_info 仍返回 `field_variable receives $name directly ... never ... a quoted name`，与另一份 v2 指引冲突。前批只读连接成功和外部 Agent 工具专项不能证明此 bundle 已更新。
2. **对外语法迁移增加负担。** 模型沿用库文档的入口直接缩进语句，当前解析器要求命名 @INPUT 段，导致连续语法失败。具名参数、命名语句输入、显式 @next 并非身份保留或大数据外置的必然前提，不应仅为了底层升级要求 Agent 重学一套规则。
3. **模型准备职责外漏。** 普通声明和引用仍需要额外模型创建意图；旧工具缺少该能力时，模型无法完成正常变量任务。后续 validate 成功但 apply 的实际 serializer 出现额外模型，被完整读回拒绝。这说明安全保护在起作用，但任务不可完成，不能将拒绝本身当成交付成功。

本次控制台 errors=[]；未出现此前未分类的 Chat 断连，不能据单次结果宣称连接问题全面修复。原 DHT22 工程 ABI 哈希未变；测试内源配置/登录哈希未变，临时登录副本已清除，测试应用退出。没有修改库、原工程或 ABS 生产解析规则。

新增测试前置规则资源一致性检查：portable Chat 的工程技能及所有参考文件须与 Agent 源码一致，缺失、陈旧或多余文件在复制登录/运行模型前拒绝，并提示构建 Chat 的 build:subapp，而非仅构建 aily-agent。2 项专项通过。该检查只证明规则文件一致，不冒充整个运行时代码的构建来源证明；当前旧 bundle 尚未重建，下一轮必须先解决产物一致性。

### 41.4 修订主线：保留无损内核，统一一套简洁 ABS

本节的方向已根据找回的旧总规范进一步细化为 [独立落地方案](D:/codes/aily-blockly/docs/abs-unified-syntax-landing-plan.md)。后续语法取舍、三个实施阶段、状态及验收标准以该文件为准；本节保留修订背景。

依据用户本轮反馈，停止以新增 v2 合同数量作为落地进度。v2 的核心价值是身份与隐藏属性保留、Project Data 无损、代次冲突保护和失败恢复；这些能力放在宿主内，不应让 Agent 在两套文本语法之间选择。

后续按以下顺序实施，**本节为修订执行方向，不表示以下能力已经实现**：

1. **固定真实入口。** 确认嵌入式 Chat 所用的实际 Agent/规则产物来自同一次构建，清除相互冲突的工具提示；不只验证 workspace 链接或源码。
2. **统一文本前端。** 保留用户熟悉的位置参数、变量引用 `$counter` 和简洁缩进。参数映射按当前宿主已验证的字段/输入顺序；单一明确 statement input 可承接缩进体，多分支或歧义输入用命名段消歧。具名参数作为必要时的明确表达，不作为所有代码的强制迁移条件。实现中归一到同一个内部 AST 和协调器，不保留两条独立的有损/无损写入路径，不用正则全局替换 `$`。
3. **宿主负责模型准备。** 对已验证声明合同，`variable_define("counter", int, math_number(7))` 的明确声明可产生本次模型创建意图；`variables_get($counter)` 仅引用已有或本次已声明模型。`$counter` 在变量字段中只选择模型；在值输入中保留自动生成 getter 块的既有兜底，但不由引用创建模型。不能由拼错的引用隐式建模，也不能按块名前缀推断任意库对象。模型 ID、native type、createVariables 细节由内部准备层处理，不要求 Agent 为普通声明重复维护另一份清单。
4. **只输出一套规则。** 库仓库保持只读，Agent 工具、技能、示例和实际导出遵循统一公开语义；内部版本标记、generation、map、journal 继续用于存储与并发正确性，不包装成第二套让模型选择的语言。
5. **用真实任务验收收敛。** 同一会话完成“普通变量 → 第二次编辑 → 大数据不变 → 正式编译 → 保存重开”；不得人工指定每个工具参数代替 LLM 决策，不绕过校验。随后再覆盖常用函数/多页场景；未知合同明确拒绝仍是安全边界，不以任意库全部支持为第一阶段完成标准。

该方向不撤回已有身份/保护/资源/回滚机制，也不把旧例子不加验证地直接覆盖成新 ABI。当前用户看到的首要缺口是简单任务无法稳定完成，应先消除这项缺口，再讨论更大范围的扩展。
