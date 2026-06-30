---
name: library-migration-guide
description: "Complete guide for converting Arduino/ESP32 hardware libraries into Aily Blockly compatible format. Covers the full workflow: source analysis, block.json design, generator.js implementation, toolbox.json configuration, bus initialization (Serial/I2C/SPI), board adaptation, and packaging."
metadata:
  version: "4.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: library,migration,conversion,block-json,generator,serial,i2c,spi,board-config
---

# Blockly Library Conversion Guide

A systematic guide for converting Arduino libraries into Aily Blockly libraries,
based on real conversion cases (ArduinoJson, OneButton, MQTT/PubSubClient, DHT, INA219, VL53L0X, etc.).

## Conversion Workflow

### Prerequisites

1. Use the existing environment/project context first to determine whether a project is already open.
2. If no project exists, use `project` with `action="create"` to create one, then continue with the new project path.

### ⚠️ CRITICAL: Library Working Directory

All library files **MUST** be created in `<projectPath>/<library-name>/`, NOT in `node_modules/`.

- ✅ Correct: `<projectPath>/lib-grove_motor/block.json`
- ❌ Wrong: `<projectPath>/node_modules/@aily-project/lib-grove_motor/block.json`

The `node_modules/` directory is managed by npm and is write-protected.
After creating the library locally, install it with: `npm install ./<library-name>`

If a file write operation returns a path/permission error, **check your target path** — you are likely
writing to `node_modules/` instead of `<projectPath>/<library-name>/`. Fix the path and retry.
Do NOT attempt to bypass by using terminal commands (mkdir, echo, Out-File, etc.) to write into protected directories.

### Step-by-step Process

1. **Source Analysis**: Analyze the Arduino library header files to identify public APIs. Classify by operation type: initialization, connection, communication, status, maintenance, quick operations.

2. **Block Design**: Design user-friendly blocks following block type mapping rules (see Section "Block Design Rules" below).

3. **Create Library Files** in `<projectPath>/<library-name>/`:
   - `block.json` — Block definitions
   - `generator.js` — Code generator
   - `toolbox.json` — Toolbox configuration
   - `package.json` — Library metadata

4. **Copy Source Files**: Use `run_terminal` to copy the Arduino source:
   - If `src/` folder exists → copy to `<projectPath>/<library-name>/src/<library-name>/`
   - If no `src/` folder → copy `.c`, `.cpp`, `.h`, `.hpp` files to `<projectPath>/<library-name>/src/<library-name>/`

5. **Write README.md**: First read `Blockly_Library_README_Conventions.md` (fetch from `https://blockly.diandeng.tech/files/Blockly_Library_README_Conventions.md`), then follow its format.

6. **Post-conversion**: Ask the user if they need help with:
   - Installing: `npm i <library-path>` (must specify the local library path)
   - Testing the converted library
   - Opening the library folder location

### Library Directory Structure

```
library-name/
├─ block.json        // Block definitions
├─ generator.js      // Code generator
├─ toolbox.json      // Toolbox configuration
├─ package.json      // Library metadata
├─ README.md         // Human-readable documentation
├─ README_AI.md      // LLM-readable documentation
└─ src/
   └─ library-name/  // Copied Arduino source files
```

---

## Detailed Code Specification

IMPORTANT: For complete code specification with detailed examples, read the companion file
`Blockly_Library_CODE_Conventions.md` located in this skill's folder. It covers:
- Full block.json design rules with templates for every block type
- Complete generator.js implementation patterns with real-world examples
- toolbox.json shadow blocks and organization
- package.json configuration with board compatibility
- Board adaptation patterns and WiFi library selection

The sections below summarize the critical rules that MUST be followed.

---

## Block Design Rules

### Block Type Mapping

| Arduino Pattern | Block Type | Connection | Field Type |
|----------------|------------|------------|------------|
| Object creation/init | Statement | prev/next | `field_input` (user enters new var name) |
| Global object method | Statement | prev/next | No variable field (direct call) |
| Object method call | Statement | prev/next | `field_variable` (select existing var) |
| Global object query | Value | output | No variable field |
| Quick operation | Statement/Value | standard | No variable field, direct params |
| Event callback | Hat block | **No prev/next** | `field_variable` + `input_statement` |
| Conditional callback | Hybrid | prev/next | `input_value` + `input_statement` |
| Status query | Value | output | `field_variable` |

### field_input vs field_variable

- **`field_input`**: For initialization blocks — user enters a NEW variable name
- **`field_variable`**: For method call blocks — user selects an EXISTING variable (set `variableTypes` and `defaultType`)
- **Global objects** (Serial, WiFi, Wire, SPI, httpUpdate, SPIFFS, ESP, EEPROM): No variable field needed

### Reading Variable Names in generator.js

```javascript
// field_input
const varName = block.getFieldValue('VAR') || 'defaultVar';

// field_variable
const varField = block.getField('VAR');
const varName = varField ? varField.getText() : 'defaultVar';

// Global object — use directly
const serialPort = block.getFieldValue('SERIAL') || 'Serial';
```

### Board Config Template Variables (block.json)

Use these in `field_dropdown` options — auto-populated at runtime:

| Variable | Usage |
|----------|-------|
| `${board.i2c}` | I2C interface list (Wire selector) |
| `${board.digitalPins}` | Digital pin list |
| `${board.analogPins}` | Analog pin list |
| `${board.serialPort}` | Serial port list |
| `${board.serialSpeed}` | Baud rate list |
| `${board.interruptPins}` | Interrupt pin list |
| `${board.interruptMode}` | Interrupt mode list |

### Extensions

Register dynamic extensions in generator.js. Always unregister before registering:

```javascript
if (Blockly.Extensions.isRegistered('ext_name')) {
  Blockly.Extensions.unregister('ext_name');
}
Blockly.Extensions.register('ext_name', function() { /* ... */ });
```

---

## Code Generation Rules

### Injection Methods & Execution Order

All injection methods take `(tag, code)` and auto-deduplicate by tag.

```cpp
#include <Lib.h>        // addLibrary(tag, code)
#define MACRO val        // addMacro(tag, code)

Type globalVar;          // addVariable(tag, code)
MyClass obj;             // addObject(tag, code)
void helper() {}         // addFunction(tag, code, isGlobal?)

void setup() {
  Serial.begin(9600);    // addSetupBegin — bus-level init ONLY
  sensor.begin();        // addSetup — device/sensor init
  attachCb(handler);     // addSetupEnd — callbacks, depends on prior init
}

void loop() {
  btn.tick();            // addLoopBegin — polling/tick calls
  // [user blocks here]
}
```

### Bus Initialization (MANDATORY)

**Serial** — Always use `ensureSerialBegin()`, NEVER write `Serial.begin()` directly:

```javascript
// ✅ Correct
ensureSerialBegin('Serial', generator);           // default 9600
ensureSerialBegin('Serial', generator, 115200);   // custom baud
ensureSerialBegin(serialPort, generator, baud);   // dynamic

// ❌ FORBIDDEN
generator.addSetupBegin('serial_begin', 'Serial.begin(9600);');
```

**I2C** — Use `wire_${wireName}_begin` key for deduplication:

```javascript
const wire = block.getFieldValue('WIRE') || 'Wire';
generator.addLibrary('Wire', '#include <Wire.h>');
const wireBeginKey = `wire_${wire}_begin`;
if (!generator.setupCodes_ || !generator.setupCodes_[wireBeginKey]) {
  generator.addSetup(wireBeginKey, wire + '.begin();\n');
}
```

**SPI** — Use `spi_${spiName}_begin` key for deduplication:

```javascript
const spi = block.getFieldValue('SPI') || 'SPI';
generator.addLibrary('SPI', '#include <SPI.h>');
generator.addSetup(`spi_${spi}_begin`, spi + '.begin();\n');
```

### Variable Management

Initialization blocks with `field_input` MUST implement a rename listener:

```javascript
if (!block._varMonitorAttached) {
  block._varMonitorAttached = true;
  block._varLastName = block.getFieldValue('VAR') || 'defaultVar';
  registerVariableToBlockly(block._varLastName, 'VarType');
  const varField = block.getField('VAR');
  if (varField) {
    const orig = varField.onFinishEditing_;
    varField.onFinishEditing_ = function(newName) {
      if (typeof orig === 'function') orig.call(this, newName);
      const ws = block.workspace || Blockly.getMainWorkspace?.();
      const oldName = block._varLastName;
      if (ws && newName && newName !== oldName) {
        renameVariableInBlockly(block, oldName, newName, 'VarType');
        block._varLastName = newName;
      }
    };
  }
}
```

### Generator Return Values

- **Statement blocks**: `return 'code;\n';`
- **Value blocks**: `return [expr, generator.ORDER_ATOMIC];`
- **Hat / event blocks**: `return '';` (empty string — event-driven, not in main flow)
- **Hybrid blocks**: `return 'conditional_code;\n';` (returned code runs inside parent callback)

### valueToCode & ORDER Constants

```javascript
// Extract input value (most cases use ORDER_ATOMIC)
const val = generator.valueToCode(block, 'INPUT', generator.ORDER_ATOMIC) || '0';

// Return value block
return [varName + '.read()', generator.ORDER_FUNCTION_CALL];
```

### Board Adaptation

Access runtime board config via `window['boardConfig']`:

```javascript
const boardConfig = window['boardConfig'];
// boardConfig.core — e.g. 'esp32:esp32', 'arduino:avr'
// boardConfig.name — board display name
// boardConfig.i2c — I2C interface list
// boardConfig.digitalPins — digital pin list
```

NEVER modify `window['boardConfig']` directly — use independent storage like `window['customXxx']`.

---

## toolbox.json Rules

**All `input_value` slots MUST have shadow blocks**:

```json
{
  "kind": "block",
  "type": "sensor_read",
  "inputs": {
    "TIMEOUT": {"shadow": {"type": "math_number", "fields": {"NUM": 1000}}}
  }
}
```

Organize blocks by user cognitive flow using `label` separators:

```json
{
  "kind": "category",
  "name": "SensorLib",
  "contents": [
    {"kind": "label", "text": "Setup"},
    {"kind": "block", "type": "sensor_init"},
    {"kind": "label", "text": "Read Data"},
    {"kind": "block", "type": "sensor_read"}
  ]
}
```

---

## package.json Configuration

```json
{
  "name": "@aily-project/lib-libname",
  "nickname": "Display Name",
  "description": "Brief description (<50 chars)",
  "version": "1.0.0",
  "compatibility": {
    "core": [],
    "voltage": [3.3, 5]
  },
  "keywords": ["aily", "blockly"],
  "tested": true,
  "url": "original library URL"
}
```

Board compatibility shorthand:
- Universal: `"core": []` (empty array = all boards)
- ESP32 only: `"core": ["esp32:esp32"]`
- Classic Arduino: `"core": ["arduino:avr", "arduino:megaavr"]`
- IoT boards: `"core": ["esp32:esp32", "esp8266:esp8266", "renesas_uno:unor4wifi"]`

---

## Common Anti-patterns

| ❌ Wrong | ✅ Correct |
|----------|-----------|
| Write `Serial.begin()` directly | Use `ensureSerialBegin(port, generator)` |
| Hardcoded Wire key `'WIRE_BEGIN'` | Use `wire_${wireName}_begin` formatted key |
| Modify `window['boardConfig']` | Use `window['customXxx']` for custom storage |
| `addSetupBegin` for sensor init | `addSetupBegin` is bus-only; use `addSetup` for sensors |
| No shadow blocks for `input_value` | Always configure shadow blocks in toolbox.json |
| Extension register without unregister | Always `unregister()` before `register()` |
| `addFunction` without 3rd param | Pass `true` when helper function must be globally visible |
| Skip `ensureSerialBegin` in quick ops | Quick operations using Serial.println need it too |

---

## Quality Checklist

- [ ] Covers 80%+ core features of the original library
- [ ] New users can get started within 10 minutes
- [ ] Common tasks complete in ≤ 3 steps
- [ ] Generated code compiles 100%
- [ ] Supports target development boards
- [ ] All `input_value` have shadow blocks in toolbox.json
- [ ] Serial init uses `ensureSerialBegin()`
- [ ] I2C init uses `wire_${wire}_begin` key deduplication
- [ ] SPI init uses `spi_${spi}_begin` key deduplication
- [ ] `addSetupBegin` only used for bus-level initialization
- [ ] Extensions unregister before register
- [ ] Never directly modifies `window['boardConfig']`
- [ ] Variable rename listener implemented on `field_input` blocks
