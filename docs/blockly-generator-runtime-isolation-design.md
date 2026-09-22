# Blockly Generator 项目级运行时隔离改造方案

> 状态：核心隔离链路与动态库删除后的全量 rebuild 已实施并通过真实项目功能验证；依赖解析与动态库升级待后续完成  
> 适用仓库：`aily-blockly`  
> 更新时间：2026-09-16
> 约束：不修改任何 Blockly 库包，不使用浏览器整页刷新

## 2026-09-16 单库加载失败恢复

7 月 17 日的 `d31cf7132` 将生成器执行失败升级为整个项目加载失败：runtime 被标记为 inactive，loader 销毁 runtime 并抛出异常。7 月 25 日 `d8fd57ce` 添加的红点/重试仅覆盖完整性校验失败，未覆盖该执行异常分支。

现已保留「失败 Realm 必须替换」的隔离约束，同时恢复单库容错：

- 保存原始错误堆栈，使用旧 context 创建新 Realm，重新注册此前成功的库，再继续加载后续库。
- 坏库保留红点工具箱入口；可读的 block.json 用于恢复已有积木外观，不执行失败的生成器；使用这些积木生成代码时显式报错，避免悄悄遗漏代码。
- 点击坏库展示原始错误、安装目录、本地源目录，复用通知的 AI 处理入口；修复后重新读盘加载并恢复工作区，清除红点。
- 库加载串行化，避免并发安装写入正在替换的 Realm。多坏库的占位和错误在恢复中保留，项目 reset / 显式全量库重建时清理。

验证命令：

```sh
npx ng test --watch=false --browsers=ChromeHeadless --include='src/app/editors/blockly-editor/services/blockly-library-recovery.spec.ts' --include='src/app/editors/blockly-editor/services/blockly-generator-runtime.service.spec.ts'
npx tsc --noEmit -p tsconfig.app.json
# 指向已安装依赖的 NLCS11 复现项目；测试复制后才修改副本。
AILY_E2E_LIBRARY_RECOVERY_PROJECT=/path/to/nlcs11_project npm run test:e2e -- blockly-library-recovery.spec.ts
```

浏览器回归覆盖：完整性失败、语法失败、运行时失败、部分注册回滚、多个坏库、并发加载、失败重试、修复后重载和正常库继续生成代码。正式开发窗口实测 NLCS11 的 `ReferenceError: asd is not defined` 已不阻止项目打开，原有积木保留，通知可显示原始错误和 AI 处理入口。AI 实际发起修复不属于本次自动验收。

本次结果：7/7 ChromeHeadless 回归通过；TypeScript 检查、生产构建通过；Electron 生产渲染层 E2E 1/1 通过。E2E 使用隔离项目副本，验证坏库红点、正常库展开、错误通知/AI入口、修复后重加载、全部积木 ID 保留，以及 NLCS11/Serial 代码恢复生成。没有进行硬件编译、上传或真实 AI 对话。

E2E 会在 Playwright 当前运行的输出目录生成 `library-failure.png` 和 `library-recovered.png`；后续测试会清理该临时目录，需要时可通过上述命令重新生成。

## 0. 2026-07-17 实施结论与方案收敛

文档对根因和 iframe Realm 选型的判断正确，但原方案首轮同时引入逐写入 Proxy journal、单库事务、依赖图、路径绑定代理和异步资源治理，实施面过大。结合当前应用“同一时刻只允许一个 active Blockly 项目”的约束，本轮采用更小且可完整验证的项目级生命周期边界：

1. 每个项目激活周期创建 hidden iframe，以 classic script 语义同步执行全部 `generator.js`。
2. 每次激活创建新的 Arduino/MicroPython Generator，所有生产代码生成入口读取当前 active Generator。
3. 项目激活时对宿主 Blockly 可变面做 checkpoint，销毁时整体恢复；当前覆盖 Blocks、Msg、Extensions、通用 registry、ContextMenuRegistry，以及 Field/FieldDropdown/Block/Workspace 等原型。
4. iframe timer、interval、RAF、idle callback 和 microtask 统一带 session/epoch guard，销毁时取消可取消资源。
5. workspace 先 dispose，再恢复宿主 checkpoint，最后移除 iframe，避免 block 销毁阶段调用已经失效的 child callback。
6. Angular 复用同一路由组件时，使用已 await 的 SPA `guide -> blockly-editor` 跳转触发确定性 teardown，不进行 Renderer 或浏览器刷新；编辑器对直接修改 query 参数的入口也有相同兜底。

### 0.1 相比原方案的修正

- **首轮用 session checkpoint 代替逐写入 journal。** 当前没有并发 project runtime，也不支持任意单库无损卸载，因此在项目边界恢复完整宿主状态比拦截每个内部注册 API 更简单，且能覆盖未预先枚举的同名覆盖。
- **原型必须纳入恢复面。** 对真实项目扫描发现 `lib-core-serial` 会修改 `Blockly.FieldDropdown.prototype.doClassValidation_` 并写入 `_serialValidatorInstalled`；原文仅列 Extensions/Blocks/Msg/registry，仍会发生跨项目泄漏。
- **脚本执行失败直接销毁 tainted session。** 不在已创建部分 lexical binding 的 Realm 中重试，也不继续把该库标记为加载成功。
- **保留项目内 classic script 共享。** 没有改成 Function/IIFE/严格模式，跨库裸全局 helper 仍可工作。

### 0.2 本轮已完成

- RuntimeService、fresh Generator factory、类内部 `this` 自引用修复。
- 父 document generator script loader 改为 iframe 内联 classic script loader。
- boardConfig、packageJson、i18n、Blockly facade、ProjectService facade 和受控 timer 注入。
- Builder、Uploader、保存 hash、AI edit/sync/lint 等代码生成入口迁移到 active runtime。
- 串口动态 toolbox 等父 window global 调用迁移到 `runtime.invokeGlobal()`。
- 项目切换、同路由 query 参数复用、close 路由均改为可 await 的 SPA 生命周期。
- 浏览器单测覆盖 Realm 共享/隔离、宿主状态与原型恢复、timer 取消、tainted Realm。
- Electron 生产渲染层 E2E 覆盖两个真实项目连续打开和 runtime session identity 变化。
- 库删除在依赖变更成功后同步 `.temp/package.json`，原地重建库注册层与 generator iframe runtime；编辑器、workspace 和 Router 均不重建，全程禁止 `projectOpen()`、`location.reload()` 或 Electron `webContents.reload()`。
- Electron E2E 覆盖真实项目卸载未使用库，验证 runtime session 更新、目标 generator 消失、剩余代码仍可生成，同时 Renderer、`app-blockly-editor` 与 `.blocklyBox` DOM identity 均保持不变。
- `Blockly.getMainWorkspace()` 和 runtime global 入参使用 workspace facade 跟踪库脚本注册的 change listener；旧 session 销毁前统一解绑，避免残留回调访问 inactive Realm。

### 0.3 后续增强项

- 运行时依赖源仍需从“物理安装库存”完全收敛到声明依赖图。
- 动态库升级仍需复用依赖同步 + runtime rebuild 入口；不应扩展为逐 lexical binding 卸载。
- ProjectService 的宏写入可继续收敛为显式 projectPath API，以覆盖已经进入 `await` 的极端晚到 Promise。
- checkpoint 方案若未来需要并发 project runtime 或可组合的单库卸载，再升级为 owner journal；当前不提前支付这部分复杂度。

### 0.4 2026-09-14 补充：生成准备与保存边界

ABS / ABI 主线第十七批沿用本方案的项目 iframe、active Generator、session 资源屏障与销毁顺序，不引入新 Realm，也不修改库。新增 `prepared-project-code.ts`：在编辑租约内完成异步资源准备，再以一次同步 `workspaceToCode` 捕获代码、头文件文本和代码映射；允许必要的同步模型注册，之后固定持久化 revision。异步等待期间的文档/上下文变化仍拒绝，不能靠放宽 revision 接受旧结果。

保存只消费已准备输出；ABS 在生成后重新核对请求状态；防抖页面生成、Builder 与 Uploader 通过同一个队列/租约入口消费。生成缓存不再只依赖事件计数，使用完整文档 revision、workspace/page、Generator 实例/配置版本与 Project Data session。Runtime 的配置、库注册、库 i18n 更新推进配置版本，同实例配置变更也会使在途生成及缓存失效。

详细实现、失败语义与真实工程证据见 [主执行方案第 31 节](D:/codes/aily-blockly/docs/abs-abi-lossless-sync-execution-plan.md)。这不将 iframe 提升为恶意库沙箱，也不宣称 `.h` 存在等价于 C++ 编译或硬件播放通过。

### 0.5 2026-09-15 补充：声明式块的准备来源

ABS / ABI 主线第二十批在 `BlocklyService.loadLibBlocks` 完成 i18n、boardConfig、静态路径和 Project Data 内存装饰并实际注册后，记录声明式 JSON 与注册对象/`init` 的对应关系。该目录属于项目 editor，reset 与原地 runtime rebuild 一起清空，不增加全局 Blockly 元数据缓存，也不另建 probe workspace 或 iframe。

候选使用的声明在异步资源准备、实际装载和最终宿主 CAS 前仍需保持原注册来源；定义覆盖、源 JSON 改变或目录重建都会使快照失效。静态合同只覆盖可证明的字段/默认值/连接种类；包含 extension、mutator 或未知字段工厂的定义不能冒充静态合同。实际执行阶段仍受同一租约和完整读回保护，这不是恶意库沙箱，也不允许因为新块而忽略额外 serializer/model 状态。详细记录见 [ABS / ABI 主线第 34 节](D:/codes/aily-blockly/docs/abs-abi-lossless-sync-execution-plan.md)。

### 0.6 2026-09-15 补充：宿主原生过程输入适配

ABS 第二十四批为主程序打包的 legacy 调用提供 `blockly-bundled-procedure-generator.ts`。在既有项目 iframe 的 Generator 脚本加载完成后，针对注册身份仍为宿主实现的调用块包装当前 Generator handler；只读 block view 将库的 INPUT<n> 读取映射到实际 ARG<n>，不修改工作区、库脚本或另一项目的 Generator。保留原 handler 的变量/函数命名、返回类型及代码生成逻辑，不替换为新的代码生成算法。同名块定义被替换时不使用此适配，custom_function_* 不在本合同内。详细验收见 ABS 主执行方案第 38 节。

### 0.7 2026-09-15 补充：自定义函数合同与派生状态

ABS 第二十六批在既有 generator 加载边界，以规范化源码哈希及实际 mutator、调用定义、依赖函数和 extension 注册身份确认有类型函数协议。加载顺序保持 generator.js → block.json：前者验证脚本注册，后者继续由 editor 声明目录证明定义来源，不能在脚本执行时要求声明式定义已注册。异步摘要绑定原 runtime session；旧 session 完成时不能登记或销毁新实例。运行时结束清除所属合同，不增加 iframe，也不修改库包。

ABS 的候选模型/签名准备保持纯数据变换，显式 FUNC/参数模型与工作区通过原事务一起提交。实际加载后及失败回滚后，仅从完整工作区重建该 Realm 内的 customFunctionRegistry 和定义名称缓存；不调用可能创建/删除模型、同步工具箱的库初始化函数。普通工程序列化和 ABS 既有实例采集前，再通过已审计定义的 serializer 准备查找表，覆盖延迟监听器清空注册表的时间窗；不读取调用 serializer 来推断定义，不等待完成事件。普通快照不推进未提交的函数名编辑缓存。派生注册表不能取代持久化状态和完整读回校验。源码更新或注册被覆盖须重新审核，不以版本名作为许可。详细验收见主执行方案第 40 节。

### 0.8 2026-09-15 补充：普通声明模型准备

普通变量声明复用既有 generator 加载/销毁边界登记模型效果，不增加 Realm、probe workspace 或库侧配置。`blockly-variable-declaration-contract.ts` 验证已加载源码摘要、实际 handler/依赖 helper 身份和捕获的入口类型；声明式目录另外证明 block.json 字段/连接与全局容器形状。当前覆盖普通 variable_define 的全局声明，C++ TYPE 与空 native model type 明确分离。已安装预览脚本与库主线仅有两个未使用 GORP 读取的差异，审计后分别绑定摘要，不按包名放行未知代码。

`abs-declaration-intents.ts` 在 detached AST 已完成身份匹配后、引用绑定前复用原模型准备层；加载和生成只消费准备好的模型。前向引用与二次编辑可复用确定性身份，拼错引用不能新建模型；未知作用域、重复存储声明、模型冲突和隐式重命名拒绝。单次验证不执行库回调、不修改真实工作区；完整读回仍拒绝额外模型。所属 runtime 销毁时清理登记，旧异步摘要或旧 owner 不能注册/清除新 session。

### 0.9 2026-09-15 补充：通用结构 mutator 与 generator JSON 声明

宿主打包的五类纯结构 mutator 在原注册点同时提供计数、重复输入、可选分支及序列化规则；不同库复用同一机制，不按库名或块名逐项授权。ABS 在 detached 数据上计算结构；能力查询和 validate 不调用库 init/serializer，不创建试探块。注册函数、mixin、Extensions.apply 和声明来源必须保持一致，实际装载后继续完整读回与 CAS。带模型副作用的函数仍使用各自模型合同，不进入纯结构规则。

既有 iframe Blockly facade 为标准 `defineBlocksWithJsonArray` 增加声明采集回调：在当前 session 中实际注册后，将已求值的 JSON 交给同一个项目声明目录，并推进 runtime revision。所属 editor reset/rebuild 仍负责清空目录；销毁的 session 不得登记。没有增加 Realm、全局目录或库侧配置，也不通过执行任意 `init()` 来猜测结构。动态参数顺序根据该实例的原生 extraState 确定，静态部分仍遵循声明顺序。验收与剩余边界见 [统一落地方案第 13 节](D:/codes/aily-blockly/docs/abs-unified-syntax-landing-plan.md)。

### 0.10 2026-09-15 补充：字段驱动结构与 UI 扩展

新增字段条件规则适配已绑定的原生 mutator；`abs-field-shape.ts` 只依据声明、已验证规则及字段值推导输入顺序和原生冗余 XML。UI 扩展通过有限 AST 效果检查识别只读 tooltip / 已审查的可见性机制，不执行回调探测，不增加 Realm、工作区、注册入口或库侧配置。所用注册身份改变即使合同失效。实例选择器记录在原不可变 generation 合同，不修改公开 map schema。共享模型、异步创建块、全局配置副作用不归入 UI。范围及证据见统一落地方案第 14 节。

### 0.11 2026-09-15 补充：库内条件结构的注册观察

在原 Blockly facade 中观察正常 register/registerMutator，宿主模块及注册方法不替换。仅完整 AST 可证明的字段结构关联到实际注册回调弱引用，闭包 mixin、Realm helper、DOM 创建方法及 Runtime 所属身份均需保持。查询/验证不执行回调探测，不另建 Realm 或工作区；新机制复用 field-shape-v1。原 Runtime 销毁/失败状态和注册恢复使旧证据失效。原型/mixin或helper被替换的反例已覆盖，详见主线第 15 节。

注册装饰器保留属性读取时捕获的函数，不能绕过库包装或递归调用新包装。`Blockly.Extensions` API 方法表已补入原 property-surface journal，与扩展注册项一起恢复；此前仅恢复注册项会把库的 API 包装及旧 Realm 闭包留给下一项目。销毁后方法身份与注册项恢复均有原生反例覆盖。

后续 ABS 动态块以 [原生配置执行主线](./abs-native-runtime-execution-plan.md) 为准。当前普通初始化新增实例级原生结构记录：只观察 append/insert/remove/move，不分析源码、不重复执行 init，不新增 Realm；记录不授予新建/变形许可。静态 JSON 顺序仍是声明实参顺序的事实来源。未来候选执行必须另行证明隔离：当前 Realm 共享宿主 Blockly 注册表，仅增加 Workspace 或备份 ABI 不能把 validate 变成只读沙箱。

### 0.12 2026-09-16 补充：独立原生候选诊断容器

N2-a 为候选诊断增加一次性 opaque-origin iframe，加载独立的同版 Blockly core；与活动项目 iframe 不共享注册表、原型、Generator 或项目服务。当前 runtime 只增加源码/声明/context/i18n 的有序快照，不改变正常执行语义。session 或配置变化使在途候选失效；资源销毁不触碰活动 workspace。

当前只允许同步原生创建/字段与 extraState 配置，并拒绝未声明的模型、子块及异步/I/O。它不是第二个 active Generator，也未接入生产 abs_validate/apply。完整宿主自定义字段/Generator 引导、位置参数绑定、附带状态归属和提交闭环仍待实施。状态隔离不等于可抢占恶意同步死循环；详细边界与测试见新主线第 3、6 节。

### 0.13 2026-09-16 补充：共享原生引导与两阶段 ABS 绑定

N2-b 将主程序字段/结构扩展注册及三模式 Generator 构造器抽成共享模块，再编译为候选 iframe 的独立包。Project Data 字段通过无 Angular 的窄入口访问原实现，位图 UI 服务桥接与 Angular 服务分开；不传宿主单例或 preload。主程序加载候选前核对编译期 SHA256，拒绝热更新期间的旧包。原 N2-a 函数字符串注入与单独 core 资产路径已移除。

ABS 完整语法读取与逐实例绑定分离，但仍使用同一语法和原变量兜底。候选以原生字段/extraState/连接执行后完整读回；argsN 声明顺序及 init 内直接 jsonInit 均记录，动态部分仍来自实际构造。模式、消息、配置及源码快照都有失效边界。

此阶段为同步诊断闭环，不替代活动项目 iframe，不提升 Agent 创建许可，也未打通候选的模型、媒体资源、项目服务或异步任务。完整 DHT/MAX31865 脚本重放不等于全工程回放或编译通过。下一步复用既有身份合并、租约、CAS 和保存链，不增加第二提交通道。实施与证据见 [原生执行主线第 7 节](./abs-native-runtime-execution-plan.md)。

### 0.14 2026-09-16 补充：同步候选接入唯一 ABS 提交链

N2-c 已将原生绑定按源调用关联到原 reconciler 的身份规划；第二次隔离执行使用正式 ID，不持久化诊断 offset ID。保留既有 metadata/保护/disabledReasons/shadow 后，第三次隔离执行加载最终 ABI，调用实际 Generator 并复用完整读回。未知模型、计时器或其他未归属效果在活动工作区变更前拒绝。

生产准备使用活动 runtime 的完整日志，不按库筛选；仅静态语法/结构合同缺失时尝试原生路径，其他校验不得绕过。Project Data 协调器、租约、baseline、CAS、活动完整读回、保存和回滚仍各只有一条实现。没有替换活动 Generator、改变库包或增加 Agent schema。

该同步子集已通过 coordinator 专项；Electron 本批只验证隔离最终 ABI/Generator，不冒充 Agent apply。全工程异步声明、模型、媒体资源和项目服务仍受 N3 限制；范围、测试及剩余项见 [原生执行主线第 8 节](./abs-native-runtime-execution-plan.md)。

### 0.15 2026-09-16 补充：候选模型/大值输入与 JS 注册观察

N3-a 将宿主已确定的变量表和通用 Project Data 大值作为结构化克隆输入；候选复用原符号解析与完整模型读回，不接纳回调产生的额外模型。通用 envelope 由宿主原资源会话 resolve，候选只读取复制的值；原媒体专用字段、异步任务及项目服务仍没有获得新权限。

活动 runtime 的 Blocks facade 在正常 JS 注册时安装实例观察器，补齐直接 jsonInit 的原参数顺序；没有初始化探针或类型合同提升。注册替换/删除推进 runtime revision；catalog 清空及定义/init 失效不能重新使用旧实例记录。候选在完成重放后禁止 Blocks 表写入与 JSON 块注册，错误被库捕获也不能通过准备。

原 active Generator、项目 checkpoint、租约和 ABS 事务保持不变。631 项专项、构建及真实 Electron 候选验证通过；完整 Agent/异步/编译仍待后续。见 [原生主线第 9 节](./abs-native-runtime-execution-plan.md)。

### 0.16 2026-09-16 补充：混合候选声明模型的准备时序

N3-b 的普通声明子集复用既有可信声明合同和纯语法绑定器，在首次隔离绑定前准备临时模型输入，解决新声明与前后向引用的准备环。临时表不参与提交：原身份匹配/声明规划决定正式模型，随后第二次隔离绑定及最终 ABI/Generator 完整读回仍使用正式表。两次规划的模型表必须一致；原重名、作用域、重命名与来源校验均保留。

没有增加模型回调采纳机制、源码摘要白名单或库侧配置；不改变活动 runtime、Generator、注册阶段边界或唯一事务。过程模型、自动子块、异步任务和媒体引用仍按原 N3 边界处理。实现与验证见 [原生主线第 10 节](./abs-native-runtime-execution-plan.md)。

### 0.17 2026-09-16 补充：混合模型准备与普通项目加载

N3-b 允许已有可信纯准备器继续负责过程/自定义函数节点，候选只为未知节点发现结构；内部 hosted 记录不进入 ABS/map，也不授予跳过完整 ABI/Generator 读回的许可。跨边界连接在最终完整工作区验证，未归属模型和自动子块仍拒绝。

候选按与主程序相同的时机复用旧过程 Generator 输入适配，移除对所有内置 init 的提前包装，避免破坏来源证明。普通 `loadWorkspaceJson` 复用声明顺序整理已知字段，修复动态字段早于配置字段被忽略的入口；无声明 JSON 的 JS-only 块仍需后续覆盖。实际活动 runtime、模型同步器、租约及保存链未替换。详见 [原生主线第 11 节](./abs-native-runtime-execution-plan.md)。

### 0.18 2026-09-16 补充：原生字段加载边界统一

普通项目加载、ABS 分片装载和候选完整 ABI 验证共用 `blockly-native-field-loading`，在原生 extraState/父连接之后、子输入之前按实际字段结构恢复保存值。独立模块只临时包装本次 workspace 的创建关联及 detached state 字段读取，不改全局注册表/原型，不运行 probe init，不跨异步任务持有适配。既有 argsN/原生构造顺序仍优先；多级动态字段、同名字段重建及下拉选项未就绪有通用推进/失败边界。

移除第 0.17 节临时使用的普通声明预排序路径。原生装载重建的内存 shadow 默认状态保留本次实际加载顺序，防止断开重生再次丢字段；不增加 ABS/map 或持久化元数据。正式提交的完整读回、模型效果拒绝、活动 Generator 与资源会话边界均不放宽。实现、限制与验证见 [原生主线第 12 节](./abs-native-runtime-execution-plan.md)。

### 0.19 2026-09-16 补充：同步默认子块的临时归属

同步 init/extraState/field.loadState 的新块归属由独立 `blockly-native-block-effects` 记录。候选只有在用户明确覆盖输入、且整个临时实块子树均属当前调用且没有请求块混入时才可清理；未知模型、游离根块、未准备 shadow 和 Generator 副作用仍拒绝。显式已有模型可复用，不能删除新模型以“修复”结果。

加载适配更名为 `blockly-native-state-loading`，完整 ABI 以保存连接为权威；初始化默认块不能替换已保存子块或重新填满空输入。补齐此前遗漏的非分片 ABS 加载入口，与分片、普通加载和候选完整验证共用同一模块。临时创建/方法包装始终按同步作用域清理，无持久化元数据、库侧修改或活动 runtime 替换。任意自动状态采纳和异步任务仍待 N3 后续实现，详见 [原生主线第 13 节](./abs-native-runtime-execution-plan.md)。

### 0.20 2026-09-16 补充：新实例默认子树的持久化证明

N3-b 在同一个一次性候选 Realm 内记录默认块创建，ID 在 init 前注入；第二次绑定重放同一临时创建记录并核对完整默认输入/子树及合同。没有增加 active runtime、库侧模板或持久化 schema。新 owner 可采纳有连接归属的省略输入、可见 shadow 及被显式子块覆盖的 fallback；已有 owner 始终以原 ABI 身份和数据为准。

显式调用及默认子块共用实例合同采集；纯合并之后继续原 Project Data、完整 ABI/实际 Generator、宿主租约/CAS。默认 payload 无源字面量的处理仅按新接纳子块身份豁免源替换，未放宽用户 literal 校验。额外根块/模型、未观察 serializer 状态、异步/I/O 仍拒绝。实现、证据与未完成范围见 [原生主线第 14 节](./abs-native-runtime-execution-plan.md)。

### 0.21 2026-09-16 补充：原生隐藏 shadow 生命周期

N3-b 在一次性候选的同步 owner 作用域中观察原生 shadow 销毁前的实际状态。当前 Blockly 设置隐藏 shadow 时本就临时实例化并销毁；本次记录这段生命周期，不再创建探测实例或执行额外库初始化。最终连接缓存必须与同 owner 的退役实例快照、完整子树及合同一致，嵌套缓存复用相同证据规则；无实例证据、跨 owner 借用、缓存篡改和未知模型仍拒绝。

原生销毁后按保存 ID 重建是合法生命周期，创建日志允许该 ID 再次出现，但构造前拒绝与活块冲突。观察 serializer/contract 时暂停创建归属，getter 副作用不能获得默认块身份。实例方法包装在原生销毁前恢复，候选清理不产生可采纳证据；没有修改活动 runtime、全局原型、库或 ABS/map schema。

隐藏大文本/数组仍经既有 Project Data 外置、materialize 及唯一 ABS 提交链。新 owner 采纳最终 fallback，已有 owner 保留原 ABI 状态；完整 ABI/真实 Generator、两次身份重放和宿主 CAS 均未放宽。711 项 ABS 与 9 项项目加载回归及构建通过，真实 Agent/固件编译仍须独立验收。详见 [原生主线第 15 节](./abs-native-runtime-execution-plan.md)。

### 0.22 2026-09-16 补充：有限注册任务与真实 Agent 准入

完整 runtime 重放暴露了未使用库也会执行的注册定时任务。一次性候选新增独立 `NativeRegistrationTasks`：注册阶段真实 one-shot timer 按待运行/运行中任务归零完成，支持嵌套与取消，限制总数、单次/累计延时，失败清理所有句柄；不固定 sleep、不滤库、不改 active runtime 的任务模型。完成后封闭注册，配置/Generator 定时器、interval、Promise continuation、I/O 和未归属模型仍拒绝。

只读能力查询在完整 runtime 可捕获且请求策略允许时返回 `validate/native-sync-v1`，允许 Agent 提交原生验证而非提前承诺块类型能力。主程序与 lex 规则一致，不修改 ABS/map schema、用户库或唯一保存事务。真实 Agent 已从空白板卡通过两类动态块新建、两次配置切换、保存重开；真实 LLM 也已自主完成 MAX31865 硬件 SPI 新建→软件 SPI 变形、两次正式固件编译及外置文本保存重开。正式编译同时修复旧预处理依赖误用于新代码的问题；证据与未开放的 N3 边界统一记录在 [原生主线第 16 节](./abs-native-runtime-execution-plan.md)。

### 0.23 2026-09-16 补充：媒体资源只读快照与共享投影

候选资源准备扩展为复用 Store 的全部引用发现，宿主在原会话/租约内解析通用大值和媒体引用，仅复制描述与已解析值。一次性 Realm 不连接宿主 Store、文件或服务；每次读取返回副本，缺失、冲突或被捕获的读取错误仍使候选失败。最终合并 ABI 再准备一份覆盖隐藏状态的快照，不能只检查 ABS 显式字段。

来源日志保留定义的 libraryName；候选复用主程序 Project Data 槽位登记和 Generator 投影，不二次改写已装饰的 JSON。内置媒体字段将视图订阅/预览留在视图生命周期，修正 headless 销毁产生空异步提交与可选来源属性输出 undefined 的问题。需要 prepareForCodeGeneration 异步派生缓存的字段仍明确拒绝；不把原始字节存在当作完成解码的证据。

字段和 extraState 的候选读回复用 canonical JSON 比较，避免正式 ABS 导出排序与原生对象属性顺序不同造成误拒绝；数组顺序和全部值仍须相同。宿主/候选也共用字段单引用选择器，不分别猜测 JSON 字符串中的对象或数组。

active runtime、项目 checkpoint、ABS 语法、唯一保存事务及库包均不变。验收结果和已交付/未开放边界集中在 [原生主线第 17 节](./abs-native-runtime-execution-plan.md)，不再以按库追加模板作为后续主线。

### 0.24 2026-09-17 补充：可信字段准备与派生缓存归属

第 0.23 节的原始字节快照不等于异步派生结果。最终候选 ABI 验证现在只调用主程序模块私有注册表中、与原始字段钩子函数身份一致的准备器；它只收到当前快照 reader，前后必须完整 ABI 读回。未知/替换钩子仍拒绝，库配置和 Generator 本身仍必须同步。

内置图片预览字段复用一个独立解码/缩放模块；仅使用 data URI 和解码完成事件，错误、5 秒超时或超过 16M 像素上限拒绝，不发布部分尺寸缓存。缓存由 Field 弱引用持有，发布前检查 owner 和资源、dispose 释放。活动项目 iframe 和候选均用同一 `tftImageCache` getter 读取当前 workspace 的资源 ID 视图，原文件名只作持久化/界面信息，同名图片不再覆盖。过期活动 runtime 无权读取；候选自己解码复制的资源字节，不接收宿主 DOM 或函数。

候选 CSP 仅新增 `img-src data:`，网络/文件及任意库异步权限不变。没有修改库包或 ABS/map/ABI schema，也没有新提交通道。实现、验收与收口边界见 [原生主线第 18 节](./abs-native-runtime-execution-plan.md)。

### 0.25 2026-09-17 补充：撤回通用异步实验，稳定现行边界

保留项目级 runtime 生命周期、候选有限注册定时器和主程序可信字段准备；撤回候选源码 async 改写、Promise/microtask 通用调度、配置异步尾任务和未知字段准备钩子执行。动态结构继续由同步原生配置与完整读回证明，不将任意异步结构加载作为 ABS 落地条件。配置/Generator 中的不支持效果即使被捕获也使候选失败。活动 runtime、租约/CAS、Project Data 和唯一保存链不变。决策、清理与本轮验证见 [原生主线第 19 节](./abs-native-runtime-execution-plan.md)。

### 0.26 2026-09-17 补充：候选中性 UI 任务与真实图形环境边界

第 0.25 节“不恢复任意异步结构”的决策不变。候选不再一律拒绝配置阶段函数型 one-shot timer，而以独立、有界、虚拟同步队列检查每个回调的持久化/结构/字段约束不变，并在最终 ABI 验证中比较实际代码及生成头文件。只允许已观察到的中性 UI 效果；Promise、网络、循环调度、生成阶段 timer 和真正依赖延后任务的结构仍拒绝。注册计时器、活动 runtime 生命周期、唯一租约/CAS/保存链不变。

aily_iic 进一步暴露 headless 与真实 BlockSvg 的差异：默认 shadow 在 `initSvg/render` 处中断，无法靠等待解决。通用方向是隔离图形候选的原生 API 一致性，尚未实现；禁止按库名补连接、删除孤立 shadow 或注入空 UI 方法掩盖问题。实现与证据见 [ABS 主线第 22 节](./abs-native-runtime-execution-plan.md#22-2026-09-17-抽查缺口修复与-i²c-环境一致性定位)。

补充原生对照：第 23.2 节的独立真实 WorkspaceSvg 页面可同步完成完整 I²C 库的 SLAVE 地址默认连接，进一步排除了“必须异步加载”的解释。“I²C 从站模式”不等于“从站视图”；正常主编辑区不新增第二种加载方式，待补齐的是独立验证候选的图形生命周期。第 23.1 节的批量编辑溯源仅扩展纯身份合并，不改变项目 runtime、候选隔离或唯一提交链。

### 0.27 2026-09-17 补充：隔离候选接入真实图形生命周期

第 0.26 节的图形环境待办已进入生产候选：`blockly-native-graphics` 使用实际 `Blockly.inject` 创建独立 WorkspaceSvg；屏外定尺寸 iframe 保证几何测量，不再使用隐藏的 headless Workspace。字段/模型绑定后才初始化视图，使用原生批量加载的连接追踪暂停避免自动推开 scratch 根块。原生连接、创建归属、shadow 证据、身份重放与完整读回仍是同一条链。

requestAnimationFrame 接入已有有界、语义中性的虚拟 UI 队列，不另建通用异步执行器；Promise/网络/任意异步结构依然拒绝。媒体字段只有在项目 Store 已配置时才主动进行编辑器资源加载，候选继续依赖私有资源快照和可信准备器，不能因有 SVG 就取得项目服务权限。图形候选不是活动主题和交互插件的完整镜像，库无需增加适配声明。

详细实施及最终验收以 [ABS 原生主线第 24 节](./abs-native-runtime-execution-plan.md#24-2026-09-17-隔离候选原生图形生命周期接入) 为准；早期失败/控制实验仍保留为历史证据。当前修改不改变 active runtime、ABS/map schema 或唯一保存事务。

### 0.28 2026-09-17 补充：当前收口不重启任意异步

任意异步结构已经排除出当前收口范围，不将“不承诺任意异步”重新列为未完成计划。第 0.27 节的同步原生图形候选、有限中性 UI 任务及可信资源准备保持，本批没有修改候选调度器。Agent 编辑证据新增可丢弃、绑定实际草稿身份的跨进程私有缓存；仍需宿主精确重放与原有 generation/读回/提交链，不扩大 runtime 权限。user-center 的 4 处 Auth 深层引用改走既有公共入口；实施及验收见 [ABS 主线第 25 节](./abs-native-runtime-execution-plan.md#25-2026-09-17-范围校正跨进程编辑证据与架构引用收口)。

## 目录

- [1. 背景](#1-背景)
- [2. 当前实现与根因](#2-当前实现与根因)
- [3. 两个真实项目的兼容性约束](#3-两个真实项目的兼容性约束)
- [4. 目标与非目标](#4-目标与非目标)
- [5. 核心架构](#5-核心架构)
- [6. Runtime Service 设计](#6-runtime-service-设计)
- [7. iframe Realm](#7-iframe-realm)
- [8. fresh Generator](#8-fresh-generator)
- [9. iframe 能力桥接](#9-iframe-能力桥接)
- [10. ProjectService 路径绑定代理](#10-projectservice-路径绑定代理)
- [11. Blockly facade 与宿主注册表 journal](#11-blockly-facade-与宿主注册表-journal)
- [12. Workspace listener](#12-workspace-listener)
- [13. Timer 与异步资源](#13-timer-与异步资源)
- [14. 项目运行时依赖解析](#14-项目运行时依赖解析)
- [15. 单库加载事务](#15-单库加载事务)
- [16. 项目切换时序](#16-项目切换时序)
- [17. 宿主全局函数迁移](#17-宿主全局函数迁移)
- [18. 库新增、删除和升级](#18-库新增删除和升级)
- [19. 文件级改造范围](#19-文件级改造范围)
- [20. 分阶段实施](#20-分阶段实施)
- [21. 测试方案](#21-测试方案)
- [22. 可观测性](#22-可观测性)
- [23. 风险与缓解](#23-风险与缓解)
- [24. 验收标准](#24-验收标准)
- [附录 A：当前关键代码入口](#附录-a当前关键代码入口)
- [附录 B：建议验证命令](#附录-b建议验证命令)
- [25. 最终结论](#25-最终结论)

## 1. 背景

当前应用在同一个 Electron Renderer 页面中依次打开不同 Blockly 项目时，库的 `generator.js` 会被插入主页面执行。脚本执行完成后，顶层词法绑定、`window.*`、Generator 对象属性、Blockly Extensions、workspace listener 和异步任务都会继续留在 Renderer 的全局运行环境中。

复现场景：

- 项目 A：`C:\Users\coloz\Documents\aily-project\xz32s3_xiaozhi_extend_199830`
- 项目 B：`C:\Users\coloz\Documents\aily-project\project_xzEsp32S3_586313`
- 先打开项目 A，再打开项目 B。
- 项目 A 所需库的 `generator.js` 状态没有完整释放。
- 项目 B 加载时复用或覆盖项目 A 留下的对象、数组、函数和 Blockly 注册项，最终错误地使用了项目 A 的库行为。

整页 `location.reload()` 虽然可以销毁 Renderer 的 JavaScript Realm，但正式打包后的应用刷新会破坏应用启动和资源加载流程，因此不能作为解决方案。

本方案改为：**只重建 Blockly 项目运行时，不刷新 Electron Renderer 和 Angular 页面。**

## 2. 当前实现与根因

### 2.1 当前加载链路

当前大致链路如下：

```text
ProjectService.projectOpen()
  -> BlocklyEditorComponent.loadProject()
  -> 扫描已安装库
  -> BlocklyService.loadLibrary()
  -> BlocklyService.loadLibraryInternal()
  -> 主 document.head 插入 <script src="file:///.../generator.js">
  -> generator.js 直接修改父页面全局对象
```

当前 `loadLibGenerator()` 的核心行为是：

1. 加载前读取 Arduino/MPY 中已有的 generator key。
2. 把 `generator.js` 作为 `<script>` 添加到父页面。
3. 加载后再次读取 generator key。
4. 只把新出现的 key 记入 `loadedGenerators`。

这种做法无法识别“覆盖已有同名 key”的情况。实际验证中，项目 B 的 `esp32-xzai` 最终有 53 个 generator key，其中只有 9 个会被当前算法识别为新增，另外 44 个同名覆盖不会被记录归属。

### 2.2 删除 script 标签不能撤销脚本副作用

移除 `<script>` 标签只会删除 DOM 节点，不会撤销已经发生的副作用，包括：

- 顶层 `var`、`function`、`let`、`const`、`class`。
- `window.*` 和隐式全局变量。
- `Arduino.forBlock` / `MPY.forBlock`。
- `Arduino.workspaceToCode` 等被覆盖的方法。
- Generator 上附加的 Map、Set、标记和辅助函数。
- `Blockly.Extensions`、Mutator、Mixin。
- `Blockly.Msg` 修改。
- workspace change listener。
- `setTimeout` 和其他延迟任务。
- 闭包中保存的旧项目数据。

### 2.3 当前 reset 范围和实际写入面不一致

当前 `reset()` 存在以下不足：

- 在基于归属恢复之前就清空 `loadedGenerators`。
- 主要清理 `Blockly.Arduino`、`Blockly.Python` 等属性，而库实际注册到 `window.Arduino`、`window.MPY`。
- 只按函数 key 删除，无法恢复被覆盖的旧函数。
- 不处理 Generator 的非函数直属属性。
- 不处理 Extensions、Mutator、Mixin、Msg、registry。
- 不处理项目级 `window.*`。
- 不处理 listener、timer 和已经开始的异步 Promise。

因此继续给 `reset()` 增加更多 `delete window.xxx` 只能缓解已知案例，不能建立可靠的生命周期边界。

## 3. 两个真实项目的兼容性约束

对两个项目中实际安装的 `generator.js` 进行只读扫描后，得到以下结果：

| 行为 | 项目 A | 项目 B | 设计影响 |
|---|---:|---:|---|
| `generator.js` 文件数 | 13 | 11 | 需要确定的项目级加载顺序 |
| `Arduino.forBlock` 赋值 | 197 | 264 | 必须使用项目级全新 Generator |
| Arduino 直属属性类型 | 11 | 20 | 不能只清理 `forBlock` |
| `setTimeout` | 31 | 35 | 需要 session resource ledger |
| workspace `addChangeListener` | 8 | 9 | iframe 销毁前必须释放 workspace/listener |
| Extension `register` | 17 | 20 | 必须回滚宿主 Blockly 注册表 |
| `registerMutator` | 3 | 3 | 必须回滚宿主 Blockly 注册表 |
| `registerMixin` | 1 | 1 | 必须回滚宿主 Blockly 注册表 |
| `Blockly.Msg` 写入 | 11 个 key | 1 个 key | 需要 overlay 或属性恢复 |

扫描未发现两个项目的 generator 使用以下能力：

- `require`、`module`、`exports`、`process`
- `eval`、动态 `Function`
- `globalThis`
- DOM `addEventListener/removeEventListener`
- `Blockly.registry` 或 ContextMenuRegistry 写入

虽然当前项目没有使用所有能力，宿主桥接仍应为未来库预留 registry 和 resource 记录接口。

### 3.1 项目内必须保留 classic script 全局共享

不能把每个库分别包进 `Function` 或 IIFE，因为当前库之间存在裸全局调用：

- `lib-core-variables` 顶层定义：
  - `registerVariableToBlockly`
  - `renameVariableInBlockly`
  - `isBlockConnected`
- `lib-core-serial`、`lib-dht`、`lib-esp32-xzai` 直接调用这些函数，没有通过 `window.xxx` 或模块导入。
- 项目 B 中 `lib-lvgl` 顶层定义 `ensureLvglLib`，`lib-esp32-xzai` 直接裸调用它。

此外，现有库包含非严格模式下的隐式全局赋值。loader 不能自动添加 `"use strict"`。

因此必须满足：

> 同一项目内的所有 generator 继续作为 classic script 在同一 Realm 中执行；不同项目使用不同 Realm。

### 3.2 必须隔离的典型项目状态

实际库会写入：

- `window.mcpControlParams`
- `window.aivoxControlServices`
- `window.mcpServiceParamMap`
- `window.customSerialPorts`
- `window.ENTRY_BLOCK_TYPES`
- 多个串口、变量和调试辅助函数
- `Arduino.workspaceToCode`
- `Arduino.dhtTypeMap`
- `Arduino.esp32Tasks`
- `Arduino.getTaskFuncName`
- `Arduino.getAllAivoxControlServices`
- 多个 `Arduino.lvgl*` 状态

项目 B 的 `esp32-xzai` 还存在顶层 `const EMOTION_ICON_MAP`。在同一 Realm 重复加载时会触发：

```text
SyntaxError: Identifier 'EMOTION_ICON_MAP' has already been declared
```

这些状态都不适合通过名称黑名单人工清理。

## 4. 目标与非目标

### 4.1 目标

1. 项目 A 打开后再打开项目 B，B 的运行状态与直接冷启动 B 完全一致。
2. 不调用 `location.reload()`、`window.location` 刷新或 Electron Renderer 重载。
3. 不修改任何库包的 `generator.js`、`block.json` 或 `toolbox.json`。
4. 保持现有 classic script、非严格模式和跨库裸全局函数的兼容性。
5. 每个项目激活周期使用全新的 Arduino/MPY Generator。
6. 项目退出后恢复宿主 Blockly 注册表到进入项目前的状态。
7. 旧项目的 timer、listener、Promise continuation 和异步库加载不能修改新项目。
8. 库安装、删除、升级时可以在当前页面内重建项目运行时。
9. 错误日志可以定位到具体项目、session、库、版本和 `generator.js` 路径。

### 4.2 非目标

1. 本方案不是恶意代码安全沙箱。同源 iframe 仍可能访问 `parent`/`top`。
2. 第一阶段不支持任意顺序的单库无损卸载。
3. 不把现有库一次性迁移为 ESM。
4. 不为每个库创建独立 Realm，因为这会破坏项目内全局协作。
5. 不重写整个 Blockly 工作区和注册机制。

### 4.3 方案选型

| 方案 | 结论 | 原因 |
|---|---|---|
| 浏览器/Renderer 整页 reload | 拒绝 | 正式安装包刷新会破坏应用启动和资源加载 |
| 继续扩充 `reset()` 的全局名称黑名单 | 拒绝 | 无法清除顶层 lexical binding，也无法覆盖未来库的未知写入 |
| 删除父页面 `<script>` 标签 | 拒绝 | 不会撤销已经执行的副作用 |
| 每个库一个 Function/IIFE | 拒绝 | 破坏现有跨库裸全局函数和非严格模式契约 |
| 每个库一个 iframe | 拒绝 | 项目内库无法共享变量和顶层 helper |
| Web Worker | 拒绝 | Blockly generator 需要同步访问 DOM、Block 和宿主对象 |
| Node `vm.Context` | 暂不采用 | 可以隔离词法环境，但 DOM、Angular Zone 和跨 context 宿主对象兼容成本更高 |
| 每项目一个 hidden iframe Realm | 采用 | 最接近当前浏览器 classic script 语义，并可通过移除 iframe 销毁整个 Realm |

## 5. 核心架构

```text
Electron Renderer / Angular Application
│
├─ ProjectService
│    └─ 项目切换、路径、锁和路由
│
├─ BlocklyEditorComponent
│    └─ 项目加载编排、workspace 生命周期
│
├─ BlocklyGeneratorRuntimeService
│    ├─ 当前 session / epoch
│    ├─ fresh ArduinoGenerator / MicroPythonGenerator
│    ├─ IframeGeneratorRealm
│    ├─ BlocklyBridge
│    ├─ HostRegistryJournal
│    └─ RuntimeResourceBag
│
├─ Host Blockly
│    ├─ Workspace
│    ├─ Blocks
│    ├─ Extensions / Mutators / Mixins
│    ├─ Msg / registry / field registry
│    └─ toolbox
│
└─ hidden iframe: Project Generator Realm
     ├─ 当前项目全部 classic generator.js
     ├─ 项目级 window / global lexical environment
     ├─ session i18n / boardConfig
     ├─ 受控 Blockly facade
     └─ 受控 projectService / timer / workspace 能力
```

### 5.1 关键原则

- iframe 负责隔离 JavaScript Realm、顶层词法绑定和 `window.*`。
- fresh Generator 负责隔离 Arduino/MPY 的可变对象状态。
- Blockly facade 和 journal 负责隔离仍然位于父页面的 Blockly 注册表。
- resource bag 和 epoch 负责隔离异步任务。
- workspace dispose 负责释放 block、field、validator 和 change listener 闭包。

以上几项缺一不可。

## 6. Runtime Service 设计

建议新增：

```text
src/app/editors/blockly-editor/services/blockly-generator-runtime.service.ts
```

建议公开接口：

```ts
export type GeneratorMode = 'arduino' | 'micropython';

export interface GeneratorRuntimeContext {
  projectPath: string;
  mode: GeneratorMode;
  boardConfig: unknown;
  packageJson: unknown;
  getWorkspace: () => Blockly.WorkspaceSvg | null;
  macroService: ProjectMacroService;
}

export interface GeneratorSource {
  packageName: string;
  version: string;
  filePath: string;
  source: string;
  i18n?: unknown;
}

export interface GeneratorLoadResult {
  packageName: string;
  filePath: string;
  arduinoBlockTypes: string[];
  mpyBlockTypes: string[];
  extensionNames: string[];
  globalNames: string[];
}

export class BlocklyGeneratorRuntimeService {
  preflight(projectPath: string): Promise<RuntimePreflightResult>;
  begin(context: GeneratorRuntimeContext): Promise<string>;
  loadGenerator(sessionId: string, source: GeneratorSource): Promise<GeneratorLoadResult>;
  rebuild(context: GeneratorRuntimeContext, sources: GeneratorSource[]): Promise<string>;

  getActiveGenerator(): ArduinoGenerator | MicroPythonGenerator | null;
  generateCode(workspace: Blockly.Workspace): string;

  updateBoardConfig(sessionId: string, boardConfig: unknown): void;
  updatePackageJson(sessionId: string, packageJson: unknown): void;
  invokeGlobal<T>(sessionId: string, name: string, ...args: unknown[]): T | undefined;

  deactivate(sessionId: string): void;
  destroy(sessionId: string): Promise<void>;
}
```

内部建议拆分为以下非 Angular 类：

```ts
class IframeGeneratorRealm {}
class BlocklyBridgeFactory {}
class BlocklyHostRegistryJournal {}
class RuntimeResourceBag {}
class LibraryLoadTransaction {}
```

### 6.1 Session 数据结构

```ts
interface ProjectGeneratorSession {
  id: string;
  epoch: number;
  projectPath: string;
  mode: GeneratorMode;
  state: 'creating' | 'loading' | 'active' | 'disposing' | 'disposed' | 'tainted' | 'failed';

  realm: IframeGeneratorRealm;
  arduino?: ArduinoGenerator;
  micropython?: MicroPythonGenerator;
  activeGenerator: ArduinoGenerator | MicroPythonGenerator;

  journal: BlocklyHostRegistryJournal;
  resources: RuntimeResourceBag;
  libraries: Map<string, LoadedGeneratorLibrary>;
}
```

同一路径的项目 reload 也必须创建新的 sessionId 和 iframe，不能因为 projectPath 相同而复用 Realm。

Session 不变量：

- 任意时刻最多只有一个 `active` session。
- sessionId、epoch 和 projectPath 在 session 创建后不可变。
- `loadedLibraries`、`loadedGenerators`、`libraryLoadTasks`、toolbox owner 等状态全部归属 session，不能继续作为服务进程生命周期状态。
- project ABI 只能在所有声明库、Blocks、Extensions 和 toolbox 提交完成后反序列化。
- session 进入 `disposing/tainted/failed/disposed` 后，任何 facade 都不得再写宿主状态。

## 7. iframe Realm

### 7.1 创建

```ts
const iframe = document.createElement('iframe');
iframe.hidden = true;
iframe.tabIndex = -1;
iframe.setAttribute('aria-hidden', 'true');
iframe.srcdoc = '<!doctype html><html><head></head><body></body></html>';
document.body.appendChild(iframe);
await waitForIframeLoad(iframe);

const realmWindow = iframe.contentWindow!;
```

注意：

- 不设置会阻止父页面访问的 sandbox。
- iframe 是生命周期隔离边界，不是安全沙箱。
- iframe 必须由 RuntimeService 持有并在 session destroy 时移除。
- 父页面不得保存 child function、Window 或 DOM 的长期引用。

### 7.2 classic script 执行

宿主先读取 `generator.js` 源码，然后在 iframe document 中添加内联 classic script：

```ts
const script = realmWindow.document.createElement('script');
script.type = 'text/javascript';
script.dataset.generatorPath = source.filePath;
script.textContent =
  source.source +
  `\n//# sourceURL=${toFileSourceUrl(source.filePath)}`;

realmWindow.document.head.appendChild(script);
```

这样可以：

- 保留 classic script 顶层声明语义。
- 保留跨库裸全局函数。
- 避免逐库 Function/IIFE 导致的作用域变化。
- 避免 `file://` 路径编码、缓存和异步加载竞态。
- 通过 `sourceURL` 保留可读堆栈。

内联 classic script 在 append 时同步执行，不能依赖元素 `onload` 作为成功依据。append 前应临时监听 iframe `error`，记录 filename、line、column 和当前 transaction；异步 `unhandledrejection` 作为 session 级诊断单独处理。

加载时临时监听 iframe 的 `error` 和 `unhandledrejection`，将跨 Realm 错误转换为普通结构：

```ts
interface RuntimeScriptError {
  name: string;
  message: string;
  stack?: string;
  filePath: string;
  packageName: string;
  sessionId: string;
}
```

跨 Realm Error 不应依赖 `error instanceof Error`。

### 7.3 禁止的执行方式

不得使用：

```ts
new realmWindow.Function(source)();
```

不得自动包裹：

```ts
(() => {
  // generator source
})();
```

不得自动添加：

```js
"use strict";
```

这些方式都会破坏现有库的顶层函数、隐式全局和跨库调用契约。

### 7.4 预检与 tainted Realm

在销毁旧项目之前，先完成只读预检：

- 当前项目 `package.json` 可解析。
- 声明的库路径存在。
- `block.json`、`toolbox.json`、i18n 可解析。
- `generator.js` 可读取。
- 使用仓库已有 Acorn 依赖完成语法解析。
- 版本、包名和实际路径一致。

如果 generator 顶层运行时执行到一半后抛错，当前 Realm 必须标记为 `tainted`。原因是顶层 lexical binding 可能已经创建，无法可靠地逐项删除。

处理方式：

1. deactivate 当前 session。
2. 回滚宿主 journal。
3. 清理资源和 workspace。
4. 删除 iframe 和 Generator。
5. 创建新 session。
6. 按确定顺序重放此前已确认的库。

不能在 tainted Realm 中直接重试同一个 generator。

### 7.5 第一阶段不做并行热切换

可以在旧项目仍然 active 时完成文件读取、JSON 校验和 Acorn 语法预检，但第一阶段不在旧 workspace 仍运行时执行新项目 generator。

原因是现有 generator 会在顶层直接调用 `Blockly.getMainWorkspace()` 并添加 listener。如果把新项目脚本预执行到旧 workspace，会让新项目状态读取或修改旧项目 block；如果为此构造完整 staging workspace，则会显著扩大改造范围。

因此第一阶段采用：

```text
旧项目 active
  -> 只读 preflight 新项目
  -> 显式销毁旧 runtime/workspace
  -> 创建新 runtime/workspace
  -> 执行新项目 generator
```

新项目执行失败时进入干净错误状态并销毁 tainted session，不通过整页刷新恢复。后续如确实需要“新项目失败后旧项目继续可用”，可以再增加独立 staging workspace，但它不是本问题的必要条件。

## 8. fresh Generator

### 8.1 工厂化

Arduino 和 MicroPython Generator 改为每 session 创建：

```ts
export function createArduinoGenerator(): ArduinoGenerator {
  return new ArduinoGenerator();
}

export function createMicroPythonGenerator(): MicroPythonGenerator {
  return new MicroPythonGenerator();
}
```

模块单例可以在迁移期保留为 deprecated 导出，但生产代码不得继续使用。

### 8.2 修复类内部的单例自引用

当前两个 Generator 的 `getValue()` 等方法仍直接引用模块单例：

```ts
arduinoGenerator.statementToCode(...)
arduinoGenerator.valueToCode(...)
arduinoGenerator.nameDB_.getName(...)
```

必须改为：

```ts
this.statementToCode(...)
this.valueToCode(...)
this.nameDB_.getName(...)
```

MicroPython 同理。否则即使外部创建了新实例，部分代码路径仍会绕回旧单例。

### 8.3 统一代码生成入口

以下调用方停止直接 import `arduinoGenerator`：

- BlocklyComponent
- Blockly BuilderService
- Blockly UploaderService
- Blockly Editor ProjectService
- Arduino lint service
- AI editBlockTool
- 其他直接调用 `workspaceToCode()` 的代码

统一改为：

```ts
const code = generatorRuntime.generateCode(workspace);
```

或在确实需要 Generator API 时：

```ts
const generator = generatorRuntime.getActiveGenerator();
```

父页面不再设置真实的：

```ts
window.Arduino
window.MPY
window.MicropPython
```

这些对象只注入当前项目 iframe。

## 9. iframe 能力桥接

建议注入：

| 能力 | 注入值 | 说明 |
|---|---|---|
| `Blockly` | session-bound facade | 普通类/函数转发，可变注册面受控 |
| `Arduino` | 当前 session 新实例 | Arduino 模式 |
| `MPY` / `MicropPython` | 当前 session 新实例 | MicroPython 模式 |
| `boardConfig` | 当前项目深拷贝 | board 切换时显式更新；禁止直接引用宿主可变对象 |
| `packageJson` | 当前项目深拷贝 | 如未来 generator 需要 |
| `__BLOCKLY_LIB_I18N__` | session 独立对象 | 不再写父 window |
| `pinyinPro` | 只读宿主能力 | 项目 A 使用 |
| `projectService` | 路径绑定窄代理 | 只暴露实际需要的宏 API |
| `global` | 指向 iframe window | 兼容浏览器/Node fallback 写法 |
| timer APIs | session resource wrapper | 追踪、取消、epoch guard |
| `console` | 可选 session-tagging facade | 日志自动携带 session/package 信息 |

不得注入：

- `require`
- `process`
- `module`
- 原始、可变的完整 ProjectService
- 父页面真实 window 作为 child window 替代品

iframe 自己的 `window`、`self`、`globalThis`、`document` 必须保持为 child Realm 对象。

`boardConfig` 建议使用 `structuredClone()` 或现有安全 JSON clone。串口库可能写入派生字段，不能让这些修改反向污染根 ProjectService 保存的 board 配置。`updateBoardConfig()` 也只能更新当前 active session 的 clone。

当前 `lib-core-text` 只使用一次 `document.createElement('mutation')`。child document 生成的节点需要加入 Blockly XML 序列化烟测。

## 10. ProjectService 路径绑定代理

LVGL 等库可能在延迟回调中调用 `projectService.addMacro/removeMacro`。如果直接暴露根 ProjectService，旧回调可能在项目路径切换后修改新项目。

建议增加显式路径 API：

```ts
addMacroForProject(projectPath: string, macro: string): Promise<void>;
removeMacroForProject(projectPath: string, macroName: string): Promise<void>;
```

iframe 获得的代理：

```ts
const macroFacade = {
  addMacro: (macro: string) => {
    assertSessionActive(session.id);
    return projectService.addMacroForProject(session.projectPath, macro);
  },
  removeMacro: (name: string) => {
    assertSessionActive(session.id);
    return projectService.removeMacroForProject(session.projectPath, name);
  },
};
```

每次 await 前后都验证 sessionId/epoch。

## 11. Blockly facade 与宿主注册表 journal

### 11.1 为什么 iframe 仍然不够

`Arduino` 可以是项目独立实例，但 Blockly Workspace、BlockSvg 和注册表仍在父页面。generator callback 必须操作真实父页面 block，因此不能用 structured clone 或 `postMessage`。

如果直接把完整宿主 Blockly 裸注入 iframe，以下状态仍然会跨项目泄漏：

- Extensions、Mutator、Mixin
- Blocks
- Msg
- registry、field registry
- context menu
- workspace listener

因此需要 facade 和 journal。

### 11.2 Journal 数据结构

```ts
interface RuntimeOwner {
  sessionId: string;
  projectPath: string;
  packageName: string;
  version: string;
  libraryPath: string;
}

interface JournalEntry {
  sequence: number;
  owner: RuntimeOwner;
  surface: string;
  key: PropertyKey;
  before: PropertyDescriptor | RegistryValue | Absent;
  after: PropertyDescriptor | RegistryValue | Absent;
  undo(): void;
}
```

必须保存修改前值，而不是只保存新增 key：

```ts
if (entry.before === ABSENT) {
  Reflect.deleteProperty(target, entry.key);
} else {
  Object.defineProperty(target, entry.key, entry.before);
}
```

回滚前验证当前值仍等于 `after`。如果不一致，说明存在新的 owner 或越界写入，禁止盲目覆盖，直接触发整个 runtime rebuild。

### 11.3 Blockly facade

```ts
const sessionBlockly = new Proxy(Blockly, {
  get(target, key) {
    assertSessionReadable(session);

    if (key === 'Blocks') return blocksProxy;
    if (key === 'Msg') return msgProxy;
    if (key === 'Extensions') return extensionsFacade;
    if (key === 'registry') return registryFacade;
    if (key === 'fieldRegistry') return fieldRegistryFacade;
    if (key === 'ContextMenuRegistry') return contextMenuFacade;
    if (key === 'getMainWorkspace') return getSessionWorkspace;
    if (key === 'defineBlocksWithJsonArray') return defineBlocksWithJournal;

    return Reflect.get(target, key);
  },
});
```

普通构造器继续转发真实宿主对象。例如 `Blockly.BlockSvg` 必须保持父页面真实构造器，保证：

```js
block instanceof Blockly.BlockSvg
```

仍然成立。

### 11.4 各注册面处理

| 注册面 | 处理方式 |
|---|---|
| `Arduino/MPY.forBlock` | fresh Generator 为主；每库事务记录新增/覆盖用于诊断 |
| Generator 直属属性 | fresh Generator 整体丢弃，不逐项 delete |
| `Blockly.Blocks` | 保存每个 type 修改前 descriptor，退出时恢复 |
| `Extensions.register` | 保存旧 extension，记录新 callback |
| `registerMutator/registerMixin` | 与 Extension 同一个 journal |
| `Extensions.unregister` | unregister 前保存旧 callback |
| `Blockly.Msg` | Proxy 记录写入前 descriptor |
| 通用 registry | 记录 type + name + 旧 item |
| field registry | 按 Blockly registry FIELD 类型记录 |
| ContextMenuRegistry | register/unregister 前读取旧 item；拒绝项目调用全局 reset |
| toolbox | 按 session/library owner 标记，事务提交后统一更新 |

Blockly 11.2.2 的 Extensions 没有公开 getter，只能通过：

```ts
Blockly.Extensions.TEST_ONLY.allExtensions
```

读取被替换前的 callback。这个内部依赖必须封装在单独的 `BlocklyRegistryAdapter` 中，并增加版本锁定测试，避免 Blockly 升级后静默失效。

## 12. Workspace listener

库既会通过：

```js
Blockly.getMainWorkspace().addChangeListener(...)
```

添加 listener，也会通过：

```js
block.workspace.addChangeListener(...)
```

绕过 Blockly facade。

建议在 session 绑定 workspace 时，对当前 workspace 实例的 `addChangeListener/removeChangeListener` 做一次可恢复包装：

1. 保存原方法。
2. 将 child callback 包成带 session active 检查的 wrapper。
3. 记录原 callback、wrapper 和 workspace。
4. destroy 时逐一 remove。
5. workspace dispose 后恢复原方法。

项目切换时仍必须实际调用 `workspace.dispose()`，因为 field validator、tooltip、mutator、block onchange 等闭包也可能来自旧 iframe。

workspace 必须在 Extensions、Blocks 和 iframe 销毁前 dispose，否则旧 block 的销毁流程可能访问已经被移除的注册项和 child callback。

## 13. Timer 与异步资源

RuntimeResourceBag 至少跟踪：

- `setTimeout/clearTimeout`
- `setInterval/clearInterval`
- `requestAnimationFrame/cancelAnimationFrame`
- `requestIdleCallback/cancelIdleCallback`
- `queueMicrotask`
- Observer、Worker 和未来新增的 event listener
- workspace change listener
- generator 脚本加载 Promise

建议让 child timer 使用父页面受控 wrapper，而不是 child 原生 timer：

```ts
function sessionSetTimeout(callback: Function, delay: number, ...args: unknown[]) {
  const id = hostSetTimeout(() => {
    resources.timeouts.delete(id);
    if (!isSessionActive(session.id, session.epoch)) return;
    callback(...args);
  }, delay);

  resources.timeouts.add(id);
  return id;
}
```

这样既能统一取消，也能控制 Angular Zone 的执行边界。

Promise continuation 和已经进入 microtask queue 的任务无法真正取消，因此所有能写宿主状态的 facade 都必须检查 session active/epoch。

## 14. 项目运行时依赖解析

当前“已安装库扫描”会在读取项目声明依赖后，继续扫描整个：

```text
node_modules/@aily-project/lib-*
```

这适合库管理器展示，但不适合作为运行时加载源。node_modules 中可能存在未声明或安装残留的库。

建议拆分：

```ts
scanInstalledLibrariesForManager(projectPath)
resolveDeclaredRuntimeLibraries(projectPath, packageJson, usedLibraryManifest)
```

运行时只加载：

1. 当前项目 package.json 明确声明的 Blockly 库。
2. 当前 ABI/used-library manifest 识别并完成依赖恢复后写回声明的库。
3. 开发板明确声明且由宿主解析出的必需库。

不得因为库物理存在于 node_modules 就自动执行它的 `generator.js`。

加载顺序必须确定：

1. 核心库优先。
2. 使用可用的依赖声明建立拓扑顺序。
3. 没有依赖信息时使用稳定的包名排序。
4. 全部 generator 加载完毕后，才加载 ABI 并放行 `FINISHED_LOADING`。

同一 session 内按规范化真实路径、包名和版本去重，禁止同一 `generator.js` 被重复执行。

## 15. 单库加载事务

每个库使用一个 `LibraryLoadTransaction`：

```text
begin transaction
  -> 写入 session i18n
  -> 执行 generator classic script
  -> 通过 facade 写宿主注册表并同步记录 journal
  -> 收集 Generator/Extensions/Msg/global 变化
  -> 暂存 block 定义
  -> 暂存 toolbox/metadata
  -> 校验 sessionId/epoch
  -> commit block/toolbox/metadata，并把 journal 标记为已提交
  -> 最后写 loadedLibraries/loadedLibraryInfos
end transaction
```

第一阶段不要求实现完整的影子 Blockly 注册表。事务期间 Extensions/Msg 等写入可以立即对当前新 workspace 可见，但每次写入必须先记录 `before`，失败时严格逆序恢复。这样既保留现有 generator 的即时 `isRegistered()` 语义，也避免 staging registry 带来的额外兼容成本。

任何步骤失败：

1. 立即把 transaction 标记 inactive。
2. 取消该 transaction 的资源。
3. 按 journal 逆序恢复宿主状态。
4. 不写 loaded 集合。
5. 如果 generator 已经开始执行，Realm 标记 tainted 并重建。

`Blockly.Events.FINISHED_LOADING` 和 toolbox update 应在整个项目库图加载完成后统一触发一次，而不是每个库各自触发。

## 16. 项目切换时序

推荐顺序：

```text
1. 对新项目做只读 preflight
2. 全局 project activation epoch++
3. runtime.deactivate(oldSession)
4. 停止 package watcher / local sync / debounce / 新库加载
5. 取消旧构建、上传和代码生成任务
6. 保存必要的项目和 workspace 状态
7. dispose 旧 workspace
8. 解绑 listener，清除 timer/resource
9. 按逆序回滚旧 session 的宿主 Blockly journal
10. 丢弃旧 Generator 实例
11. 移除旧 iframe 和所有 child 引用
12. 清理 BlocklyService 的 toolbox、maps、loaded bookkeeping
13. 更新 ProjectService.currentProjectPath
14. 创建新 workspace / session / Generator / iframe
15. 注入新项目 context
16. 加载新项目声明的库
17. 加载 project.abi
18. session 标记 active，项目标记 loaded
```

关键约束：

- 第 3 步必须早于修改 `currentProjectPath`。
- workspace dispose 必须早于注册表回滚和 iframe 删除。
- 每个 await 后必须重新检查 epoch/sessionId。
- `ngOnDestroy` 只作为幂等兜底，不能是唯一清理边界。

### 16.1 路由处理

当前项目切换使用：

```text
await close()
固定等待 100ms
再 navigate 到新项目
```

但 `close()` 内部没有 await 路由完成，100ms 只是竞态补偿。

应改为：

- SPA 路由跳转必须 `await router.navigate(...)`。
- 删除固定 100ms 延时。
- runtime teardown 由显式 API 完成，不依赖 Angular 是否复用组件。
- 即使保留“guide -> editor”的 SPA 导航，也不触发浏览器刷新。

## 17. 宿主全局函数迁移

当前宿主从父 window 调用库导出的函数，包括：

- `ensureSerialToolboxListener`
- `loadExistingSerialBlockToToolbox`
- `updateSerialCustomPorts`
- 其他变量、串口或工具函数

iframe 化后，这些函数位于当前项目 Realm，应改为：

```ts
runtime.invokeGlobal(
  activeSessionId,
  'ensureSerialToolboxListener',
  workspace,
);
```

或者提供固定宿主转发函数，但不要把 child 的真实函数复制到父 window。

`invokeGlobal()` 必须：

1. 验证 session active。
2. 只允许调用白名单或当前库已登记的 global export。
3. 捕获并标准化跨 Realm 错误。
4. 在 session 失效后返回 no-op/undefined，而不是执行旧函数。
5. 使用 iframe window 作为函数调用的 `this`。
6. 只返回调用结果，不把 child function 本身交给宿主长期保存。

## 18. 库新增、删除和升级

第一阶段不再尝试逐 key 卸载一个 generator。

原因：任意库都可能：

- 覆盖另一个库的同名 generator。
- 覆盖 `workspaceToCode`。
- 修改 window 全局和顶层词法绑定。
- 注册 timer、listener、Extensions。
- 被后加载库依赖其顶层函数。

推荐流程：

1. 保存当前 BlocklyProjectDocument 和视图状态。
2. 更新 package.json/依赖。
3. 重新解析当前运行时库图。
4. 销毁当前项目 session。
5. 创建新的 session/iframe/Generator。
6. 按新依赖图重放所有 generator。
7. 恢复文档和视图。

整个过程只重建 Blockly 项目运行时，不刷新 Angular/Electron 页面。

## 19. 文件级改造范围

| 文件/模块 | 改造内容 |
|---|---|
| 新增 `blockly-generator-runtime.service.ts` | session、epoch、iframe、fresh Generator、global 调用、销毁 |
| 可选新增 `blockly-runtime-registry.adapter.ts` | Blockly 11 注册表读取、写入和恢复适配 |
| 可选新增 `blockly-runtime-resource-bag.ts` | timer、RAF、listener、observer 追踪 |
| `blockly.service.ts` | generator 改由 runtime 加载；i18n 写 session；移除父 script loader；block/toolbox 事务化 |
| `blockly-editor.component.ts` | 显式 begin/deactivate/destroy；board config 同步；宿主 global 调用迁移 |
| `blockly.component.ts` | 使用 active Generator；不再设置父 `window.Arduino/MPY`；workspace listener 生命周期 |
| `arduino.ts` | factory；内部单例引用改 `this` |
| `micropython.ts` | factory；内部单例引用改 `this` |
| Blockly `builder.service.ts` | 从 runtime 生成代码 |
| Blockly `uploader.service.ts` | 从 runtime 生成代码 |
| Blockly editor `project.service.ts` | 从 runtime 生成代码 |
| AI lint/editBlock 工具 | 停止 import Generator 单例 |
| 根 `project.service.ts` | 显式 runtime teardown；await SPA 路由；删除 100ms 竞态 |
| `blockly-library-package.service.ts` | 拆分 manager inventory 和 runtime dependency resolver |
| 测试目录 | Runtime、journal、真实项目切换、打包环境测试 |

## 20. 分阶段实施

### 阶段 0：建立基线

- 为当前 A、B 两项目记录冷启动 generator/Extensions/toolbox/代码生成快照。
- 增加 A→B、B→A、B→B 自动化用例。
- 增加 runtime 诊断日志格式。
- 不修改现有行为。

### 阶段 1：fresh Generator

- 新增 Generator factory。
- 修复类内部单例引用。
- 迁移所有生产调用方到统一 runtime 入口。
- 暂时仍可使用旧 script loader，以单元测试确认代码生成一致。

### 阶段 2：项目级 iframe Realm

- 创建 RuntimeService 和 iframe。
- 在 iframe 内按 classic script 执行 generator。
- 注入 boardConfig、i18n、Generator、pinyinPro。
- 把串口等父 window 调用迁移为 `invokeGlobal()`。

### 阶段 3：Blockly facade 与 journal

- 接管 Extensions、Mutator、Mixin、Msg、Blocks。
- 接管 workspace listener 和 timer。
- 完成回滚冲突检测。
- 删除旧 `loadedGenerators = newKeys diff` 所有权逻辑。

### 阶段 4：项目切换与依赖解析

- 引入 project activation epoch。
- 删除 100ms 路由等待。
- 运行时只加载当前项目声明的库。
- 库增删升级改为 runtime rebuild。

### 阶段 5：删除旧路径

- 删除父 document generator `<script>` loader。
- 删除基于 script DOM 的 remove 逻辑。
- 删除父 window Generator/i18n/global export。
- 完成开发模式和正式安装包回归。

### 20.1 迁移期回退策略

开发迁移期可以用本地 feature flag 在“旧 loader”和“新 runtime”之间切换，以便对比生成代码和定位兼容问题，但该 flag 只用于开发验证：

- 不把整页 reload 作为任何错误回退。
- 新 runtime 出错时进入可诊断的干净失败状态。
- 正式启用前必须完成真实 A/B 项目和安装包验收。
- 验收完成后删除旧 loader 和生产环境 feature flag，避免长期维护两套生命周期。

## 21. 测试方案

### 21.1 单元测试

1. 每次 `begin()` 返回新的 sessionId、iframe 和 Generator identity。
2. `deactivate()` 后 facade 写操作全部拒绝/no-op。
3. classic script 顶层 function 可被后加载库裸调用。
4. 同一 Realm 重复顶层 const 会失败；新 Realm 加载成功。
5. Generator 直属属性只存在于当前 session 实例。
6. Extension register/unregister/override 能恢复原 callback。
7. `Blockly.Msg` 覆盖能恢复原 descriptor。
8. Blocks 同名覆盖能恢复旧定义。
9. timer/session listener destroy 后资源计数归零。
10. projectService facade 永远使用绑定路径。
11. 跨 Realm Error 可以稳定序列化。
12. journal 遇到 after-value 冲突时拒绝盲目恢复。

### 21.2 集成测试

1. 冷启动 A。
2. 冷启动 B。
3. A→B。
4. B→A。
5. B→B reload。
6. A→B→A 循环 50 次。
7. 快速连续点击打开 A/B，旧加载完成不得污染新 session。
8. 在 generator 加载中间主动抛错，重试后无残留。
9. 动态安装、删除、升级一个库后 rebuild 并恢复 ABI。
10. Arduino→MicroPython→Arduino 不交叉。
11. 包含 custom field、mutator、listener 的 workspace dispose 不报错。

### 21.3 A/B 专项断言

项目 B 冷启动与 A→B 后必须一致：

- Generator key 集合。
- 每个 generator function 的 owner/session。
- `Arduino.workspaceToCode` identity/owner。
- Arduino 直属属性集合。
- Extensions/Mutators/Mixins 集合和 callback owner。
- `mcpControlParams`、`aivoxControlServices`、`mcpServiceParamMap` 内容。
- Blocks、Msg、toolbox。
- 同一 ABI 的最终生成代码。

还需确认：

- A 独有的 DHT、FastLED、Servo 状态不会出现在 B。
- B 的 LVGL 状态不会残留到 A。
- 父页面 window 不包含库级 MCP、串口和变量全局。

### 21.4 正式安装包测试

至少验证：

- Angular 开发服务器环境。
- `npm run build` 产物。
- 正式安装包 `file://.../renderer/index.html` 环境。
- 应用全过程不调用浏览器刷新。
- iframe classic script、sourceURL、DOM mutation、timer wrapper 正常。
- 关闭项目、切换项目、切换开发板、动态依赖变更均正常。

## 22. 可观测性

建议日志统一包含：

```text
[GeneratorRuntime]
sessionId
epoch
projectPath
packageName
version
generatorPath
phase
durationMs
```

开发模式提供只读诊断快照：

```ts
interface RuntimeDiagnostics {
  sessionId: string;
  state: string;
  iframeCount: number;
  loadedLibraries: string[];
  arduinoGeneratorCount: number;
  mpyGeneratorCount: number;
  extensionCount: number;
  workspaceListenerCount: number;
  timeoutCount: number;
  journalEntryCount: number;
}
```

不得把完整项目源码、隐私路径内容或生成代码上传到远程日志。

## 23. 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| 同源 iframe 不是安全沙箱 | 明确只用于状态隔离；静态检查 `parent/top/prototype` 越界写入 |
| 同源 localStorage/IndexedDB 仍然共享 | 当前库未使用；加入静态扫描和开发态告警，禁止把它们当项目 session 状态 |
| Extensions 依赖 TEST_ONLY 内部 API | 封装适配器；锁定 Blockly 版本；升级时运行契约测试 |
| child callback 被父 registry 引用导致 iframe 无法 GC | workspace dispose、journal 逆序回滚、resource 清理后再删除 iframe |
| child document 与父 document 不同 | 对 mutation、DOMParser、canvas/file input 做兼容回归 |
| 跨 Realm Error/Array identity 差异 | Error 标准化；使用 `Array.isArray`，避免跨 Realm `instanceof Array` |
| iframe timer 不受父 Angular Zone 管理 | 给 child 注入父页面 session timer wrapper |
| generator 中途错误留下 lexical binding | Realm 标记 tainted，整 session 重建 |
| 快速项目切换产生晚到 Promise | 所有异步 continuation 检查 sessionId/epoch |
| 运行时误加载 node_modules 残留库 | 运行时只使用当前项目声明依赖和明确恢复结果 |
| 任意单库卸载的覆盖栈过于复杂 | 第一阶段统一 rebuild 当前项目 runtime |

## 24. 验收标准

以下条件全部满足后，方案才算完成：

- [ ] 不存在任何 `location.reload()` 或 Renderer reload 依赖。
- [ ] 当前项目始终只有一个 active generator iframe。
- [ ] 每个项目激活周期都有新的 Generator identity。
- [ ] 父 window 不再保存库级 generator 全局状态。
- [ ] 父 document 不再包含项目级 generator script。
- [ ] B 冷启动与 A→B 后的运行时快照完全一致。
- [ ] A→B→A 循环 50 次，iframe、listener、timer、Extensions 数量不增长。
- [ ] 同名 generator 覆盖能够正确归属，不再只记录新增 key。
- [ ] 旧 session 的延迟回调不能写入新项目。
- [ ] generator 执行失败后重试不会出现重复顶层 const。
- [ ] 动态库变更通过 runtime rebuild 正常恢复 workspace。
- [ ] 开发环境和正式安装包均通过回归。
- [ ] 整个改造不要求修改任何库包。

## 附录 A：当前关键代码入口

以下位置是实施时的首要修改点，行号可能随代码变化，优先按函数名定位：

| 相对路径 | 当前关键函数/行为 |
|---|---|
| `src/app/editors/blockly-editor/services/blockly.service.ts` | `loadLibraryInternal()`、`loadLibGenerator()`、`removeLibGenerator()`、`reset()`、串口动态 toolbox 调用 |
| `src/app/editors/blockly-editor/blockly-editor.component.ts` | `loadProject()`、`ngOnDestroy()`、boardConfig 更新、`window.updateSerialCustomPorts` |
| `src/app/editors/blockly-editor/components/blockly/blockly.component.ts` | `initDevMode()` 设置父 `window.Arduino/MPY`、workspace 生命周期 |
| `src/app/editors/blockly-editor/components/blockly/generators/arduino/arduino.ts` | `ArduinoGenerator`、`getValue()`、模块单例导出 |
| `src/app/editors/blockly-editor/components/blockly/generators/micropython/micropython.ts` | `MicroPythonGenerator`、`getValue()`、模块单例导出 |
| `src/app/services/domains/project/project.service.ts` | `projectOpenInternal()`、`close()`、固定 100ms 等待、路由切换 |
| `src/app/services/domains/dependencies/blockly-library-package.service.ts` | `scanInstalledLibraries()`、声明依赖和物理库存扫描 |
| `src/app/services/domains/dependencies/npm.service.ts` | `getAllInstalledLibraries()` 当前同时服务运行时和库管理器 |
| `src/app/editors/blockly-editor/services/builder.service.ts` | 多处直接调用模块单例 `workspaceToCode()` |
| `src/app/editors/blockly-editor/services/uploader.service.ts` | 直接调用模块单例生成代码 |
| `src/app/editors/blockly-editor/services/project.service.ts` | 保存/读取代码时直接调用模块单例 |
| `src/app/tools/aily-chat/tools/editBlockTool.ts` | AI 工具直接 import Generator 单例 |
| `src/app/tools/aily-chat/services/arduino-lint.service.ts` | lint 代码生成入口需要迁移到 runtime |

## 附录 B：建议验证命令

文档实施完成后至少运行：

```powershell
npm run build
npm run test:e2e
git diff --check
```

其中 E2E 必须包含真实 A/B 项目切换场景；仅 TypeScript/Angular 构建通过不能证明 Realm、注册表和异步资源已经正确释放。

## 25. 最终结论

本问题的根因不是某一个库忘记清理变量，而是宿主把多个项目的 classic `generator.js` 放进了同一个、不可销毁的 Renderer 全局 Realm，同时复用了 Generator 单例和宿主 Blockly 注册表。

可靠的无刷新方案必须同时建立三个隔离边界：

1. **项目级 iframe Realm**：隔离顶层声明、隐式全局和 `window.*`。
2. **项目级 fresh Generator**：隔离 `forBlock`、`workspaceToCode` 和所有直属可变属性。
3. **宿主 Blockly facade + journal**：隔离并恢复 Extensions、Blocks、Msg、registry、listener 和 toolbox。

再配合 session epoch、资源账本、显式 teardown 和声明依赖解析，即可在不刷新 Electron Renderer、不修改库的前提下，稳定解决跨项目 generator 污染问题。
