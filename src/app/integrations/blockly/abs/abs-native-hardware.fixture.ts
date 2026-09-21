// Real readonly library definitions used as native-runtime tests, not production recipes.
export const nativeHardwareFixtures = {
  "adafruit_DHT": {
    "source": "// 定义DHT块的动态扩展\r\nif (Blockly.Extensions.isRegistered('dht_init_dynamic')) {\r\n  Blockly.Extensions.unregister('dht_init_dynamic');\r\n}\r\nBlockly.Extensions.register('dht_init_dynamic', function () {\r\n  // 获取i18n翻译\r\n  const i18n = window.__BLOCKLY_LIB_I18N__?.['@aily-project/lib-dht']?.extensions?.dht_init_dynamic || {};\r\n  const i2cLabel = i18n.i2c_interface || 'I2C接口';\r\n  const pinLabel = i18n.pin || '引脚';\r\n\r\n  this.updateShape_ = function (dhtType) {\r\n    if (this.getInput('PIN_SET')) this.removeInput('PIN_SET');\r\n    if (this.getInput('WIRE_SET')) this.removeInput('WIRE_SET');\r\n    switch (dhtType) {\r\n      case 'DHT20':\r\n        const i2cOptions = (window.boardConfig && window.boardConfig.i2c) ? window.boardConfig.i2c : [['I2C0','I2C0']];\r\n        this.appendDummyInput('WIRE_SET')\r\n            .appendField(i2cLabel)\r\n            .appendField(new Blockly.FieldDropdown(i2cOptions), 'WIRE');\r\n        break;\r\n      default:\r\n        const pinOptions = (window.boardConfig && window.boardConfig.digitalPins) ? window.boardConfig.digitalPins : [['D2','2'], ['D3','3'], ['D4','4'], ['D5','5'], ['D6','6'], ['D7','7'], ['D8','8'], ['D9','9'], ['D10','10'], ['D11','11'], ['D12','12'], ['D13','13']];\r\n        this.appendDummyInput('PIN_SET')\r\n            .appendField(pinLabel)\r\n            .appendField(new Blockly.FieldDropdown(pinOptions), 'PIN');\r\n        break;\r\n    }\r\n  };\r\n  this.getField('TYPE').setValidator(option => {\r\n    this.updateShape_(option);\r\n    return option;\r\n  });\r\n  // 初始化形状\r\n  this.updateShape_(this.getFieldValue('TYPE'));\r\n});\r\n\r\n",
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
      }
    ]
  },
  "adafruit-max31865": {
    "source": "/**\r\n * Adafruit MAX31865 RTD Sensor - Blockly Generator\r\n * Supports PT100/PT1000 RTD sensor via SPI interface\r\n */\r\n\r\n// ============================================================\r\n// Extension: Dynamic SPI mode switching (Hardware/Software)\r\n// ============================================================\r\nif (typeof Blockly !== 'undefined' && Blockly.Extensions) {\r\n  if (Blockly.Extensions.isRegistered('max31865_spi_mode_extension')) {\r\n    Blockly.Extensions.unregister('max31865_spi_mode_extension');\r\n  }\r\n  Blockly.Extensions.register('max31865_spi_mode_extension', function() {\r\n    var block = this;\r\n    block.updateShape_ = function(mode) {\r\n      // Remove SW pin inputs if they exist\r\n      if (block.getInput('SW_MOSI')) block.removeInput('SW_MOSI');\r\n      if (block.getInput('SW_MISO')) block.removeInput('SW_MISO');\r\n      if (block.getInput('SW_SCK')) block.removeInput('SW_SCK');\r\n\r\n      if (mode === 'SW') {\r\n        // Add software SPI pin inputs\r\n        block.appendDummyInput('SW_SCK')\r\n          .appendField('SCK引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D5', '5'], ['D18', '18'], ['D19', '19']]\r\n          ), 'SW_SCK_PIN');\r\n        block.appendDummyInput('SW_MOSI')\r\n          .appendField('MOSI引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D23', '23'], ['D21', '21']]\r\n          ), 'SW_MOSI_PIN');\r\n        block.appendDummyInput('SW_MISO')\r\n          .appendField('MISO引脚')\r\n          .appendField(new Blockly.FieldDropdown(\r\n            (typeof window !== 'undefined' && window['boardConfig'] && window['boardConfig'].digitalPins) || [['D19', '19'], ['D22', '22']]\r\n          ), 'SW_MISO_PIN');\r\n      }\r\n    };\r\n\r\n    var spiModeField = block.getField('SPI_MODE');\r\n    if (spiModeField) {\r\n      spiModeField.setValidator(function(option) {\r\n        block.updateShape_(option);\r\n        return option;\r\n      });\r\n    }\r\n    block.updateShape_(block.getFieldValue('SPI_MODE'));\r\n  });\r\n}\r\n\r\n// ============================================================\r\n",
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
      }
    ]
  }
};
