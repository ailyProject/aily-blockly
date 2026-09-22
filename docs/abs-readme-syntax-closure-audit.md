# ABS 历史简写与库 README 一致性审计

日期：2026-09-17。主线入口：[原生执行方案第 20 节](./abs-native-runtime-execution-plan.md#20-2026-09-17-历史简写与-readme-一致性收口)。库仓库只读，本文不改变 ABS schema。

## 1. 审计基线与原则

历史证据取自 Git `4caee8fd^` 的 `src/app/tools/aily-chat/tools/abiAbsConverter.ts`、`absParser.ts`；当前证据取自唯一 ABS 同步链及本地库 `block.json`、`generator.js`、`readme_ai.md`，不只根据文档示例推断实现。

职责划分不变：ABS 表达调用和用户显式结构，map/ABI 保存身份、布局、保护与映射，Project Data 保存大值。参数先遵循数字 `argsN` 的原声明顺序（字段/value 混排），未出现在原声明中的动态参数追加在后，彼此按原生顺序排列。视觉插入或移动不能挤占已声明参数的位置。

## 2. 历史上实际存在的修饰与兜底

| 历史机制 | 实际作用 | 当前处理 |
| --- | --- | --- |
| `controls_for`、repeat、while 单语句体 | parser 有基础定义回退；缩进进入唯一 statement input；没有专用 for 导出分支 | 保留通用顺序和单语句体，不引入 for 模板 |
| `controls_if`、`controls_switch` | 专用导出分支展开为 IF/DO/CASE/ELSE/DEFAULT；按编号输入推导分支数 | 保留真实槽名；补齐经主程序 mutator 注册身份认证的省略状态推导，不按块类型匹配 |
| text join、list/repeated inputs | ADD/INPUT/ARG 以及 EXTRA_N 重映射、数量推导 | 已认证的 repeated-input 配方恢复省略状态；连续性、预算和显式状态冲突必须验证，不恢复未知前缀猜测 |
| `function_params_mutator` | EXTRA_N 类型/名字成对转 params，剩余值归 RETURN | 复用已有 typed-function 协议，补齐 README 位置签名；函数及参数模型仍需显式创建意图，不从多余参数猜模型身份 |
| number/text/boolean/variable 简写 | `number(n)`、布尔值、HIGH/LOW、`var`、裸 `$name` 等 | 已有 value-input 模块保留；裸 `$name` 在值槽展开变量块，在变量字段直接选择；本轮不改规则 |
| 输入名别名 | DO/DO0→do、IF0→condition、ARDUINO_SETUP→setup 等 | 旧归一化不是可靠双射；当前使用真实槽名或唯一隐式语句体，不恢复有歧义的反向猜测 |
| DHT 默认 PIN 等基础定义回退 | 未加载/动态字段缺失时硬编码补名 | 已由实际注册声明及候选实例配置替代，不恢复离线结构假设 |

历史“更通用”既包含应保留的便捷写法，也包含可能静默丢数据的猜测。二者不能一并恢复或一并删除。

## 3. 当前库文档一致性

| 库/能力 | README 关键格式 | 本轮结论 |
| --- | --- | --- |
| core-loop | `controls_for($var, from, to, by)` + 缩进体 | 通用定义顺序，非特殊动态形状 |
| core-logic | `controls_if(条件0, 条件1)` + `@DO1:`；switch 类似 | 原来新建额外分支依赖 `@extra`；现可由已认证配方推导；`@ELSE:` 也可为空 |
| core-text / core-lists | `text_join(ADD0=..., ADD1=...)`、`list_values(..., INPUT1=...)` | 补齐无 `@extra` 的数量推导；支持 0 项、1 项和多项，跳号须显式保留结构 |
| core-text / tt_getSubstring | `tt_getSubstring(text("value"), FROM_START, LAST, math_number(0))` | 修复旧适配把动态 AT1_VALUE 插到 WHERE2 前的问题；纯准备与原生候选均验证九种组合 |
| core-text / text_charAt、core-math | value、selector、可选 AT/DIVISOR | 原顺序已一致，继续共享字段条件路径 |
| esp32_i2c | ADDRESS、DATA/QUANTITY、可选 CUSTOM_ADDRESS | 顺序已一致；保留只读库原实现，不增加 I2C 特例 |
| DHT / MAX31865 | 声明前缀后接 PIN/WIRE 或 SW 三引脚 | 原生配置顺序一致；补齐 README 裸数字引脚对字符串枚举键的精确字面匹配；真实原生测试同时覆盖具名 SW 三引脚和非法引脚拒绝 |
| Blinker / AI-vox / SPI | 声明前缀、运行时输入/默认子树或配置效果 | 不新增语法装饰；沿原生实例与默认子树/模型效果校验，不把所有效果当纯结构 |
| core-functions | 函数名、返回类型、重复类型/名字、可选 RETURN；调用 `FUNC_NAME=$name, INPUT0=...` | 补齐不写 `@extra.params` 的签名推导和前向调用；保留 128 参数预算、类型/名字/身份校验 |
| core-custom | `custom_function("name", void, "PARAMS")` 等 | 当前库的 PARAMS/ARGS 确为文本字段，与 core-functions 是不同协议；不能混用旧 mutator 规则 |
| u8g2 / TFT / GFX / WS2812 大字段 | 正常字段值、Project Data 引用 | 不属于位置语法修饰，继续统一外置数据与可信准备；本轮不改库和资源协议 |

发现但不应通过放宽 parser 修复的文档问题：

- core-logic Basic Usage 的一个示例同时用位置参数和 `@IF0:` 给同一槽赋值。必须拒绝重复赋值，不能静默覆盖其中一个条件。
- 库根 `ABS_SYNTAX_REFERENCE.md` 存在“字段优先”的旧描述。实际 block args 的字段/value 混排优先；不能为迎合旧描述改变变量或算术参数位置。
- README 的源码示例不代表已有函数/变量模型可以被默默创建。创建意图、跨页签名和身份权限仍由宿主协议负责。

库文件本轮未修改；上述文档差异作为独立文档维护项，不能宣称所有 README 字节均可直接执行。

## 4. 实现边界

- `abs-structural-syntax` 只从已认证 repeated-input 配方准备数量/可选分支；与 `abs-structural-shape` 共用序列化规则。未知 mutator、跳号、超预算和显式状态冲突失败。
- `abs-native-arguments` 与 `abs-field-shape` 统一“原声明前缀 + 动态尾部”，删除视觉锚点插入 ABS 位置的逻辑；字段锚点的来源校验仍保留。
- `abs-custom-function-syntax` 只为已有且通过来源校验的函数协议准备源码签名。调用签名来自本次定义或宿主基线，不从 INPUT 数量伪造类型。显式 `@extra` 优先，prepare 继续验证模型归属和派生字段。
- 数字下拉值只允许源码字面量精确等于现有选项键，例如 `18` 对应 `"18"`；不把 `18.0` 或 `1.8e1` 近似成 `"18"`，也不按选项显示文本或板卡外引脚猜测。
- 原生混合链只传递宿主已准备的源码状态和顺序，不在发现阶段执行函数模型块；合并后仍进行完整原生 ABI/代码验证。
- 真实故障注入另发现共享定义/页内根块顺序不同导致回滚失败：提交前按已捕获的共享归属稳定分组；回滚入口显式接收事务捕获的根块顺序，并校验根 ID 完整性后再加载。没有删除 `/roots` 完整读回检查。
- canonical 导出仍可保留原生 `@extra` 来表达空槽、关闭默认分支或 opaque 状态。允许省略可推导状态，不等于可以丢弃不可推导状态。
- 不恢复另一套 parser、库源码改写、任意异步任务、活动工作区试探或独立保存入口。

旧 generation 若捕获了错误的子串位置合同，应从现有 ABI 重新 `abs_export` 再编辑；不把旧位置文本偷偷按新顺序解释，也不重建 ABI 身份。来源合同变化仍由既有 stale/CAS 校验保护。

## 5. 验收与范围

最终结果统一记录主线第 20 节，避免重复维护不同数字。验收包括纯准备与独立原生候选的 README 绑定、ABS 全量回归、项目加载、打包/预处理，以及真实 Electron 中当前 lex-pro 工具的验证、应用、保存和重开。

真实工具调用不等于 LLM 自主会话，生成 C++ 不等于固件编译。未经本轮运行的能力只引用历史证据，不冒称重新通过。
