// Readonly library snapshot: actual registration and full SPI generator.
export const spiModelFixture = {
  "source": "function registerVariableToBlockly(varName, varType) {\n  // 获取当前工作区\n  const workspace = Blockly.getMainWorkspace();\n  if (workspace && workspace.createVariable && varName) {\n    // 检查是否已存在同名变量（不考虑类型）\n    const existingVar = workspace.getVariable(varName);\n    if (existingVar) {\n      return; // 已存在，无需创建\n    }\n    \n    // 创建新变量（如果varType为undefined，Blockly会创建无类型变量）\n    if (varType !== undefined) {\n      workspace.createVariable(varName, varType);\n    } else {\n      workspace.createVariable(varName, '');\n    }\n    // console.log('Variable registered to Blockly:', varName, varType);\n  }\n}\n/**\r\n * Adafruit MAX31865 RTD Sensor - Blockly Generator\r\n * Supports PT100/PT1000 RTD sensor via SPI interface\r\n */\r\n\r\n// ============================================================\r\n// Extension: Dynamic SPI mode switching (Hardware/Software)\r\n// ============================================================\r\nif (typeof Blockly !== 'undefined' && Blockly.Extensions) {\r\n  if (Blockly.Extensions.isRegistered('max31865_spi_mode_extension')) {\r\n    Blockly.Extensions.unregister('max31865_spi_mode_extension');\r\n  }\r\n  Blockly.Extensions.register('max31865_spi_mode_extension', function() {\r\n    var block = this;\r\n    block.updateShape_ = function(mode) {\r\n      // Remove SW pin inputs if they exist\r\n      if (block.getInput('SW_MOSI')) block.removeInput('SW_MOSI');\r\n      if (block.getInput('SW_MISO')) block.removeInput('SW_MISO');\r\n      if (block.getInput('SW_SCK')) block.removeInput('SW_SCK');\r\n\r\n      if (mode === 'SW') {\r\n        // Add software SPI pin inputs\r\n        block.appendDummyInput('SW_SCK')\r\n          .appendField('SCK引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D5', '5'], ['D18', '18'], ['D19', '19']]\r\n          ), 'SW_SCK_PIN');\r\n        block.appendDummyInput('SW_MOSI')\r\n          .appendField('MOSI引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D23', '23'], ['D21', '21']]\r\n          ), 'SW_MOSI_PIN');\r\n        block.appendDummyInput('SW_MISO')\r\n          .appendField('MISO引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D19', '19'], ['D22', '22']]\r\n          ), 'SW_MISO_PIN');\r\n      }\r\n    };\r\n\r\n    var spiModeField = block.getField('SPI_MODE');\r\n    if (spiModeField) {\r\n      spiModeField.setValidator(function(option) {\r\n        block.updateShape_(option);\r\n        return option;\r\n      });\r\n    }\r\n    block.updateShape_(block.getFieldValue('SPI_MODE'));\r\n  });\r\n}\r\n\r\n// ============================================================\r\n// Init block - variable management + SPI setup\r\n// ============================================================\r\nArduino.forBlock['max31865_init'] = function(block, generator) {\r\n  // 1. Variable rename listener\r\n  if (!block._max31865VarMonitorAttached) {\r\n    block._max31865VarMonitorAttached = true;\r\n    block._max31865VarLastName = block.getFieldValue('VAR') || 'rtd';\r\n    registerVariableToBlockly(block._max31865VarLastName, 'Adafruit_MAX31865');\r\n    var varField = block.getField('VAR');\r\n    if (varField) {\r\n      var originalFinishEditing = varField.onFinishEditing_;\r\n      var capturedBlock = block;\r\n      varField.onFinishEditing_ = function(newName) {\r\n        if (typeof originalFinishEditing === 'function') {\r\n          originalFinishEditing.call(this, newName);\r\n        }\r\n        var workspace = capturedBlock.workspace || (typeof Blockly !== 'undefined' && Blockly.getMainWorkspace && Blockly.getMainWorkspace());\r\n        var oldName = capturedBlock._max31865VarLastName;\r\n        if (workspace && newName && newName !== oldName) {\r\n          renameVariableInBlockly(capturedBlock, oldName, newName, 'Adafruit_MAX31865');\r\n          capturedBlock._max31865VarLastName = newName;\r\n        }\r\n      };\r\n    }\r\n  }\r\n\r\n  // 2. Extract parameters\r\n  var varName = block.getFieldValue('VAR') || 'rtd';\r\n  var spiMode = block.getFieldValue('SPI_MODE');\r\n  var csPin = block.getFieldValue('CS_PIN');\r\n  var wires = block.getFieldValue('WIRES');\r\n  var swSck = block.getFieldValue('SW_SCK_PIN');\r\n  var swMosi = block.getFieldValue('SW_MOSI_PIN');\r\n  var swMiso = block.getFieldValue('SW_MISO_PIN');\r\n\r\n  // 3. Library includes\r\n  generator.addLibrary('SPI', '#include <SPI.h>');\r\n  generator.addLibrary('Adafruit_SPIDevice', '#include <Adafruit_SPIDevice.h>');\r\n  generator.addLibrary('Adafruit_MAX31865', '#include <Adafruit_MAX31865.h>');\r\n\r\n  // 4. Object declaration\r\n  if (spiMode === 'SW') {\r\n    generator.addObject(varName,\r\n      'Adafruit_MAX31865 ' + varName + '(' + csPin + ', ' + swMosi + ', ' + swMiso + ', ' + swSck + ');');\r\n  } else {\r\n    generator.addObject(varName, 'Adafruit_MAX31865 ' + varName + '(' + csPin + ');');\r\n  }\r\n\r\n  // 5. SPI bus initialization (dedup with spi_${spi}_begin key)\r\n  var spiBeginKey = 'spi_SPI_begin';\r\n  if (!generator.setupCodes_ || !generator.setupCodes_[spiBeginKey]) {\r\n    generator.addSetupBegin(spiBeginKey, 'SPI.begin();\\n');\r\n  }\r\n\r\n  // 6. Sensor begin\r\n  generator.addSetup(varName + '_begin',\r\n    varName + '.begin(' + wires + ');\\n');\r\n\r\n  return '';\r\n};\r\n\r\n// ============================================================\r\n// Read temperature - Value output block\r\n// ============================================================\r\nArduino.forBlock['max31865_read_temperature'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n  var rtdNominal = generator.valueToCode(block, 'RTD_NOMINAL', generator.ORDER_ATOMIC) || '100';\r\n  var refResistor = generator.valueToCode(block, 'REF_RESISTOR', generator.ORDER_ATOMIC) || '430';\r\n\r\n  return [varName + '.temperature(' + rtdNominal + ', ' + refResistor + ')', generator.ORDER_FUNCTION_CALL];\r\n};\r\n\r\n// ============================================================\r\n// Read raw RTD value - Value output block\r\n// ============================================================\r\nArduino.forBlock['max31865_read_rtd'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n\r\n  return [varName + '.readRTD()', generator.ORDER_FUNCTION_CALL];\r\n};\r\n\r\n// ============================================================\r\n// Read fault status - Value output block\r\n// ============================================================\r\nArduino.forBlock['max31865_read_fault'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n\r\n  return [varName + '.readFault()', generator.ORDER_FUNCTION_CALL];\r\n};\r\n\r\n// ============================================================\r\n// Clear fault - Statement block\r\n// ============================================================\r\nArduino.forBlock['max31865_clear_fault'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n\r\n  return varName + '.clearFault();\\n';\r\n};\r\n\r\n// ============================================================\r\n// Set wire type - Statement block\r\n// ============================================================\r\nArduino.forBlock['max31865_set_wires'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n  var wires = block.getFieldValue('WIRES');\r\n\r\n  return varName + '.setWires(' + wires + ');\\n';\r\n};\r\n\r\n// ============================================================\r\n// Auto convert toggle - Statement block\r\n// ============================================================\r\nArduino.forBlock['max31865_auto_convert'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n  var enable = block.getFieldValue('ENABLE') === 'TRUE';\r\n\r\n  return varName + '.autoConvert(' + (enable ? 'true' : 'false') + ');\\n';\r\n};\r\n\r\n// ============================================================\r\n// 50Hz filter toggle - Statement block\r\n// ============================================================\r\nArduino.forBlock['max31865_enable_50hz'] = function(block, generator) {\r\n  var varField = block.getField('VAR');\r\n  var varName = varField ? varField.getText() : 'rtd';\r\n  var enable = block.getFieldValue('ENABLE') === 'TRUE';\r\n\r\n  return varName + '.enable50Hz(' + (enable ? 'true' : 'false') + ');\\n';\r\n};\r\n",
  "blocks": [
    {
      "type": "max31865_init",
      "message0": "初始化 MAX31865 %1 SPI模式 %2 CS引脚 %3 线制 %4 %5",
      "args0": [
        {
          "type": "field_input",
          "name": "VAR",
          "text": "rtd"
        },
        {
          "type": "field_dropdown",
          "name": "SPI_MODE",
          "options": [
            [
              "硬件SPI",
              "HW"
            ],
            [
              "软件SPI",
              "SW"
            ]
          ]
        },
        {
          "type": "field_dropdown",
          "name": "CS_PIN",
          "options": "${board.digitalPins}"
        },
        {
          "type": "field_dropdown",
          "name": "WIRES",
          "options": [
            [
              "2线",
              "MAX31865_2WIRE"
            ],
            [
              "3线",
              "MAX31865_3WIRE"
            ],
            [
              "4线",
              "MAX31865_4WIRE"
            ]
          ]
        },
        {
          "type": "input_dummy",
          "name": "SW_PINS"
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6B35",
      "tooltip": "初始化 MAX31865 RTD温度传感器，设置SPI接口和线制",
      "extensions": [
        "max31865_spi_mode_extension"
      ]
    },
    {
      "type": "max31865_read_temperature",
      "message0": "%1 读取温度 RTD标称值 %2 参考电阻 %3",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        },
        {
          "type": "input_value",
          "name": "RTD_NOMINAL",
          "check": [
            "Number"
          ]
        },
        {
          "type": "input_value",
          "name": "REF_RESISTOR",
          "check": [
            "Number"
          ]
        }
      ],
      "output": "Number",
      "colour": "#FF6B35",
      "tooltip": "读取摄氏温度。PT100标称值为100，PT1000为1000；PT100参考电阻为430，PT1000为4300"
    },
    {
      "type": "max31865_read_rtd",
      "message0": "%1 读取原始RTD值",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        }
      ],
      "output": "Number",
      "colour": "#FF6B35",
      "tooltip": "读取16位原始RTD值（非温度值）"
    },
    {
      "type": "max31865_read_fault",
      "message0": "%1 读取故障状态",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        }
      ],
      "output": "Number",
      "colour": "#FF6B35",
      "tooltip": "读取8位故障状态寄存器"
    },
    {
      "type": "max31865_clear_fault",
      "message0": "%1 清除故障",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6B35",
      "tooltip": "清除故障状态寄存器中的所有故障"
    },
    {
      "type": "max31865_set_wires",
      "message0": "%1 设置线制 %2",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        },
        {
          "type": "field_dropdown",
          "name": "WIRES",
          "options": [
            [
              "2线",
              "MAX31865_2WIRE"
            ],
            [
              "3线",
              "MAX31865_3WIRE"
            ],
            [
              "4线",
              "MAX31865_4WIRE"
            ]
          ]
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6B35",
      "tooltip": "设置RTD线制（2线、3线或4线）"
    },
    {
      "type": "max31865_auto_convert",
      "message0": "%1 自动转换 %2",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        },
        {
          "type": "field_dropdown",
          "name": "ENABLE",
          "options": [
            [
              "启用",
              "TRUE"
            ],
            [
              "禁用",
              "FALSE"
            ]
          ]
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6B35",
      "tooltip": "启用或禁用连续自动转换模式"
    },
    {
      "type": "max31865_enable_50hz",
      "message0": "%1 50Hz滤波 %2",
      "args0": [
        {
          "type": "field_variable",
          "name": "VAR",
          "variable": "rtd",
          "variableTypes": [
            "Adafruit_MAX31865"
          ],
          "defaultType": "Adafruit_MAX31865"
        },
        {
          "type": "field_dropdown",
          "name": "ENABLE",
          "options": [
            [
              "启用",
              "TRUE"
            ],
            [
              "禁用",
              "FALSE"
            ]
          ]
        }
      ],
      "previousStatement": null,
      "nextStatement": null,
      "colour": "#FF6B35",
      "tooltip": "启用50Hz噪声滤波（禁用时默认为60Hz）"
    }
  ]
};
