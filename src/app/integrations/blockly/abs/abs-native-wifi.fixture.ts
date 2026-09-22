// Readonly library registration/JSON fixtures; no generator handlers executed.
export const nativeWifiFixtures = {
  "diandeng_blinker": {
    "source": "Blockly.Extensions.register('blinker_init_wifi_extension', function () {\r\n  // 直接在扩展中添加updateShape_函数\r\n  this.updateShape_ = function (configType) {\r\n    // 先移除已存在的输入\r\n    if (this.getInput('AUTH')) {\r\n      this.removeInput('AUTH');\r\n    }\r\n    if (this.getInput('SSID')) {\r\n      this.removeInput('SSID');\r\n    }\r\n    if (this.getInput('PSWD')) {\r\n      this.removeInput('PSWD');\r\n    }\r\n\r\n    // 如果是手动配网，添加密钥和WiFi配置字段\r\n    if (configType !== 'EspTouchV2') {\r\n      // 添加密钥输入，使用input_value类型\r\n      this.appendValueInput('AUTH')\r\n        .setCheck('String')\r\n        .appendField(\"密钥\");\r\n\r\n      // 添加WiFi配置输入\r\n      this.appendValueInput('SSID')\r\n        .setCheck('String')\r\n        .appendField(\"WiFi名称\");\r\n\r\n      this.appendValueInput('PSWD')\r\n        .setCheck('String')\r\n        .appendField(\"WiFi密码\");\r\n      \r\n      // 延迟创建默认块，避免重复创建\r\n      setTimeout(() => {\r\n        this.createDefaultBlocks_();\r\n      }, 100);\r\n    }\r\n  };\r\n\r\n  // 创建默认字符串块的方法\r\n  this.createDefaultBlocks_ = function() {\r\n    // 检查workspace是否存在且已渲染\r\n    if (!this.workspace || !this.workspace.rendered) {\r\n      return;\r\n    }\r\n\r\n    // 为AUTH输入添加默认的字符串块\r\n    const authInput = this.getInput('AUTH');\r\n    if (authInput && !authInput.connection.targetConnection) {\r\n      try {\r\n        var authBlock = this.workspace.newBlock('text');\r\n        authBlock.setFieldValue('Your Device Secret Key', 'TEXT');\r\n        authBlock.initSvg();\r\n        authBlock.render();\r\n        authInput.connection.connect(authBlock.outputConnection);\r\n      } catch (e) {\r\n        console.warn('Failed to create AUTH default block:', e);\r\n      }\r\n    }\r\n\r\n    // 为SSID输入添加默认的字符串块\r\n    const ssidInput = this.getInput('SSID');\r\n    if (ssidInput && !ssidInput.connection.targetConnection) {\r\n      try {\r\n        var ssidBlock = this.workspace.newBlock('text');\r\n        ssidBlock.setFieldValue('Your WiFi SSID', 'TEXT');\r\n        ssidBlock.initSvg();\r\n        ssidBlock.render();\r\n        ssidInput.connection.connect(ssidBlock.outputConnection);\r\n      } catch (e) {\r\n        console.warn('Failed to create SSID default block:', e);\r\n      }\r\n    }\r\n\r\n    // 为PSWD输入添加默认的字符串块\r\n    const pswdInput = this.getInput('PSWD');\r\n    if (pswdInput && !pswdInput.connection.targetConnection) {\r\n      try {\r\n        var pswdBlock = this.workspace.newBlock('text');\r\n        pswdBlock.setFieldValue('Your WiFi Password', 'TEXT');\r\n        pswdBlock.initSvg();\r\n        pswdBlock.render();\r\n        pswdInput.connection.connect(pswdBlock.outputConnection);\r\n      } catch (e) {\r\n        console.warn('Failed to create PSWD default block:', e);\r\n      }\r\n    }\r\n  };\r\n\r\n  // 监听MODE字段的变化\r\n  this.getField('MODE').setValidator(function (option) {\r\n    this.getSourceBlock().updateShape_(option);\r\n    return option;\r\n  });\r\n\r\n  this.updateShape_(this.getFieldValue('MODE'));\r\n});",
    "blocks": [
      {
        "type": "blinker_init_wifi",
        "message0": "初始化Blinker WiFi模式 %1",
        "args0": [
          {
            "type": "field_dropdown",
            "name": "MODE",
            "options": [
              [
                "手动配网",
                "手动配网"
              ],
              [
                "EspTouch V2",
                "EspTouchV2"
              ]
            ]
          }
        ],
        "extensions": [
          "blinker_init_wifi_extension"
        ],
        "previousStatement": null,
        "nextStatement": null,
        "colour": "#03A9F4",
        "inputsInline": false,
        "icon": "iconfont icon-blinker"
      }
    ]
  },
  "ai-vox": {
    "source": "Blockly.Extensions.register('aivox3_init_wifi_extension', function () {\r\n// 直接在扩展中添加updateShape_函数\r\n  this.updateShape_ = function (configType) {\r\n    if (this.getInput('SSID')) {\r\n      this.removeInput('SSID');\r\n    }\r\n    if (this.getInput('PSWD')) {\r\n      this.removeInput('PSWD');\r\n    }\r\n\r\n    // 如果是手动配网，添加密钥和WiFi配置字段\r\n    if (configType == 'Manual') {\r\n      // 添加WiFi配置输入\r\n      this.appendValueInput('SSID')\r\n        .setCheck('String')\r\n        .appendField(\"WiFi名称\");\r\n\r\n      this.appendValueInput('PSWD')\r\n        .setCheck('String')\r\n        .appendField(\"WiFi密码\");\r\n      \r\n      // 延迟创建默认块，避免重复创建\r\n      setTimeout(() => {\r\n        this.createDefaultBlocks_();\r\n      }, 100);\r\n    }\r\n  };\r\n\r\n  // 创建默认字符串块的方法\r\n  this.createDefaultBlocks_ = function() {\r\n    // 检查workspace是否存在且已渲染\r\n    if (!this.workspace || !this.workspace.rendered) {\r\n      return;\r\n    }\r\n\r\n    // 为SSID输入添加默认的字符串块\r\n    const ssidInput = this.getInput('SSID');\r\n    if (ssidInput && !ssidInput.connection.targetConnection) {\r\n      try {\r\n        var ssidBlock = this.workspace.newBlock('text');\r\n        ssidBlock.setFieldValue('nulllab', 'TEXT');\r\n        ssidBlock.initSvg();\r\n        ssidBlock.render();\r\n        ssidInput.connection.connect(ssidBlock.outputConnection);\r\n      } catch (e) {\r\n        console.warn('Failed to create SSID default block:', e);\r\n      }\r\n    }\r\n\r\n    // 为PSWD输入添加默认的字符串块\r\n    const pswdInput = this.getInput('PSWD');\r\n    if (pswdInput && !pswdInput.connection.targetConnection) {\r\n      try {\r\n        var pswdBlock = this.workspace.newBlock('text');\r\n        pswdBlock.setFieldValue('nulllab', 'TEXT');\r\n        pswdBlock.initSvg();\r\n        pswdBlock.render();\r\n        pswdInput.connection.connect(pswdBlock.outputConnection);\r\n      } catch (e) {\r\n        console.warn('Failed to create PSWD default block:', e);\r\n      }\r\n    }\r\n  };\r\n\r\n  // 监听MODE字段的变化\r\n  this.getField('MODE').setValidator(function (option) {\r\n    this.getSourceBlock().updateShape_(option);\r\n    return option;\r\n  });\r\n  this.updateShape_(this.getFieldValue('MODE'));\r\n});",
    "blocks": [
      {
        "message0": "初始化 AI-VOX WIFI模式 %1",
        "type": "aivox3_init_wifi",
        "args0": [
          {
            "type": "field_dropdown",
            "name": "MODE",
            "options": [
              [
                "手动配网",
                "Manual"
              ]
            ]
          }
        ],
        "extensions": [
          "aivox3_init_wifi_extension"
        ],
        "previousStatement": null,
        "nextStatement": null,
        "colour": "#4CAF50",
        "icon": "fa-regular fa-message-bot"
      }
    ]
  }
};
