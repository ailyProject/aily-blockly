---
name: abs-syntax-reference
description: "ABS 语法快速参考：权威 ABS 规则与示例 skill，覆盖块连接类型、参数顺序、语句输入、变量引用与常见示例。触发词：ABS、语法、块脚本"
metadata:
  version: "1.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: abs,syntax,reference,blockly
---

# ABS (Aily Block Syntax) 快速参考

本 skill 现在是 ABS 语法的权威参考入口。

## Blockly 代码编辑流程

### 【需求分析】
仔细分析用户需求，理解要实现的功能和目标。对于不明确的需求，提出澄清问题。项目代码编写操作只在ABS文件上进行。

### 【设计方案】
使用工具了解当前工作区信息，仔细查询可使用的开发板和库，设计实现方案。方案设计要考虑功能实现的可行性、效率和可维护性。
- 严禁假设应该使用的库或工具，必须通过工具查询确认。
- 方案设计完成后输出完整方案设计及实现步骤。

### 【准备工作】
1. 使用分析当前工作区及当前项目状态，了解现有资源，确保项目已创建、库已安装。
2. 安装所需库，确保所有依赖库已正确安装。
3. 使用todo_write_tool规划项目流程，明确每一步要实现的功能和使用的工具。
4. 列出需要使用的库，必须包含`lib-core-*`等核心库（如lib-core-logic、lib-core-variables等）。如果需要新库，使用search_boards_libraries工具查询并安装。
5. 逐一阅读库的readme_ai.md，了解块定义和ABS语法。没有readme的库需要直接分析库文件获取信息。

### 【实现阶段】
1. 完整规划代码逻辑，构思ABS结构。
2. 使用sync_abs_file工具的export操作获取当前代码。
3. 编辑ABS代码：添加新块、修改参数、调整结构。遵守ABS编写规范，确保字段直接写值，输入连接值块，语句输入用缩进，多输入块用标记，空括号不可省略。
4. 使用sync_abs_file工具的import操作导入修改后的ABS。
5. 仔细分析错误信息，定位并修复ABS代码问题。遵循修复原则：诊断优先、最小改动、错误处理。
6. 如果库功能不完善，安装lib-core-custom自定义库(需要用户确认)，重复步骤2-5直至完成。
7. 如果代码逻辑复杂且现有库(包括lib-core-custom)无法满足需求，考虑先拆分成独立的功能块或者功能库，再逐步集成到主流程中。

### 【修复原则】
- 诊断优先：分析报错，定位问题，语法错误还是逻辑错误。
- 最小改动：只修改需要变更的ABS行，保持其他结构不变。
- 错误处理：读取库文件了解块定义和ABS语法，确保修复正确。

### 【执行要求】
- 深入分析嵌入式代码逻辑和硬件特性，确保逻辑正确。
- ABS代码保持清晰的缩进和换行，便于阅读和调试。

## Block Connection Types

| Type | Role | Parameter Style |
|------|------|-----------------|
| **Value** | 作为值嵌入到其他块参数中 | 所有参数都写在括号内：`logic_compare($a, EQ, $b)` |
| **Statement** | 独立成行，通过 next 串联 | 普通参数写在括号内，语句输入使用 `@NAME:` |
| **Hat** | 根入口块，如 `arduino_setup`、`arduino_loop` | 规则与 Statement 相同 |

## Syntax Rules

| Element | Syntax | Example |
|---------|--------|---------|
| Block call | `block_type(param1, param2)` | `serial_println(Serial, text("Hi"))` |
| Empty params | `block_type()` | `time_millis()` |
| Statement input | `@NAME:` + 换行 + 缩进 | `@DO0:\n    action()` |
| Variable ref | `$varName` | `$count`, `$sensor` |

## Parameter Types

| Type | Syntax | Example |
|------|--------|---------|
| Dropdown | `ENUM_VALUE` | `Serial`, `HIGH`, `EQ`, `AND` |
| Text | `"string"` | `"hello"`, `"dht"` |
| Number | `123` | `9600`, `13` |
| Variable | `$name` | `$count`, `$temp` |
| Value block | `block(args)` | `math_number(10)`, `$var` |

## 参数顺序规则

**参数顺序必须严格遵循 block.json 中 `args0` 的定义顺序**，字段和输入可能交错出现，不能想当然地把下拉字段放到最前面。

例如 `logic_compare` 的 `args0` 顺序是：`A(input_value), OP(field_dropdown), B(input_value)`，因此：

- 正确：`logic_compare($a, EQ, $b)`
- 错误：`logic_compare(EQ, $a, $b)`

## Value Blocks

值块的所有参数都必须写在括号里，不能使用命名输入。

```abs
# Comparison: logic_compare(A, OP, B)
logic_compare($a, EQ, math_number(10))
logic_compare($temp, GT, math_number(30))

# Logic: logic_operation(A, OP, B)
logic_operation($sensor1, AND, $sensor2)
logic_operation(logic_compare($a, GT, math_number(0)), OR, logic_compare($a, LT, math_number(100)))

# Math: math_arithmetic(A, OP, B)
math_arithmetic($a, ADD, $b)

# Ternary: logic_ternary(condition, trueValue, falseValue)
logic_ternary(logic_compare($score, GTE, math_number(90)), text("A"), text("B"))

# Negate
logic_negate($flag)

# Boolean
logic_boolean(TRUE)
```

## Statement Blocks with Statement Inputs

语句输入必须使用 `@NAME:`，并且子块体使用 4 个空格缩进。

```abs
# If-Else: statement inputs use @NAME:
controls_if()
    @IF0: logic_compare($temp, GT, math_number(30))
    @DO0:
        serial_println(Serial, text("Hot"))
    @ELSE:
        serial_println(Serial, text("OK"))

# If-ElseIf-Else
controls_if()
    @IF0: logic_compare($v, GT, math_number(100))
    @DO0:
        action1()
    @IF1: logic_compare($v, GT, math_number(50))
    @DO1:
        action2()
    @ELSE:
        action3()

# Loop
controls_repeat_ext(math_number(10))
    serial_println(Serial, text("Loop"))

controls_for($i, math_number(0), math_number(10), math_number(1))
    serial_println(Serial, $i)
```

## Simple Statement Blocks

无语句输入的语句块，同样全部使用括号参数。

```abs
serial_begin(Serial, 115200)
serial_println(Serial, text("Hello"))
serial_println(Serial, $count)
time_delay(math_number(1000))
variables_set($count, math_number(0))
math_change($count, math_number(1))
```

## Program Structure

```abs
arduino_setup()
    serial_begin(Serial, 115200)

arduino_loop()
    serial_println(Serial, text("Hello"))
    time_delay(math_number(1000))
```

## Variable Reference Context

| Target Type | `$var` Becomes |
|-------------|-----------------|
| field_variable | 变量字段，如 `variables_set($x, ...)` |
| input_value | `variables_get` 表达式，如 `serial_println(Serial, $x)` |

## Checklist

- 必须写括号：`block()`，不能省略为 `block`
- `input_value` 位置的数字应写成 `math_number(n)`
- `input_value` 位置的文本应写成 `text("s")`
- 下拉值使用枚举值，如 `HIGH`、`Serial`、`EQ`、`AND`
- 语句体使用 4 空格缩进
- 只有语句输入才使用命名输入：`@IF0:`、`@DO0:`、`@ELSE:`
- 值块的所有参数都在括号里，不能写命名输入
- 参数顺序严格遵循 block.json 的 `args0` 定义，而不是“字段优先”

## 调试建议

1. 先加载 `abs-syntax-reference` skill，确认最新语法规则。
2. 使用 `sync_abs_file` 导出当前 ABS 内容并定位问题。
3. 对照 `args0` 顺序修正参数位置、缩进、值块包装方式。
4. 再导入验证，依据报错继续最小化修复。
