/**
 * 聊天消息示例数据
 * 包含所有可用组件的示例用法
 *
 * 支持的组件类型:
 * - aily-state: 状态显示 (doing/done/warn/error/info, 可带进度)
 * - aily-button: 按钮组件 (primary/default/dashed/link/text)
 * - aily-board: 开发板查看器
 * - aily-library: 扩展库查看器
 * - aily-think: 思考过程查看器
 * - aily-mermaid: Mermaid 图表查看器
 * - aily-context: 上下文查看器
 * - aily-blockly: Blockly 积木代码查看器
 * - aily-error: 错误信息查看器
 * - aily-task-action: 任务操作查看器
 */
export const ChatListExamples = [
    // =====================================
    // aily-state 状态显示组件示例
    // 支持状态: doing, done, warn, error, info
    // 支持进度: progress (0-100)
    // =====================================
    {
        content: `以下为可用的状态提示信息：

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

\`\`\`aily-state
{"state":"info","text":"这是一条普通信息提示"}
\`\`\`

\`\`\`aily-state
{"state":"doing","text":"正在编译代码","progress":65}
\`\`\`
`,
    },

    // =====================================
    // aily-button 按钮组件示例
    // 支持类型: primary, default, dashed, link, text
    // 支持属性: text, action, type, icon, disabled, loading, id
    // =====================================
    {
        content: `按钮组件示例：

\`\`\`aily-button
[
{"text":"创建项目","action":"create_project","type":"primary"},
{"text":"补充说明","action":"more_info","type":"default"},
{"text":"查看文档","action":"view_docs","type":"link","icon":"file-text"},
{"text":"删除","action":"delete","type":"dashed","disabled":true}
]
\`\`\`
`,
    },

    // =====================================
    // aily-board 开发板查看器示例
    // =====================================
    {
        content: 'I want to know the weather today.',
        role: 'user',
    },
    {
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

    // =====================================
    // aily-library 扩展库查看器示例
    // =====================================
    {
        content: 'I am in Beijing.',
        role: 'user',
    },
    {
        content: `推荐使用如下扩展库：

\`\`\`aily-library
{
    "name": "@aily-project/lib-servo360",
    "nickname": "360舵机驱动",
    "version": "1.0.0",
    "description": "360舵机控制支持库，支持Arduino UNO、MEGA、ESP32等开发板",
    "author": "aily Project",
    "compatibility": {
        "core": ["arduino:avr", "esp32:esp32"],
        "voltage": [3.3, 5]
    },
    "keywords": ["aily", "blockly", "servo", "执行器"],
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
        "core": ["arduino:avr", "esp32:esp32"],
        "voltage": [3.3, 5]
    },
    "keywords": ["aily", "blockly", "sht3x", "温湿度传感器"],
    "tested": false,
    "icon": "iconfont icon-dht22"
}
\`\`\`
`,
    },

    // =====================================
    // aily-think 思考过程查看器示例
    // 支持属性: content, isComplete
    // =====================================
    {
        content: `让我思考一下这个问题...

\`\`\`aily-think
{
    "content": "首先，我需要分析用户的需求。用户想要控制一个LED灯，这需要用到数字输出功能。\n\n接下来，我需要确定使用哪个引脚。Arduino Uno上的引脚13有内置LED，可以直接使用。\n\n最后，我需要编写相应的代码来实现闪烁效果。",
    "isComplete": true
}
\`\`\`

基于以上分析，这里是我的建议：`,
    },

    // =====================================
    // aily-mermaid 图表查看器示例
    // 支持 Mermaid 语法的各种图表
    // =====================================
    {
        content: `这是项目的流程图：

\`\`\`aily-mermaid
{
    "code": "graph TD\n    A[开始] --> B{是否已安装驱动?}\n    B -->|是| C[连接开发板]\n    B -->|否| D[安装驱动]\n    D --> C\n    C --> E[选择串口]\n    E --> F[上传代码]\n    F --> G[完成]"
}
\`\`\`

以及时序图：

\`\`\`aily-mermaid
{
    "code": "sequenceDiagram\n    participant U as 用户\n    participant A as 应用\n    participant B as 开发板\n    U->>A: 点击上传\n    A->>B: 发送代码\n    B-->>A: 返回状态\n    A-->>U: 显示结果"
}
\`\`\`
`,
    },

    // =====================================
    // aily-context 上下文查看器示例
    // 支持属性: label, content, encoded
    // =====================================
    {
        content: `以下是相关的代码上下文：

\`\`\`aily-context
{
    "label": "main.ino:15-28",
    "content": "void setup() {\n  Serial.begin(9600);\n  pinMode(LED_BUILTIN, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(LED_BUILTIN, HIGH);\n  delay(1000);\n  digitalWrite(LED_BUILTIN, LOW);\n  delay(1000);\n}",
    "encoded": false
}
\`\`\`
`,
    },

    // =====================================
    // aily-blockly 积木代码查看器示例
    // 支持属性: blocks, xml, workspace, code, title
    // =====================================
    {
        content: `这是推荐的积木代码：

\`\`\`aily-blockly
{
    "title": "LED闪烁程序",
    "code": "void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n  delay(500);\n  digitalWrite(13, LOW);\n  delay(500);\n}",
    "blocks": [
        {"type": "setup_block", "id": "setup1"},
        {"type": "pin_mode", "id": "pm1", "pin": 13, "mode": "OUTPUT"},
        {"type": "loop_block", "id": "loop1"},
        {"type": "digital_write", "id": "dw1", "pin": 13, "value": "HIGH"},
        {"type": "delay", "id": "d1", "time": 500}
    ]
}
\`\`\`
`,
    },

    // =====================================
    // aily-error 错误查看器示例
    // 支持属性: error (status, message), timestamp, severity, metadata
    // =====================================
    {
        content: `连接时发生错误：

\`\`\`aily-error
{
    "error": {
        "status": 500,
        "message": "无法连接到编译服务器，请检查网络连接"
    },
    "timestamp": "2025-02-13T10:30:00.000Z",
    "severity": "error",
    "metadata": {
        "retryCount": 3,
        "lastAttempt": "2025-02-13T10:29:55.000Z"
    }
}
\`\`\`
`,
    },

    // =====================================
    // aily-task-action 任务操作查看器示例
    // 支持 actionType: max_messages, error, timeout, unknown
    // =====================================
    {
        content: `任务执行状态：

\`\`\`aily-task-action
{
    "actionType": "max_messages",
    "message": "已达到最大消息数限制（10条），您可以选择继续对话或开始新会话。",
    "metadata": {
        "maxMessages": 10,
        "currentMessages": 10
    }
}
\`\`\`
`,
    },

    // =====================================
    // 综合示例 - 包含多种组件的对话
    // =====================================
    {
        content: 'Thank you!',
        role: 'user',
    },
    {
        content: `Arduino Uno上每一个带有数字编号的引脚，都是数字引脚，包括写有"A"编号的模拟输入引脚。使用这些引脚具有输入输出数字信号的功能。

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

| 模式宏名称 | 说明 |
| ----- | --- |
| INPUT | 输入模式 |
| OUTPUT | 输出模式 |
| INPUT_PULLUP | 输入上拉模式 |

\`\`\`aily-button
[
{"text":"查看更多引脚说明","action":"view_more_pins","type":"primary"},
{"text":"开始编程","action":"start_coding","type":"default"}
]
\`\`\`
`,
    },
    {
        content: 'Have a nice day!',
        role: 'user',
    },
    {
        content: 'You too! 如果有任何问题，随时可以问我。',
    },
];
