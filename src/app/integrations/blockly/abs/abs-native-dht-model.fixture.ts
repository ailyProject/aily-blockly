// Readonly installed DHT library snapshot; full generator, not a production adapter.
export const dhtModelFixture = {
  "source": "function registerVariableToBlockly(varName, varType) {\n  // 获取当前工作区\n  const workspace = Blockly.getMainWorkspace();\n  if (workspace && workspace.createVariable && varName) {\n    // 检查是否已存在同名变量（不考虑类型）\n    const existingVar = workspace.getVariable(varName);\n    if (existingVar) {\n      return; // 已存在，无需创建\n    }\n    \n    // 创建新变量（如果varType为undefined，Blockly会创建无类型变量）\n    if (varType !== undefined) {\n      workspace.createVariable(varName, varType);\n    } else {\n      workspace.createVariable(varName, '');\n    }\n    // console.log('Variable registered to Blockly:', varName, varType);\n  }\n}\nfunction isBlockConnected(block, targetBlockType = null) {\n  if (!block) return false;\n\n  // 获取入口块类型列表\n  const entryTypes = (typeof window !== 'undefined') ? window.ENTRY_BLOCK_TYPES : \n                     (typeof global !== 'undefined') ? global.ENTRY_BLOCK_TYPES : \n                     ['arduino_setup', 'arduino_loop'];\n\n  // 确定要查找的目标类型\n  let targetTypes;\n  if (targetBlockType === null || targetBlockType === undefined) {\n    // 未指定目标类型时，检查是否连接到任意入口块\n    targetTypes = entryTypes;\n  } else {\n    // 将目标类型统一为数组\n    targetTypes = Array.isArray(targetBlockType) ? targetBlockType : [targetBlockType];\n  }\n\n  // 向上遍历查找目标块\n  const visited = new Set();\n  let currentBlock = block;\n\n  while (currentBlock) {\n    if (visited.has(currentBlock.id)) break;\n    visited.add(currentBlock.id);\n\n    // 检查当前块是否为目标类型\n    if (targetTypes.includes(currentBlock.type)) {\n      return true;\n    }\n\n    // 向上遍历：依次检查包围父块、前置连接、输出连接\n    let nextBlock = null;\n\n    // 1. 检查包围的父块（块嵌套在语句输入中）\n    const surroundParent = currentBlock.getSurroundParent();\n    if (surroundParent) {\n      nextBlock = surroundParent;\n    }\n    // 2. 检查前置连接（语句块的上方块）\n    else if (currentBlock.previousConnection && currentBlock.previousConnection.isConnected()) {\n      nextBlock = currentBlock.previousConnection.targetBlock();\n    }\n    // 3. 检查输出连接（表达式块所连接的块）\n    else if (currentBlock.outputConnection && currentBlock.outputConnection.isConnected()) {\n      nextBlock = currentBlock.outputConnection.targetBlock();\n    }\n\n    currentBlock = nextBlock;\n  }\n\n  return false;\n}\n// 定义DHT块的动态扩展\nif (Blockly.Extensions.isRegistered('dht_init_dynamic')) {\n  Blockly.Extensions.unregister('dht_init_dynamic');\n}\nBlockly.Extensions.register('dht_init_dynamic', function () {\n  // 获取i18n翻译\n  const i18n = window.__BLOCKLY_LIB_I18N__?.['@aily-project/lib-dht']?.extensions?.dht_init_dynamic || {};\n  const i2cLabel = i18n.i2c_interface || 'I2C接口';\n  const pinLabel = i18n.pin || '引脚';\n\n  this.updateShape_ = function (dhtType) {\n    if (this.getInput('PIN_SET')) this.removeInput('PIN_SET');\n    if (this.getInput('WIRE_SET')) this.removeInput('WIRE_SET');\n    switch (dhtType) {\n      case 'DHT20':\n        const i2cOptions = (window.boardConfig && window.boardConfig.i2c) ? window.boardConfig.i2c : [['I2C0','I2C0']];\n        this.appendDummyInput('WIRE_SET')\n            .appendField(i2cLabel)\n            .appendField(new Blockly.FieldDropdown(i2cOptions), 'WIRE');\n        break;\n      default:\n        const pinOptions = (window.boardConfig && window.boardConfig.digitalPins) ? window.boardConfig.digitalPins : [['D2','2'], ['D3','3'], ['D4','4'], ['D5','5'], ['D6','6'], ['D7','7'], ['D8','8'], ['D9','9'], ['D10','10'], ['D11','11'], ['D12','12'], ['D13','13']];\n        this.appendDummyInput('PIN_SET')\n            .appendField(pinLabel)\n            .appendField(new Blockly.FieldDropdown(pinOptions), 'PIN');\n        break;\n    }\n  };\n  this.getField('TYPE').setValidator(option => {\n    this.updateShape_(option);\n    return option;\n  });\n  // 初始化形状\n  this.updateShape_(this.getFieldValue('TYPE'));\n});\n\n// 通用库管理函数，确保不重复添加库\nfunction ensureLibrary(generator, libraryKey, libraryCode) {\n  if (!generator.libraries_) {\n    generator.libraries_ = {};\n  }\n  if (!generator.libraries_[libraryKey]) {\n    generator.addLibrary(libraryKey, libraryCode);\n  }\n}\n\nfunction ensureDHTLibrary(generator) {\n  ensureLibrary(generator, 'DHT_include', '#include <DHT.h>');\n}\n\nfunction ensureDHT20Library(generator) {\n  ensureLibrary(generator, 'Wire_include', '#include <Wire.h>');\n  ensureLibrary(generator, 'DHT20_include', '#include <DHT20.h>');\n}\n\n// 初始化类型映射表\nif (!Arduino.dhtTypeMap) {\n  Arduino.dhtTypeMap = {};\n}\n\nArduino.forBlock['dht_init'] = function (block, generator) {\n  // 检查块是否连接到代码流程中，如果是独立块则不生成代码\n  // 使用全局函数，支持指定目标块类型\n  const isConnected = isBlockConnected(block);\n  \n  // 添加引脚动态显示逻辑\n  // if (!block._pinVisibilityAttached) {\n  //   block._pinVisibilityAttached = true;\n    \n  //   const typeField = block.getField('TYPE');\n  //   if (typeField && typeof typeField.setValidator === 'function') {\n  //     typeField.setValidator(function(newValue) {\n  //       const pinField = block.getField('PIN');\n  //       if (pinField && typeof pinField.setVisible === 'function') {\n  //         // DHT20 使用I2C，隐藏引脚；其他显示引脚\n  //         pinField.setVisible(newValue !== 'DHT20');\n  //       }\n  //       return newValue;\n  //     });\n  //   }\n    \n  //   // 初始化时检查当前值\n  //   const currentType = block.getFieldValue('TYPE');\n  //   const pinField = block.getField('PIN');\n  //   if (pinField && typeof pinField.setVisible === 'function' && currentType === 'DHT20') {\n  //     pinField.setVisible(false);\n  //   }\n  // }\n  \n  // 监听VAR输入值的变化，自动重命名Blockly变量\n  if (!block._dhtVarMonitorAttached) {\n    block._dhtVarMonitorAttached = true;\n    block._dhtVarLastName = block.getFieldValue('VAR') || 'dht';\n    // 初次注册变量到 Blockly 系统（仅执行一次）\n    registerVariableToBlockly(block._dhtVarLastName, 'DHT');\n    const varField = block.getField('VAR');\n    if (varField) {\n      const originalFinishEditing = varField.onFinishEditing_;\n      varField.onFinishEditing_ = function(newName) {\n        if (typeof originalFinishEditing === 'function') {\n          originalFinishEditing.call(this, newName);\n        }\n        const workspace = block.workspace || (typeof Blockly !== 'undefined' && Blockly.getMainWorkspace && Blockly.getMainWorkspace());\n        const oldName = block._dhtVarLastName;\n        if (workspace && newName && newName !== oldName) {\n          renameVariableInBlockly(block, oldName, newName, 'DHT');\n          block._dhtVarLastName = newName;\n        }\n      };\n    }\n  }\n\n  var varName = block.getFieldValue('VAR') || 'dht';\n  var dht_type = block.getFieldValue('TYPE');\n  // var pin = block.getFieldValue('PIN');\n\n  // 保存类型映射\n  Arduino.dhtTypeMap[varName] = dht_type;\n\n  let code = '';\n  // DHT20 特殊处理（I2C接口）\n  if (dht_type === 'DHT20') {\n    var wire = block.getFieldValue('WIRE');\n    // 注册Blockly变量，类型为DHT20\n    \n    // 确保DHT20库已添加\n    ensureDHT20Library(generator);\n    \n    // 添加DHT20对象定义（使用Wire）\n    var dht20Def = 'DHT20 ' + varName + '(&' + wire + ');';\n    generator.addObject(varName, dht20Def);\n    \n    generator.sensorVarName = varName;\n    \n    // 在setup中初始化I2C和DHT20\n    generator.addSetup(`wire_${wire}_begin`, wire + '.begin();');\n    // generator.addSetup(`${varName}_begin`, varName + '.begin();');\n    code += `${varName}.read();\\n`; // 读取以初始化传感器\n  } else {\n    var pin = block.getFieldValue('PIN');\n    // DHT11/22/21 处理（单总线接口）\n    // 注册Blockly变量，类型为DHT，同名变量只注册一次\n    registerVariableToBlockly(varName, 'DHT');\n    \n    // 确保DHT库已添加\n    ensureDHTLibrary(generator);\n    \n    // 添加DHT对象定义，使用用户指定的变量名\n    var dhtDef = 'DHT ' + varName + '(' + pin + ', ' + dht_type + ');';\n    generator.addObject(varName, dhtDef);\n    \n    generator.sensorVarName = varName;\n    \n    // 在setup中初始化DHT对象\n    // generator.addSetupBegin(varName + '_begin', varName + '.begin();');\n    code += `${varName}.begin();\\n`;\n  }\n\n  if (!isConnected) {\n    return '';\n  }\n\n  // 使用ensureDHTInit确保DHT传感器初始化\n  // ensureDHTInit(pin, dht_type, generator);\n\n  return code;\n};\n\nArduino.forBlock['dht_read_temperature'] = function (block, generator) {\n  const varField = block.getField('VAR');\n  const varName = varField ? varField.getText() : 'dht';\n  \n  // 通过类型映射表检查是否为DHT20\n  const dhtType = Arduino.dhtTypeMap[varName] || 'DHT11';\n  \n  // DHT20 需要先调用read()再获取数据\n  if (dhtType === 'DHT20') {\n    return ['(' + varName + '.read(), ' + varName + '.getTemperature())', Arduino.ORDER_COMMA];\n  }\n  \n  return [varName + '.readTemperature()', Arduino.ORDER_ATOMIC];\n};\n\nArduino.forBlock['dht_read_humidity'] = function (block, generator) {\n  const varField = block.getField('VAR');\n  const varName = varField ? varField.getText() : 'dht';\n  \n  // 通过类型映射表检查是否为DHT20\n  const dhtType = Arduino.dhtTypeMap[varName] || 'DHT11';\n  \n  // DHT20 需要先调用read()再获取数据\n  if (dhtType === 'DHT20') {\n    return ['(' + varName + '.read(), ' + varName + '.getHumidity())', Arduino.ORDER_COMMA];\n  }\n  \n  return [varName + '.readHumidity()', Arduino.ORDER_ATOMIC];\n};\n\nArduino.forBlock['dht_read_success'] = function (block, generator) {\n  const varField = block.getField('VAR');\n  const varName = varField ? varField.getText() : 'dht';\n  \n  // 通过类型映射表检查是否为DHT20\n  const dhtType = Arduino.dhtTypeMap[varName] || 'DHT11';\n  \n  // DHT20 的成功判断方式不同\n  if (dhtType === 'DHT20') {\n    return ['(' + varName + '.read() == DHT20_OK)', Arduino.ORDER_RELATIONAL];\n  }\n  \n  return ['!isnan(' + varName + '.readTemperature()) && !isnan(' + varName + '.readHumidity())', Arduino.ORDER_LOGICAL_AND];\n};\n\n",
  "blocks": [
    {
      "type": "dht_init",
      "message0": "初始化 DHT %1 传感器 类型 %2",
      "args0": [
        {
          "type": "field_input",
          "name": "VAR",
          "text": "dht"
        },
        {
          "type": "field_dropdown",
          "name": "TYPE",
          "options": [
            [
              "DHT11",
              "DHT11"
            ],
            [
              "DHT22",
              "DHT22"
            ],
            [
              "DHT21",
              "DHT21"
            ],
            [
              "DHT20",
              "DHT20"
            ]
          ]
        }
      ],
      "inputsInline": true,
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#4CAF50",
      "icon": "iconfont icon-dht22",
      "extensions": [
        "dht_init_dynamic"
      ]
    },
    {
      "type": "dht_read_temperature",
      "message0": "从 DHT %1 传感器 读取温度 (℃)",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "dht",
          "variableTypes": [
            "DHT"
          ],
          "defaultType": "DHT"
        }
      ],
      "inputsInline": true,
      "output": "Number",
      "colour": "#4CAF50",
      "icon": "iconfont icon-dht22"
    },
    {
      "type": "dht_read_humidity",
      "message0": "从 DHT %1 传感器 读取湿度 (%)",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "dht",
          "variableTypes": [
            "DHT"
          ],
          "defaultType": "DHT"
        }
      ],
      "inputsInline": true,
      "output": "Number",
      "colour": "#4CAF50",
      "icon": "iconfont icon-dht22"
    },
    {
      "type": "dht_read_success",
      "message0": "DHT %1 传感器 读取成功",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "dht",
          "variableTypes": [
            "DHT"
          ],
          "defaultType": "DHT"
        }
      ],
      "inputsInline": true,
      "output": "Boolean",
      "colour": "#4CAF50",
      "icon": "iconfont icon-dht22"
    }
  ]
};
