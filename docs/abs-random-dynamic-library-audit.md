# ABS 未覆盖动态库随机抽查与 LLM 语法发现审计

日期：2026-09-17。第 1–6 节为修复前真实导入测试与诊断，保留原始失败；第 7 节记录后续修复。库仓库、原项目、登录信息始终只读；后续仅修改主程序及 lex 通用工具提示。

## 1. 抽样方法与验证范围

先对照主线文档、`scripts/`、`electron/test/`、ABS tests/fixtures 排除已有实际导入覆盖，再扫描库 `generator.js` 的动态输入/字段创建路径。限定本次候选为结构动态库，不把仅修改 tooltip、变量重命名或静态枚举的库混入样本。

本次候选池：`RTC`、`aily_iic`、`simple-keypad`、`seeed_mmwave`、`unihiker_k10_speech`、`ai-vox-xzai`。其中 aily_iic/ai-vox-xzai 有历史源码抽查记录，但未找到真实 ABS 导入测试记录；seeed_wio_sd 已是异步边界审计样本，不列入池。

在执行样本前生成随机种子 `da1692043c747bd2`，按 `SHA256(seed + ":" + directory)` 排序取前五：

1. aily_iic
2. seeed_mmwave
3. RTC
4. simple-keypad
5. unihiker_k10_speech

抽样与写法固化在 `scripts/abs-random-library-cases.cjs`。没有按测试结果替换失败库。结构/参数参考各库原始 `readme_ai.md`，必要时核对 `block.json` 与完整 `generator.js`。板卡为 XIAO ESP32S3：示例数字引脚替换为实际枚举键 D0…D7；Wire 实例使用实际值 `Wire`。不为通过而重写库源码或添加产品侧按库适配。

测试使用正式 Electron 主程序、完整 preload、已构建 Angular 页面及当前 lex-pro 的真实工具注册表；每个库放入独立空白板卡工程副本，完整重放该项目的注册来源。执行 `blocks_list/block_info → abs_export → Agent read/write → abs_validate → abs_import → project_save`，核对持久化字段/输入、保护入口、保存重开后的完整工作区及 C++ 文本。对象库的原生模型使用既有 `createVariables` 意图，不修改 ABS 写法、不注入模型 ID。

拒绝后继续修改使用原 generation，不能用 `abs_export` 强制覆盖未应用草稿。草稿通过 Agent VFS 编辑，外部变更工具会先把草稿写到磁盘；因此拒绝时应区分 ABI/map 与 ABS 草稿：前两者必须不变，后者应保留编辑内容。这不是 ABI 数据丢失。

本轮不是 LLM 自主决策会话，也未执行固件编译。K10 的 SDK 不适用于测试板卡，但解析/导入同名字段问题发生在编译之前，不以此证明硬件可用性。

## 2. 结果

结论：**已覆盖的核心主线可用，但不能宣布动态库适用性完全收口。** 完整复验 5 库、16 个场景，9 次 import 接受、8 次符合预期字段语义；7 次拒绝均保持已提交 ABI/map 不变。另 1 次是 import 成功但库自身动态语义不符。不是 9/16“全功能通过”。

| 库 | 实际写法/变化 | 最终结果 | 归因 |
| --- | --- | --- | --- |
| aily_iic | `wire_begin(Wire, SLAVE, math_number(8))` → MASTER → SLAVE/32 | 3 次均拒绝；`ABS_GENERATION_FAILED`，配置阶段 timer 不支持 | 第 19 节已有异步边界，当前该库确实不可新建这些块 |
| seeed_mmwave | `mmwave_init("radar", SOFTWARE, D0, D1)` → SERIAL1 → SOFTWARE/D2/D3 | 3/3 接受，字段增减、相同块 ID、C++、保存重开一致 | 通用原生路径通过，不依赖按库适配 |
| RTC | 同时创建 DS1302 三线与 DS3231 I²C 两个实例；同时改两个；再逐个改 | 新建及分步编辑 3 次成功，ID 不变；批量改动 1 次 `ABS_IDENTITY_AMBIGUOUS` | 动态形状通过；批量同类节点身份匹配有限制，有已实测分步路径 |
| simple-keypad | README 具名引脚，4×4 → 3×1 → 4×4 | 3 次 import 接受；中间 3×1 仍有 4×4 多余字段，语义断言失败 | 原始库 validator bug，绕过 ABS 亦可复现 |
| unihiker_k10_speech | `k10_asr_speak(text("hello"), 1)`、间隔 2.5、具名参数写法 | 3 次均拒绝；位置参数报顺序歧义，具名参数报 incomplete field serialization | 通用 field/input 同名处理缺口，非异步/板卡引脚问题 |

五个隔离工程均完成关闭重开，对比完整工作区、生成 C++ 及 ABI/ABS/map 文件一致，每个项目的 3 个不可删除入口均保留。两类全拒绝库重开后仍是原始空白板卡，没有残留候选块。页面错误列表 `errors=[]`；测试总结果仍为 `success=false`、进程退出码 1，保留缺口，不把“没有页面异常”视为功能通过。

## 3. 根因与处理边界

### 3.1 I²C：配置阶段计时器，不是 ABS 参数拼写

`wire_begin(Wire, SLAVE, math_number(8))` 与 `wire_begin(Wire, MASTER)` 均触发 `Native candidate does not support timers after registration. Phase: ABS binding`。

完整 generator 的 pin-info 扩展在块配置阶段执行 `setTimeout`。这命中主线第 19 节明确保留的限制，不是新引入的位置顺序错误，也不能用“setTimeout 只改 UI”的猜测跳过未知回调。本轮不恢复任意异步调度，不为单库打补丁。若此库属于当前必须覆盖的使用场景，需单独证明相关任务的效果、完成边界及事务安全，再讨论通用只读 UI 效果协议。

### 3.2 RTC：动态形状与身份匹配是两个问题

`rtc_init("clock3", DS1302, D0, D1, D2)` 与 `rtc_init("clock2", DS3231, D4, D5)` 可在同一候选中创建不同的真实动态字段。

同时改动这两个同类型节点时，`abs-reconciler.ts` 中的重复类型匹配在没有唯一内容锚点时返回 `ABS_IDENTITY_AMBIGUOUS`。不能通过按当前位置强配身份或删除保护校验解决；这会把 map 中的布局/保护信息交给错误的节点。补测保留一个未改节点、分两次修改的流程；批量编辑的通用 map 辅助身份机制仍是独立能力边界，不需把 ID 写回 ABS。

### 3.3 矩阵键盘：库原生验证器读取旧值

`simple-keypad/generator.js` 的 LAYOUT validator 调用 `block.updateShape_()`，后者读取 `block.getFieldValue('LAYOUT')`。validator 执行时新值尚未提交，因此从 4×4 切换到 3×1 仍按旧布局创建字段。真实 ABS import 返回成功，但 ABI 仍带 `ROW_3/COL_1/COL_2/COL_3`；不能只看工具 ok 就报语义通过。

控制实验 `scripts/abs-random-library-native-diagnostic.cjs` 直接执行未修改的完整库 generator、真实 Blockly 注册与 `setFieldValue`，完全绕过 ABS，也复现相同结果。属于库自身缺陷，主程序不应维护同名块的另一套行列推导逻辑。本轮保持库只读，单独记录需库侧修复的事项。

### 3.4 K10：field/input 同名，内部身份域过度合并

库中的 `k10_asr_speak` 有 `INTERVAL` 数字字段，同时通过扩展保留同名旧版隐藏 value input。Blockly 本身允许 field 与 input 分属不同名称空间。

当前 `abs-native-arguments.ts` 按裸 name 去重，`abs-syntax-binding.ts` 的参数索引也使用裸 name；因此原始 README 位置写法 `k10_asr_speak(text("hello"), 1)` 无法获得“完整无歧义顺序”，返回 `ABS_GENERATION_FAILED`。控制实验确认字段和连接确实并存，不是 README 凭空写了参数。

具名补测 `k10_asr_speak(TEXT=text("world"), INTERVAL=2.5)` 也失败。`blockly-native-instance.ts` 把 `!argumentOrder` 和缺少字段序列化放在同一报错分支，因此此时的 `incomplete field serialization` 不能解读为库真的未保存字段；根因仍是参数顺序因重名返回 undefined。

这是需要通用处理的转换缺口。后续应在元数据、原生参数序列、绑定和读回中区分 `(kind, name)`，原声明顺序仍保持；旧版已连接输入也必须无损保留。不能删隐藏输入、跳过读回，或按 k10/INTERVAL 名字写例外。同时应拆开参数顺序不足与字段序列化不完整的诊断，避免误导排查。

## 4. block_info / blocks_list 是否把 ABS 语法给 LLM

**有，但不是所有动态配置的完整、可直接复制运行的调用示例。** 已检查真实注册表返回的 `content`，而不只看 `structuredContent` 或 TypeScript 类型。

| 工具 | LLM 实际收到 | 边界 |
| --- | --- | --- |
| blocks_list | type/library/signature、根块/输出标志、能力摘要、元数据来源、变量与能力规则 | 紧凑列表不返回每个字段详情，也不展开动态 shape 规则 |
| block_info | signature、argsOrder、字段类型和下拉选项、value/statement 输入、argument guidance、完整 absCapability、变量规则 | 原生 validate 类型可能只有 block.json 的静态声明，不会遍历全部运行时变体 |

实测毫米波输出 `signature=mmwave_init(VAR, SERIAL_TYPE)`，没有 SOFTWARE 模式的 RX_PIN/TX_PIN；K10 输出 `signature=k10_asr_speak(<TEXT>, INTERVAL)`，也没有旧版隐藏连接。两者均标注 `metadataSource=installed-library`、`level=validate`、`contract=native-sync-v1`，并提示签名可能只是默认形状、需要原生验证。不是工具完全没有语法，而是动态语法发现尚不完备。

签名里的 `<TEXT>`、`{BODY}` 是占位元数据，不是应写进 ABS 的字面文本。`block_info` 的 guidance 明确说明 value input、单语句体缩进与 `@NAME:` 的用途，以及 `$name` 与 `variables_get($name)` 的区别；裸 `$name` 的值槽兜底仍保留。

代码链路：

- lex `services/library/catalog.ts`：合并安装库定义与宿主能力；默认只读元数据，不在活动工作区 newBlock 探测。
- lex `services/abs/guidance.ts`：构造位置签名和参数提示。
- lex `tools/registrars/library/projections.ts`：将这些信息投影到 LLM 文本。
- lex `tools/result.ts`、`tools/definitions.ts`：实际工具返回的 content 传给模型，详细 structured result 放在 details。

建议优先复用现有隔离原生候选，提供“给定配置后实际参数形状”的只读查询/诊断结果，同时标注静态前缀与动态尾部，而不是再维护一份库专用签名表或在活动工作区试创建块。该建议本轮未实施。

## 5. 可复现证据与本轮改动

- 首轮：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-N7ruk7/result.json`，`.tmp-abs-random-library-electron.log`。保留原始失败；首个 I²C 测试因把 VFS 草稿落盘误当作全文件原子失败而提前中断，不据此给出库结论。
- 最终复验：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-FeRZjo/result.json`，`.tmp-abs-random-library-final-electron.log`。每个工程的 `random-library-evidence.json` 保存确切源文本、实际 model-facing 工具输出、validation/import/save 结果与 ABI；汇总由 `random-library-audit.json` 保存。
- 原生控制实验：`.tmp-abs-random-native-diagnostic.log`；用 xmldom 提供 Blockly XML 依赖，不模拟字段/validator。
- 抽样种子/顺序复核与 6 个脚本语法检查通过，`.tmp-abs-random-script-checks.log`。正式转换代码未改动，因此未声称本轮重跑前批的 779 项全量或重新构建产品。
- 本轮仅新增抽样夹具、真实测试入口、控制实验和审计文档；未修改正式 ABS 转换器或 lex 工具协议，没有放宽任何拒绝条件。

五个库的 block.json/generator.js/readme_ai.md/package.json 哈希逐一确认未变；原工程 ABI SHA256 保持 `d556530fc57380bf8fab311d13e11f7ba52d3c39a39a67fd03fd24bc1e4de743`。真实截图已查看毫米波、矩阵键盘与最终 RTC 页面；未修改登录配置，未 commit/push。

最终结果必须分别统计“事务接受”“符合预期动态语义”“保留身份与保存重开”，不能把 import.ok 直接当作库功能正确。

## 6. 建议处理顺序（本轮未实现）

1. 优先关闭主程序的 field/input 同名通用缺口；加入不同名字的合成测试和旧隐藏连接带子块的往返测试，避免修复只对 K10 生效。保持 ABS args 顺序、map 身份及唯一提交链。
2. 完善动态语法发现：静态前缀明确标注为非完整签名；复用隔离候选返回指定配置下的 shape/顺序/约束，不能扫描源码猜所有变体。此项是 LLM 可用性改进，不是放宽转换门禁。
3. 把 RTC 已验证的“同类型节点逐个编辑”作为明确恢复指导；若必须批量处理，单独设计 map 侧身份操作，不往 ABS 添加 ID 或位置元信息。
4. 矩阵键盘归库维护事项。本轮只读约束不变，不通过主程序模拟键盘布局来掩盖库 bug。
5. aily_iic 保持明确不支持该异步路径；只有产品确认属于必须覆盖的场景并完成效果归属设计后，才讨论受限通用效果扩展。不因一次抽样重开任意异步目标。

## 7. 修复执行：通用命名空间、候选语法和中性 UI 任务

本节接替第 6 节当前待办；历史诊断与原始失败证据不覆盖、不改写为通过。

### 7.1 不变项与实现拆分

- ABS 文法不改。字段与输入各有名字域，内部身份改为 `field:name` / `input:name`；value/statement 同属 input 域，仍禁止重复。原 argsN 顺序保持，动态尾部按原生声明追加。
- 位置参数直接按有类型的参数项绑定；具名嵌套调用匹配输入，标量优先字段，已有 `@NAME:` 可明确指定同名输入。输出器、原生合同、lex 元数据同步区分两域；不删除隐藏输入或子树。命名空间逻辑不含 K10 等库名。
- `block_info/blocks_list.signatureScope` 区分 `complete-fixed-shape`、`configuration-dependent`、`declared-prefix-only`。最后一种不是完整调用承诺。
- `abs_validate.syntaxAdvice` 从本次已经准备好的候选提取实际顺序/字段类型/枚举键/数值约束，放在 receipt 之外，不改变校验授权协议。只给首个对应源调用偏移，不暴露 block ID、字段大值、extraState；最多 32 种形状、每种 64 项参数、32 个枚举值及总量 48 KiB，并明确截断。它不是所有可能变体的枚举，也不为无效草稿另开探测执行通道。
- RTC 同类型批量编辑歧义保留草稿/map；分步恢复只是临时诊断绕过，不是正常 Agent 工作流。批量身份跟踪仍须修复，不能以逐块调用增加 token 与往返成本；具体要求见主线第 22.4 节。键盘原生 validator 缺陷仍归库维护，主程序不复制其布局算法。

### 7.2 为什么旧 I²C 看似不需要异步

Git `4caee8fd^` 的旧 `absParser.ts/queryArgsOrderFromBlockly` 在 `Blockly.getMainWorkspace()` 上创建临时块。旧 ABS 转换函数并未等待 Promise，但原始 generator 中的 `setTimeout` 由真实页面继续执行。因此“不写 async 的转换器能用”不等于“库没有延后任务”。

aily_iic 的 `wire_begin_mutator/updateShape_` 同步创建 SLAVE 地址输入；pin-info 扩展通过 50/100 ms 延后刷新 Wire 菜单显示和引脚提示。新候选此前在注册结束后一律拒绝 timer，把同步结构 + 延后显示也一起挡住了。这是候选效果边界过粗，不应因此恢复任意异步加载，更不应要求库修改代码。

### 7.3 受限通用机制，而非按库适配

新增候选局部 `NativeUiTasks`，职责仅为有限延后任务的语义中性检查：

1. 注册阶段继续沿用既有有限注册任务；配置阶段的函数型 one-shot timer 收集进虚拟队列，不实际等待页面事件循环。
2. 每个候选最多 128 次调度（含取消），单次 delay ≤ 2000 ms、累计 ≤ 5000 ms；按虚拟到期顺序执行，嵌套任务计入同一预算。取消真实生效，失败粘性保留。
3. 同步配置完成后，每个回调前后对比完整持久化 workspace、连接检查、空输入、字段类型/约束/变量类型/枚举键。显示 label/tooltip 不作为程序语义；改变字段值、输入结构、模型或约束即拒绝。
4. 最终完整 ABI 校验在任务前后运行实际同步 Generator，生成文本及已捕获的头文件产物必须相同，仍检查完整读回。产物比较复用既有 `captureArduinoGeneratedArtifacts`，不访问磁盘。Generator 与最终合同/序列化检查期间不允许调度新 timer。配置发现结果单独不构成提交授权。
5. Promise continuation、microtask、interval、网络/未知宿主服务、异步改结构和无界任务继续拒绝；不改写库源码，不根据 `setTimeout` 语法猜测“它一定只是 UI”，不忽略回调。
6. 队列属于一次独立候选，失败和销毁均清理，不复用跨项目状态；活动项目 runtime、编辑租约、CAS、资源准备及唯一提交/保存路径不变。

这是受限的效果验证，不是任意异步结构完成协议。需要 timer 才能生成结构/数据/代码的库仍不在当前支持范围。真实 UI 继续遵循原库时序；只有候选允许证明语义中性的任务同步收敛。

### 7.3.1 真实复测新增发现：I²C 从站还有图形环境差异

解除 timer 一刀切后，SLAVE 路径继续被完整性门禁拒绝，原因已不再是异步：原库在创建默认 math_number 后，先调用 `shadowBlock.initSvg()/render()`，再执行 ADDRESS 连接。真实 Blockly `Workspace` 创建的 headless Block 没有这两个方法；原库 catch 吞掉异常，遗留孤立 shadow。不能把孤立块直接丢弃或补猜连接来通过。

控制脚本 `scripts/abs-iic-headless-diagnostic.cjs` 执行完整未修改库及真实 Blockly，完全绕过 ABS 与候选策略。同步结果和等待真实计时器 350 ms 后均为：MODE=SLAVE、ADDRESS 存在但未连接、额外 math_number shadow 的 parent=null、initSvg/render=undefined。证据 `.tmp-abs-iic-headless-diagnostic.log`。这证明“多等异步”不能修复此路径。

通用后续方案是**候选原生环境一致性**，而不是 I²C 专用结构适配：在一次性隔离 Realm 中提供真正的 Blockly 图形工作区/BlockSvg 生命周期，复用实际原生 API、原创建归属 journal、完整 ABI 读回和唯一提交链。须先验证同步渲染刷新、UI 调度/资源隔离、销毁和大项目成本，再与 headless 快速路径收敛；不能假装 `initSvg/render` 是空函数，也不能在活动工作区做试探。此扩展本批未实现，不将 SLAVE 宣称为已经支持。

### 7.4 验证计划

- 合成库名覆盖 field/input 同名位置/具名/section、重复参数拒绝、保护与旧连接身份无损往返。
- 延后 tooltip/菜单标签正例；字段/连接/模型/约束/生成代码改变、网络、Promise、超预算、检查时新调度负例。
- lex 实际 model-facing 内容与同名参数完整性；候选语法提示截断/隐私/非授权边界。
- ABS 全量、工程加载、类型和构建，再以相同随机样本跑真实 Electron + lex 工具导入/保存/重开；K10 增加旧同名输入已连接子块的两轮编辑。
- 保留 RTC 歧义和键盘库缺陷为已知未解决项，分别统计接受、语义正确和事务/重开一致性，不能以修改总通过口径掩盖失败。

### 7.5 最终真实复测与未完成项

证据根目录：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-VqKhLX`；汇总 `random-library-audit.json`、页面 `result.json`、每库 `random-library-evidence.json`，运行日志 `.tmp-abs-audit-fix-electron-final.log`。使用正式 Electron 页面和当前 lex 工具，不是自主 LLM 会话或固件编译。

| 库 | 场景数 / 接受 / 语义正确 | 结果 |
| --- | --- | --- |
| aily_iic | 3 / 1 / 1 | MASTER 导入保存成功；两个 SLAVE 场景因 headless 图形生命周期缺失产生孤立 shadow，被拒绝 |
| seeed_mmwave | 3 / 3 / 3 | 软件/硬件串口切换与动态引脚均通过 |
| RTC | 4 / 3 / 3 | 初建与分步编辑通过；双实例同时修改仍报身份歧义，批量能力未修复 |
| simple-keypad | 3 / 3 / 2 | 4×4→3×1 的原生 validator 旧值问题仍在，不能把导入成功算成语义正确 |
| unihiker_k10_speech | 5 / 5 / 5 | 同名 field/input、新建及保留旧隐藏连接的编辑通过 |

合计 18 轮、15 次接受、14 次符合字段语义、3 次安全拒绝。5 个工程的已提交工作区、C++、ABI/ABS/map 保存重开一致；所有库源哈希不变，原工程 ABI 哈希不变。页面 `errors=[]`，总验收 **success=false**，脚本 exit 1。I²C MASTER 和 K10 页面截图已查看。

LLM 实际发现内容具备签名完整性说明；15 次成功验证均返回 receipt 外的候选语法提示。自动化 ABS **800/800**、lex ABS **68/68**、工程加载 **9/9**、打包/预处理/证据脚本 **13/13**，类型与构建通过。

后续不继续按库打补丁：主程序需解决通用批量身份延续和隔离候选图形环境一致性；库自身 validator 行为单独留证。不把逐块编辑、增加等待或丢弃无归属数据作为上述缺口的解决方案。

### 7.6 批量身份缺口后续修复

主线第 23 节通过既有文件 edit 的精确文本溯源接入统一身份匹配，没有 RTC 专用逻辑。原第二轮改为 **一次 edit 携带两处替换**，随后整体验证/导入；真实 Electron 证据 `D:/codes/.tmp-abs-native-ui/aily-project-data-ui-qCdYHR/result.json`：success=true、errors=[]，RTC 四轮全部通过，两个实例各自 ID 与保护入口不变，保存重开一致。内部编辑载荷不返回给 LLM，只暴露批次和修改数量。

此轮针对 RTC 复测，不把前节另外四库的失败抹成成功。另有独立真实 WorkspaceSvg 原生控制实验同步通过 I²C SLAVE 默认地址连接；它证明环境差异，但生产隔离图形候选仍未接入。批量机制的进程内缓存边界及最终 809/74 项回归见主线第 23 节。

### 7.7 生产图形候选接入后的真实验收

主线第 24 节已补齐隔离候选的真实 WorkspaceSvg 生命周期，不再依赖 headless Block 或 I²C 专用补丁。真实 Electron + 当前 lex 工具证据：`D:/codes/.tmp-abs-native-ui/aily-project-data-ui-KxMZKe/result.json`，**success=true、errors=[]、exit 0**。

- I²C **3/3**：SLAVE(8)→MASTER→SLAVE(32)，动态 ADDRESS、默认 shadow 和 C++ 正确，保存重开一致；最终 `Wire.begin(32)`，实际页面截图已查看。
- RTC **4/4**：双实例第二轮仍为一次 edit 同时修改两处，逐实例身份不变，保存重开一致。
- 两库源哈希和原工程 ABI 哈希不变，未修改库。ABS 全量 **820/820**，类型检查及 development 构建通过。

第 7.5 节的 I²C/RTC 失败是保留的历史证据，当前对应缺口已修复；simple-keypad 等未在本次复测的结果不改写为通过。本次为正式工具事务与代码生成验收，不新增自主 LLM 或固件编译成功结论。
