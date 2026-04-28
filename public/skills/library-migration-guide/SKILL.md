---
name: library-migration-guide
description: "Blockly 库转换规范：将 Arduino/ESP32 硬件库转换为 Aily Blockly 兼容格式的完整流程、block.json 设计、generator.js 实现与 toolbox.json 配置。包含串口/I2C/SPI 总线初始化、代码注入顺序、开发板适配等专业规范。触发词：库转换、迁移、migration、block.json、generator、ensureSerialBegin、Wire.begin、SPI"
metadata:
  version: "3.0.0"
  author: aily-team
  scope: global
  agents: mainAgent
  auto-activate: false
  tags: library,migration,conversion,block-json,generator,serial,i2c,spi,board-config
---

# Blockly 库转换规范

基于真实转换案例（ArduinoJson、OneButton、MQTT/PubSubClient、DHT、INA219、VL53L0X 等）的系统性指南，帮助将 Arduino 库转换为 Blockly 库。

## 核心原则

1. **用户体验优先**：简化复杂 API，提供直观操作
2. **功能完整**：覆盖原始库核心功能，保持语义一致
3. **智能自动化**：自动处理初始化、变量管理、错误检查
4. **类型安全**：通过约束防止连接错误
5. **开发板适配**：智能适配不同 Arduino 开发板
6. **总线复用**：Serial/I2C/SPI 初始化必须使用平台统一方法，确保与其他库共存

## 转换流程

```
源码分析 → 块设计 → block.json → generator.js → toolbox.json → 测试
```

## 库目录结构

```
library-name/
├─ block.json        // 块定义
├─ generator.js      // 代码生成器
├─ toolbox.json      // 工具箱配置
├─ README.md         // 人类可读文档
├─ README_AI.md      // LLM 可读文档
└─ src/              // Arduino 库源码
```

---

## 一、源码分析

### 1.1 API 识别

分析头文件，识别公共 API，按操作类型分类：

| 操作类型 | 说明 | 示例 |
|---------|------|------|
| 初始化 | 对象创建、基本配置 | `PubSubClient(client)`, `setServer()` |
| 连接 | 网络连接、认证 | `connect(clientId, user, pass)` |
| 通信 | 发送、接收、订阅 | `publish()`, `subscribe()` |
| 状态 | 连接检查、错误状态 | `connected()`, `state()` |
| 维护 | 保持连接、清理资源 | `loop()` |
| 快捷操作 | 一个块完成完整工作流 | 文件读写、数据传输 |

### 1.2 用户流程设计

```
设备初始化 → 网络连接 → 服务配置 → 数据交换 → 状态监控
                                         ↓
                                    快捷操作模式
                                   (简化工作流)
```

---

## 二、block.json 设计规范

### 2.1 块类型映射规则

| Arduino 模式 | 块类型 | 连接方式 | 字段类型 | 设计要点 |
|-------------|--------|----------|----------|---------|
| 对象创建/初始化 | Statement | previousStatement/nextStatement | `field_input` | 用户输入变量名，自动注册 |
| 全局对象方法调用 | Statement | previousStatement/nextStatement | 无变量字段 | 直接调用全局对象（Serial、httpUpdate 等） |
| 对象方法调用 | Statement | previousStatement/nextStatement | `field_variable` | 引用已创建的对象变量 |
| 全局对象状态查询 | Value | output: ["Type"] | 无变量字段 | 直接返回全局对象状态 |
| 快捷操作 | Statement/Value | 标准连接 | 无变量字段，直接参数 | 自动生成辅助函数 |
| 事件回调 | Hat 块 | 无 previousStatement/nextStatement | `field_variable` + `input_statement` | 帽子模式，事件驱动 |
| 条件回调 | 混合块 | 有 previousStatement/nextStatement | `input_value` + `input_statement` | 主程序流中定义条件回调 |
| 状态查询 | Value | output: ["Type"] | `field_variable` | 引用对象，返回值 |

### 2.2 field_input vs field_variable

**`field_input`：用于对象初始化**（用户输入新变量名）：
```json
{
  "type": "field_input",
  "name": "VAR",
  "text": "button1"
}
```

**`field_variable`：用于方法调用**（选择已有变量）：
```json
{
  "type": "field_variable",
  "name": "VAR",
  "variable": "button1",
  "variableTypes": ["OneButton"],
  "defaultType": "OneButton"
}
```

**generator.js 中读取变量名**：
- `field_input`：`block.getFieldValue('VAR')`
- `field_variable`：`const varField = block.getField('VAR'); const varName = varField ? varField.getText() : 'default';`
- 全局对象：直接使用对象名，如 `Serial`、`WiFi`

### 2.3 全局对象识别标准

- **平台内建**：`Serial`、`Wire`、`SPI`、`WiFi`、`httpUpdate`、`SPIFFS`、`ESP`、`EEPROM` 等
- **库全局实例**：头文件中已声明为全局实例的对象
- **单例对象**：设计为全局唯一访问的对象

全局对象块无需变量管理和重命名监听器。

### 2.4 开发板配置模板变量（block.json 专用）

block.json 中的 `field_dropdown` 可使用以下模板变量，运行时由平台自动填充：

| 模板变量 | 说明 | 示例用途 |
|---------|------|---------|
| `${board.i2c}` | I2C 接口列表 | I2C 传感器的 Wire 选择 |
| `${board.digitalPins}` | 数字引脚列表 | GPIO 引脚选择 |
| `${board.analogPins}` | 模拟引脚列表 | ADC 引脚选择 |
| `${board.serialPort}` | 串口列表 | Serial/Serial1/Serial2 选择 |
| `${board.serialSpeed}` | 波特率列表 | 9600/115200 等选择 |
| `${board.interruptPins}` | 中断引脚列表 | 外部中断引脚选择 |
| `${board.interruptMode}` | 中断模式列表 | RISING/FALLING/CHANGE 选择 |

**I2C 传感器下拉菜单标准写法**：
```json
{
  "type": "field_dropdown",
  "name": "WIRE",
  "options": "${board.i2c}"
}
```

### 2.5 标准块结构模板

**基本 Statement 块**（自定义对象）：
```json
{
  "type": "libname_funcname",
  "message0": "描述标签 %1 %2",
  "args0": [
    {
      "type": "field_variable",
      "name": "VAR",
      "variable": "defaultName",
      "variableTypes": ["CustomType"],
      "defaultType": "CustomType"
    },
    {"type": "input_value", "name": "PARAM", "check": ["Type"]}
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#统一颜色",
  "tooltip": "块功能描述"
}
```

**全局对象调用块**（无变量字段）：
```json
{
  "type": "serial_println",
  "message0": "Serial %1 print %2 with newline",
  "args0": [
    {
      "type": "field_dropdown",
      "name": "SERIAL",
      "options": "${board.serialPort}"
    },
    {"type": "input_value", "name": "VAR"}
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#48c2c4",
  "tooltip": "串口打印（换行）"
}
```

**I2C 传感器初始化块**（含 Wire 选择和可选地址）：
```json
{
  "type": "sensor_init",
  "message0": "initialize sensor %1 I2C %2 address %3",
  "args0": [
    {"type": "field_input", "name": "VAR", "text": "sensor"},
    {
      "type": "field_dropdown",
      "name": "WIRE",
      "options": "${board.i2c}"
    },
    {
      "type": "field_dropdown",
      "name": "ADDRESS",
      "options": [["0x44", "0x44"], ["0x45", "0x45"]]
    }
  ],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#4CAF50",
  "tooltip": "初始化 I2C 传感器"
}
```

**全局对象状态查询块**（Value 输出，无参数）：
```json
{
  "type": "httpupdate_get_last_error",
  "message0": "get last update error code",
  "output": "Number",
  "colour": "#FF9800",
  "tooltip": "返回最后一次更新的错误码"
}
```

**事件回调块**（Hat 模式，无连接属性，返回空字符串）：
```json
{
  "type": "onebutton_attach_click",
  "message0": "when button %1 is clicked",
  "args0": [
    {
      "type": "field_variable",
      "name": "VAR",
      "variable": "button",
      "variableTypes": ["OneButton"],
      "defaultType": "OneButton"
    }
  ],
  "message1": "do %1",
  "args1": [{"type": "input_statement", "name": "HANDLER"}],
  "colour": "#5CB85C",
  "tooltip": "设置按钮单击事件处理器"
}
```

**混合块**（条件回调，有连接属性 + 回调体，返回条件代码）：
```json
{
  "type": "pubsub_set_callback_with_topic",
  "message0": "when topic %1 received do",
  "args0": [{"type": "input_value", "name": "TOPIC"}],
  "message1": "%1",
  "args1": [{"type": "input_statement", "name": "HANDLER"}],
  "previousStatement": null,
  "nextStatement": null,
  "colour": "#9C27B0",
  "tooltip": "处理特定 MQTT 主题"
}
```

### 2.6 Extensions（动态扩展）

block.json 中可通过 `extensions` 数组引用在 generator.js 中注册的扩展，用于运行时动态修改块形状：

```json
{
  "type": "dht_init",
  "extensions": ["dht_init_dynamic"]
}
```

**扩展注册模式**（generator.js 中）：
```javascript
// 必须先检查并移除已注册的扩展（避免重复加载错误）
if (Blockly.Extensions.isRegistered('extension_name')) {
  Blockly.Extensions.unregister('extension_name');
}
Blockly.Extensions.register('extension_name', function() {
  this.updateShape_ = function(value) {
    // 根据字段值动态添加/移除输入
    if (this.getInput('DYNAMIC_INPUT')) this.removeInput('DYNAMIC_INPUT');
    // 添加新输入...
  };
  this.getField('FIELD_NAME').setValidator(function(option) {
    this.getSourceBlock().updateShape_(option);
    return option;
  });
  this.updateShape_(this.getFieldValue('FIELD_NAME'));
});
```

**典型应用场景**：
- DHT 库：根据传感器型号切换 I2C 接口 / 数字引脚输入
- I2C 库：根据主/从模式动态显示地址输入
- 引脚信息显示：在 Wire 下拉菜单中附加 SDA/SCL 引脚信息

---

## 三、generator.js 实现规范

### 3.1 核心库函数

直接调用，无需自行实现：
- `registerVariableToBlockly(varName, varType)` — 注册变量到 Blockly 系统
- `renameVariableInBlockly(block, oldName, newName, varType)` — 重命名变量
- `ensureSerialBegin(serialPort, generator, baudrate?)` — 确保串口已初始化（由 core-serial 提供）

### 3.2 代码注入方法与执行顺序

Generator 提供多个代码注入方法，它们在生成的 Arduino sketch 中按固定顺序排列：

```cpp
#include <Library.h>           // generator.addLibrary(tag, code)
#define MACRO_NAME value       // generator.addMacro(tag, code)

int globalVar;                 // generator.addVariable(tag, code)
MyClass myObj;                 // generator.addObject(tag, code)

void myFunction() { }         // generator.addFunction(tag, code, isGlobal?)

void setup() {
  // ↓ generator.addSetupBegin(tag, code) — 最先执行，用于总线初始化
  Serial.begin(9600);
  Wire.begin();
  // ↓ generator.addSetup(tag, code) — 通用 setup 代码
  sensor.begin();
  // ↓ generator.addSetupEnd(tag, code) — 最后执行，依赖前面初始化完成
  attachCallback(handler);
}

void loop() {
  // ↓ generator.addLoopBegin(tag, code) — 循环开头，用于 tick()/轮询
  button.tick();
  // ↓ [用户在 arduino_loop 块中拖放的代码]
}
```

**所有注入方法均以 `(tag, code)` 为参数签名，通过 tag 自动去重。**

| 方法 | 注入位置 | 典型用途 |
|------|---------|---------|
| `addLibrary(tag, code)` | 文件头部 `#include` | 库引用 |
| `addMacro(tag, code)` | `#include` 之后 | 预处理器定义、条件编译 |
| `addVariable(tag, code)` | 全局作用域 | 简单变量声明 |
| `addObject(tag, code)` | 全局作用域 | 类实例声明 |
| `addFunction(tag, code, isGlobal?)` | 全局作用域 | 辅助函数定义，第三参数 `true` 确保全局可见 |
| `addSetupBegin(tag, code)` | `setup()` 最前 | **总线初始化**：`Serial.begin()`、`Wire.begin()`、`SPI.begin()` |
| `addSetup(tag, code)` | `setup()` 中间 | 传感器/模块初始化 |
| `addSetupEnd(tag, code)` | `setup()` 末尾 | 回调注册、依赖前序初始化的代码 |
| `addLoopBegin(tag, code)` | `loop()` 开头 | `tick()`、`loop()` 维护调用 |

### 3.3 串口初始化规范（ensureSerialBegin）

**规则：库中需要使用串口输出时，必须调用 `ensureSerialBegin()` 而非自行编写 `Serial.begin()`。**

`ensureSerialBegin` 由 core-serial 库全局提供，功能：
- 通过 `Arduino.addedSerialInitCode` Set 自动去重，避免重复初始化
- 检测 ESP32 自定义串口（`window['customSerialPorts']`），如已自定义则跳过
- 使用 `addSetupBegin` 确保串口初始化在 setup() 最先执行

```javascript
// ✅ 推荐：使用平台统一函数（无需额外判断）
ensureSerialBegin('Serial', generator);             // 默认 9600
ensureSerialBegin('Serial', generator, 115200);     // 指定波特率
ensureSerialBegin(serialPort, generator, baudRate);  // 动态串口

// ❌ 禁止：自行编写串口初始化（会导致与其他库重复或冲突）
generator.addSetupBegin('serial_begin', 'Serial.begin(9600);');
```

**在库中的使用时机**：
- 传感器初始化块中需要打印调试信息
- 快捷操作块中使用 `Serial.println()` 进行状态反馈
- 扫描功能（如 I2C 扫描）需要串口输出结果

### 3.4 I2C 总线初始化规范

**规则：I2C 传感器库不应自行实现 Wire 库管理，而应使用 aily_iic（I2C 通信库）提供的初始化能力进行 Wire 初始化去重。**

I2C 初始化的核心去重约定：使用 `wire_${wireName}_begin` 作为 setup key。

```javascript
// ✅ 推荐：I2C 传感器初始化块的标准模式
Arduino.forBlock['sensor_init'] = function(block, generator) {
  const wire = block.getFieldValue('WIRE') || 'Wire';
  const address = block.getFieldValue('ADDRESS') || '0x44';

  // 1. 添加必要的库引用
  generator.addLibrary('Wire', '#include <Wire.h>');
  generator.addLibrary('SensorLib', '#include <SensorLib.h>');
  ensureSerialBegin('Serial', generator);

  // 2. 声明传感器对象
  generator.addObject('sensor', 'SensorClass sensor;');

  // 3. Wire 初始化去重——使用统一的 key 格式 `wire_${wire}_begin`
  //    这与 aily_iic 库和其他 I2C 传感器使用同一个 key，
  //    因此无论用户是否已通过 wire_begin 块初始化了 Wire，
  //    都不会生成重复的 Wire.begin()
  const wireBeginKey = `wire_${wire}_begin`;
  if (!generator.setupCodes_ || !generator.setupCodes_[wireBeginKey]) {
    generator.addSetup(wireBeginKey, wire + '.begin();\n');
  }

  // 4. 传感器自身初始化
  let setupCode = '';
  if (wire !== 'Wire') {
    // 非默认 Wire 实例：传入 Wire 引用
    setupCode += 'if (!sensor.begin(' + address + ', &' + wire + ')) {\n';
  } else {
    setupCode += 'if (!sensor.begin(' + address + ')) {\n';
  }
  setupCode += '  Serial.println("Sensor init failed!");\n';
  setupCode += '}\n';

  return setupCode;
};
```

**I2C 去重 key 规范**：
- 标准格式：`wire_${wireName}_begin`（如 `wire_Wire_begin`、`wire_Wire1_begin`）
- 与 aily_iic 库（`wire_begin` 块）使用完全相同的 key
- 无论用户是否拖了 `wire_begin` 块，传感器库都能正确工作且不重复

**进阶：检查已有 Wire 初始化（包括自定义引脚模式）**：
```javascript
// 完整的 Wire 初始化去重检查（参考 INA219/VL53L0X 实现）
function ensureWireBegin(wire, generator) {
  const wireBeginKey = `wire_${wire}_begin`;
  let isAlreadyInitialized = false;

  if (generator.setupCodes_) {
    // 检查标准初始化 key
    if (generator.setupCodes_[wireBeginKey]) {
      isAlreadyInitialized = true;
    }
    // 也检查是否通过 wire_begin_with_settings 自定义引脚初始化过
    // （aily_iic 库的自定义引脚模式也使用 wire_${wire}_begin 作为 key）
  }

  if (!isAlreadyInitialized) {
    generator.addSetup(wireBeginKey, wire + '.begin();\n');
  }
}
```

**DHT20（I2C 传感器）的典型模式**：
```javascript
// DHT20 通过 Wire 对象引用方式初始化
if (dhtType === 'DHT20') {
  const wire = block.getFieldValue('WIRE') || 'Wire';
  generator.addObject(varName, 'DHT20 ' + varName + '(&' + wire + ');');
  // 使用统一 key 确保 Wire 初始化
  generator.addSetup(`wire_${wire}_begin`, wire + '.begin();');
  code += varName + '.read();\n';
}
```

### 3.5 SPI 总线初始化规范

**规则：SPI 设备库使用 `spi_${spiName}_begin` 作为去重 key。**

```javascript
// ✅ 标准 SPI 初始化
const spi = block.getFieldValue('SPI') || 'SPI';
generator.addLibrary('SPI', '#include <SPI.h>');
generator.addSetup(`spi_${spi}_begin`, spi + '.begin();\n');

// ESP32 自定义引脚 SPI 初始化
const sck = generator.valueToCode(block, 'SCK', generator.ORDER_ATOMIC);
const miso = generator.valueToCode(block, 'MISO', generator.ORDER_ATOMIC);
const mosi = generator.valueToCode(block, 'MOSI', generator.ORDER_ATOMIC);
const cs = generator.valueToCode(block, 'CS', generator.ORDER_ATOMIC);
generator.addLibrary('SPI', '#include <SPI.h>');
// 自定义引脚 SPI.begin(sck, miso, mosi, cs) 是 ESP32 特有
let code = 'SPI.begin(' + sck + ', ' + miso + ', ' + mosi + ', ' + cs + ');\n';
```

### 3.6 变量重命名监听器（必须自行实现）

初始化块使用 `field_input` 时，需实现重命名监听器：

```javascript
// 在 generator 函数开头添加，仅在首次执行时绑定
if (!block._varMonitorAttached) {
  block._varMonitorAttached = true;
  block._varLastName = block.getFieldValue('VAR') || 'defaultVar';
  registerVariableToBlockly(block._varLastName, 'VariableType');
  const varField = block.getField('VAR');
  if (varField) {
    const originalFinishEditing = varField.onFinishEditing_;
    varField.onFinishEditing_ = function(newName) {
      if (typeof originalFinishEditing === 'function') {
        originalFinishEditing.call(this, newName);
      }
      const workspace = block.workspace || (typeof Blockly !== 'undefined' && Blockly.getMainWorkspace && Blockly.getMainWorkspace());
      const oldName = block._varLastName;
      if (workspace && newName && newName !== oldName) {
        renameVariableInBlockly(block, oldName, newName, 'VariableType');
        block._varLastName = newName;
      }
    };
  }
}
```

### 3.7 Generator 实现模式

**自定义对象块**（含变量管理）：
```javascript
Arduino.forBlock['onebutton_setup'] = function(block, generator) {
  // 1. 变量重命名监听器（参见 3.6 节，此处省略）

  // 2. 提取参数
  const varName = block.getFieldValue('VAR') || 'button';
  const pin = block.getFieldValue('PIN');
  const activeLow = block.getFieldValue('ACTIVE_LOW') === 'TRUE';

  // 3. 库和变量管理（自动去重）
  generator.addLibrary('OneButton', '#include <OneButton.h>');
  registerVariableToBlockly(varName, 'OneButton');
  generator.addVariable('OneButton ' + varName, 'OneButton ' + varName + ';');

  // 4. 自动添加 tick() 到主循环（自动去重）
  generator.addLoopBegin(varName + '.tick();', varName + '.tick();');

  // 5. 生成代码
  return varName + '.setup(' + pin + ', INPUT_PULLUP, ' + activeLow + ');\n';
};
```

**I2C 传感器初始化块**（含 Wire 去重，参考 INA219/BH1750 实战代码）：
```javascript
Arduino.forBlock['bh1750_init'] = function(block, generator) {
  const varName = block.getFieldValue('VAR') || 'lightMeter';
  const address = block.getFieldValue('ADDRESS') || '0x23';
  const wire = block.getFieldValue('WIRE') || 'Wire';

  // 1. 库引用
  generator.addLibrary('Wire', '#include <Wire.h>');
  generator.addLibrary('BH1750', '#include <BH1750.h>');
  ensureSerialBegin('Serial', generator);

  // 2. 对象声明
  generator.addObject(varName, 'BH1750 ' + varName + '(' + address + ');');

  // 3. Wire 初始化去重（统一 key 格式）
  const wireBeginKey = `wire_${wire}_begin`;
  if (!generator.setupCodes_ || !generator.setupCodes_[wireBeginKey]) {
    generator.addSetup(wireBeginKey, wire + '.begin();\n');
  }

  // 4. 传感器初始化
  let setupCode = '// Initialize BH1750 light sensor\n';
  if (wire !== 'Wire') {
    setupCode += 'if (' + varName + '.begin(BH1750::CONTINUOUS_HIGH_RES_MODE, ' + address + ', &' + wire + ')) {\n';
  } else {
    setupCode += 'if (' + varName + '.begin()) {\n';
  }
  setupCode += '  Serial.println("BH1750 initialized!");\n';
  setupCode += '} else {\n';
  setupCode += '  Serial.println("BH1750 init failed!");\n';
  setupCode += '}\n';

  return setupCode;
};
```

**全局对象块**（无变量管理，简化）：
```javascript
Arduino.forBlock['serial_println'] = function(block, generator) {
  const serialPort = block.getFieldValue('SERIAL') || 'Serial';
  const content = generator.valueToCode(block, 'VAR', generator.ORDER_ATOMIC) || '""';
  return serialPort + '.println(' + content + ');\n';
};

Arduino.forBlock['httpupdate_get_last_error'] = function(block, generator) {
  generator.addLibrary('ESP32httpUpdate', '#include <ESP32httpUpdate.h>');
  return ['httpUpdate.getLastError()', generator.ORDER_ATOMIC];
};
```

**事件回调块**（Hat 模式，返回空字符串）：
```javascript
Arduino.forBlock['onebutton_attach_click'] = function(block, generator) {
  const varField = block.getField('VAR');
  const varName = varField ? varField.getText() : 'button';
  const handlerCode = generator.statementToCode(block, 'HANDLER') || '';
  const callbackName = 'onebutton_click_' + varName;

  const functionDef = `void ${callbackName}() {\n${handlerCode}}\n`;
  generator.addFunction(callbackName, functionDef);

  let code = varName + '.attachClick(' + callbackName + ');\n';
  generator.addSetupEnd(code, code);
  generator.addLoopBegin(varName + '.tick();', varName + '.tick();');

  return ''; // Hat 块返回空字符串
};
```

**混合块**（条件回调，返回条件代码）：
```javascript
Arduino.forBlock['pubsub_set_callback_with_topic'] = function(block, generator) {
  const topic = generator.valueToCode(block, 'TOPIC', generator.ORDER_ATOMIC) || '""';
  const callbackName = 'mqtt' + topic.replace(/[^a-zA-Z0-9]/g, '_') + '_sub_callback';
  const callbackBody = generator.statementToCode(block, 'HANDLER') || '';

  const functionDef = 'void ' + callbackName + '(const char* payload) {\n' + callbackBody + '}\n';
  generator.addFunction(callbackName, functionDef);

  return 'if (strcmp(topic, ' + topic + ') == 0) {\n  ' + callbackName + '(payload_str);\n}\n';
};
```

**快捷操作块**（自动生成辅助函数）：
```javascript
Arduino.forBlock['esp32_sd_write_file_quick'] = function(block, generator) {
  const path = generator.valueToCode(block, 'PATH', generator.ORDER_ATOMIC) || '""';
  const content = generator.valueToCode(block, 'CONTENT', generator.ORDER_ATOMIC) || '""';

  generator.addLibrary('FS', '#include <FS.h>');
  generator.addLibrary('SD', '#include <SD.h>');
  ensureSerialBegin('Serial', generator); // 确保串口可用于错误输出

  let functionDef = '';
  functionDef += 'void writeFile(const char * path, const char * message) {\n';
  functionDef += '  File file = SD.open(path, FILE_WRITE);\n';
  functionDef += '  if (!file) { Serial.println("Failed to open file"); return; }\n';
  functionDef += '  file.print(message);\n';
  functionDef += '  file.close();\n';
  functionDef += '}\n';
  generator.addFunction('writeFile_function', functionDef, true);

  return 'writeFile(' + path + ', ' + content + ');\n';
};
```

### 3.8 valueToCode 与 ORDER 常量

从 `input_value` 提取嵌入块的代码时使用 `generator.valueToCode(block, inputName, order)`。

返回值块使用 `return [code, order]` 格式。

| 常量 | 用途 |
|------|------|
| `generator.ORDER_ATOMIC` | 原子级表达式：字面量、变量、函数调用、括号表达式 |
| `generator.ORDER_FUNCTION_CALL` | 方法调用返回值：`obj.method()` |

```javascript
// 提取输入值（大多数场景用 ORDER_ATOMIC）
const value = generator.valueToCode(block, 'VALUE', generator.ORDER_ATOMIC) || '0';

// 返回值块
return [wire + '.read()', generator.ORDER_FUNCTION_CALL];
return [varName, generator.ORDER_ATOMIC];
```

### 3.9 智能开发板适配

**通过 `window['boardConfig']` 访问运行时开发板配置：**

```javascript
const boardConfig = window['boardConfig'];
// boardConfig.core — 核心标识，如 'esp32:esp32', 'arduino:avr'
// boardConfig.name — 板子名称
// boardConfig.i2c — I2C 接口列表 [['Wire', 'Wire'], ['Wire1', 'Wire1']]
// boardConfig.i2cPins — I2C 引脚映射 {'Wire': [['SDA',21], ['SCL',22]]}
// boardConfig.digitalPins — 数字引脚列表
// boardConfig.serialPort — 串口列表
```

**开发板检测模式**：
```javascript
function isESP32(boardConfig) {
  return boardConfig && boardConfig.core && boardConfig.core.indexOf('esp32') > -1;
}

// WiFi 库适配（不同板使用不同头文件）
function ensureWiFiLib(generator) {
  const boardConfig = window['boardConfig'];
  if (boardConfig && boardConfig.core && boardConfig.core.indexOf('esp32') > -1) {
    generator.addLibrary('WiFi', '#include <WiFi.h>');
  } else if (boardConfig && boardConfig.core && boardConfig.core.indexOf('renesas_uno') > -1) {
    generator.addLibrary('WiFi', '#include <WiFiS3.h>');
  } else {
    generator.addLibrary('WiFi', '#include <WiFi.h>');
  }
}
```

**重要：永远不要直接修改 `window['boardConfig']`**，如需存储自定义配置请使用独立存储：
```javascript
// ✅ 使用独立存储
if (!window['customI2CPins']) { window['customI2CPins'] = {}; }
window['customI2CPins'][wire] = [['SDA', sda], ['SCL', scl]];

// ❌ 禁止直接修改全局配置
boardConfig.i2cPins[wire] = [...]; // 会影响所有库
```

---

## 四、toolbox.json 配置

**所有 `input_value` 插槽必须配置 shadow 块**：
```json
{
  "kind": "block",
  "type": "pubsub_publish",
  "inputs": {
    "TOPIC": {"shadow": {"type": "text", "fields": {"TEXT": "topic"}}},
    "PAYLOAD": {"shadow": {"type": "text", "fields": {"TEXT": "hello"}}}
  }
}
```

**数值型 shadow 块**：
```json
{
  "kind": "block",
  "type": "wire_set_clock",
  "inputs": {
    "FREQUENCY": {
      "shadow": {"type": "math_number", "fields": {"NUM": "100000"}}
    }
  }
}
```

**按用户认知流程组织**：
```json
{
  "kind": "category",
  "name": "MQTT",
  "icon": "iconfont icon-mqtt",
  "contents": [
    {"kind": "label", "text": "连接"},
    {"kind": "block", "type": "mqtt_create"},
    {"kind": "label", "text": "通信"},
    {"kind": "block", "type": "mqtt_publish"}
  ]
}
```

---

## 五、package.json 配置

```json
{
  "name": "@aily-project/lib-libname",
  "nickname": "显示名称",
  "nickname_zh_cn": "中文显示名称",
  "nickname_en": "English Display Name",
  "description": "简洁描述（<50字符）",
  "version": "语义化版本",
  "compatibility": {
    "core": ["arduino:avr", "esp32:esp32", "esp8266:esp8266", "renesas_uno:unor4wifi"],
    "voltage": [3.3, 5]
  },
  "keywords": ["aily", "blockly", "功能关键词"],
  "tested": true,
  "url": "原始库 URL"
}
```

**开发板适配简写**：
- 通用库：`"core": []`（空数组 = 支持所有板）
- 仅 ESP32：`"core": ["esp32:esp32"]`
- 经典 Arduino：`"core": ["arduino:avr", "arduino:megaavr"]`
- IoT 板：`"core": ["esp32:esp32", "esp8266:esp8266", "renesas_uno:unor4wifi"]`

---

## 六、常见错误与反模式

| 错误 | 正确做法 |
|------|---------|
| 自行编写 `Serial.begin()` | 调用 `ensureSerialBegin(port, generator)` |
| 使用硬编码 key 如 `'WIRE_BEGIN'` 做 Wire 初始化 | 使用 `wire_${wireName}_begin` 格式化 key |
| 直接修改 `window['boardConfig']` | 使用独立存储如 `window['customXxx']` |
| 未检查 `generator.setupCodes_` 就添加 setup 代码 | 先检查 key 是否存在再添加 |
| `addFunction` 未传第三参数 | 辅助函数需全局可见时传 `true` |
| `input_value` 无 shadow 块 | toolbox.json 中必须为所有 `input_value` 配置 shadow |
| Extension 注册未先检查已注册 | 先 `unregister` 再 `register`，避免重复加载报错 |
| 使用 `addSetupBegin` 做传感器初始化 | `addSetupBegin` 仅用于总线级初始化（Serial/Wire/SPI），传感器用 `addSetup` |

---

## 七、质量检查清单

- [ ] 覆盖原始库 80%+ 核心功能
- [ ] 新用户 10 分钟内上手
- [ ] 常见任务 ≤3 步完成
- [ ] 生成代码 100% 可编译
- [ ] 支持目标开发板
- [ ] 所有 `input_value` 都有 shadow 块
- [ ] 串口初始化使用 `ensureSerialBegin()`
- [ ] I2C 初始化使用 `wire_${wire}_begin` key 去重
- [ ] SPI 初始化使用 `spi_${spi}_begin` key 去重
- [ ] `addSetupBegin` 仅用于总线级初始化
- [ ] Extension 注册前先 unregister
- [ ] 未直接修改 `window['boardConfig']`
