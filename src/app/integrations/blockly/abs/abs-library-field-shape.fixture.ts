// Readonly library registration fixtures captured 2026-09-15. No generator handlers are executed.
export const fieldShapeLibraryFixtures = {
  "core-text": {
    "source": "try {\n  const TEXT_GET_SUBSTRING_MUTATOR_MIXIN = {\n    mutationToDom: function () {\n      const container = document.createElement('mutation');\n      container.setAttribute('at1', this.isAt1_ ? 'true' : 'false');\n      container.setAttribute('at2', this.isAt2_ ? 'true' : 'false');\n      return container;\n    },\n    domToMutation: function (xmlElement) {\n      this.isAt1_ = xmlElement.getAttribute('at1') !== 'false';\n      this.isAt2_ = xmlElement.getAttribute('at2') !== 'false';\n      this.updateAt_(1, this.isAt1_);\n      this.updateAt_(2, this.isAt2_);\n    },\n    updateAt_: function (n, isAt) {\n      // 使用dummy输入而非创建新输入\n      const dummyInputName = 'AT' + n + '_DUMMY';\n      const dummyInput = this.getInput(dummyInputName);\n\n      if (!dummyInput) {\n        console.error('找不到输入：', dummyInputName);\n        return;\n      }\n\n      // 字段名称\n      const fieldName = 'AT' + n;\n      // 值输入名称（添加_VALUE后缀）\n      const valueInputName = 'AT' + n + '_VALUE';\n\n      // 删除之前可能添加的值输入块\n      const existingInput = this.getInput(valueInputName);\n      if (existingInput) {\n        this.removeInput(valueInputName);\n      }\n\n      // 如果需要数值输入，添加一个值输入块\n      if (isAt) {\n        // 创建值输入块\n        const valueInput = this.appendValueInput(valueInputName)\n          .setCheck('Number');\n\n        // 找出dummy输入后的下一个输入名称\n        const inputList = this.inputList;\n        const dummyIndex = inputList.findIndex(input => input.name === dummyInputName);\n\n        // 如果dummy输入不是最后一个输入，将值输入移动到dummy输入之后\n        if (dummyIndex < inputList.length - 1) {\n          const nextInputName = inputList[dummyIndex + 1].name;\n          this.moveInputBefore(valueInputName, nextInputName);\n        }\n      }\n\n      // 更新状态标记\n      if (n === 1) this.isAt1_ = isAt;\n      if (n === 2) this.isAt2_ = isAt;\n    }\n  };\n\n  const TEXT_GET_SUBSTRING_EXTENSION = function () {\n    // 初始化\n    this.isAt1_ = true; // 默认显示AT1输入\n    this.isAt2_ = true; // 默认显示AT2输入\n\n    // WHERE1\n    const dropdown1 = this.getField('WHERE1');\n    if (dropdown1) {\n      dropdown1.setValidator((value) => {\n        const isAt = value === 'FROM_START' || value === 'FROM_END';\n        this.updateAt_(1, isAt);\n        return undefined;\n      });\n    }\n\n    // WHERE2\n    const dropdown2 = this.getField('WHERE2');\n    if (dropdown2) {\n      dropdown2.setValidator((value) => {\n        const isAt = value === 'FROM_START' || value === 'FROM_END';\n        this.updateAt_(2, isAt);\n        return undefined;\n      });\n    }\n\n    // 应用初始状态\n    this.updateAt_(1, this.isAt1_);\n    this.updateAt_(2, this.isAt2_);\n  };\n\n  if (Blockly.Extensions.isRegistered('text_getSubstring_mutator')) {\n    Blockly.Extensions.unregister('text_getSubstring_mutator');\n  }\n\n  Blockly.Extensions.registerMutator(\n    'text_getSubstring_mutator',\n    TEXT_GET_SUBSTRING_MUTATOR_MIXIN,\n    TEXT_GET_SUBSTRING_EXTENSION\n  );\n} catch (e) {\n  console.error(\"注册text_getSubstring_mutator扩展失败:\", e);\n}\n\n",
    "blocks": [
      {
        "type": "tt_getSubstring",
        "message0": "在文本 %1中获取子串",
        "args0": [
          {
            "type": "input_value",
            "name": "STRING",
            "check": "String"
          }
        ],
        "message1": "%1 %2",
        "args1": [
          {
            "type": "field_dropdown",
            "name": "WHERE1",
            "options": [
              [
                "从第#个字符",
                "FROM_START"
              ],
              [
                "从倒数第#个字符",
                "FROM_END"
              ],
              [
                "从第一个字符",
                "FIRST"
              ]
            ]
          },
          {
            "type": "input_dummy",
            "name": "AT1_DUMMY"
          }
        ],
        "message2": "%1 %2",
        "args2": [
          {
            "type": "field_dropdown",
            "name": "WHERE2",
            "options": [
              [
                "到第#个字符",
                "FROM_START"
              ],
              [
                "到倒数第#个字符",
                "FROM_END"
              ],
              [
                "到最后一个字符",
                "LAST"
              ]
            ]
          },
          {
            "type": "input_dummy",
            "name": "AT2_DUMMY"
          }
        ],
        "output": "String",
        "style": "text_blocks",
        "helpUrl": "",
        "inputsInline": true,
        "mutator": "text_getSubstring_mutator",
        "icon": "fa-regular fa-input-text"
      }
    ]
  },
  "esp32_i2c": {
    "source": "// ESP32 I2C 通信库 Generator\n// 为ESP32平台提供I2C主从模式通信支持\n\n// 检查扩展是否已注册，避免重复加载\nif (Blockly.Extensions.isRegistered('esp32_i2c_address_extension')) {\n  Blockly.Extensions.unregister('esp32_i2c_address_extension');\n}\n\nfunction updateI2CCustomAddressInput(block, address) {\n  const hasInput = !!block.getInput('CUSTOM_ADDRESS');\n  if (address === 'CUSTOM' && !hasInput) {\n    block.appendValueInput('CUSTOM_ADDRESS')\n      .setCheck('Number')\n      .appendField('自定义地址');\n  } else if (address !== 'CUSTOM' && hasInput) {\n    block.removeInput('CUSTOM_ADDRESS');\n  }\n}\n\n// 注册地址选择扩展\nBlockly.Extensions.register('esp32_i2c_address_extension', function() {\n  const block = this;\n  const addressField = block.getField('ADDRESS');\n  if (!addressField) return;\n  addressField.setValidator(function(newValue) {\n    updateI2CCustomAddressInput(block, newValue);\n    if (block.rendered) block.render();\n    return newValue;\n  });\n  updateI2CCustomAddressInput(block, block.getFieldValue('ADDRESS'));\n});\n\n",
    "blocks": [
      {
        "type": "esp32_i2c_write_to_device",
        "message0": "向设备%1写入数据%2",
        "args0": [
          {
            "type": "field_dropdown",
            "name": "ADDRESS",
            "options": [
              [
                "0x3C (OLED显示屏)",
                "0x3C"
              ],
              [
                "0x48 (ADS1115)",
                "0x48"
              ],
              [
                "0x68 (MPU6050)",
                "0x68"
              ],
              [
                "0x76 (BMP280)",
                "0x76"
              ],
              [
                "0x77 (BMP280备用)",
                "0x77"
              ],
              [
                "自定义地址",
                "CUSTOM"
              ]
            ]
          },
          {
            "type": "input_value",
            "name": "DATA",
            "check": [
              "String",
              "Number"
            ]
          }
        ],
        "previousStatement": null,
        "nextStatement": null,
        "colour": "#FF9800",
        "tooltip": "向指定I2C设备写入数据的简化版本",
        "extensions": [
          "esp32_i2c_address_extension"
        ]
      },
      {
        "type": "esp32_i2c_read_from_device",
        "message0": "从设备%1读取%2字节数据",
        "args0": [
          {
            "type": "field_dropdown",
            "name": "ADDRESS",
            "options": [
              [
                "0x3C (OLED显示屏)",
                "0x3C"
              ],
              [
                "0x48 (ADS1115)",
                "0x48"
              ],
              [
                "0x68 (MPU6050)",
                "0x68"
              ],
              [
                "0x76 (BMP280)",
                "0x76"
              ],
              [
                "0x77 (BMP280备用)",
                "0x77"
              ],
              [
                "自定义地址",
                "CUSTOM"
              ]
            ]
          },
          {
            "type": "input_value",
            "name": "QUANTITY",
            "check": "Number"
          }
        ],
        "output": "Array",
        "colour": "#FF9800",
        "tooltip": "从指定I2C设备读取指定字节数的数据",
        "extensions": [
          "esp32_i2c_address_extension"
        ]
      }
    ]
  }
};
