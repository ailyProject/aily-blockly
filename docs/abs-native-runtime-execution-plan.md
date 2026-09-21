# ABS 原生结构驱动执行与历史工具复用方案

更新：2026-09-17。状态：**第 26 节最终七库验收及提交前门禁通过，当前约定范围收口；第 25 节同一草稿跨进程编辑证据、第 24 节生产隔离图形候选、第 23 节批量身份跟踪、第 22 节通用参数命名空间与语法发现保持**。N1、N2 同步子集及 N3 已证明的模型输入、默认子树/隐藏 shadow、通用大值、媒体只读快照、有限注册任务和内置图片派生准备已接入唯一提交链。N4 的真实 Agent 新建/变形、LLM 自主两轮编辑、两次正式固件编译及保存重开见第 16 节；媒体真实验收见第 17、18 节。任意异步结构已按第 19 节明确排除出当前收口范围，不是剩余计划或发布前置条件。其他未经证明的模型生产效果、serializer 状态及派生算法仍保守拒绝，不承诺所有动态库全覆盖。接替统一方案第 15.5 节的动态块排序。

当前维护入口为第 26 节的最终抽样验收与交付，先前通用修复设计与 I²C 方案见随机库审计第 7 节。第 21 节保留修复前抽查失败，第 20 节保留 README 修复证据，第 19 节任意异步范围外决策继续有效；真实 LLM/固件证据仍引用第 16.6 节。前文各批“下一步”属于历史记录，不再作为当前待办。ABS 保持原位置调用与变量规则，身份、布局、保护和槽位映射不搬回 ABS。

## 1. 第一性原理与不变项

块结构的事实来源是库已经注册的原生实现及当前配置，不是 ABS 维护的另一份库业务逻辑。ABS 负责表达调用；原生运行时负责产生字段/输入/模型；ABI/map 负责持久化身份、布局、保护、opaque 状态及映射；Project Data 继续外置大数据。

- 实参保持 block.json 数字 argsN 的定义顺序；原声明外的动态参数按原生顺序追加，不能因视觉 inputList 插入/移动而挤占已声明参数的位置。
- 变量规则和裸 $ 在值输入中的既有展开保持；不新增 ABS 模式或要求 Agent 选择合同。
- 复用唯一租约、候选合并、完整读回、CAS 和恢复流程；不恢复旧清空重建、第二保存通道。
- 静态结构合同保留为快速路径。未知结构不因源码模板不匹配而永远不可用，但必须进入真实受控原生执行，不能仅删除校验。
- 库仓库与用户工程只读；不调整登录配置、依赖或无关工作区修改。

## 2. 已删除工具审计

事实基线：Git `4caee8fd^` 的 `src/app/tools/aily-chat/tools/`，非凭函数注释推测。

| 旧模块/机制 | 结论 | 当前落点与取舍 |
| --- | --- | --- |
| abiAbsConverter / absParser | 已迁移并继续复用 | `integrations/blockly/abs/` 中仍在；原 argsOrder、字面量和 extraState 透传保留，不复活第二转换器 |
| editBlockTool.createBlockFromConfig / configureBlockFields | 提取执行顺序，不整文件恢复 | 原生创建→配置→结构刷新→连接；字段缺失不能静默跳过，不按 updateShape_ 等私有名字执行多套猜测 |
| remapExtraFieldsToActualFields / remapExtraInputsToActualInputs | 复用动态发现思想 | 替换 EXTRA_N 与“未配置第 N 个”的猜测为源声明＋原生构造记录 |
| applyDynamicExtensions / inferExtraState / manuallyCreateInputs | 部分拒绝 | 原生 loadExtraState 值得复用；按 INPUT/ADD 名称推测协议、人工补槽和重复应用 extension 不恢复 |
| atomicBlockTools | 分离原子操作语义 | 显式身份、连接兼容性、环检查可复用；模糊 ID/类型匹配、独立修改与保存入口不恢复 |
| blockFieldValue / smartSetFieldValue | 复用序列化值校验边界 | 当前 `abs-field-values`、`blockly-runtime-block-metadata` 已承接主要能力；不以值猜变量字段、不静默改枚举 |
| browserTaskScheduler / operation queue | 本批恢复小模块，禁止双队列 | 原 scheduler 源码被删但测试仍留存；恢复到 shared/concurrency/browser-frame-budget，保留一个计时状态，去掉未使用 idle/RAF 分支；迁移原测试，接入 abs-chunk-loader。租约仍是唯一并发入口 |
| getWorkspaceOverview / blockAnalyzer | 只读分析可复用 | 当前实际实例元数据、ABI 索引、Agent 工程统计；不借工具箱探针的默认结构代表另一实例 |
| blockConfigFixer | 不恢复自动修复写路径 | JSON 括号修复后猜槽归属会改变意图；精确报错，不通过猜嵌套关系凑成可加载 ABI |
| syncAbsFile / editAbiFile / reloadAbiJson | 不恢复 | 当前 generation/Project Data/提交恢复已经替代；旧直写绕过保护和三文件一致性 |
| connectionGraphTool | 独立功能，不混入 ABS | 当前 schematic connection-graph 服务与 integration 已在；硬件接线图不等于 Blockly 连接图 |

旧实现的优势确实是执行原生配置后再读取实际结构；并非完全没有特例，也不等于已验证无损往返。

另发现 `tools/aily-chat/tools/blockFieldValue.spec.ts` 仍引用已删除的 helper。本批将嵌套 Project Data 对象保留断言迁入 `abs-core.spec.ts`，变量描述符由 `abs-symbols.spec.ts` 的原生 FieldVariable、ID 保留、完整状态成员及非变量对象反例承接，删除孤立测试；不恢复旧自动字符串化或按名称猜模型。本批仍不把专项测试描述成全仓测试通过。

## 3. 模块与实施顺序

### N1：通用原生声明记录与已有实例闭环（已完成本批范围）

在正常块初始化处记录原生 append/insert/remove/move 的结果，不额外初始化块。声明式字段/value 顺序用原 JSON；动态字段与输入按原生构造/插入关系补齐。记录为弱引用、归属当前声明目录；库覆盖方法、目录失效、字段/输入不一致则拒绝使用记录。

已有实例导出及同形编辑直接消费该记录，不需要特定库源码证明。静态下拉中带原生 validator 的配置字段保守区分同类型不同实例形状，仅查询回调是否存在，不执行回调；普通引脚、线制枚举不因此被冻结。此处不是对所有可能结构触发机制的推断证明，仍须完整原生读回。不能让一个实例覆盖另一个实例。原生装载之前按该合同排列字段加载顺序，防止 canonical JSON 排序使动态 PIN 早于 TYPE 加载而被跳过。读取结构不自动批准新实例或新配置。

### N2：受控原生候选执行（同步子集已接入提交，N4 已验证完整工程 runtime 场景）

语法读取与参数绑定分离：前者产生位置调用，后者在配置推进时读取原生结构；静态块继续用现有纯函数快速路径。恢复显式 extraState/字段，按原定义顺序绑定，所有请求值必须被消费并原生读回一致。未知槽、枚举、模型引用和不明确的连接必须报告。

该执行器必须运行在能够丢弃的候选环境，不得在 validate 中修改活动工作区后声称只读。当前 iframe 与宿主共享 Blockly 注册表，仅新建 Workspace 或备份 ABI 不构成隔离；需要独立的运行时/注册表、受限项目服务和候选资源归属。先验证隔离反例，再启用生产新建/变形入口。

- **N2-a：已实现诊断级容器。** `sandbox="allow-scripts"` 的 opaque-origin iframe 独立加载随主程序打包的同版 Blockly core，不传宿主 Blockly、Generator、ProjectService、DOM 或函数对象。输入/输出使用 MessageChannel 结构化克隆；结束、失败、取消和超时均移除 iframe 并关闭端口。每个候选重新创建，不污染或重建当前项目 runtime。
- **N2-a：已实现来源记录。** 当前 runtime 按实际先后记录 context、i18n、完整脚本文本与主程序最终注册的 block JSON。快照检查 session、配置 revision 和记录 revision；切换、重建、加载失败、上下文或库变化均不能继续使用旧快照。不从磁盘重新找“可能对应”的新版库源码，不把宿主 callback 的闭包复制到子 Realm。
- **N2-a：已实现同步原生配置与读回。** 使用真实 `newBlock`、`loadExtraState`、`field.loadState/saveState`，逐项重新获取字段；随后核对请求值、序列化值、ID、extraState 和未请求的块/模型。N1 观察器改为每 Realm 独立工厂，代码仅维护一份。内部字段序列不是新的 ABS 具名语法。
- **N2-b：已实现共享宿主引导与同步位置绑定。** 独立包复用同一套自定义字段/结构扩展注册及 Arduino/MPY/Python 工厂、pinyin；没有空 Generator 或字段替身。`readAbsSyntax` 完整读取调用后，`bindAbsSyntax` 按实例逐项消费字段/value，原生连接检查与最终序列化校验复用同一个执行器。普通 JSON 与 `init()` 内直接 `jsonInit()` 均记录原 argsN 顺序。真实 Electron 已验证活动日志内两份完整库脚本及两种配置；这不等于全工程脚本、Generator 执行中的模型效果、媒体资源水合或提交链已完成。详见第 7 节。
- **N2-c：同步子集已接入唯一提交链。** 原生结果经现有身份匹配，再用正式 ID 重放；逐实例合同只覆盖当前调用，不授予整个块类型许可。合并 metadata/shadow 后，在独立 Realm 加载最终 ABI、执行实际 Generator、完整读回，最后进入既有 lease/baseline/CAS/apply/回滚链。诊断结果本身仍不是 generation receipt。公开能力查询保持保守，不修改 Agent 协议。详见第 8 节。

配置/生成子集仍拒绝定时器、microtask、Promise continuation、I/O 和项目服务调用；错误是粘性的，即使库捕获异常也不算支持。第 16 节仅为注册阶段补入有预算、可取消的一次性定时任务，完成后再封闭注册。AST 仍拒绝 async/await/dynamic import 等尚未承接的机制，不匹配库名、块名或结构模板；即使异步函数未被调用也保守拒绝。

隔离边界是**状态隔离**，不是恶意 JavaScript 安全沙箱或 CPU 抢占保障。同 renderer 的无限同步回调不能靠父页面定时器可靠终止；不能把超时配置描述成已解决拒绝服务，也不能据此开放任意外部脚本执行。

### N3：通用附带状态与任务边界

模型、自动子块和全局配置均记录为候选执行的附带状态，必须能解释其归属、保留原 ID，并进入同一个完整读回。任务完成依赖受跟踪资源和稳定性证明，不用固定等待 100/300 ms 作为生产完成条件。未知 Promise、持续定时器、I/O、不可回滚副作用明确不支持；不能以事后捕获的“实际结果”覆盖用户请求。

- **N3-a 已完成受控输入子集。** 复用 `AbsSymbols`、变量创建意图及完整读回，将宿主变量表复制到候选；复用 Project Data payload 解包，把已解析的通用大值复制为只读快照。候选不获得文件系统/活动资源会话，不自动接纳未知模型。详见第 9 节。
- **N3-b 已完成普通声明时序子集。** 已有可信声明合同为首次原生绑定准备临时模型输入；原 reconciler 决定最终模型/作用域/身份，再以正式表重放。前向引用不因首次模型未就绪失败，也不采纳 Generator 任意新增的模型。详见第 10 节。
- **N3-b 已接通既有模型准备器与原生发现。** 已有可信过程/自定义函数节点交回原纯准备器，不在发现阶段重复创建默认模型；最终完整 ABI 装载、连接与真实 Generator 校验仍覆盖全部节点。普通项目加载复用声明顺序，见第 11 节。
- **N3-b 已补入无声明字段恢复。** 按实际字段存在性、实例身份和下拉选项就绪情况推进恢复；原声明/构造顺序仍优先，未改变 ABS 实参顺序。普通重开无需读取旧 map 或依赖旧实例。见第 12 节。
- **N3-b 已承接临时子块替换。** 记录同步 init/extraState/field.loadState 的创建归属；明确输入仅可替换完全属于该调用、未被请求使用的临时实块子树。完整 ABI 回放按保存拓扑替换初始化默认连接。见第 13 节。
- **N3-b 已接纳有证明的默认子树。** 新建 owner 的省略输入与被明确子块覆盖的 fallback 按连接归属捕获；创建前分配 ID、两次重放核对，再进入原合并/资源/完整读回。已有 owner 不重建默认数据。见第 14 节。
- **N3-b 已接纳原生已实例化的隐藏 shadow。** 观察原生临时 shadow 销毁前的状态，不另建探测实例；最终缓存、原连接、创建 owner、完整子树和实例合同须一致。嵌套隐藏大值继续走原 Project Data，保存重开可恢复原 ID。见第 15 节。
- **N3-c 已承接有限注册任务。** 完整项目源码的注册阶段一次性定时器按真实完成归零；数量、延时预算、异常和资源销毁均有边界，配置/Generator 异步仍拒绝。Agent 可针对当前可重放 runtime 提交原生验证，不提前授予类型许可。见第 16 节。
- **N3-b/c 未开放边界（非本轮落地前置项）。** 没有已有准备器的过程 serializer、未曾实例化观察的 dormant 默认状态、未知模型生产效果和任意库异步不自动承接；媒体原始快照与可信派生准备已由第 17、18 节覆盖。字段无法稳定、请求字段不存在或回调覆盖已装载值时明确拒绝，不宣称任意动态依赖均能自动推导。注册阶段结束后，候选配置/生成器不能再写 Blocks 注册表或调用 defineBlocksWithJsonArray；被捕获的错误仍使候选失败。新增边界须由真实复现驱动，不累计为无限扩展待办。

### N4：验证与清理

不匹配任何现有模板的未知扩展必须通过 N1 测试；覆盖原定义字段/value 交错、重命名、新字段/输入、重排、同类型多配置、影子块、保护与无修改校验。N2/N3 再跑空白工程→真实 Agent 编辑→保存重开→LLM→固件编译。

本轮已取得上述同步场景的真实证据：完整 runtime、实际 Agent 工具、LLM 两轮新建/变形、正式编译新 ELF、外置大文本与保存重开均通过。第 16 节同时记录首次失败与修复，不用候选或程序驱动工具测试代替自主 LLM 验收。未覆盖的 N3 机制仍按独立边界推进。

撤除上一轮尚未交付的 default-inputs 源码模板及公开许可，不把未验证的 WiFi 新建能力作为现行能力。保留空输入断开 bug 修复及原生库测试样本。已经交付的计数、函数和字段结构快速路径暂不删除，待原生候选路径覆盖其等价回归后再收敛。

## 4. 验收记录

本节为 N1 阶段历史验收，当前状态以文首及第 19 节为准。N1 本身通过不代表 N2/N3、LLM 自主会话或固件编译完成。

实现文件：`blockly-native-structure` 记录真实构造及插入；`abs-native-arguments` 合并源声明与动态记录；`abs-native-field-order` 只重排装载副本的字段。现有 runtime contracts / reconciler / readback / CAS 保持唯一通道。记录只参与已有实例，不将一个实例提升为该类型所有配置的合同。

| 验收项 | 结果与证据 |
| --- | --- |
| 主程序 ABS 专项 | ChromeHeadless 573/573；`.tmp-abs-native-migration-tests.log` |
| 主程序构建 | development 通过；`.tmp-abs-native-selectors-build.log` |
| Agent 专项 | 选定 ABS / ABI 工程状态 / 工程文件 85/85；`aily-lex-pro/packages/aily-agent/.tmp-abs-native-agent-tests.log` |
| Agent 构建 | JS 与声明生成通过；同目录 `.tmp-abs-native-agent-build.log` |
| 架构检查 | 0 循环；仍有 user-center 的 4 个既有跨层引用，未扩大到本批处理范围 |
| 真实 Electron | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-wcA7RN/result.json`：success=true、errors=[]、Agent 实际工具注册表、三轮编辑通过 |
| 保存重开 | 同一结果记录：5 个块 ID/序列化状态、3 个根块保护、生成 C++ 以及 ABI/ABS/map 三文件字节一致 |
| 只读边界 | 原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库未修改，既有 core-custom 文档变更保留 |

专项覆盖未知 for-loop 扩展、DHT 双实例、软件 SPI、WiFi 输入、改名、字段/value 交错、原生 move/insert、shadow、显式空输入、普通下拉编辑和无修改校验。没有增加对应库的源码许可。旧 helper 的 Project Data 对象断言已迁移，未恢复旧写入口。

Electron 使用真实原生构造器在板卡空白模板中初始化 DHT/MAX31865，随后由实际 Agent read/write 与 abs_export/validate/apply 完成三轮引脚编辑（LED_BUILTIN→D0→LED_BUILTIN→D0）。这不是 Agent 新建动态块测试：block_info 仍明确 preserve-only。读回生成 `DHT native_dht(D0, DHT22)` 及软件 SPI 对象，并验证重开一致；未执行固件编译或设备运行。

执行中修正了测试夹具遗漏的板卡占位符替换及数字引脚假设；一次 Electron 启动在 Agent 模块加载阶段超时。最后一轮实际工具流程用时 112864 ms，通过原有 90 s 单步骤 / 270 s 整体边界，没有增加超时或放宽产品校验。

恢复 scheduler 后将 64 块的装载批次细分为最多 8 块的连接片段；每片段检查时间预算，超过预算在原任务队列让出并重新检查租约。单个库同步回调仍不可抢占，时间预算不冒充异步稳定性或隔离保障。

## 5. 下一批的准入与完成标准

本节保留 N2 实施前的历史准入条件，当前维护边界见第 19 节。

优先 N2 的隔离候选执行边界，不再新增库名、私有方法名或源码模板名单。先以“候选 extension 改注册表、创建额外块/模型、启动计时器、抛错”反例证明失败候选不会污染宿主，再接通未知动态块的位置参数绑定。静态路径与原生路径最终必须汇入同一候选合并、请求值校验和提交接口。

N2 的第一条端到端验收必须是 Agent 在空白工程中创建无模板动态块并改变结构配置，而非再次编辑预先创建的实例。涉及自动子块、模型或异步任务的情况进入 N3，不通过固定延时或事后覆盖候选来伪造稳定。全部通过前，不将 preserve-only 普遍提升为可创建，也不删除尚承担生产覆盖的静态快速路径。

## 6. 2026-09-16 N2-a 实施与验收

本批未修改 ABS/map schema、用户库或 Agent 协议。保留原活动项目 Runtime 和租约；仅在显式诊断候选调用时按需加载候选模块。Blockly core 是构建资产，不从 CDN 获取，不增加第二版本依赖。

模块职责：`blockly-native-replay-journal` 记录顺序和失效；`blockly-native-candidate-protocol` 定义数据边界；`blockly-native-candidate-policy` 检查当前同步子集和请求大小；`blockly-native-candidate` 管理资源/取消/过期检查；`blockly-native-candidate-realm` 执行原生配置并检查最终序列化。`blockly-native-structure` 被主程序与子 Realm 共用，不复制结构识别算法。

- ChromeHeadless **591/591**：`.tmp-abs-candidate-realm-tests3.log`。包括独立注册表/原型/全局、opaque 父窗口限制、跨脚本 const、实际 DHT/MAX31865 配置、额外块/模型拒绝、资源错误被捕获仍失败、过期和取消、extraState、序列化期间改写字段，以及全部原有 ABS 专项。
- development 构建通过：`.tmp-abs-candidate-realm-build2.log`。首轮发现跨 Realm 序列化函数依赖打包器的 object-spread 辅助函数；已消除自包含引导函数的该外部依赖并通过重跑，没有复制编译辅助函数到候选环境。
- 架构检查仍因 user-center 的 4 项既有跨层引用退出非零，0 循环；本批没有新增该类引用，不宣称全仓架构检查通过。
- 真实 Electron 通过：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-mrnyP9/result.json`，success=true、errors=[]。直接加载产品实际产出的候选懒加载模块：未知扩展在独立 Blockly 中创建 MODE=B、LEFT=3、RIGHT=7；定时器、未请求模型、脚本抛错三项拒绝。父页面与 preload 不可访问；宿主块定义/原型/工作区不变、无 iframe 残留。
- 该空白工程原本只有 ABI，ABS/map 尚未初始化；测试明确核对 ABI 字节不变、ABS/map 仍不存在，而非为测试补写三文件。首轮测试错误假定三文件均存在，修正夹具后通过。原工程 ABI 哈希不变。
- 打包的独立 Blockly core 与当前 node_modules 实际 core 文件 SHA256 一致：`b2c93d488e7fe47964fea1aa9a9d1f6da153a9268c55294e0cbe3c846ac9b100`。此 Electron 验证是独立候选诊断，不是 Agent 的 ABS 新建/编译验收；未运行 LLM、固件编译或设备操作。

下一批先完成 N2-b 的真实宿主引导依赖与按序参数绑定，再进入 N2-c，不能把本批测试中的扩展定义片段当成所有库完整 generator.js 已可重放的证据。

## 7. 2026-09-16 N2-b：共享引导与同步 ABS 绑定

### 7.1 实施内容

1. **同源实现，独立实例。** 新增 `blockly-native-registrations`，主组件与候选包共同导入实际字段和结构扩展；`blockly-generator-factory` 统一模式选择。候选包独立编译 Blockly、Arduino/MPY/Python、pinyin，不共享宿主对象。Project Data 字段改用窄 `project-data/public-api`，位图服务桥接从 Angular 服务实现中分离，仍保留原字段类与 UI 行为，不复制字段实现。
2. **构建所有权。** `run-angular.cjs` 在 build/serve/test 前生成候选包；serve/watch 同步监听该包依赖，失败重建删除旧候选资产。统一接入现有 npm、Electron 打包及 E2E global-setup 入口，不新增依赖；E2E 跳过构建的时效判断同时纳入这两个构建脚本。构建检查单一 Blockly core、无 Angular/Electron 模块、无外部导入；主程序嵌入 SHA256 并在执行前校验候选资产，拒绝旧包/混合构建。删除 N2-a 的函数 `toString()` 注入和单独复制 core 的路径。
3. **语法与绑定分离。** `readAbsSyntax` 不查询定义或执行块回调，保留调用、位置实参、原始 token、缩进段和 `@extra`。`bindAbsSyntax` 为原静态路径与原生路径共用的唯一绑定器；原 `parseAbsSyntax` API 仍是二者组合。没有引入第二语法，变量引用、裸 `$` 值展开、字面量、别名、具名段等既有纯路径保持。
4. **逐实例原生执行。** 同一个 `NativeCandidateWorkspace` 负责显式字段诊断和 ABS 候选的创建、extraState、字段装载、连接检查、请求保留、模型/额外块拒绝和最终树形读回。传给字段/extraState 回调的对象与请求快照分别克隆，回调不能原地修改期望值后蒙混通过校验。`blockly-native-abs-binding` 只将共享绑定器接到执行器，不含库名或源码形状模板。字段/value 仍按原 argsN；动态部分依照实际构造记录，直接 `jsonInit()` 也捕获当次声明顺序，不能以视觉顺序代替。
5. **上下文失效。** 回放上下文包含模式与 Blockly 消息；语言刷新单独记录并使快照失效。保留原 session、配置和来源 revision 校验。

开发/CI 应使用 `npm run ng -- build ...`、`npm start`、`npm run test:abs-sync` 等仓库入口。直接执行裸 `ng` 会绕过候选准备；确需使用时先运行 `npm run prepare:blockly-native`。生成目录 `.generated/blockly-runtime` 不提交 Git，缺失或版本不匹配时明确失败。独立入口类型检查：`node node_modules/typescript/bin/tsc -p tsconfig.blockly-native.json`。

### 7.2 验收与边界

- ChromeHeadless **606/606**：`.tmp-abs-native-bootstrap-final3-tests.log`，包含原有回归及两阶段解析、变量兜底、原声明/视觉顺序相反、直接 jsonInit、同类型不同配置、值/语句连接、过多参数、不兼容连接、后置回调丢弃子块、请求对象被回调原地修改、真实三模式 Generator、自定义多行字段及旧候选资产拒绝。
- development 构建通过：`.tmp-abs-native-bootstrap-final-build.log`，16.756 s；候选资产随主程序一起生成、复制，不从外部下载。
- 独立入口类型检查通过：`.tmp-abs-native-bootstrap-final-types.log`。独立包与 Electron 构建脚本测试 **8/8**：`.tmp-abs-native-bootstrap-final-node.log`。
- 架构检查仍是 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-bootstrap-final-architecture.log`；不宣称全仓检查通过。
- 真实 Electron 最终重跑：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-qf6mn9/result.json`，success=true、errors=[]。未知扩展通过 ABS 位置调用创建；从活动回放日志抽取 DHT/MAX31865 **完整 generator.js**，逐字节 SHA256 与只读库源匹配，分别创建 DHT20/Wire、DHT22/PIN、软件 SPI 三动态引脚和硬件 SPI 配置。日志：`.tmp-abs-native-bootstrap-final-electron.log`。
- 该 Electron 检查是两份完整库脚本的候选执行，不是全部工程脚本回放；没有执行代码生成、Agent apply、LLM 会话或固件编译。宿主定义/原型/工作区不变；ABI 字节不变，原本不存在的 ABS/map 仍不存在；原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。
- 首轮新增反例的夹具误将承载 MODE 的整行删掉，实际先触发字段丢失拒绝；改为只断开已请求子块后，独立验证连接丢失拒绝。没有放宽产品校验以通过测试。

### 7.3 剩余主线与退出标准

**N2-b 当时的下一步为 N2-c，现已按第 8 节接入同步子集。** 诊断用的 `abs-candidate-<source offset>` 只是临时 ID，绝不能持久化替代 map 身份。`@disabled` 的持久化策略同样复用现有 ABI/map，不创建另一套 reason/保护机制。

**N3 是全工程准入的必要项。** 当前同步候选仍拒绝变量/过程模型、自动子块、异步资源、项目服务和 I/O；Project Data 在候选内没有文件系统会话。主程序媒体字段已注册，不代表资源已能水合。完整 generator.js 可注册其 handler，不等于执行 handler 后的模型和派生状态已覆盖。整工程脚本中即使仅声明未调用 async 函数仍会被当前门禁拒绝，需以真实任务归属替代该保守门禁，不能直接删掉检查。

纯语法/静态提交路径的历史兜底仍工作；新原生诊断中的具名参数预配置、隐式模型及所有 opaque 效果未宣称全面支持。现行 Agent 能力等级不变，库和 Agent 本批未修改。最终验收仍为：空白工程中 Agent 创建未知动态块并改变结构 → 唯一 apply → 保存重开 → 自主会话与编译；本批证据不能替代它。

## 8. 2026-09-16 N2-c：原生证据汇入唯一事务

### 8.1 已实施的边界

1. **身份只由原 reconciler 决定。** 第一次隔离绑定只确定语法/结构；沿用原指纹、归属、歧义、保护策略规划 ID。随后使用正式 `start → id` 重放原生配置，再合并一次。两次绑定语法和最终身份必须一致。初始化过程中以 `this.id` 生成的默认值因此使用正式 ID，不做字符串替换；临时树不外置资源、不装载、不保存。
2. **合同按调用和 ID 绑定。** `abs-native-binding` 只包含内部 source/AST/实例形状/serializer seed；不进 ABS 或公开 map，不新增 Agent 参数。旧块 metadata、坐标、disabledReasons、连接状态和 dormant shadow 仍由原 reconciler 合并。只在本次原生实例确认后裁剪已不存在的字段/输入；已有字段的 opaque 值仍遵守原显式编辑规则。
3. **提交前验证最终 ABI，而非诊断工作区。** `blockly-native-abi-verification` 在第三个一次性 Realm 装载已经合并的 ABI，按同一原生字段顺序加载，执行实际模式 Generator，并在前后调用同一个完整 `assertAbsReadback`。生成器增加模型、改变字段、捕获定时器错误或抛错都会在活动工作区变更前失败。将 `absJson` 抽为无 Angular 的纯模块供两端共用，没有复制完整读回算法。
4. **唯一资源和保存路径。** 原 `prepareAbsReconciliation` 复用新抽出的 `prepareAbsReconciledResources`；原生路径汇入同一资源协调器。`AbsWorkspaceSyncService` 仅在原路径缺少语法绑定/结构合同时尝试原生准备，字段非法、身份歧义、保护、资源、baseline/CAS 等错误不被原生结果豁免。静态/已有实例快速路径继续保留。apply、布局、完整活动读回、三文件事务、读回失败回滚及提交不明隔离没有第二实现。
5. **完整来源与失效。** 生产路径使用当前 runtime 的完整有序快照，不按块名/库名过滤 generator.js。每次隔离往返和准备后检查 revision/session，最终仍检查磁盘 CAS。没有探测性修改活动工作区，也没有库侧适配或新源码模板。

内部流程：`原生绑定 → 既有身份规划 → 正式 ID 重放 → 既有 metadata/shadow 合并 → 资源准备 → 隔离 ABI/Generator 完整读回 → 既有 apply/CAS`。

已捕获的结构选择器变化及超出已知实例槽位的新输入不能继续冒充“同形编辑”，需要准备形状。没有完整声明的老实例不通过“ABI 未保存空槽”猜测其可用输入，保留原完整读回边界。`@disabled` 在绑定阶段只保留语法标记，持久化理由仍由旧 ABI/map 合并；新增/改变禁用状态仍要求显式宿主操作。

### 8.2 验收证据

- ChromeHeadless **615/615**：`.tmp-abs-native-commit-final-tests.log`。新增未知扩展经 validate/apply 新建与变形、正式 ID 默认值、同类型多配置隔离、受保护变形及子块/影子块保留、原始禁用理由、保护删除拒绝、生成器模型/计时器/字段变化/异常拒绝、快照过期和磁盘竞争等回归。
- 上述提交测试使用真实 Blockly、实际 coordinator、内存 CAS 端口；活动代码生成端口为测试桩，候选端执行实际 Arduino Generator。ABI 保存/重新装载断言不冒充真实 Electron Agent 闭环。
- 独立入口类型检查通过：`.tmp-abs-native-commit-types.log`；构建脚本测试 **8/8**：`.tmp-abs-native-commit-node.log`。development 构建记录见 `.tmp-abs-native-commit-build.log`，最终构建见 `.tmp-abs-native-commit-final-build.log`。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-aP2Dex/result.json`，`success=true`、`errors=[]`。在实际打包候选模块中增加正式 ID、保护/opaque metadata、最终 ABI 装载与实际 Generator 读回；生成器创建未归属模型被拒绝。此前完整 DHT/MAX31865 绑定用例仍通过。该测试明确是隔离验证，不是 Electron abs_apply 或全工程代码生成。
- 架构检查仍因 user-center 的 4 项既有跨层引用退出非零，0 循环：`.tmp-abs-native-commit-architecture.log`。未改动这些不相关文件，不宣称全仓通过。
- 原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库、Agent 与登录配置本批未修改，既有脏工作区改动保留；未 commit/push。

### 8.3 下一步及明确未完成项

N2-c 当时的下一步为 **N3 的模型/资源/任务归属**，不继续增加按库适配。变量输入和通用大值快照现已按第 9 节承接；过程模型、自动子块、媒体专用引用、项目服务和异步/I/O 仍未承接，全工程中未执行的 async 声明也仍可能被当前保守门禁拒绝。上述情况没有因提交链接通而自动变得可用，已有静态路径及变量兜底未删除。

另需逐步覆盖具名参数配置顺序，以及原静态字段校验在配置切换后的动态选项；仅 JS 注册块的宿主导出记录已在第 9 节补齐。本批不通过放宽 `ABS_FIELD_INVALID` 或猜测字段来兜底。公开 `preserve-only` 仍是未执行原生准备时的保守建议，不将一次成功候选推广为所有配置的创建许可。N3 与真实 Agent 新建/变形验收后再调整能力提示。

N4 退出标准保持不变：真实空白工程 Agent 自主创建未知块并变形，保存重开无损，再运行 LLM 会话和固件编译。本批未运行 LLM、固件编译或设备操作，不能据此宣布通用动态块方案全部完成。

## 9. 2026-09-16 N3-a：变量与通用大值作为候选输入

### 9.1 原理及落地

先承接**宿主已经确定的输入**，再扩展**执行产生的附带效果**，二者不能混为一谈。变量表已有 ID/名称/类型；Project Data 已有验证、解码和会话边界。候选只需要这些输入的独立副本，不需要另一套模型命名规则、资源文件格式或文件系统访问能力。

| 职责 | 实现与复用 | 明确不做 |
| --- | --- | --- |
| 变量输入 | `blockly-native-models` 装载宿主变量表，复用 `AbsSymbols` 解析引用及 `assertAbsReadback` 比较完整模型表；两次绑定分别携带初始/规划后的模型表 | 不从字段名字猜模型，不将回调新增、改名、删除的模型当成输入 |
| 字段合同 | `abs-runtime-field-contract` 抽出主程序/候选共用的 FieldVariable 协议转换；先解析模型引用再 loadState | 不先调用未配置变量字段的 saveState，以免触发默认变量创建 |
| 资源输入 | `abs-native-resources` 在宿主会话/租约内 resolve 通用 envelope，按 ID 去重并校验元信息；`blockly-native-values` 只读取复制的 ref/value 快照 | 不传路径、preload、store 或 ProjectService；未知/冲突引用不返回空值 |
| 大值解包 | 从现有 `project-data-generic-values` 提取 payload 级同步/异步入口，文档装载和候选字段/extraState 共用同一解包、codec 类型及嵌套引用校验 | 不按动画、图片、某种字段名分支，不新增资产格式 |
| JS 声明记录 | 原 runtime 的 Blocks facade 观察正常注册，真实 init 时记录 jsonInit 的 argsN 和动态构造；catalog 仅导出当前定义的实例记录 | 不探针初始化，不把实例提升成静态类型合同，不采信清空/替换后的旧记录 |

`$counter` 仍是变量下拉引用，`variables_get($counter)` 仍生成变量块；裸 `$counter` 在值输入中仍由同一个历史展开器生成变量块。此次是让原生候选使用这些原有规则，不是改变 ABS 或要求 Agent 选择新语法。原 `variable_define("counter", int, math_number(7))` 静态路径和已有声明意图未删除。

通用大值在绑定时才恢复，语法树保留原 envelope、token 和源偏移；因此 ABS 仍是短引用，资源替换与最后外置继续进入原协调器。支持字段及嵌套 JSON/数组 extraState；总请求仍受既有 16 MiB 上限约束。带 `$ailyData` 的媒体专用字段状态不因此自动获得资源缓存/项目服务，仍明确拒绝其未准备的执行。

JS 注册观察没有替换活动 Generator。定义被替换、init 改变、目录清空或原生结构被直接改写时旧实例声明失效。候选重放结束后禁止注册表写入和 JSON 块注册，防止配置/生成器回调带出未归属的注册效果；该边界不是恶意 JavaScript 安全沙箱或任意原型副作用证明。

### 9.2 验证

- ChromeHeadless **631/631**：`.tmp-abs-native-model-values-final-tests.log`。包括原 615 项及已有/显式创建变量、下拉与显式/裸变量值输入、类型筛选、缺失/歧义模型、模型回调效果拒绝、注册效果被捕获仍拒绝、通用大文本/嵌套数组 extraState、缺失/冲突/重复资源、实际 coordinator 外置保存及 JS 定义顺序/失效等新增回归。
- 独立入口类型检查通过：`.tmp-abs-native-model-values-types.log`；构建脚本 **8/8**：`.tmp-abs-native-model-values-node.log`；development 构建通过，17.765 s：`.tmp-abs-native-model-values-build.log`。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-f5xn63/result.json`，`success=true`、`errors=[]`。实际候选包中，变量下拉与裸变量值输入均保持 `owned-counter`；42,500 字节文本从输入快照恢复，ABS token 仍是 envelope；实际 Arduino Generator 完整读回通过。DHT/MAX31865 原完整脚本绑定及既有隔离反例继续通过。宿主工作区、ABI 字节及 ABS/map 原有不存在状态均不变。
- Electron 本批验证的是隔离执行和提供的只读输入快照，不是完整工程 replay、Agent apply、真实资源文件写入或固件编译。coordinator 的新建/变量/大值两轮 apply 测试采用真实 Blockly + 内存 CAS/资源端口，沿用既有活动代码生成测试桩；两种证据不互相冒充。
- 首轮变量测试误要求 serializer 输出空 `type`，已按 Blockly 省略默认值的实际格式修正夹具；原完整读回一直保留其默认等价规则。JS fallback 回归发现目录清空后旧记录被重新采用，已补退休定义及当前 init 身份检查，没有放宽原反例。
- 架构检查仍为 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-model-values-architecture.log`。原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库、Agent、登录配置本批未修改，未 commit/push。

### 9.3 下一步的收敛顺序

1. **N3-b：模型生产及引用时序。** 普通声明的混合候选准备次序已按第 10 节完成。过程模型、自动子块和其他 serializer 仍需要各自通用归属边界，不能先执行 Generator 后无条件采纳生成结果。
2. **N3-c：资源与任务会话。** 承接媒体专用引用的只读缓存及受跟踪任务。当前未执行的 async 声明仍被保守拒绝；不能直接去掉门禁、使用固定延时，或把候选接到活动项目服务。完成任务所有权后才调整完整工程准入。
3. **N4：真实 Agent 全链路。** 在完整来源重放通过的空白工程，Agent 创建无模板动态块并变形、保存重开，再测自主会话和编译；届时统一收敛能力提示。具名配置顺序及配置切换后的动态选项也仍需覆盖，不新增库特例。

本批完成 N3 的受控输入子集，并非 N3 全部完成；不改 ABS/map schema，不删除仍承担生产覆盖的静态快速路径或历史兜底。

## 10. 2026-09-16 N3-b：混合原生候选的普通声明与引用时序

### 10.1 根因与实现

原声明规划已能在身份匹配后、符号解析前准备所有模型。缺口不是变量语法，而是原生路径需要**先完成首次字段绑定**才能得到待匹配的完整 AST；新声明的模型尚未进入该候选，提前或后续的 `$counter` 都可能在这一步失败。

新 `abs-native-model-inputs` 仅解决这个准备环：遍历已读取的 raw AST，只查询已有可信声明合同，复用 `bindAbsSyntax` 读取声明字段。初始化表达式的内部结构在这次字段投影中不参与绑定，完整原生阶段仍逐项校验，原 AST 不变。字段/value 按原 `argsN` 排序，具名调用共用旧规则；不硬编码 NAME/VAR、TYPE 的参数位置，不按库名或字段名猜声明。

执行顺序保持一条链：**声明输入预准备 → 原生试绑定 → 原身份/声明规划 → 正式 ID 和模型表重放 → 原合并/资源/完整读回 → 唯一事务**。

- 临时模型来自可信声明文本，不来自任意引用、回调运行结果或 Generator 副作用。它们只供一次性候选试绑定，不合并进待保存 workspace；重名、类型冲突、错误作用域、旧声明隐式改名等仍由原 `prepareAbsDeclarationIntents` 判定。
- 初始输入复用 baseline 与显式创建意图，不重建已有模型。临时输入按名称去重不代表允许重复声明；完整规划仍拒绝重复存储声明。
- 静态规划与原生预准备共用 `absDeclarationRequestId`，没有第二套模型 ID 规则。第二次重放后，块身份及完整计划变量表都必须稳定；缺省变量表按空表比较。
- 未提供可信声明合同、不明确的引用以及禁用声明不会获得推断创建许可。声明初始化值中的未知原生块仍由原生绑定处理，不要求其先获得静态合同。

ABS/map schema、裸 `$` 值输入展开、变量下拉语义、保护与 opaque 状态、静态快速路径、活动 Generator 和库源码均不改变。本批没有扩充声明源码摘要白名单，也没有将普通声明合同推广为任意库模型生产许可。

### 10.2 验收及剩余工作

- ChromeHeadless **643/643**，最终重跑 38.585 s：`.tmp-abs-native-declaration-order-final-tests.log`。新增 12 项覆盖原序/具名实参、未知初始化表达式、原 AST 不变、声明来源、禁用、前后向引用、显式意图去重、重复/越界声明、类型冲突、重命名及拼错引用拒绝；实际 coordinator 验证不改宿主、apply、二次编辑、模型/块 ID 和保存重开。
- 上述事务测试使用真实 Blockly、候选 Realm、实际候选 Arduino Generator 与原 coordinator；声明来源为明确标注的测试证明，存储/资源采用内存端口，活动代码生成沿用测试桩。它不等于新跑真实 Electron/Agent、全工程回放、LLM 或固件编译。
- 独立候选入口类型检查、构建脚本 **8/8**、development 最终构建通过（17.097 s）；日志为 `.tmp-abs-native-declaration-order-{types,node,final-build}.log`。架构检查仍是 user-center 的 4 项既有跨层引用、0 循环，未扩大修复范围。
- 首轮回归修正新增表稳定性检查对缺省变量表的处理，并修正 raw AST 测试误用只接受 JSON 值的比较器；没有放宽字段、模型或事务校验。

本节之后的过程准备器复用已按第 11 节承接；自动子块和其他 serializer 的可归属效果仍待实现。N3-c 的媒体只读缓存/任务会话，以及 N4 的真实 Agent 新建变形→重开→LLM/编译保持原退出标准。未修改库、Agent、登录配置或用户工程，未 commit/push。

## 11. 2026-09-16 N3-b：既有模型准备器、原生发现与普通加载收敛

### 11.1 职责边界

已有纯过程/自定义函数准备器已经负责参数模型、UI 字段 ID、签名和引用校验。未知块的原生结构发现不应迫使它们提前 `loadExtraState`，产生随机参数 ID、默认模型，再由宿主事后采纳。

1. `hostPrepared` 只来自当前快照已经证明的准备器覆盖范围；`hostCalls` 是一次请求内的源偏移/类型/已知实参顺序，不是新的 ABS 注解、公开 map 或 Agent 参数。候选使用同一 `bindAbsSyntax` 读取所有节点，只初始化未交给宿主准备器的节点。不存在用假块替代模型块的实现。
2. 原 reconciler 要求每个调用恰好有一种证据：本次原生实例，或仍有效的宿主准备器。来源不明、重复/遗漏/类型不符的 hosted 记录拒绝。身份匹配、参数 ID 生成、签名冲突、显式模型意图及跨页策略继续执行原代码。
3. 跨两种准备方式的连接不冒充已在发现工作区验证。完整 ABI 经原准备/合并后，在独立 Realm 实际加载、生成代码并完整读回；不兼容连接、悬空调用和 Generator 新建未归属子块仍在宿主变更前拒绝。两个局部发现结果不能替代这一步。
4. 候选重放复用原 `adaptBundledArduinoProcedureCalls`，保持真实旧 Generator 的 `INPUTn` 读取与主程序原生 `ARGn` 输入一致。删除候选启动时无条件包装所有内置 init 的逻辑，只观察实际注册/发现节点，避免无关观察破坏内置过程来源证明。
5. raw AST 遍历收敛为 `walkAbsRawSyntax`，普通声明预准备与 hosted 收集共用；不新增第二语法读取器、身份匹配器、模型表或保存入口。

当前过程新增/变更仍沿用已有准备器支持的 ABS 表达与模型意图。没有静态实参顺序时不猜顺序或槽名，使用原有显式参数/分段规则；库仍只读。自定义函数的纯准备已进入混合通道，但其完整脚本中的计时器、异步同步器等限制没有因此解除，不能宣称任意过程库均已可用。

### 11.2 由重开测试暴露的真实数据入口

新测试发现：ABS apply 会按实例合同排序字段，普通 `loadWorkspaceJson` 却直接按 canonical ABI 的键顺序加载。`DETAIL` 排在 `MODE` 前时，Blockly 跳过尚不存在的字段，随后 MODE=B 创建的只是默认值。这不是过程参数丢失，而是普通加载与事务加载的边界遗漏。

`orderAbsDeclaredFields` 与原实例排序共享一个字段重排函数，普通加载在清空工作区前按现有注册 JSON 的数字 argsN 排列已知字段，其他字段随后加载。复用 Project Data 的 `collectProjectBlocks` 遍历嵌套块/影子块，不复制图遍历，也不让普通加载意外要求 ABS 的严格 ID 索引。空工作区及尚无 ID 的本地块仍可加载；只调整装载视图，不改 ABI/map 字节格式，不运行 probe init。

此修复覆盖声明 JSON 中的配置字段先于其动态字段的情况。仅 JS 构造、没有声明 JSON，或动态字段之间还有配置依赖的重开顺序没有通用证明；下一批优先补这一无损加载边界，不将本批排序描述成所有动态块重开保证。

### 11.3 验证与退出边界

验收包括真实 coordinator 中过程参数准备、未知动态块位于函数体、函数返回调用位于原生值输入、前向调用、参数移除及模型保留、二次编辑与保存重开；拒绝伪造参数 ID、缺失模型、未知 serializer 成员、无定义调用、不兼容跨边界连接和 Generator 自动新增子块。另覆盖 hosted 描述符的完整性、无准备器拒绝、实际普通加载入口、声明失效及空/无 ID 兼容。

coordinator 测试仍使用内存存储/资源端口，活动代码生成端口为测试桩，候选运行实际 Blockly 和 Arduino Generator；不等于 Agent/LLM/固件编译。独立 Electron 验证范围仍为候选和完整 ABI 诊断，不扩大为真实 Agent apply。

- ABS 专项 **659/659**，46.154 s：`.tmp-abs-native-host-models-final2-tests.log`；项目加载专项 **9/9**：`.tmp-abs-native-host-models-project-load.log`。
- 独立入口类型检查通过：`.tmp-abs-native-host-models-final-types.log`；构建脚本 **8/8**：`.tmp-abs-native-host-models-final-node.log`；development 构建通过，17.041 s：`.tmp-abs-native-host-models-build.log`。
- 架构检查仍为 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-host-models-final-architecture.log`，不宣称全仓架构检查通过。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-ZyDRDN/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-host-models-electron2.log`。两条宿主过程调用与两个原生调用的混合发现、带 `mixed-param` 模型的完整 ABI 读回、实际 Arduino Generator 与 INPUT/ARG 适配通过。已有变量/大值、完整 DHT/MAX31865 脚本诊断及隔离反例继续通过；本例的最终 ABI 是明确构造的诊断输入，实际协调器准备和提交由上述专项另行覆盖，不是 Electron Agent apply。
- Electron 宿主工作区、镜像字节及 ABS/map 原有不存在状态保持不变；原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。
- 首轮混合测试发现候选提前包装内置 init 使 Generator 兼容合同失效，以及普通重开忽略动态字段，均已修复并保留反例。测试夹具另修正了未知槽的内联段写法、原生 `structuredClone` 的错误 this 绑定及 Electron 诊断根块缺少坐标的问题，未放宽产品校验。

本批未开放任意自动子块采纳、模型副作用或新 serializer，也未改动异步门禁。下一步顺序为：无声明 JSON 的重开顺序证据 → 自动子块/其他模型的通用归属 → 媒体/任务会话 → N4 全链路。静态快速路径和已有保护/资源/CAS/回滚保持唯一，未改库、Agent、登录配置或用户工程，未 commit/push。

## 12. 2026-09-16 N3-b：无声明字段恢复与 shadow 重生

### 12.1 原理与边界

保存值不提供字段之间的依赖图，字段名的字母顺序也不是初始化顺序。真实块在 init/extraState/配置回调后暴露的字段才是事实来源。不能要求每个库增加元数据，不能以另一个默认实例模拟当前块，也不能让丢失的值被默认值掩盖。

新增独立同步模块 `blockly-native-field-loading`：

1. 普通 `loadWorkspaceJson`、ABS `loadAbsWorkspaceInChunks` 及独立 Realm 的最终 `verifyNativeAbi` 共用字段恢复算法。原生 serializer 继续负责模型装载、块创建、extraState、父连接、输入/next、shadow 与 UI；没有复制第二套 serializer，也未替换全局注册表或 Blockly 原型。
2. 当前 Blockly 没有公开字段装载回调。适配层在**调用者拥有的加载视图**上短暂安装 fields accessor；原生 loader 在 extraState/父连接之后、子输入之前读取字段时执行恢复，然后交还空字段表，避免重复调用 validator。仅在本次 workspace 实例上临时关联 `newBlock` 的请求 ID 与实际块，保留原生 ID 重映射。所有临时 accessor/方法在 finally 恢复；不进入 ABI/map/ABS，也不跨异步任务持有。
3. 字段优先按现有 JSON argsN 与当前原生构造记录选择；暂无声明时只选当前实际存在的请求字段。配置回调创建新字段后继续推进。同名 Field 对象被重建时向新对象恢复保存值，而不重复加载未变化的对象。已有下拉但选项尚未就绪时，使用共用运行时字段合同延期处理；最终仍缺失/不可用则报错，不接受默认选项替代。
4. 以请求字段数决定有限的推进预算；回调循环重建、覆盖已恢复字段、缺失字段或拒绝下拉保存值均明确失败。普通装载保留其他原生字段 codec 的归一化行为；ABS 提交另有原完整 ABI/readback 检查，未将这里的局部稳定性当作完整意图证明。
5. Blockly 会在装载中重新序列化 shadow 默认块，重新得到视觉字段顺序。适配层把本次成功执行的最后装载顺序整理到**原生已生成的内存 shadow 默认状态**，保障此次装载后原生断开/重生路径；不添加 sidecar 或持久化字段顺序属性，canonical ABI/map 字节规则不变。

删除上一批普通装载的 `orderAbsDeclaredFields` 预排序实现；`nativeFieldOrder` 按当前实际结构读取顺序，原 `orderAbsNativeFields` 仍负责已准备实例合同的装载视图。图遍历、字段类型识别及 canonical 比较均复用已有模块。没有库名、字段名、私有 update 方法名或源码模板分支。

此处是同步字段恢复，不是普通项目打开的新增事务：出错后的工程恢复仍交给原调用链；ABS 保留原租约、回滚与 CAS。没有采纳任意额外子块/模型，没有等待 async/媒体任务，也不允许长期异步回调借用临时加载上下文。任意自定义 codec 的语义依赖、UI 后续修改产生的新 shadow 配置和未受控 serializer 副作用不因本批自动获得完整证明。

### 12.2 验证

新增测试覆盖无声明 JSON、多级选择器、同类型不同配置、缺省 ID、extraState 和父连接时序、字段对象替换、下拉选项就绪、未知字段/无效选项拒绝、重建不收敛、回调覆盖、异常清理、跨工作区隔离、原生 ID 重映射、重复状态 ID 提前拒绝、嵌套块与 shadow 重生。

协调器回归从空白增量创建纯 JS 块，经 validate/apply 保存 canonical ABI，再清空目录和工作区、重新注册定义，用普通恢复入口重开；不借旧实例记录补值，保持块 ID、保护与镜像字节。该专项仍使用内存存储/资源端口与活动生成器测试桩，候选使用真实 Generator。

- ABS 专项 **672/672**，49.618 s：`.tmp-abs-native-reopen-final2-tests.log`；项目加载专项 **9/9**：`.tmp-abs-native-reopen-load.log`。
- 独立候选入口类型检查通过：`.tmp-abs-native-reopen-final-types.log`；构建脚本 **8/8**：`.tmp-abs-native-reopen-node.log`；development 构建通过，26.385 s：`.tmp-abs-native-reopen-build.log`。
- 架构检查仍为 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-reopen-architecture.log`；没有把专项成功写成全仓架构检查通过。
- 首轮新增 shadow 重生反例确实失败，暴露原生重新序列化默认块带回视觉顺序；补入内存默认状态顺序后原反例通过，没有放宽断言。随后补齐下拉选项就绪反例，最终全量重跑通过。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-lnEhPy/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-reopen-electron.log`。实际应用页面的 `loadWorkspaceJson` 在独立渲染 WorkspaceSvg 中完成无声明 JSON、两级选择器、两轮加载/重开、根保护及断开后 shadow 重生；临时工作区/注册定义均清理，主工作区指针恢复。
- Electron 的既有完整 ABI/实际 Generator、混合过程模型、42,500 字节大值及 DHT/MAX31865 来源诊断继续通过。此处新测试是普通加载方法的渲染级回归，不是重启整个应用、Agent apply、LLM 或固件编译；完整 coordinator 提交另由上述专项验证。
- 宿主工作区及 ABI/ABS/map 原有字节/存在状态不变；原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。库、Agent、登录配置及用户工程本批未修改，既有脏工作区保留，未 commit/push。

### 12.3 下一阶段

按原主线进入**自动子块/其他模型的通用归属**：区分用户明确请求、原 ABI 已有状态与原生执行附带效果，复用身份规划和完整读回，不能无条件采纳候选结果。随后才开放媒体只读缓存/受跟踪任务，最后执行 N4 的真实 Agent 新建变形 → 保存重开 → LLM 会话 → 固件编译。当前不提升所有 preserve-only 能力，不删除仍承担覆盖的静态快速路径。

## 13. 2026-09-16 N3-b：临时默认子块归属及完整拓扑回放

### 13.1 决策及职责

**可替换的临时值不等于可自动保存的用户数据。** 用户明确提供 `owner(..., child(...))` 或 `null` 时，库同步初始化的临时实块可以退场；未指定的自动块、shadow 默认值和模型表没有因此获得持久化许可。不能仅比较最终类型/数量，再删除看起来多余的块或变量。

- `blockly-native-block-effects` 是独立于 ABS/库的同步创建作用域，记录实际 Block 对象与调用 owner；嵌套 init 继承归属。只临时包装当前 workspace 的 `newBlock`，始终恢复原 descriptor；不改写 ID、不碰全局原型，不按库名/字段名/私有方法名推断。
- 候选执行器只为明确的 create、loadExtraState、field.loadState 及连接操作分配创建归属。替换前检查**整棵已连接子树**：必须全部来自当前 owner，且没有用户请求块混入。检查通过后才 dispose；未连接的额外根块、其他 owner 的块和模型影响仍由原完整所有权/读回拒绝。被清理子块不会进入 seed、身份规划、ABI/map 或新增节点表。
- 原字段加载模块更名为 `blockly-native-state-loading`，唯一 API 为 `withNativeStateLoading`，不保留兼容别名。字段算法、extraState 时序与拓扑恢复共用同一创建作用域，删除两处重复的 workspace 方法包装实现。Contract/saveState getter 不获得 field.loadState 的创建归属。
- **ABI 是完整保存状态，不是新块模板。** 进入原生 input/next 装载前，清理属于当前加载 owner、尚未被保存节点认领的临时默认连接，再交原生 serializer 加载真实保存的子块与 shadow。ABI 中缺省的输入表示空连接，不允许 init 把用户已断开的输入重新填满。旧 shadow 的 ID/字段仍来自保存状态，而不是刚初始化的默认对象。
- 非分片 `loadAbsWorkspaceState` 此前仍直接调用 native.load；本次协调器回归暴露它会残留默认游离块。现与普通项目加载、分片 append、最终隔离 ABI 验证共同经过同一适配。原生 serializer、唯一事务、模型准备器、资源外置、CAS、保护和回滚均保留。

模型界限本批有正反例：重复使用请求中已存在的变量模型允许且保留 ID；默认子块创建/销毁时产生的未知变量拒绝，绝不删除变量掩盖副作用。原生发现中的 shadow 默认值仍拒绝丢弃，因为 ABS 没有赋予修改其隐藏 fallback 的意图；完整 ABI 装载则已有明确持久化事实，可以回放既有 shadow。这两个场景不能使用同一“都删掉”的策略。

库只读抽查发现 ai-vox / ai-vox-xzai / diandeng_blinker 等真实存在主动 newBlock 的默认值，aily_iic 有主动创建 shadow 的路径。但这些完整来源还可能依赖渲染、计时器或 initSvg；本批无按库适配，也不将同步测试样例成功写成这些库的全部功能已可进入原生候选。

### 13.2 验收记录

测试覆盖嵌套创建归属、异常 descriptor 恢复、整树检查前不删除、init/extraState/字段各阶段默认块、缺省输入与无 ID 块、保存 shadow 重生、其他已加载请求块被移入子树时拒绝、明确 child/null、未知自动根块/模型/计时器拒绝、销毁时模型泄漏拒绝以及显式模型复用。

协调器跑无渲染整批、渲染整批、渲染分片三种模式的 validate → apply → 数值编辑且 ID 保留 → 断开 → canonical ABI 重开，检查无默认游离块、原保护不变。首次全量测试确实在未接入通用恢复的非分片入口失败，已修复入口而非放宽完整读回。首轮两处夹具另修正 saveExtraState 的缺省 null，以及负例中库自身反复 dispose 导致测试提前失败的问题。

- ABS 专项最终 **690/690**，57.066 s：`.tmp-abs-native-effects-final2-tests.log`；项目加载 **9/9**：`.tmp-abs-native-effects-load.log`。
- 独立候选入口类型检查通过：`.tmp-abs-native-effects-final2-types.log`；构建脚本 **8/8**：`.tmp-abs-native-effects-node.log`；development 构建通过，24.449 s：`.tmp-abs-native-effects-build.log`。
- 架构检查仍是 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-effects-final-architecture.log`，不宣称全仓架构检查通过。
- 协调器使用真实 Blockly、实际候选 Generator、原 validate/apply/完整读回，但存储/资源端口及活动生成器是既有测试桩。不是 LLM 或固件编译验收。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-nIURAc/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-effects-electron.log`。候选明确数值子块/空输入均完成实际 Generator 与完整 ABI 校验，默认子块附带未知模型仍拒绝；实际普通加载入口的渲染专有默认块替换后 `orphanBlocks=0`。前批两级字段、两轮加载/重开、保护与 shadow 重生继续通过。
- Electron 范围仍是隔离候选及临时渲染工作区诊断，不是 Electron Agent apply 或应用重启/LLM/固件编译。宿主工作区、ABI/ABS/map 字节及原有不存在状态不变；原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。
- 本批未修改库、Agent、登录配置或用户工程；既有脏工作区保留，未 commit/push。

### 13.3 明确未完成与下一步

本批完成的是**临时效果的替换/退出**，不是任意原生效果的采纳。下一步仍在 N3：对用户未显式提供的原生默认 shadow/子树，建立按连接归属的稳定身份与两次重放证明，再与原身份/保护/资源流程合并；未知模型/serializer 需要明确模型输入或生产意图，不能从字段名字猜表结构。

异步生成/媒体缓存及任务所有权尚未开放；渲染后、onchange 或延迟任务产生的新默认块不在本批同步创建作用域内。通用加载适配本身不提供普通工程打开的新增事务，也不是恶意库脚本安全沙箱。N4 Agent 自主新建变形 → 保存重开 → LLM → 固件编译仍未完成。

## 14. 2026-09-16 N3-b：默认子树的稳定身份与持久化

### 14.1 语义与模块边界

**初始化默认值只能补全新实例，不能覆盖已有用户事实。** 这次不按库或字段类型适配，也不扩展 ABS/map schema：

1. 新 owner 未提供某输入时，接纳该输入下同步创建、整树归属于该调用的默认实块或可见 shadow。不能有显式请求节点混入、跨 owner 借块或额外游离根块；显式 `null` 仍不授权删除 shadow。
2. 显式实块覆盖原生 shadow 时，先捕获实际 shadow 的完整状态及实例合同，再退出临时 shadow；新 owner 将它保存为 dormant fallback，已有 owner 仍使用原 ABI 的 shadow 身份/值。省略或编辑已有 owner 不重新采纳 init 默认数据。
3. `NativeDefaultCreations` 在 init **之前**分配默认块 ID，记录调用位置、创建序号、类型、ID，第二次隔离绑定复用该临时记录；包含期间被替换的临时创建，以发现重放顺序变化。序号仅是一次事务内的重放定位，不作为持久化身份规则，也不进入 ABS/map。
4. 创建记录之外，再比较两次实际默认输入归属、完整子树、字段/extraState/metadata 和逐实例合同。身份分配影响默认内容、两次创建不一致或内容不稳定时拒绝；不在事后遍历字符串替换 ID。
5. `captureNativeBlock` 统一显式调用、活默认子块及即将被覆盖 shadow 的合同采集。`adoptAbsNativeDefaults` 只做纯数据新 owner 合并，复用 ABI 索引、保护、原 matcher 与合同校验；普通装载仍由原完整拓扑恢复模块负责。未知模型、注册写入、计时器、游离块及 Generator 副作用检查保留。
6. 默认子块的字段/extraState 大值通过原 Project Data 外置。只有新采纳子块 ID 对应的 payload 无需 ABS 字面量替换；用户显式调用的值仍须精确源绑定。由原 payload 遍历识别归属，覆盖大文本、JSON/数组及混合嵌套资源，不新增另一套字段遍历或资源仓库。提交后的 canonical ABS 将可见默认子块导出为正常调用，资源为既有紧凑引用；隐藏 fallback 仍只保存在 ABI。

唯一事务、活动 Generator、项目 runtime session、租约、CAS、保护及回滚未替换。对附带块的实例观察也复用原声明顺序记录，不以视觉顺序推断实参位置。静态快速路径仍有独立覆盖，未为清理而删除。

### 14.2 验收与回归

新增正反例覆盖默认实块整树、可见 shadow、覆盖 fallback、init 中读取自身 ID、两次创建不一致、owner ID 影响默认内容、默认游离根块、显式 null 的 shadow 保护、默认节点保存后编辑且 ID 保留、原保护块保留及 canonical ABI 重开。渲染协调器覆盖分片创建与整批编辑；fallback 保存重开后断开显式子块可恢复原 shadow ID/值。资源用例覆盖 40,000 字符字段和 12,000 项数组 extraState，经外置后再次编辑不丢数据。

首轮新增 shadow 编辑反例暴露旧拒绝规则，补入独立 fallback 捕获而不是放宽删除检查。大值默认字段反例随后暴露没有 ABS 字面量的资源准备路径，已按新采纳节点归属收敛；未改动严格用户字面量替换算法。

追加大数组 extraState 的二次编辑反例，又发现原生 shape 的已解析值覆盖了源 envelope。现对显式提供的 native extraState 保留 ABS 中的原引用，实际 shape 一致性移至资源 materialize 之后校验；不是改动 ABS、放宽字面量比较或忽略 extraState。单独运行协调器还发现既有分支 mutator 测试依赖其他 spec 的全局注册，已在该 spec 显式导入原宿主注册入口，消除测试顺序依赖。

- ABS 全量专项 **698/698**，69.220 s：`.tmp-abs-native-defaults-final4-tests.log`；项目加载 **9/9**：`.tmp-abs-native-defaults-load.log`。
- 协调器单文件独立重跑 **98/98**，42.814 s：`.tmp-abs-native-defaults-final-focused.log`；显式声明测试依赖后，不再靠其他 spec 的加载顺序通过分支 mutator 用例。
- 独立候选入口类型检查通过：`.tmp-abs-native-defaults-final-types.log`；构建脚本 **8/8**：`.tmp-abs-native-defaults-final-node.log`；development 构建通过，25.656 s：`.tmp-abs-native-defaults-build.log`。
- 架构检查仍报告 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-defaults-final-architecture.log`；不是全仓架构检查通过。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-Lq7Wp5/result.json`，`success=true`、`errors=[]`；`.tmp-abs-native-defaults-electron.log`。新增 `implicitDefaults` 证明默认实块、可见 shadow、两次身份重放与完整 ABI/实际 Generator；此前临时替换、未知模型拒绝、普通渲染加载、保护及 shadow 重生继续通过，游离块为 0。
- Electron 范围仍是隔离候选和独立渲染工作区诊断，不是 Agent apply、LLM 或固件编译。完整保存/资源/编辑链另由 coordinator 专项覆盖，后者使用真实 Blockly/候选 Generator，但存储和活动代码准备为测试桩。
- 宿主工作区及 ABI/ABS/map 字节、存在状态均未改变。原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。本批未修改库、Agent、登录配置或用户工程，未 commit/push，未清理用户既有脏文件。

### 14.3 剩余边界及下一步

- 当前接纳的是实际同步实例化并可捕获合同的默认树。任意 serializer 凭空添加的 dormant 状态、跨 owner 借用、没有实际实例证据的嵌套隐藏树仍拒绝，不能因为“类型看起来正确”就保存。
- 如果默认 payload 依赖临时 owner ID，二次重放会拒绝；这比重写未知字段中可能存在的引用可靠。未知模型生产效果仍需明确模型意图，不能依据字段名称猜模型结构。
- 下一阶段继续 N3 的未观察 dormant 状态/模型边界与媒体只读资源、受跟踪任务；在开放异步来源前必须有资源与完成归属证明。然后进入 N4 真实 Agent 自主创建变形 → 保存重开 → LLM → 固件编译，不能用候选 Generator 成功替代全链路验收。

## 15. 2026-09-16 N3-b：原生隐藏 shadow 的生命周期证据

### 15.1 原因与通用实现

隐藏状态不等于没有原生实例。核对当前安装的 Blockly 源码发现：输入已有实块时，`setShadowState` / `setShadowDom` 仍会临时创建 shadow、序列化，再销毁实例并缓存状态。第 14 节只捕获活子树和显式覆盖时的 shadow，漏掉了这段已经发生的原生生命周期；因此最终保存图比活实例图大时被拒绝。

本次按“实际发生过什么”补证据，而非按块类型解释缓存：

1. **独立证据模块。** `blockly-native-shadows` 只在现有同步 owner 操作期间包装新实例的 `dispose`，销毁前采集整树状态与原实例合同，并在调用原方法前恢复 descriptor。祖先销毁期间抑制重复子树采集；最终候选清理不成为采纳证据。不执行额外 init、私有 shape 方法或创建 probe workspace。
2. **缓存必须有原生事实。** 最终保存图逐边核对实际 input/next 连接；隐藏状态必须与原连接缓存、已销毁实例的完整快照及创建 owner 精确一致。嵌套隐藏树递归复用已采集证据，重复身份、借用其他 owner 的缓存、伪造 serializer 节点及事后修改缓存均拒绝。原 ABI 不支持的拓扑（如 `next.shadow`）不会因此自动得到新 schema。
3. **观察不是副作用授权。** 采集 serializer / contract 时暂停创建归属，getter 创建的块不能变成合法默认值；未知模型仍由完整读回拒绝。证据必须来自已销毁的实例，而非与活块同 ID 的另一个缓存。库覆盖观察方法或无法提供稳定读回时拒绝，不猜测恢复。
4. **身份属于块，不属于一次构造。** 原生 shadow 可销毁后按保存 ID 重建，创建日志允许不同构造事件复用已退役 ID；构造前仍拒绝与当前活块 ID 冲突。两次候选继续按 owner/序号/类型/ID 重放并比较完整输出，不新增持久化定位参数。
5. **最终连接状态优先。** 后续字段配置可能在显式子块已经连接后更新 fallback；绑定器读取最终真实缓存，替换较早捕获的旧 fallback。新 owner 才采纳默认数据，已有 owner 仍以原 ABI 为事实，显式 null 不授权删除 shadow。
6. **复用现有保存链。** 活实例、即将销毁及隐藏实例共用 `captureNativeBlock`、ABI 索引和同一快照结构，删除候选中的重复图遍历。隐藏文本/数组走既有 Project Data 外置、materialize、完整 ABI/实际 Generator、租约/CAS/apply/回滚；ABS 不承载隐藏数据正文，也没有新增 ABS/map 元数据或库侧适配。

### 15.2 验收记录

新增回归覆盖嵌套隐藏树、两次身份重放、JSON/XML shadow 原生入口、销毁后同 ID 重建、后续字段更新 fallback，以及跨 owner 借缓存、缓存被篡改、凭空生成缓存、活 ID 冲突、销毁产生未知模型和 serializer getter 创建块等拒绝用例。

渲染协调器同时覆盖整批/分片：validate 不改宿主或文件 → apply → 显式数值二次编辑 → 保存 → 大值 materialize 后普通重开 → 断开实块恢复两层 shadow。隐藏 extraState 的 40,000 字符和 12,000 项数组外置后保持完整，子树 ID 与原保护保持，ABS 无隐藏正文。首轮两处重开测试失败是夹具直接向同步加载器传入未解析资源；已补齐正常打开使用的 materialize 阶段，未修改生产加载约束或放宽读回。

- ABS 全量专项 **711/711**，76.615 s：`.tmp-abs-native-shadows-final-tests.log`；项目加载 **9/9**：`.tmp-abs-native-shadows-load.log`。
- 独立候选入口类型检查通过：`.tmp-abs-native-shadows-final-types.log`；构建脚本 **8/8**：`.tmp-abs-native-shadows-node.log`；development 构建通过，26.446 s：`.tmp-abs-native-shadows-build.log`。
- 架构检查仍报告 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-shadows-architecture.log`；不是全仓架构检查通过。
- 协调器保存/编辑回归使用真实 Blockly 和候选 Generator，存储/资源端口及活动代码准备仍是测试桩；不能替代真实 Agent 或固件编译。
- 真实 Electron：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-cy1LAb/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-shadows-electron.log`。`implicitDefaults` 六项全部为 true：实默认块、可见/隐藏 shadow、身份重放、完整 ABI/实际 Generator 验证、伪造缓存拒绝。既有普通渲染加载继续无游离块，`orphanBlocks=0`。
- Electron 范围为 `isolated-diagnostic-not-abs-apply`，不是 Agent apply、LLM 或固件编译。宿主工作区、ABI/ABS/map 字节及原存在状态未改变；原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。
- 本批未修改库、Agent、登录配置或用户工程，未 commit/push；用户既有工作区变更保留。

### 15.3 完成边界与下一步

本批收敛了同步原生生命周期可证明的隐藏默认树，不声称任意 serializer、模型或动态库均已支持。完全未实例化的缓存、未知模型生产效果、渲染后/onchange/异步生成、媒体专用引用及不可归属任务仍明确拒绝；候选隔离也不是恶意脚本或 CPU 抢占沙箱。

下一批优先推进 **N4 已支持同步子集的真实 Agent 新建/变形 → 保存重开 → 固件编译**，不要等待所有未知机制都适配后才开始端到端验收。使用完整项目 runtime 来源及原 Agent 工具链；如果入口仍阻塞，应记录实际机制和最小复现，再按 N3 补齐通用边界，不新增按库许可。通过一个固件用例只证明该场景闭环，不等于 N3 全部能力完成。

## 16. 2026-09-16 N4 真实入口收敛：注册任务、能力提示与正式编译

### 16.1 真实复现暴露的两处缺口

从空白板卡工程通过实际 Agent read/write、block_info、abs_export/validate/apply/save 创建 DHT 和 MAX31865，首轮在 abs_validate 被 `Native candidate does not support setTimeout` 拒绝，工程未提交。结果保留于 `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-fNPaLJ/result.json`，日志 `.tmp-abs-native-creation-electron.log`。

完整已安装脚本包含 core-serial 的延迟配置初始化及 Seeed GFX 的延迟工作区监听器注册；没有使用对应块也会在注册阶段触发。这说明“只选目标库脚本的候选诊断通过”不能推出“完整工程可重放”。同时，能力查询仍报告 preserve-only，Agent 规则禁止新建，导致已接入的原生准备链没有正确的发现入口。

不删除或改写这些库，也不筛掉未使用脚本。问题分别在运行时任务生命周期与能力提示语义，应分开修复。

### 16.2 实现及不变项

- `NativeRegistrationTasks` 独立管理注册阶段的一次性任务：使用真实原生 timer，追踪待运行及正在运行的回调，支持取消与嵌套任务；待处理和运行中任务都归零后才完成。不用固定等待、立即同步执行回调或虚拟时钟替代原语义。
- 每候选最多 128 次调度、单次延时不超过 2 s、累计请求延时不超过 5 s；保留原 10 s 候选整体边界。超限、回调异常（包括抛出 falsy 值）或异步返回会粘性失败并取消剩余句柄。清除正在运行的 timer 不能提前宣布完成；异常/成功/宿主取消均随候选销毁清理。
- 注册完成后再检查额外工作区块/模型并封闭注册，后续 init/extraState/字段/Generator 的 timer 仍拒绝。interval、microtask、Promise continuation、I/O、项目服务、未知模型/serializer 并未开放；原生包自身等待任务不授予库 async 函数权限。错误增加执行阶段/源码标签，便于区分注册、绑定、完整 ABI 及清理阶段。
- 能力发现增加 `validate/native-sync-v1`，含义只是“可提交新建/变形调用，由 abs_validate 执行原生验证”。仅在当前完整 runtime 可捕获且通过现有请求策略时提供；不创建探针块、不运行库回调、不颁发 shape/model/build 证明。不可重放时仍 preserve-only，未注册仍 unavailable，既有静态合同不变。
- Agent 同步解析该提示并说明：使用同一位置 ABS，动态参数遵循原定义/原生构造顺序；无声明合同的已知类型模型须显式 createVariables，不能猜模型或绕过 ABI/map。拒绝伪造合同、shape、过程或声明信息。没有第二 ABS 模式、持久化 schema 或提交入口。

### 16.3 已取得的真实证据

- ABS 全量 **723/723**，83.935 s：`.tmp-abs-native-landing-tests2.log`；项目加载 **9/9**：`.tmp-abs-native-landing-load.log`；独立候选类型检查通过：`.tmp-abs-native-landing-types.log`；development 构建通过，26.062 s：`.tmp-abs-native-landing-build.log`。
- 构建/LLM 证据脚本 **11/11**：`.tmp-abs-native-landing-node.log`；Agent 能力协议 **15/15**：`aily-lex-pro/packages/aily-agent/.tmp-abs-native-creation-tests.log`；Agent JS/声明及 Chat portable 构建、npm 安装后启动验证通过：`aily-lex-pro/packages/aily-chat/.tmp-abs-native-landing-portable2.log`。
- 首次同时打包与全量测试出现 2 项超时；停止并行重负载后原断言和超时边界不变，串行全量通过。首次 portable 打包失败是测试 PATH 缺少 npm.cmd，使用项目既有 Node 22/npm 命令重新构建通过，未修改产品依赖。架构检查仍为 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-landing-architecture.log`，不是全仓架构检查通过。
- 修复后实际 Agent 工具通过：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-hmsxf2/result.json`，`success=true`、`errors=[]`，73,477 ms；日志 `.tmp-abs-native-creation-electron2.log`。
- 空白工程只含 3 个原生受保护入口；未手工创建动态实例。Agent 新建 DHT22/软件 SPI MAX31865，再切 DHT20/硬件 SPI，最后切回；三轮分别 validate、apply、save，覆盖整批/分片。两类块身份、保护、三文件及实际 C++ 在普通重开后保持。使用当前完整 runtime 日志，不筛库脚本。
- 这组证据仍是程序驱动的真实 Agent 工具，不是 LLM 自主会话或固件编译。后两项由独立 `project-data-llm-native-smoke.cjs` 通过实际聊天输入框验证：自然语言新建硬件 SPI → 自然语言改软件 SPI → 两次正式 project_build → 保存重开，并核对外置大文本、模型与块 ID、生成源码哈希及新 ELF。

### 16.4 未扩大的范围

本批任务队列只解释有限注册时序，不承担渲染/onchange/持续任务、配置/生成阶段异步、媒体服务或任意模型生产效果。完整 Agent 场景通过也不提升所有库为可创建；每次实际候选仍必须经原身份重放、资源、完整 ABI/Generator、宿主读回、租约/CAS 与回滚。保留尚承担覆盖的静态快速路径，不删除为清理而删除的生产能力。

### 16.5 正式编译暴露的派生缓存失配

首轮真实 LLM 已自主完成新建、原生 validate/apply/save，磁盘 ABI 保存了 MAX31865 及显式类型模型，78,400 字节大文本仍外置。但正式编译报 `SPI.h: No such file or directory`，一次 clear_cache 重试也失败；证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-5foiIz/result.json`、`.tmp-abs-native-landing-llm.log`。验收没有因此计为成功或进入第二轮。

根因不在 ABS 参数或库：背景预处理时工作区尚空，结果只含 core/variant 两个依赖；正式编译仅凭 `.temp/preprocess.json` 存在就复用。它随后写入含 SPI/MAX31865 的新代码，却把旧依赖表传给 Builder。新代码与旧依赖结果不是同一份构建输入，存在文件不能作为复用依据。

修复位于 `child/scripts/compile-preprocess.js`，被唯一正式 `compile.js` 入口调用：冻结本次配置到独立临时文件，重新运行既有预处理 CLI，且必须得到本次成功结果才编译。只替换派生的依赖结果，不清对象/库归档缓存，不改库或 SDK；失败、退出信号、缺少结果或 success=false 均拒绝继续，并清理配置快照。删除原先给旧缓存补 BUILD_PATH 的补丁函数，避免继续修饰过期事实。后台预处理仍供提前诊断/准备资源，不能代替正式构建输入证明。

子进程参数不经 shell 拼接，使用当前 Node、隐藏窗口，错误沿原构建流程报告。脚本回归 **8/8**：`.tmp-abs-native-build-preprocess-tests.log`，覆盖冻结输入、旧结果替换、对象缓存保留、启动/进程/信号/结果失败及临时快照清理。代价是每次正式构建重新做依赖分析，库物化与实际编译缓存仍保留；不引入另一套不完整的缓存指纹。后续若优化，只能根据完整输入证明复用。

### 16.6 真实 LLM 两轮闭环通过

最终证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-lzK4Ou/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-landing-llm2.log`。真实 Electron 主页面加载当前本地 lex-pro portable，由主程序恢复隔离副本中的登录；模型配置为 `aily-services/auto`。通过聊天输入框发送自然语言，没有预写 ABS 或注入工具调用。

1. 空白板卡仅预置三个受保护入口和一个大文本哨兵。LLM 查询规则、宿主能力与只读库实现，显式创建 `native_rtd: Adafruit_MAX31865`，新建硬件 SPI 初始化（CS=D1、2 线制），执行 validate/apply/save/project_build。
2. 同一会话第二轮将**同一个块和模型**改成软件 SPI（SCK=D2、MOSI=D3、MISO=D4），保留 CS 和线制，再次 validate/apply/save/project_build。第二轮没有再次创建模型或重复块。
3. 两轮正式编译分别耗时 60.55 s、39.52 s；完整自主会话轮次分别 378,127 ms、161,854 ms。两次 `lastBuildStatus=success`，本轮生成源码 SHA256 均与构建记录一致，新链接 ELF 分别 6,462,768 和 6,462,772 字节，源码/ELF 哈希均随结构变更而变化。不是仅生成 C++、预处理成功或读取旧固件。
4. 78,400 字节中文/emoji 大文本仍经 Project Data 外置，ABI/ABS 不含正文。普通关闭重开后实际文本完整、块/变量 ID 和三个入口保护不变，ABI/ABS/map 三文件字节一致；materialized 内存与磁盘 revision 相同，`changed=false`。重开后 lex 会话仍可读取。
5. 源工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。测试只操作隔离工程/配置副本；登录原文件不变，临时凭据由既有 finally 清理。第二次复用前一次测试已复制的 SDK/工具目录，未链接用户 SDK；编译缓存和产物仍属于本轮工程。库仓库没有本批改动，既有 core-custom 文档修改保留。未 commit/push，未上传硬件。

因此当前 N4 **已支持同步范围的落地用例闭环完成**，不能再将它描述成“只有候选诊断通过”或“新 Agent 尚未部署”。这也不是所有动态库、板卡或硬件运行均已验收。

### 16.7 当时余项与下一步（由第 17 节接替）

- 优先收敛 N3 **媒体专用只读资源**：以现有 Project Data 资源会话和真实拒绝场景为输入，明确快照、完成及释放归属；不增加按库/字段名名单，也不把通用大文本已通过等同于所有媒体字段已通过。
- 未经现有准备器解释的模型生产效果、没有原生实例证据的 serializer 状态，以及配置/生成阶段异步仍明确拒绝。各自需要真实最小复现、所有权和完整读回证据后再开放，不以固定等待或删除校验解决。
- 已有静态快速路径仍承担生产覆盖；只在原生路径有等价正反例时合并删除，不为减少文件而移除能力。正式编译的新边界已覆盖 ESP32 真实场景与脚本回归；其他板卡和 Coder 仍需各自集成回归，缓存提速不得恢复“结果文件存在即有效”。
- 保留本轮两套独立验收：程序驱动真实 Agent 用于稳定复现，聊天输入框 LLM 用于真实自主闭环。后续调整准入、资源或保存链时复跑，不把一类成功替代另一类。

## 17. 媒体只读资源补齐与主线收口

### 17.1 缺口与统一实现

第 16 节的外置大文本通过，不能证明媒体专用引用通过。实际代码中有两种不同语义：通用 `$ailyProjectDataValue` 必须在字段加载前还原原值；媒体 `$ailyData` 是字段持久化状态的一部分，必须原样保留，原 Generator 通过主程序既有投影读取解码后的字节。此前候选只准备前者，完整 ABI 甚至统一拒绝后者；媒体投影注册/Generator 包装也未重放。

本批没有新建媒体格式、库名单或提交接口：

1. `project-data-references` 提取 Store 原有资源发现，供存储/GC、宿主快照和候选共用，支持对象、数组及既有 JSON 字符串引用，冲突元数据仍拒绝。字段单引用选择器也由宿主/候选共用，JSON 字符串中的对象或数组语义一致。移除 Store 的重复遍历和 Runtime 的字段选择实现。
2. `captureAbsNativeValues` 按现有会话解析全部引用，只传资源描述和已解析值。首次绑定、身份重放及最终 ABI 各自核对当前租约/上下文；最终快照覆盖合并保留的资源，包括 ABS 不直接表达的隐藏状态。
3. `nativeCandidateValues` 保存候选私有快照，每次读取返回副本，校验资源身份/元数据。字段仍收到原媒体引用，通用 envelope 仍使用原 materialize 算法；完整保存图所有引用必须有准备结果。只读 facade 不暴露 put、resolve、Store、路径或宿主对象；读取错误被库捕获也使候选失败，结束仍随一次性 Realm 释放。
4. 从现有 Project Data adapter 分离“登记已经装饰的定义”，主程序与候选共用。来源日志带实际 libraryName，复用原投影差异，不重写已注册 JSON、翻译或原实参顺序。Generator 包装支持注入只读 reader，算法仍只有一份；不新增某个动态块的源码模板或许可。
5. 主程序内置媒体字段修正 headless 生命周期：位图上传订阅在 initView 建立，不再构造时延迟执行；位图/LED 的预览读取以真实视图存在为前提；动画销毁没有编辑器输入时不产生空异步提交。TFT/U8G2 可选来源信息不输出 undefined JSON 成员。这是实际字段的 UI/数据职责修正，不是候选按字段名绕过任务检查。
6. 最终 ABI 验证检查字段的 `prepareForCodeGeneration` 协议。需要异步派生缓存的字段尚无候选准备证据时明确拒绝，不以“已有原始字节”冒充“解码和派生头文件已就绪”，避免旧 Generator 生成占位图后被误判为成功。配置/Generator 异步和任意模型副作用未开放。
7. 真实 Electron 首轮暴露候选将对象插入顺序误当作字段值：正式 ABS 导出对键排序，原生字段重建属性顺序不同，`JSON.stringify` 字节比较误报 `CUSTOM_BITMAP` 未保持。字段加载、后续配置、最终字段及 extraState 的四处比较统一复用 `absJson`；只忽略对象键顺序，数组顺序、值/类型、缺失成员及无效 JSON 仍受校验。没有按媒体字段放宽读回。

### 17.2 验收清单与最终证据

- 候选使用主程序真实 U8G2 位图/动画、TFT 图片/动画、LED 矩阵字段：ABS 创建保留媒体 envelope，完整 ABI 调用既有 Generator 投影，逐字节验证解包矩阵/Base64。
- 反例覆盖资源缺失、元数据变化、重复快照、错误二进制长度、读取副本被修改、捕获读取异常和未准备的异步派生缓存；失败候选不留 iframe。
- 媒体测试先使用与正式导出一致的 canonical JSON，再由真实字段还原属性；额外覆盖嵌套 extraState 键顺序等价与数组反序必须失败，避免仅测试内存原始属性顺序。
- 协调器覆盖整批与分片：新建媒体/动态节点 → 二次编辑 → 保存 → 普通重开；ID、保护、引用与字节保持，资源缺失时磁盘和宿主均不变。
- 真实 Electron 使用已安装库及实际 Agent 工具，增加由正常位图字段写入的资源哨兵；三轮动态新建/变形均保留资源，保存重开核对像素与 C++。不是仅自定义测试字段或注入 Generator 替身。

最终运行结果：

- ABS 全量 **737/737**，160.791 s：`.tmp-abs-native-media-tests5.log`；项目加载 **9/9**：`.tmp-abs-native-media-load-final.log`；构建/预处理/LLM 证据脚本 **13/13**：`.tmp-abs-native-media-node-final.log`。独立候选类型检查通过：`.tmp-abs-native-media-types-final.log`；development 构建通过，30.521 s：`.tmp-abs-native-media-build-final.log`。
- 真实 Electron + 当前 lex-pro Agent 最终证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-vTxfyS/result.json`，`success=true`、`errors=[]`；日志 `.tmp-abs-native-media-electron3.log`。Agent 三轮耗时 161,847 ms，6 个节点身份稳定，3 个受保护入口保持；实际库 DHT/MAX31865 新建及两次变形全部 validate/apply/save 成功。
- 由正常 U8G2 位图字段写入的 **128×64、8192 像素**资源保持外置，1024 字节 XBM 引用不变。正式 Generator 输出逐字节等于预期位图，不接受占位图；普通关闭重开后媒体值/像素、工作区、模型/块 ID、生成代码和 ABI/ABS/map 三文件均一致。此用例验证实际 C++ 输出，不冒充本轮又做了固件编译；LLM 两轮编译仍为第 16.6 节的独立证据。
- 首轮真实验收 `aily-project-data-ui-3RuUk0` 暴露产品对象键顺序误判，已由第 17.1(7) 项修复并增加回归。第二轮 `aily-project-data-ui-sVBOnx` 的三轮工具调用已通过，但脚本自身也用字符串比较资源对象而误报；改用 Node 深值断言后重新完成全流程，未删像素/C++/重开断言。只有第三轮完整结果计为通过。
- 早期回归修正了分片测试必须使用 WorkspaceSvg、缺资源反例必须真正进入原生路径的夹具问题。多阶段协调器套件的测试时限改为 20 秒并在退出时恢复，候选产品时限没有改变；单独协调器 **103/103** 和两次串行全量通过。另一次浏览器 30 秒无活动退出不计为通过，未据此放宽产品限制。
- 架构检查仍有 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-native-media-architecture-final.log`，不是全仓无违规。源工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；本批未修改库仓库、源工程、登录配置或 lex 实现，未 commit/push。

### 17.3 当时收口口径与扩展边界（由第 18 节接替）

当前主线交付的是一套 ABS/map/ABI 语义和唯一无损提交链，不是承诺任意 JavaScript 程序均可自动安全重放。以下边界在产品中明确拒绝，不能留成“继续猜测更多库”的无限任务：未经准备器解释的模型/serializer 效果、没有原生实例证据的隐藏状态、配置/Generator 阶段异步、持久在线任务、文件/I/O 及需要异步解码的派生媒体缓存。

这些能力尚未实现；若要开放，必须单独给出真实需求、资源/身份归属、完成条件与失败回滚证据。本轮只收口已经验证的同步主线，不将明确拒绝描述成全能力完成。静态快速路径仍保留，待有等价正反例和实际收益时再合并删除。其他板卡、Coder 集成回归及硬件运行与本轮范围分开报告。

当时维护入口为本节和第 16.6 节的真实证据，现由第 18 节接替；历史批次的“下一步”保留为档案，后续不再按库追加合同批次，也不再新增 ABS 模式或把布局/身份写回正文。

## 18. 受控派生资源准备与运行时缓存归属

### 18.1 本批需求与设计

第 17 节尚未开放的派生缓存有真实最小复现：内置图片预览字段把解码结果写在主窗口 `tftImageCache`，旧 Generator 在项目 iframe 查找同名全局，无法共享正确结果；候选则统一拒绝该准备钩子。即使只开放 Promise，也不能解决缓存归属和同名图片冲突。

本批只承接主程序已拥有的准备实现，不运行库任意异步：

1. 准备注册表记录随主程序打包的字段原型和原始钩子函数身份，不按库/块名放行，不暴露给重放脚本。候选只给准备器资源快照 reader；准备前后完整 ABI 读回。未知、替换以及被 `null`/`undefined` 遮蔽的必需钩子均拒绝，不能通过移除钩子绕过准备。
2. 提取原图片解码、缩放、RGB565 预处理为共享模块。仅处理内存 data URI，完成条件为浏览器解码事件；超时/错误/不完整输出拒绝，处理尺寸与现有算法一致，不使用固定等待。
3. 派生缓存归属实际 Field 的 WeakMap，发布前验证资源与存活 owner，dispose 显式释放；删除窗口级文件名别名缓存。旧 Generator 只通过当前 workspace 的资源 ID 视图读取，过期 runtime 不可读取；同名文件不互相覆盖。
4. 活动 runtime 和一次性候选均安装相同旧库接口桥接。候选只允许 data 图片来源，网络/文件、库 Promise continuation、配置/生成阶段计时器及未知模型效果边界不变。
5. 新回归覆盖真实解码、同名资源/工作区隔离、损坏字节、失效 owner、钩子替换/移除及解码超时；候选完整读回和取消/iframe 回收沿用原全量反例。真实 Electron 再验证动态编辑与重开，以及正方形预计算/非正方形实时缩放的 Generator 输出，不将成功生成占位图计为通过。

ABS、map、ABI 与 Project Data 持久化 schema 不变化，库仓库和用户源工程只读。

### 18.2 验收与复现

真实页面在第 17 节的三轮 Agent 新建/变形测试上增加 `AILY_ABS_DERIVED_LIBRARY=D:/codes/aily-blockly-libraries/adafruit_GFX`，使用未修改的真实库。两张正常字段写入的 PNG 使用相同显示文件名，分别生成 8×8 红色、8×16 蓝色像素；同时保留原 U8G2 位图哨兵。每次检查外置引用和逐像素 C++，保存重开后核对工作区及 ABI/ABS/map 字节，不只断言页面没有报错。

最终证据（2026-09-17）：

- ABS 全量 **747/747**，161.524 s：`.tmp-abs-derived-tests-final.log`；项目加载 **9/9**：`.tmp-abs-derived-load-final.log`；构建/预处理/LLM 证据脚本 **13/13**：`.tmp-abs-derived-node-final.log`。独立候选类型检查通过：`.tmp-abs-derived-types-final.log`；development 构建通过，37.978 s：`.tmp-abs-derived-build-final.log`。最终原型/钩子防移除校验加入后已重跑以上检查。
- 真实 Electron + 当前 lex-pro Agent：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-fR68xm/result.json`，`success=true`、`errors=[]`，三轮工具调用耗时 190,521 ms；日志 `.tmp-abs-derived-electron.log`。8 个节点身份稳定，3 个不可删除入口保持，动态 DHT/MAX31865 新建及两次变形均 validate/apply/save 成功。
- 两张同名 PNG 的引用和原文件名保持，实际生成 C++ 中分别为 **64 个 `0xF800`**、**128 个 `0x001F`**。后者直接调用真实库的非正方形缩放，验证跨 Realm 图像对象可用。原 **8192 像素 / 1024 字节 XBM** 逐字节保持。普通关闭重开后工作区、全部 ID、字段/资源、生成代码和 ABI/ABS/map 三文件均一致。第 19 节复核修正证据描述：该夹具输出内联 C++ 数组，没有额外 artifacts，也没有项目 `src`；原“生成 artifacts 已落盘”的表述不成立，不能以空集合检查作为 `.h` 文件验收。
- 真实页面截图 `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-fR68xm/project-data-page.png` 已查看：项目正常加载，两张图片预览可见。本轮不是 LLM 自主会话或再次固件编译，相关独立证据仍引用第 16.6 节。
- 首轮专项夹具遗漏图片 `byteLength`，无损校验正确拒绝；补齐实际规范状态后验证通过。另一反例最初使用 async 函数，先被既有源码门禁拒绝；改用同步替换以真正命中准备器身份检查。复核另补必需钩子被 `null` 遮蔽的反例，未降低任何旧门禁或完整读回要求。
- 架构检查仍报告 user-center 的 4 项既有跨层引用、0 循环：`.tmp-abs-derived-architecture-final.log`，不宣称全仓无违规。源工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库仓库、源工程、登录配置和 lex 实现未修改；未 commit/push。

### 18.3 当前收口与扩展规则

本节保留可信派生准备的验收，当前维护入口见第 19 节；第 16.6 节保留真实自主 LLM 与两次正式固件编译证据，第 17 节保留同步媒体验收。历史章节的“下一步”不再累计为当前待办，也不通过恢复另一套 ABS 或按库追加结构模板推进。

本批关闭原图片预览派生缓存的实际落地缺口；可复用边界是“主程序拥有的准备器 + 原生结构 + 完整读回 + 唯一提交”。新内置字段需要异步派生时，在自己的模块登记原始原型/钩子和只读准备器、提供正反例即可，不修改动态块转换器或库包。缓存没有写入 ABS/ABI/map，不增加持久化一致性负担。

仍不宣称已实现的范围：未经准备的模型生产/serializer 所有权、任意库异步与 I/O、未登记的派生算法。它们明确拒绝，不得通过吞错、固定等待、放松读回或写回内联大数据解除。其他板卡、Coder 集成及硬件运行属于另外的验收范围，不由本批 C++ 像素检查代替。已有静态快速路径没有等价迁移收益和证据时保留；不为删文件损失旧兜底。

## 19. 2026-09-17 主线收敛与稳定化

### 19.1 决策与事实依据

目标是基于确定的结构和资源完成无损转换，而不是执行任意异步 JavaScript。动态块可以同步依据配置恢复结构，不等于异步块。必要的资源准备继续等待明确结果；任意任务的“没有新消息”不能证明结构已稳定。

前一轮有限异步生命周期实验撤回，不作为交付能力或待落地前置项。它增加了源码改写、Promise/microtask 跟踪和多阶段稳定性快照，但仍拒绝异步结构变化；实验完整回归为 763 成功、2 失败（`.tmp-abs-async-tests.log`），两项分别暴露异步脚本的能力建议扩大和配置定时器准入扩大，不能通过改掉既有负例来宣称稳定。

当前库标准 `generator.js` 的 AST 扫描未发现原生 async 函数声明，并不意味着没有异步。实际 `seeed_wio_sd` 是同步创建兼容输入，Promise 仅负责稍后隐藏；其他库的 `projectService.addMacro/removeMacro` 是外部持久化副作用，需要明确事务，不能由通用等待机制代替。这些证据不足以支持本轮扩大执行器。

### 19.2 唯一现行边界

| 能力 | 本轮取舍 |
| --- | --- |
| ABS 参数与变量、map 身份/布局/保护、动态结构恢复 | 保持第 1 节及已验证的同步路径，不改 schema，不增加语法 |
| Project Data 外置值、图片解码与派生缓存 | 保留第 17、18 节的只读快照和主程序私有准备器；身份/失效/完整读回校验不降低 |
| 有限注册定时器 | 保留第 16 节的必要能力，只允许同步一次性回调及嵌套注册；128 次、单次 2000 ms、累计 5000 ms，排空后封闭；返回 Promise、超额或被捕获的不支持效果仍失败 |
| 库 async/await、Promise continuation、microtask、配置/生成阶段定时器 | 恢复既有拒绝边界；不做源码改写、不运行通用异步阶段、不执行未知字段准备钩子 |
| I/O、编译宏持久化、未知模型/serializer 效果 | 不开放，不吞错，不绕过唯一提交链 |

注册计时器与可信字段准备是不同职责的两个小模块，不合并成全能调度器。源码策略只校验、不转换；候选失败后销毁整个 Realm，异常保持粘性。活动项目运行时的正常资源生命周期不因此取消或扩大。

已删除实验源码改写、通用任务调度、异步阶段结构快照及专用 Electron 夹具；恢复有限注册队列和同步配置/完整 ABI 验证，移除未知准备钩子的后备执行接口。保留实际图片和动态块 Electron 验收脚本，补充不改写源码、未调用 async 也拒绝、回调返回 Promise、取消、数量/延时预算等边界测试。

### 19.3 本轮验收

本轮收敛范围验收完成，没有开放任意异步库，也没有改变 ABS/map/ABI 规则。

| 检查 | 结果与证据 |
| --- | --- |
| 最终 ABS 专项 | **760/760**，161.029 s；`.tmp-abs-stable-tests-final2.log` |
| 候选及媒体边界独立复测 | **52/52**；`.tmp-abs-stable-boundaries.log` |
| 普通项目与示例加载 | **9/9**；`.tmp-abs-stable-load.log` |
| 独立打包、编译预处理及 LLM 证据脚本 | **13/13**；`.tmp-abs-stable-node.log` |
| 候选类型检查 / development 构建 | 通过；`.tmp-abs-stable-types.log` / `.tmp-abs-stable-build.log`（31.485 s） |
| 真实 Electron + 当前 lex-pro 工具 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-XUQccU/result.json`：success=true、errors=[]；`.tmp-abs-stable-electron.log` |

真实页面沿用只读源工程，在独立副本添加未修改的 `adafruit_DHT`、`adafruit-max31865`、`u8g2`、`adafruit_GFX` 库。实际 Agent 工具完成三轮新建/变形，184,223 ms；8 个节点身份稳定、3 个不可删除根块保持。XBM 的 8192 像素/1024 字节逐字节保留，两张同名 PNG 分别生成 64 个 `0xF800` 和 128 个 `0x001F`，引用及原始文件名不串用。关闭重开后完整工作区、生成 C++ 和 ABI/ABS/map 字节一致；截图 `project-data-page.png` 已查看，图片预览正常。

证据边界：上述库直接生成内联 C++ 数组，本夹具没有额外 `.h` artifacts，因此不把它当作 `src` 头文件落盘验证。本轮没有再次运行自主 LLM 或固件编译，相关历史证据仍为第 16.6 节，不将工具调用测试冒充自主会话。

首轮 755 项通过后增加 5 项配置/Generator 拒绝测试；一次最终全量在 500 项通过后发生 Chrome 30 s 无消息断连，记录于 `.tmp-abs-stable-tests-final.log`。单独复测和原设置下完整重跑均通过，没有提高超时、屏蔽用例或修改产品门禁来掩盖中断。

架构检查仍为 user-center 的 4 项既有跨层引用、0 循环（`.tmp-abs-stable-architecture.log`），不宣称全仓检查通过。原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库仓库、原工程、登录配置与 lex 实现未修改；未 commit/push。清理模块的残留引用检查与相关 tracked 文件 `git diff --check` 通过。

### 19.4 后续准入（非默认待办）

没有具体失败工程与必要行为证据，不恢复任意库异步目标。新增支持必须先说明完成信号、状态/资源归属和失败原子性，再沿现有 prepare → 同步验证/生成 → 唯一提交链扩展；不按库名打补丁，不增加另一套 ABS、保存通道或隐式等待。不能确定完成时应报错保留原项目，而不是输出缺数据的成功结果。

## 20. 2026-09-17 历史简写与 README 一致性收口

### 20.1 审计与修复

详细逐项证据、库对照及取舍见[ABS 历史简写与库 README 一致性审计](./abs-readme-syntax-closure-audit.md)。历史基线为 `4caee8fd^`，并非只查看当前重构后的文件。

确认 `for` 的简易写法来自通用 args 顺序和唯一语句体，没有专用导出分支。历史特例还包括 if/switch 分支、可变参数数量、函数类型/名字对及字面量/变量简写；旧槽名别名、EXTRA_N 和默认字段猜测不等于可以安全恢复的能力。

本批关闭四个实际不一致：

1. if/switch、join/list 等 README 不写 `@extra` 时，额外槽位未被创建。新增纯语法准备模块，消费现有主程序 mutator 注册配方；与结构准备共享序列化规则，不匹配库名/块名，显式状态优先，拒绝跳号和超预算。
2. 子串动态输入曾按视觉锚点插入 ABS 参数中间，导致 WHERE2 位置偏移。统一为原 argsN 声明前缀＋原生动态尾部，保留原字段/value 混排和锚点来源验证，删除视觉插入式位置合并。
3. typed-function 适配只接受 `@extra.params`，与 core-functions README 位置类型/名字对不一致。新增已有函数协议的纯语法模块，支持前向调用、签名推导和修改；函数及参数模型仍由既有显式意图准备。混合原生链只传递宿主准备的源码状态，不在发现阶段创建模型块。
4. README 的裸数字引脚与下拉持久化字符串键冲突。仅允许精确源码字面量匹配现有枚举键，不做数值近似、显示标签或非法引脚猜测。

ABS schema、变量引用及裸 `$name` 值槽展开不变；位置/身份/保护仍在 map/ABI，大值仍在 Project Data。未知函数协议、opaque 状态和异步边界没有放宽。core-custom 的文本 PARAMS/ARGS 与 core-functions 动态参数是两个不同协议，不混同处理。

### 20.2 自动化回归

| 检查 | 结果与证据 |
| --- | --- |
| 最终 ABS 全量 | **779/779**，162.016 s；`.tmp-abs-readme-final-tests.log` |
| 首轮结构/顺序专项 | **52/52**；`.tmp-abs-readme-focused.log` |
| 函数及混合宿主专项 | **14/14**；`.tmp-abs-readme-functions.log`；后续补充反例纳入最终全量 |
| 数字引脚及原生绑定专项 | **51/51**；`.tmp-abs-readme-pins.log` |
| 普通工程与示例加载 | **9/9**；`.tmp-abs-readme-final-load.log` |
| 独立候选打包、编译预处理和 LLM 证据脚本 | **13/13**；`.tmp-abs-readme-final-node.log` |
| 类型检查 / development 构建 | 通过；`.tmp-abs-readme-final-types.log` / `.tmp-abs-readme-final-build.log`（33.419 s） |

新增覆盖原生和纯准备的子串九种组合、0/1/多项简写、显式空槽、非法跳号/重复槽、源声明重排、函数前向引用和参数类型变更、裸数字引脚与非法选项，以及共享/页内根顺序恢复和缺失/重复根 ID 拒绝。全量在本批各阶段分别为 771、775、778、最终 779 通过，没有调整超时或删除负例取得通过。

### 20.3 真实 Electron 与当前 lex-pro

均使用 Node 22、正式 Electron 主程序/完整 preload/实际 Angular 页面、当前 `aily-lex-pro/packages/aily-agent` 的真实工具及隔离工程副本；不是模拟 ABS 写入器。

| 路径 | 结果与证据 |
| --- | --- |
| 分支/可变参数 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-JO41Ce/result.json`：success=true、errors=[]；两轮实际工具，142,210 ms，19 个块、3 个保护入口；无状态简写新建后用显式状态扩展空槽；`.tmp-abs-readme-structural-electron.log` |
| 子串/I2C 条件输入 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-fDuyJK/result.json`：success=true、errors=[]；三轮实际工具，53,942 ms，13 个块、3 个保护入口；`.tmp-abs-readme-conditional-electron.log` |
| 函数 README 签名与模型 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-gnaxXw/result.json`：success=true、errors=[]；三轮实际工具，64,353 ms；回滚、跨页、保存重开均通过；`.tmp-abs-readme-final-functions-electron.log` |

前两条路径验证完整工作区、块身份、生成 C++ 和 ABI/ABS/map 的保存重开一致；子串进一步核对选择器以及两个位置数值，I2C 自定义地址为 32。两张实际页面截图已查看。截图中的后台 SDK 安装提示不是固件编译成功的证据；本轮不宣称重新完成 LLM 自主会话或正式固件编译，历史证据仍见第 16.6 节。

首轮函数工程 `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-bOv7yC/result.json` 保留失败证据：三轮 README 编辑及模型伪造拒绝已通过，随后注入 Generator 新增变量，预期读回拒绝，但回滚在 `/roots` 再次失败。原因是 ABI 分开保存共享函数和页内根块，组合时共享优先，而活动工作区仍可能保留源码“函数在最后”的根顺序。修复复用既有归属模型：提交前对共享定义做稳定分组，保证页切换/重开一致；回滚携带原运行时根顺序，先检查 ID 集合完整性再加载，不弱化完整读回，不调换测试中的函数位置掩盖问题。

最终函数复验保留同一“函数写在最后”的源码夹具：参数从无到 int 再到 float、调用参数 7→9、返回变量 amount，实际生成 `int abs_custom(float amount)`、`abs_custom(9)` 和 `return amount;`。模型 ID 伪造被拒绝；故障注入命中一次，返回 `ABS_READBACK_MISMATCH` 后完整恢复，磁盘镜像不变且无待恢复事务。跨页签名修改返回 `ABS_SHARED_CONTRACT_REQUIRED`；切页返回、保存、关闭重开后工作区及三份文件一致，内存/磁盘标准化 ABI 摘要均为 `39b8e3115d5a4235471a64acc8e6a572fa915170e5c2ef13e2631f58c3840f4c`。实际截图 `procedure-generation-page.png` 已查看。

### 20.4 收口边界

本批 README 一致性及其真实事务回归收口完成；不是新增“任意动态库/异步库全覆盖”的承诺。

库 README 还存在重复 IF0 赋值示例以及根语法文档“字段优先”的过时描述，已记录到审计文档；转换器继续拒绝重复输入，真实 argsN 顺序优先。库仓库保持只读，不靠修改示例掩盖转换错误，也不承诺所有 README 原文均可直接执行。

旧 generation 若保存了错误的子串位置合同，须从既有 ABI 重新导出；既有 stale/CAS 拒绝保持，不将旧草稿偷偷按新位置绑定。第 19 节的任意异步收敛决策继续有效。

架构检查仍为 user-center 的 4 项既有深层引用、0 循环（`.tmp-abs-readme-final-architecture.log`），不将它描述为全仓检查通过。原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`；库、原工程、登录配置及 lex 实现未修改；未 commit/push。

## 21. 2026-09-17 未覆盖动态库随机抽查与语法发现

完整方法、逐库写法、原因及建议见[随机动态库审计](./abs-random-dynamic-library-audit.md)。这次是诊断与测试，不新增产品适配，不修改库来取得通过。

从没有实际导入覆盖记录的结构动态库池中，以预先生成的随机种子 `da1692043c747bd2` 抽取 aily_iic、seeed_mmwave、RTC、simple-keypad、unihiker_k10_speech。每库独立空白工程，使用原始库注册、真实 Electron 页面与当前 lex-pro 工具。最终 16 个场景：9 次导入接受，其中 8 次符合预期动态字段语义；7 次拒绝保持已提交 ABI/map 不变。所有工程的保护入口、完整工作区/C++ 和保存重开一致，页面 `errors=[]`，总验收仍 `success=false`。

| 发现 | 处理结论 |
| --- | --- |
| mmWave 软件/硬件串口三轮增减引脚通过 | 证明新增未特化库可走通通用原生链 |
| RTC 两种动态形状创建和分步编辑通过；同时改两个同类型块被拒绝 | 现有身份消歧边界，分步路径已实测；不能按位置猜 ID |
| simple-keypad 4×4→3×1 导入成功但保留多余字段 | 完整原生库控制实验同样复现，属于库 validator 读取旧值；库保持只读，不在 ABS 中补键盘专用逻辑 |
| K10 INTERVAL 同时为字段和隐藏输入，位置/具名写法均拒绝 | 主程序通用命名空间缺口，优先区分 `(kind, name)`，覆盖旧连接无损往返，不删隐藏数据或改 ABS 顺序 |
| aily_iic 配置阶段 timer 被拒绝 | 已声明的异步边界，不计支持，不为本样本重新开放任意异步 |

`blocks_list` 确实向 LLM 返回签名摘要；`block_info` 返回签名、argsOrder、字段/枚举、输入及写法 guidance。真实 `content` 已保存验证。但 native-sync-v1 的未知变体仍可能仅给静态声明：如 mmwave_init 只列 VAR/SERIAL_TYPE，未列软件串口动态引脚。因此“有 ABS 语法说明”不等于“所有配置的完整语法已暴露”。后续应复用隔离原生候选提供配置后的形状发现，而不是维护库名分支或活动工作区试探。

最终证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-FeRZjo/result.json` 与各工程 `random-library-evidence.json`，日志 `.tmp-abs-random-library-final-electron.log`；控制实验 `.tmp-abs-random-native-diagnostic.log`。抽样顺序与六个脚本语法检查通过。第一轮保留在 `aily-project-data-ui-N7ruk7`：首个用例把 VFS 草稿落盘误当成 ABI/map 原子性失败，已修正测试口径后完整重跑；没有调整产品门禁。

本轮未修改正式转换代码，未重跑前批 779 项全量、未重新构建产品，不新增 LLM 自主会话或固件编译结论。五个库源文件哈希及原工程 ABI 均不变，未修改登录配置及 lex 实现，未 commit/push。当前任务是关闭以上有证据的通用缺口，并清楚公开使用边界，不重启任意动态/异步全覆盖目标。

## 22. 2026-09-17 抽查缺口修复与 I²C 环境一致性定位

执行方案及详细边界见[随机库审计第 7 节](./abs-random-dynamic-library-audit.md#7-修复执行通用命名空间候选语法和中性-ui-任务)。本批修改主程序及 lex 的通用逻辑，库源码、原项目和登录配置不变，不增加库名分支或另一条保存链。

### 22.1 已实现

1. **同名 field/input**：独立身份域贯穿声明合同、原生顺序、绑定、渲染、宿主绑定校验和 lex 元数据。保留声明顺序、原 ABS 语法、旧隐藏连接和 map 身份；两种 input 共用输入域，仍拒绝重复字段/重复连接。拆分顺序歧义与字段序列化缺失错误。
2. **LLM 语法发现**：`block_info/blocks_list` 明确签名完整性；成功 `abs_validate` 在 receipt 外返回实际候选参数/字段约束的有界只读提示。无额外探测工作区，不将提示作为授权，不泄露字段大值或块 ID。
3. **中性延后 UI 效果**：候选局部虚拟 one-shot 队列同步收敛。每步保持持久化状态、空槽、连接检查、字段约束和枚举键，最终保持生成代码及头文件产物；超预算、网络/Promise/异步结构和 Generator 调度继续拒绝。不是任意异步恢复。
4. **诊断说明与保真测试**：RTC 身份歧义保留草稿/map；分步修改仅验证临时绕过路径，不能视为批量编辑问题已修复，后续要求见第 22.4 节。K10 新增已连接旧隐藏输入两轮编辑。无序 `getAllBlocks(false)` 诊断列表按 ID 比较，不改变 ABI 根序/连接顺序、字节镜像或代码的严格对比。

### 22.2 I²C 不是单一异步问题

旧转换器在真实图形工作区创建临时块，库本来就有由页面执行的 timer；`wire_begin` 动态地址输入本身同步创建。新实现先前把配置阶段所有 timer 拒绝，这是第一层差异，本批已改为语义中性验证。

解除后完整原库的 SLAVE 路径暴露第二层差异：默认数字块调用 `initSvg/render` 后才连接，而 headless Block 无此 API，异常被库吞掉，留下无归属连接的 shadow。直接原生控制实验不经过 ABS，并等待 350 ms，结果仍相同。**恢复任意异步、加长等待或删除 shadow 都不解决原生环境差异。**

后续聚焦通用的独立图形候选工作区，提供真正 BlockSvg 生命周期并沿用现有归属/读回/提交链；须单独证明同步渲染、资源与销毁隔离、性能，不伪造空方法、不在活动工作区探测、不按 I²C 名字补连接。本批未实现该扩展，因此不能宣布 aily_iic 从站或任意动态库全覆盖。

### 22.3 验证记录

- ABS 最终全量 **800/800**：`.tmp-abs-audit-fix-tests-complete.log`，180.758 s。lex 构建通过，ABS 全量 **68/68**：`packages/aily-agent/.tmp-abs-audit-fix-all-tests.log`，其中能力/语法发现 **16/16**。
- 首轮 fixture 使用了本仓 Blockly 不提供的新版 dropdown API，已改用本仓真实 API；生成代码负例改为实际 Arduino 输出通道并补头文件产物反例。未删除语义负例、未提高超时。
- 并行浏览器/构建/Electron 造成资源压力时出现候选超时及连锁租约失败，保留 `.tmp-abs-audit-fix-tests-final.log`；最终串行运行通过，不将并行失败掩盖为功能通过。
- 先行真实复测：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-xLySx1/result.json`。K10 五轮导入与字段语义通过；重开诊断仅无序列表顺序不同，已修正测试再复验。I²C 从站拒绝留存，MASTER validate 成功、一次 apply 受并行超时影响，不以此声称 MASTER 已完成真实导入。
- 原生 I²C 控制实验：`.tmp-abs-iic-headless-diagnostic.log`；脚本 `scripts/abs-iic-headless-diagnostic.cjs`，完整库、真实 Blockly，未修改库或补写其图形方法。
- 串行最终验证：工程加载 **9/9**、候选打包/编译预处理/证据脚本 **13/13**、类型检查及 development 构建通过（33.361 s）；分别见 `.tmp-abs-audit-fix-load.log`、`.tmp-abs-audit-fix-node.log`、`.tmp-abs-audit-fix-types-final.log`、`.tmp-abs-audit-fix-build-final.log`。
- 最终真实 Electron + lex 工具复测：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-VqKhLX/result.json`，5 库、18 轮、15 次接受、14 次动态字段语义符合预期、3 次拒绝。5 个项目均保存重开一致、库源文件未变，页面 `errors=[]`，总验收仍为 **success=false / 进程 exit 1**，不能把安全拒绝和分步成功算成批量能力通过。逐库结果见随机审计第 7.5 节。
- 实际工具内容包含 `signatureScope`，15 次成功验证均返回 receipt 之外的 `syntaxAdvice`。I²C MASTER 和 K10 最终页面截图已查看；从站未通过。原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。本批不新增 LLM 自主会话或固件编译成功结论，未 commit/push。

### 22.4 主线纠偏：批量编辑必须由宿主内部完成（尚未实现）

ABS 的核心工作流是一次编辑多处程序、一次整体验证和提交，工具往返次数不能随修改块数线性增长。RTC 的分步测试只证明原生动态形状可执行，不能作为要求 Agent 逐块调用工具的产品方案。

当前缺口在 `abs-reconciler.ts/matchGroup`：同一已确认父级/输入下的重复类型主要按包含全部字段和子树的内容签名匹配；多处同时变更后，剩余多个旧/新节点无法对应就返回 `ABS_IDENTITY_AMBIGUOUS`。这把内容变化与身份延续绑定得过紧，不是 ABS 文法不支持批量，也不是 RTC 库需要专用适配。

后续实施原则：

1. **编辑批次与节点操作分离**：Agent 一次提交多处 ABS 文本变更；宿主内部建立所有节点操作计划，复用现有整体验证、原子提交和保存链。不得要求每个块单独 export/validate/apply。
2. **身份依据保留在 map/宿主**：复用 generation、旧源码和 AST 范围；接入已有编辑入口的批次变更记录，在源摘要校验后跟踪旧/新范围及父级/输入归属。编辑溯源由工具内部捕获，不要求 LLM 编写 block ID、槽名或新增 ABS `@meta`，也不创建另一套程序语法。
3. **区分可证明延续与真实歧义**：未变锚点及有来源的局部修改可在一次批次中对应；插入、删除、移动、复制按明确操作语义处理。整文件替换且多个节点不可区分时，单靠前后文本不能总是恢复历史身份，只针对歧义组报告一次，不盲目按位置或某个库的 VAR 字段猜测。
4. **验收以批量为准**：同类型多节点同时改字段/动态形状、重复调用、插删重排、保护根及 Project Data 引用、失败回滚和保存重开；断言一次批次而非 N 次逐块提交。RTC 双实例同时修改必须成为正例。

本批仅完成定位和执行要求修正，未实现上述编辑溯源/批量匹配；当前工具的分步恢复提示仍是临时限制说明，不能作为收口结论。批量身份修复和图形候选环境一致性都是主线未完成项。

## 23. 2026-09-17 批量编辑溯源接入与图形环境对照

本节接替第 22.4 节的未执行状态。目标是让一次普通文本编辑批量修改多个同类型块，不向 ABS 暴露身份信息，不增加按块的工具往返或库适配。

### 23.1 已实现的通用链路

1. lex 在既有 `edit`（本来就支持多个 `edits[]`）、子 Agent edit 和 Code Mode edit 的成功文件发布处捕获精确替换。使用调用局部上下文，不复制文件工具或新增 LLM 参数；只接受唯一精确匹配且能重放出实际写入内容的记录。
2. 独立 `abs-edit-provenance` 模块保留有界批次链。旧/新源码摘要必须和当前 generation/candidate 一致；同一替换中的未变前后缀只是上下文，不视作已删除字符。未经捕获的整文件 write 不凭 diff 猜来源。
3. 宿主对不可变 baseline 重放所有 UTF-16 编辑，要求得到完全一致的候选；沿未被覆盖的调用名 token 跟踪源码偏移，只在已确认父级/输入归属内复用原 ID。多个字段、子节点及动态配置可在同一批次修改，保护/opaque 数据仍来自原 ABI。
4. 原有内容匹配保留为无溯源时的保守路径。跨归属移动、整篇重写后无法区分的节点仍拒绝；不按位置或某个库的变量字段猜 ID。格式、变量简写、argsN 顺序、map schema、Project Data 和唯一保存链不变。
5. 编辑记录只走内部协议，并由 receipt 校验。LLM 返回中只显示批次/修改数量，不重复回传替换文本；移除默认“逐块修改”的恢复指导，改为一次多处 edit 后整体验证/提交。
6. Agent 的 ABS 工具描述和语法参考明确批量 edit 工作流；同时清理语法参考残留的“按视觉 after 插入参数”说明，统一回实际 argsN 声明前缀与原生动态顺序。这是文档纠偏，不是修改 ABS 文法。

此机制区分**一次编辑批次**与宿主内部的多个节点操作。它不宣称整份任意重写都能恢复历史身份。当前记录为进程内有界缓存（32 文件、128 批次、1024 项、512 KiB），重启/淘汰/模糊匹配/外部写入可能失去附加证据；不会静默绑定新 generation。跨进程编辑记录持久化尚未实现，不隐藏此边界。

### 23.2 I²C 术语澄清与对照证据

“主视图”和“I²C 主/从模式”是两个独立概念。此前的“从站图形环境”容易误解：并不存在要另开一个从站视图的设计。MASTER/SLAVE 都在同一个 Blockly 工作区；差别是 SLAVE 初始化默认地址时实际调用了 BlockSvg API。

新增只读控制脚本 `scripts/abs-iic-svg-diagnostic.cjs`：在独立真实 Chrome 页面中加载同版 Blockly 和完整未修改 I²C 库，创建真正 WorkspaceSvg。设置 SLAVE 后**同步**得到 ADDRESS→math_number(8)、shadow=true、孤立块数 0，没有等待 timer，也没有把 initSvg/render 替换成空函数。日志 `.tmp-abs-iic-svg-control2.log`。与第 22.2 节 headless 控制实验共同证明：问题在原生环境一致性，不是需要任意异步加载。

该脚本是隔离页面的原生对照，**不是生产候选图形支持已经完成**。生产接入仍需把真实渲染调度、资源准备、销毁及生成代码/ABI 不变验证放进已有隔离候选生命周期；不能直接在活动主工作区创建探测块，也不能为了 render 全面放开 Promise/网络/定时器。该部分仍待执行。

### 23.3 验证与收口口径

批量身份专项覆盖同类型双修改、完全相同调用、连续批次、UTF-16 偏移、插入、保护删除、完整替换不猜 ID、陈旧/越界/超预算以及跨父级移动拒绝；生产 wire 验证一次批量只进入一次代码准备/提交，并保存重开一致。真实 RTC 回归改为一次 `edit` 携带两处替换，必须实际接受并保留两个 ID，不能再以分步成功代替。

最终结果：

| 验证 | 结果与证据 |
| --- | --- |
| ABS 全量 | **809/809**，172.962 s；`.tmp-abs-batch-complete.log` |
| lex ABS 全量 / 构建 | **74/74**；`packages/aily-agent/.tmp-abs-batch-tests-release-check.log`；构建及声明生成通过，`.tmp-abs-batch-build-release-check.log` |
| 原生类型检查 / development 构建 | 通过；`.tmp-abs-batch-types.log` / `.tmp-abs-batch-app-build.log`（49.476 s） |
| 真实 Electron + 当前 lex 工具 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-qCdYHR/result.json`：**success=true、errors=[]、exit 0**；RTC 四轮全部接受、字段语义正确、保存重开一致；Agent 166,553 ms |
| 同类型批量关键场景 | 第二轮 **1 次 edit、2 处替换**，validate/import 均成功；model-facing 返回只有 `editTracking:{batches:1,edits:2}`，不含源码编辑载荷 |
| I²C 真实图形原生对照 | 同步完成地址 shadow 连接，0 孤立块；`.tmp-abs-iic-svg-control2.log`；仅对照，不算生产 ABS 支持 |

RTC 四轮中 clock3 始终为 `61fbfb3c-4d8b-4ee9-a79c-e6fca837dfe9`，clock2 始终为 `16fb598c-c33d-49c7-95d7-2c97c9d0ce8e`，不是只比较 ID 集合；ABI、C++、ABS/map 及保护入口保存重开一致，实际 RTC 页面截图已查看。源码仍按原 ABS 写法表达两种 RTC 配置，没有库名分支或 inline ID。

前轮失败保留：新跨归属测试最初把无合同的 value 输入当 statement section，未构成有效 ABS，已修正夹具并完整重跑；初次编译发现新模块与已有 Project Data `abs-source-edits.ts` 同名，已保留原资源替换模块，独立命名为 `abs-edit-provenance.ts`，资源回归全部通过。未放宽产品门禁或删负例。

库源码哈希及原工程 ABI SHA256 均不变，后者仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。未修改登录配置，未 commit/push；本轮是实际 Agent 工具事务测试，不新增自主 LLM 会话或固件编译成功结论。生产 I²C 图形候选与跨进程编辑记录仍未完成。

## 24. 2026-09-17 隔离候选原生图形生命周期接入

本节接替第 23.2 节的生产图形待办。不引入库适配表或新的 ABS 写法；将原生执行需要的环境能力补到候选容器，复用原来的绑定、身份重放、完整 ABI 校验和唯一提交链。

### 24.1 实施边界

1. `blockly-native-graphics` 独立管理图形环境接入。候选使用同版 Blockly 的真实 `inject/WorkspaceSvg/BlockSvg`，有真实 SVG DOM、字段视图、渲染器及连接数据库；不提供空 `initSvg/render`，不改变库源文件。原生候选统一为这一条路径，不保留按库猜测的 headless/图形双轨；无需原生候选的纯声明快速路径不变。这是程序结构验证环境，不是主题、交互编辑器或任意 UI 插件的完整镜像。
2. iframe 仍为一次性 opaque-origin、无 preload/宿主 DOM/文件权限；仅由 `display:none` 改成屏外固定尺寸，保证原生测量可用。成功、失败、取消和超时仍销毁整个 Realm。
3. 显式绑定遵循原生加载次序：先创建并配置字段/模型/连接，再在原归属范围内初始化视图。不能在绑定变量前初始化 `FieldVariable`，否则原生字段会创建无归属默认模型。视图初始化沿用反序列化的 `setConnectionTracking(false)`，暂停交互式邻近推开，不让重叠 scratch 根块在渲染后改变布局；显式连接类型校验不变，回调自行移动块仍拒绝。
4. 原生 animation frame 进入已有 `NativeUiTasks`，与配置 UI timer 共享总任务预算、取消和同步清空机制；每个实际回调前后检查序列化、结构及字段约束。Generator 阶段仍禁止调度；最终 ABI 路径继续比较生成代码与外置头文件。这里不是恢复任意异步结构加载。
5. 主程序媒体字段区分“存在图形视图”与“连接了项目 Store”。无 Store 的只读候选仍创建真实视图，但不自行启动编辑器上传订阅或异步 Store 读取；资源继续使用快照、既有 Generator 投影及可信派生准备。普通编辑器有 Store 时维持原流程。
6. 新增不依赖库名的图形默认子块夹具，检查真实 DOM/测量/路径、原生 shadow 创建与覆盖、最终 ABI 的位置/保护/隐藏 shadow、取消帧、违规帧及 Realm 清理。既有变量/媒体/提交回滚测试必须全部通过，不能删负例换通过。

### 24.2 验收记录

| 验证 | 结果与证据 |
| --- | --- |
| ABS 全量 | **820/820**，149.547 s；`.tmp-abs-svg-all-final.log`，含新增 11 项图形/任务边界测试 |
| 工程加载 / 独立候选打包 | **9/9** / **2/2**；`.tmp-abs-svg-load.log` / `.tmp-abs-svg-bundle.log` |
| 原生类型检查 / development 构建 | 通过；`.tmp-abs-svg-types.log` / `.tmp-abs-svg-build.log`（47.005 s） |
| 真实 Electron + 当前 lex 工具 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-KxMZKe/result.json`：**success=true、errors=[]、exit 0** |
| I²C | **3/3**：SLAVE(8)→MASTER→SLAVE(32)，原生默认 shadow、实际参数和 C++ 均正确，最终代码包含 `Wire.begin(32)`；Agent 143,875 ms |
| RTC 批量回归 | **4/4**；第二轮 **1 次 edit、2 处替换**，两个实例身份分别保留；Agent 82,690 ms |

两个项目的完整工作区、C++、ABI/ABS/map 和保护入口保存重开一致，两个实际页面截图已查看；原库文件哈希与原工程 ABI SHA256 均不变，后者仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。运行日志 `.tmp-abs-svg-electron.log`，分库证据 `random-library-audit.json` 和各工程 `random-library-evidence.json`。本轮没有新增自主 LLM 会话或固件编译结论，也没有修改 lex、库包、原工程或登录配置；未 commit/push。

首轮接入发现并修复：过早初始化变量字段创建多余模型、媒体视图自行启动 Store 读取，以及原生邻近推开改变 scratch 坐标。新增队列错误定位只报告差异路径，不回传资源/字段内容。此前失败日志保留在 `.tmp-abs-svg-candidate.log`、`.tmp-abs-svg-all-first.log`、`.tmp-abs-svg-all-second.log`、`.tmp-abs-svg-coordinator.log`；新增测试最初的夹具括号及默认 shadow 证据位置断言也已修正。`.tmp-abs-svg-all-third.log` 后段受到开发 watcher 重建共享候选资产影响，SHA256 门禁正确拒绝版本不一致；最终冻结生产代码后完整重跑通过，没有放宽版本校验。

全仓架构检查 **未通过**：`.tmp-abs-svg-architecture.log` 报告 `user-center/credit-contract.spec.ts` 和 `credit-display.ts` 的 4 处跨域深层引用，均在本轮未修改文件中；0 环路。本轮不顺带修改这些用户改动，也不将该检查报成通过。

### 24.3 收口与保留边界

生产图形候选和 I²C 环境一致性缺口已收口；不再把它列为“待接入”或要求修改库。ABS 参数顺序、变量简写、外置资源及 map 协议不变。仍不承诺任意 Promise/异步结构或交互插件；simple-keypad 的原库 validator 旧值问题、编辑溯源跨进程持久化等独立事项保持原状态，不混作本次图形候选修复。

## 25. 2026-09-17 范围校正、跨进程编辑证据与架构引用收口

### 25.1 范围外不等于未完成

第 19 节已经撤回通用异步实验。任意 Promise、网络回调或持续任务驱动的结构修改**不在当前收口范围，也不列为后续必做项**。本批不修改候选调度器或新增异步适配。未知库的同步动态结构已通过原生图形候选通用执行；“不承诺任意结构”指无法证明其归属与稳定性的效果，不能误读成仅开放逐库白名单。

当前范围内保留：按原声明顺序的 ABS 参数、变量兜底、原生同步结构/图形生命周期、批量编辑、ABI/map 身份和保护、Project Data、完整读回与唯一提交。simple-keypad 的库 validator 旧值缺陷属于独立库问题；库仍只读，不用转换器特例绕过。

### 25.2 编辑证据跨进程保存

1. `abs-edit-provenance` 继续负责精确替换、UTF-16 批次链、摘要与预算；新增独立 `abs-edit-provenance-store` 只负责可丢弃的本地证据缓存，不操作 ABI/map，不成为第二保存事务。
2. 既有文件工具在权限检查后，用实际物理草稿路径（含历史 overlay）读取旧证据；原 CAS 发布成功后才写新证据。缓存失败不撤销已经成功的程序写入，CAS 失败不产生新证据。生产路径不保留能绕过磁盘校验的内存副本。
3. 缓存位于 Agent 私有目录 `abs-edit-provenance/<canonical-path-hash>.json`，使用既有 `PI_CODING_AGENT_DIR`/默认 Agent 目录解析；项目不增加第四份镜像，ABS/map schema 和 LLM 参数均不变。文件包含已捕获的替换文本，属于私有源码缓存，不输出到模型结果或日志；可删除，删除后退回保守匹配。
4. 缓存同时绑定规范物理路径、文件身份/时间戳/大小及实际内容 SHA256；新进程可以读取同一草稿并继续链。外部替换即使字节相同也不能复用旧文件身份；跨项目、复制成另一 overlay、陈旧/断裂摘要、非法区间、超预算、损坏或链接缓存均不作为身份依据。这里承诺的是**同一实际草稿的跨进程接续**，不是对跨文件复制、未捕获改写或跨历史导航猜测编辑来源。
5. 单草稿仍限 128 批次、1024 处编辑、512 KiB 序列化证据，磁盘最多保留 32 份草稿记录；精确匹配不成立或整文件 write 清除该草稿线索。缓存使用独立临时文件原子替换，不加项目锁或另建恢复引擎；竞争/失败允许丢失线索，不允许绕过宿主的源码重放、父级归属或 generation 校验。
6. validate 从当前 `storageProjectPath` 读取草稿证据，而 ABI/generation 仍取 live 项目；避免历史 overlay 的物理身份与主项目身份混用。一次批量编辑仍只有一次 edit 和一次整体验证/提交，model-facing 只返回批次与修改数量。

### 25.3 user-center 公共入口

`credit-display.ts` 的类型引用与 `credit-contract.spec.ts` 的三处唯一深层依赖统一改为 `@core/auth/public-api`。公共入口已有所有所需导出，无需增加中转模块、调整架构基线或修改 Auth/积分业务逻辑；保留用户原有改动。

### 25.4 本批验证

| 验证 | 结果与证据 |
| --- | --- |
| user-center 定向测试 | **26/26**；`.tmp-abs-credit-boundary.log` |
| 架构门禁 | **170 files、0 baseline violations、0 cycles**；`.tmp-abs-durable-architecture.log`；没有调整 baseline |
| lex 构建与声明生成 | 通过；`packages/aily-agent/.tmp-abs-durable-build-final.log` |
| lex ABS / 项目文件发布联合回归 | **114/114**，31.241 s；`packages/aily-agent/.tmp-abs-durable-all-final.log`；含新增 9 项持久化测试 |
| 真实 Electron + 当前 lex 工具 | `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-I9aKSW/result.json`：**success=true、errors=[]、exit 0**；RTC **4/4**，Agent 136,953 ms |
| Blockly ABS 全量 | **820/820**，162.299 s；`.tmp-abs-durable-blockly.log` |

新增持久化测试直接启动新的 Node 进程读写同一草稿，覆盖 CRLF/UTF-16 连续批次、一次两处编辑、陈旧/跨项目/同字节外部替换、CAS 失败、整文件 write、坏数据/上限/链接文件、缓存不可写及 32 文件淘汰；overlay 用真实文件工具和宿主协议验证，主项目镜像不被草稿编辑改写。

Electron 第二轮仍为 **1 次 edit、2 处替换**，validate/import 返回 `editTracking:{batches:1,edits:2}`，两实例各自 ID 保持，四轮实际字段均正确。完整工作区、C++、ABI/ABS/map 和保护入口保存重开一致，RTC 页面截图已查看。日志 `.tmp-abs-durable-electron.log`；库源文件未变，原工程 ABI SHA256 仍为 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。

本轮没有新跑自主 LLM 会话或固件编译，不将真实工具回归当成两者的替代证据。没有修改库、原工程、登录配置、异步机制或 ABS/map 语法；未 commit/push。该节接替第 24.3 节的“跨进程未完成”状态，但不扩大为任意历史导航/草稿复制都能恢复编辑来源的承诺。

## 26. 2026-09-17 最终七库抽样验收与交付

完整记录见 [最终抽样验收](abs-final-library-acceptance.md)，可复现种子与 ABS 用例位于 `scripts/abs-final-library-cases.cjs`。随机抽取未完成过真实导入验收的 ai-vox-xzai、seeed_HM3301、arduino_r4_LED_Matrix、spa06、pid、serial_transfer、ArduinoFFT；包含结构动态、板级选项、字段联动与普通块，不将 PID 等同于拓扑 mutator。

真实 Electron + 当前 lex 工具最终 **7/7 库、21/21 正例、1/1 拒绝反例通过**，页面 `errors=[]`、进程 exit 0。十次批量 edit 每次修改多处调用；七个工程保存重开的完整工作区、C++、ABI/ABS/map 一致，原库哈希及原工程 ABI 不变。证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-36OaIJ/result.json`。

首轮超时与 R4 状态遗漏失败保留；修正的是测试丢弃原生 extraState 和证据写进历史事务工程的问题，未放宽生产门禁、提高超时或逐库补转换分支。R4 需保留原生导出的 itemCount；未知 serializer 不能由 ADD 槽名猜测。ABS 原位置参数/变量/状态透传规则不变，身份和布局仍在 ABI/map。任意异步仍为范围外，不重新列入计划。

本轮交付以七库实际加载回归、Blockly/lex 专项、类型与独立暂存源码构建为门禁。提交只包含 ABS 所需模块、测试、构建入口和文档；本地 Auth/积分业务与依赖解析选项不混入。门禁结果和推送分支以最终抽样验收文档为准；本批不新增 LLM 自主或固件编译结论。
