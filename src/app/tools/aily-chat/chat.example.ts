export const ChatListExamples = [
    {
        content: `以下为可用的系统提示信息：
\`\`\`aily-state
{"state":"doing","text":"正在查询开发板文档"}
\`\`\`
\`\`\`aily-state
{"state":"done","text":"开发板文档查阅完成"}
\`\`\`
\`\`\`aily-state
{"state":"warn","text":"没有找到相关的开发板文档"}
\`\`\`
\`\`\`aily-state
{"state":"error","text":"发生错误，请稍后再试"}
\`\`\`
\`\`\`aily-button
[
{"text":"创建项目","action":"create_project"},
{"text":"补充说明","action":"more_info","type":"default"}
]
\`\`\`
`,
    },
    {
        content: 'I want to know the weather today.',
        role: 'user',
    }, {
        content: `推荐使用如下控制器：  
\`\`\`aily-board
{
    "name": "@aily-project/board-jinniu_board",
    "nickname": "金牛创翼板",
    "version": "0.0.1",
    "description": "金牛创翼板是一款集成多种常用传感器的开发板，包括电机、WS2812灯、LED灯、超声波、DHT11、自锁和按键开关、电位器、无源蜂鸣器和电机驱动",
    "author": "",
    "brand": "OpenJumper",
    "url": "",
    "compatibility": "",
    "img": "jinniu_board.png",
    "disabled": false
}
\`\`\``,
    },
    {
        content: 'I am in Beijing.',
        role: 'user',
    }, {
        content: `推荐使用如下扩展库
\`\`\`aily-library
{
    "name": "@aily-project/lib-servo360",
    "nickname": "360舵机驱动",
    "version": "1.0.0",
    "description": "360舵机控制支持库，支持Arduino UNO、MEGA、ESP32等开发板",
    "author": "aily Project",
    "compatibility": {
      "core": [
        "arduino:avr",
        "esp32:esp32"
      ],
      "voltage": [
        3.3,
        5
      ]
    },
    "keywords": [
      "aily",
      "blockly",
      "servo",
      "servo_attach",
      "servo_write",
      "执行器"
    ],
    "tested": true,
    "icon": "iconfont icon-servo"
}
\`\`\`
\`\`\`aily-library
{
    "name": "@aily-project/lib-sht3x",
    "nickname": "SHT3x温湿度传感器库",
    "version": "0.0.1",
    "description": "支持Arduino SHT30、SHT31和SHT35温湿度传感器的控制库",
    "author": "Danil",
    "compatibility": {
      "core": [
        "arduino:avr",
        "esp32:esp32"
      ],
      "voltage": [
        3.3,
        5
      ]
    },
    "keywords": [
      "aily",
      "blockly",
      "sht3x",
      "温湿度传感器",
      "sensor",
      "humidity",
      "temperature"
    ],
    "tested": false,
    "icon": "iconfont icon-dht22"
}
\`\`\`
\`\`\`aily-library
{
    "name": "@aily-project/lib-core-custom",
    "nickname": "自定义代码",
    "version": "1.0.0",
    "description": "允许在Blockly中插入自定义Arduino代码、宏定义、函数等的库",
    "author": "aily Project",
    "compatibility": {
      "core": []
    },
    "keywords": [
      "aily",
      "blockly",
      "lib",
      "custom",
      "code"
    ],
    "tested": true,
    "icon": "fa-light fa-code"
}
\`\`\`
`
    },
    {
        content: 'Thank you!',
        role: 'user',
    },
    {
        content: `Arduino Uno上每一个带有数字编号的引脚，都是数字引脚，包括写有"A"编号的模拟输入引脚，如图2-21。使用这些引脚具有输入输出数字信号的功能。

\`\`\`aily-state
{"state":"doing","text":"正在查询开发板文档"}
\`\`\`

\`\`\`aily-state
{"state":"done","text":"开发板文档查阅完成"}
\`\`\`

\`\`\`c
pinMode(pin, mode);
\`\`\`

参数pin为指定配置的引脚编号；参数mode为指定的配置模式。

可使用的三种模式，如表2-3所示：

表 2‑3 Arduino引脚可配置状态

| 模式宏名称 | 说明 |
| ----- | --- |
| INPUT | 输入模式 |
| OUTPUT | 输出模式 |
| INPUT\_PULLUP | 输入上拉模式 |
`
    },
    {
        content: 'Have a nice day!',
    },
    {
        content: 'You too!'
    },
];