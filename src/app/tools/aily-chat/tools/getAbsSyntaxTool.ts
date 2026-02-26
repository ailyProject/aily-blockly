import { ToolUseResult } from "./tools";

/**
 * ABS (Aily Block Syntax) Syntax Reference Tool
 * Provides concise but complete syntax specification for LLM code generation
 */

/**
 * Concise ABS Syntax Specification (English)
 */
const ABS_SYNTAX_SPECIFICATION = `# ABS (Aily Block Syntax) Quick Reference

## Block Connection Types

| Type | Role | Parameter Style |
|------|------|-----------------|
| **Value** | Embedded in other blocks' params | All params in parentheses: \`logic_compare(EQ, $a, $b)\` |
| **Statement** | Standalone line, chains via next | Params in parentheses, statement inputs use \`@NAME:\` |
| **Hat** | Root entry (arduino_setup, arduino_loop) | Same as Statement |

## Syntax Rules

| Element | Syntax | Example |
|---------|--------|---------|
| Block call | \`block_type(param1, param2)\` | \`serial_println(Serial, text("Hi"))\` |
| Empty params | \`block_type()\` | \`time_millis()\` |
| Statement input | \`@NAME:\` + newline + indent | \`@DO0:\\n    action()\` |
| Variable ref | \`$varName\` | \`$count\`, \`$sensor\` |

## Parameter Types

| Type | Syntax | Example |
|------|--------|---------|
| Dropdown | \`ENUM_VALUE\` | \`Serial\`, \`HIGH\`, \`EQ\`, \`AND\` |
| Text | \`"string"\` | \`"hello"\`, \`"dht"\` |
| Number | \`123\` | \`9600\`, \`13\` |
| Variable | \`$name\` | \`$count\`, \`$temp\` |
| Value block | \`block(args)\` | \`math_number(10)\`, \`$var\` |

## Value Blocks (All params in parentheses)

\`\`\`
# Comparison: logic_compare(OP, A, B)
logic_compare(EQ, $a, math_number(10))
logic_compare(GT, $temp, math_number(30))

# Logic: logic_operation(OP, A, B)
logic_operation(AND, $sensor1, $sensor2)
logic_operation(OR, logic_compare(GT, $a, math_number(0)), logic_compare(LT, $a, math_number(100)))

# Ternary: logic_ternary(condition, trueValue, falseValue)
logic_ternary(logic_compare(GTE, $score, math_number(90)), text("A"), text("B"))

# Negate
logic_negate($flag)

# Boolean
logic_boolean(TRUE)
\`\`\`

## Statement Blocks with Statement Inputs

\`\`\`
# If-Else: statement inputs use @NAME:
controls_if()
    @IF0: logic_compare(GT, $temp, math_number(30))
    @DO0:
        serial_println(Serial, text("Hot"))
    @ELSE:
        serial_println(Serial, text("OK"))

# If-ElseIf-Else
controls_if()
    @IF0: logic_compare(GT, $v, math_number(100))
    @DO0:
        action1()
    @IF1: logic_compare(GT, $v, math_number(50))
    @DO1:
        action2()
    @ELSE:
        action3()

# Loop
controls_repeat_ext(math_number(10))
    serial_println(Serial, text("Loop"))

controls_for($i, math_number(0), math_number(10), math_number(1))
    serial_println(Serial, $i)
\`\`\`

## Simple Statement Blocks (All params in parentheses)

\`\`\`
serial_begin(Serial, 115200)
serial_println(Serial, text("Hello"))
serial_println(Serial, $count)
time_delay(math_number(1000))
variables_set($count, math_number(0))
math_change($count, math_number(1))
\`\`\`

## Program Structure

\`\`\`
arduino_setup()
    serial_begin(Serial, 115200)

arduino_loop()
    serial_println(Serial, text("Hello"))
    time_delay(math_number(1000))
\`\`\`

## Variable Reference Context

| Target Type | \`$var\` Becomes |
|-------------|-----------------|
| field_variable | Variable field: \`variables_set($x, ...)\` |
| input_value | variables_get: \`serial_println(Serial, $x)\` |

## Checklist
- Parentheses required: \`block()\` not \`block\`
- Numbers in input_value → \`math_number(n)\`
- Text in input_value → \`text("s")\`
- Dropdown values: uppercase \`HIGH\`, \`Serial\`, \`EQ\`, \`AND\`
- 4-space indent for statement body
- Named inputs only for statement inputs: \`@IF0:\`, \`@DO0:\`, \`@ELSE:\`
- Value blocks: ALL params in parentheses (no named inputs)
`;

/**
 * Get ABS syntax specification tool implementation
 */
export async function getAbsSyntaxTool(): Promise<ToolUseResult> {
    try {
        return {
            is_error: false,
            content: ABS_SYNTAX_SPECIFICATION
        };
    } catch (error) {
        return {
            is_error: true,
            content: `Failed to get ABS syntax specification: ${error instanceof Error ? error.message : String(error)}`
        };
    }
}
