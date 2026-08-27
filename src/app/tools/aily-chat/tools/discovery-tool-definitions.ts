export const DISCOVERY_TOOL_DEFINITIONS = [
    {
        name: "search_boards_libraries",
        description: `智能开发板和库搜索工具，支持文本搜索和结构化筛选。
使用前可使用get_hardware_categories工具获取可用的分类和筛选维度。
**⭐ 推荐调用方式（统一使用 filters）：**
\`\`\`json
// 文本搜索
{ "type": "boards", "filters": { "keywords": ["wifi", "esp32", "arduino"] } }

// 结构化筛选 + 文本搜索
{ "type": "boards", "filters": { "keywords": ["esp32"], "connectivity": ["WiFi"], "flash": ">4096" } }

// 纯结构化筛选
{ "type": "libraries", "filters": { "category": "sensor", "communication": ["I2C"] } }
\`\`\`

**使用场景：**
1. 查找特定功能的库（如"温度传感器"、"舵机"、"OLED"）
2. 查找支持特定芯片的开发板（如"esp32"、"arduino"）
3. 按硬件规格筛选开发板（如"Flash >= 4MB"、"支持WiFi和BLE"）
4. 按类别筛选库（如"sensor类"、"通信类"）

**筛选参数说明：**

*通用参数：*
- keywords: 文本搜索关键词（字符串或数组），如 "esp32 wifi" 或 ["esp32", "wifi"]

*开发板筛选（filters）：*
- flash: Flash大小筛选（KB），支持比较运算符（如 ">4096", ">=1024"）
- sram: SRAM大小筛选（KB）
- frequency: 主频筛选（MHz）
- cores: 核心数筛选
- architecture: 架构筛选（如 "xtensa-lx7", "avr"）
- connectivity: 连接方式数组（如 ["WiFi", "BLE"]）
- interfaces: 接口数组（如 ["SPI", "I2C", "camera"]）
- brand: 品牌筛选
- voltage: 工作电压筛选

*库筛选（filters）：*
- category: 类别筛选（如 "sensor", "actuator", "communication"）
- hardwareType: 硬件类型数组（如 ["temperature", "humidity"]）
- supportedCores: 支持的核心数组（如 ["esp32:esp32", "arduino:avr"]）
- communication: 通信方式数组（如 ["I2C", "SPI"]）

**注意：**
- 返回结果默认限制在前50条最相关匹配
- 数值筛选支持运算符：>, >=, <, <=, =, !=`,
        input_schema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['boards', 'libraries'],
                    description: '搜索类型：boards(仅开发板), libraries(仅库)。默认为 boards',
                    default: 'boards'
                },
                filters: {
                    type: 'object',
                    description: '筛选条件（支持文本搜索和结构化筛选）',
                    properties: {
                        keywords: {
                            oneOf: [
                                { type: 'string', description: '搜索关键词，空格分隔多个词' },
                                { type: 'array', items: { type: 'string' }, description: '搜索关键词数组' }
                            ],
                            description: '文本搜索关键词（OR逻辑：匹配任意一个关键词即可返回）。例如: "wifi esp32" 或 ["wifi", "esp32", "arduino"] 会返回包含wifi或esp32或arduino的所有结果，匹配越多分数越高'
                        },
                        flash: {
                            type: 'string',
                            description: 'Flash大小筛选（KB），支持比较运算符：>=4096, >2048, =16384'
                        },
                        sram: {
                            type: 'string',
                            description: 'SRAM大小筛选（KB），支持比较运算符'
                        },
                        frequency: {
                            type: 'string',
                            description: '主频筛选（MHz），支持比较运算符'
                        },
                        cores: {
                            type: 'string',
                            description: '核心数筛选，支持比较运算符'
                        },
                        architecture: {
                            type: 'string',
                            description: '架构筛选，如 xtensa-lx7, avr, arm-cortex-m4'
                        },
                        connectivity: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '连接方式数组（AND逻辑），如 ["WiFi", "BLE", "Ethernet"]'
                        },
                        interfaces: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '接口数组（AND逻辑），如 ["SPI", "I2C", "UART", "camera"]'
                        },
                        brand: {
                            type: 'string',
                            description: '品牌筛选，如 Espressif, Arduino, Seeed'
                        },
                        voltage: {
                            type: 'string',
                            description: '工作电压筛选（V）'
                        },
                        category: {
                            type: 'string',
                            description: '库类别筛选，如 sensor, actuator, communication, display'
                        },
                        hardwareType: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '硬件类型数组，如 ["temperature", "humidity"]'
                        },
                        supportedCores: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '支持的核心数组，如 ["esp32:esp32", "arduino:avr"]'
                        },
                        communication: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '通信方式数组，如 ["I2C", "SPI", "UART", "OneWire"]'
                        }
                    }
                },
                maxResults: {
                    type: 'number',
                    description: '最大返回结果数，默认50',
                    default: 50
                }
            },
            required: ['filters']
        },
        agents: ["mainAgent"]
    },
    {
        name: "get_hardware_categories",
        description: `获取开发板或库的分类信息，用于引导式选型流程。

**⭐ 推荐使用流程：**
1. 先调用此工具获取分类概览（如传感器有哪些类型？开发板有哪些品牌？）
2. 根据分类结果，调用 search_boards_libraries 进行精确搜索

**开发板分类维度（dimension）：**
- architecture: 架构（avr, xtensa-lx6, xtensa-lx7, riscv, arm-cortex-m4...）
- connectivity: 连接方式（wifi, ble, bluetooth-classic, zigbee...）
- interfaces: 接口类型（camera, sd-card, display, usb-device, ethernet...）
- tags: 用途标签（AI, IoT, ARM, 教育, 入门...）

**库分类维度（dimension）：**
- category: 主分类（sensor, motor, display, communication, audio...）
- hardwareType: 硬件类型（temperature, humidity, led, oled, touch, stepper...）
- communication: 通信协议（i2c, spi, uart, gpio, pwm...）

**使用示例：**
\`\`\`json
// 获取所有库的主分类
{ "type": "libraries", "dimension": "category" }

// 获取传感器类库的硬件类型
{ "type": "libraries", "dimension": "hardwareType", "filterBy": { "category": "sensor" } }

// 获取开发板的接口类型分类（camera, sd-card, display等）
{ "type": "boards", "dimension": "interfaces" }

// 获取开发板的用途标签（AI, IoT, ARM等）
{ "type": "boards", "dimension": "tags" }

// 获取支持WiFi的开发板的架构分布
{ "type": "boards", "dimension": "architecture", "filterBy": { "connectivity": ["wifi"] } }
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    enum: ['boards', 'libraries'],
                    description: '获取分类的类型：boards(开发板) 或 libraries(库)'
                },
                dimension: {
                    type: 'string',
                    description: '分类维度：开发板可选 architecture/connectivity/interfaces/tags；库可选 category/hardwareType/communication'
                },
                filterBy: {
                    type: 'object',
                    description: '可选的预过滤条件，用于获取特定范围内的分类',
                    properties: {
                        category: {
                            type: 'string',
                            description: '仅限库：先按主分类过滤，再获取子分类'
                        },
                        architecture: {
                            type: 'string',
                            description: '仅限开发板：先按架构过滤'
                        },
                        connectivity: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '仅限开发板：先按连接方式过滤'
                        },
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '仅限开发板：先按用途标签过滤'
                        }
                    }
                }
            },
            required: ['type', 'dimension']
        },
        agents: ["mainAgent"]
    },
    {
        name: "get_board_parameters",
        description: `获取当前项目开发板的详细参数配置工具。
从当前打开项目的开发板配置(board.json)中读取详细的硬件配置参数。

**可用参数类型：**
引脚相关：
- analogPins
- digitalPins
- pwmPins
- servoPins
- interruptPins
通信接口：
- serialPort
- serialSpeed
- spi
- spiPins
- i2c
- i2cPins
- i2cSpeed

其他配置：
- builtinLed
- rgbLed
- batteryPin
- name
- description
- compilerParam
- uploadParam

**使用场景：**
1. 用户询问"这个开发板有哪些模拟引脚"
2. 需要知道当前开发板支持的串口波特率
3. 查询SPI/I2C引脚配置
4. 获取PWM引脚列表用于舵机控制
5. 查看开发板的完整硬件参数

**示例：**
获取当前开发板的模拟和数字引脚：
\`\`\`json
{
  "parameters": ["analogPins", "digitalPins"]
}
\`\`\`

获取当前开发板的所有参数：
\`\`\`json
{}
\`\`\`

获取通信接口配置：
\`\`\`json
{
  "parameters": ["serialPort", "spi", "i2c", "spiPins", "i2cPins"]
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                parameters: {
                    type: 'array',
                    items: {
                        type: 'string'
                    },
                    description: '要获取的参数列表。如果不指定，返回所有参数。常用参数：analogPins, digitalPins, pwmPins, servoPins, serialPort, spi, i2c, spiPins, i2cPins 等'
                }
            },
            required: []
        },
        agents: ["mainAgent"]
    },
    {
        name: "grep_tool",
        description: `- Fast content search tool that works with any codebase size
- Searches file contents using regular expressions
- Supports full regex syntax (eg. "log.*Error", "function\\s+\\w+", etc.)
- Use this tool when you need to find files containing specific patterns
- Use word boundaries \\b to ensure a complete word match.
support two modes:
1. File name mode (default): returns a list of file paths containing the matched content
2. Content mode: returns the specific line content, file path, and line number of the matches

Basic Syntax:
Query board info in boards.json (returns filenames)
\`\`\`json
{
  "pattern": "WIFI|BLE",
  "path": "D:\\\\codes\\\\aily-blockly",
  "include": "*boards.json"
}
\`\`\`

Query and return specific content (for detailed info)
\`\`\`json
{
  "pattern": "\\\\bWIFI\\\\b|\\\\bBLE\\\\b",
  "path": "D:\\\\codes\\\\aily-blockly",
  "include": "*boards.json"
  "returnContent": true,
  "contextLines": 1
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '要搜索的模式（支持正则表达式或普通文本）'
                },
                path: {
                    type: 'string',
                    description: '搜索路径（目录）。如果不提供，默认使用当前项目路径'
                },
                include: {
                    type: 'string',
                    description: '文件包含模式（glob格式），如 "*.js"（仅搜索JS文件）、"*.{ts,tsx}"（搜索TS和TSX文件）、"*boards.json"（文件名包含boards.json）'
                },
                isRegex: {
                    type: 'boolean',
                    description: '搜索模式是否为正则表达式。true=正则表达式（支持 | 或 .* 等元字符），false=普通文本（自动转义特殊字符）。使用正则时需手动添加 \\b 实现全词匹配',
                    default: true
                },
                returnContent: {
                    type: 'boolean',
                    description: '是否返回匹配的具体内容。false=只返回文件名列表（快速），true=返回匹配的行内容、文件路径和行号（详细）',
                    default: false
                },
                contextLines: {
                    type: 'number',
                    description: '上下文行数（0-5）。当returnContent为true时，显示匹配行周围的上下文。0=只显示匹配行，1=上下各1行，2=上下各2行',
                    default: 0
                },
                maxLineLength: {
                    type: 'number',
                    description: '每行最大字符长度（100-2000）。用于控制返回内容的长度，避免单行超大文件（如压缩JSON）返回过多数据。推荐值：20',
                    default: 100
                },
                maxResults: {
                    type: 'number',
                    description: '最大结果数量限制',
                    default: 20
                }
            },
            required: ['pattern']
        },
        agents: ["mainAgent"]
    },
    {
        name: "glob_tool",
        description: `- Fast file pattern matching tool that works with any codebase size
- Supports glob patterns like "**/*.js" or "src/**/*.ts"
- Returns matching file paths sorted by modification time
- Use this tool when you need to find files by name patterns
- When you are doing an open ended search that may require multiple rounds of globbing and grepping, use the Agent tool instead

快速文件模式匹配工具，用于按文件名模式查找文件。

基本语法:
查找所有 JavaScript 文件
\`\`\`json
{
  "pattern": "**/*.js",
  "path": "D:\\\\codes\\\\aily-blockly"
}
\`\`\`

查找特定名称的文件
\`\`\`json
{
  "pattern": "*boards.json",
  "path": "C:\\\\Users\\\\LENOVO\\\\AppData\\\\Local\\\\aily-project"
}
\`\`\`

查找多种文件类型
\`\`\`json
{
  "pattern": "**/*.{ts,tsx,js,jsx}",
  "path": "D:\\\\codes\\\\aily-blockly\\\\src"
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                pattern: {
                    type: 'string',
                    description: '文件匹配模式（支持 glob 语法）。例如: "**/*.js"（所有JS文件）, "src/**/*.ts"（src目录下所有TS文件）, "*boards.json"（文件名包含boards.json）'
                },
                path: {
                    type: 'string',
                    description: '搜索路径（目录）。如果不提供，默认使用当前工作目录'
                },
                limit: {
                    type: 'number',
                    description: '返回结果的最大数量限制（防止返回过多文件）',
                    default: 100
                }
            },
            required: ['pattern']
        },
        agents: ["mainAgent"]
    },
    {
        name: "fetch",
        description: `获取网页内容和API数据。支持HTTP/HTTPS请求。
- 内容超过限制字符时自动截断，截断时会提示剩余字符数
- 支持分页读取：当内容被截断时，可用 startIndex 从截断位置继续读取
- 如果在 webview_bridge 模式下抓到的是站点外壳、占位内容或网页正文缺失，尤其是 JS 渲染页面，应自动添加或增大 waitMs 后直接重试，不需要用户确认
如需搜索信息请优先使用 web_search 工具。`,
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '要请求的URL地址（仅支持 http:// 和 https://）'
                },
                method: {
                    type: 'string',
                    description: 'HTTP请求方法',
                    enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
                    default: 'GET'
                },
                headers: {
                    type: 'object',
                    description: '请求头（键值对）'
                },
                body: {
                    description: '请求体'
                },
                timeout: {
                    type: 'number',
                    description: '请求超时时间（毫秒）',
                    default: 30000
                },
                choice: {
                    type: 'string',
                    description: '可选抓取策略。留空时自动选择；若网页正文依赖 JS 渲染，可显式使用 webview_bridge。若 webview_bridge 结果仍缺少正文，应自动增大 waitMs 重试',
                    enum: ['webview_bridge', 'jina', 'direct_fetch']
                },
                waitMs: {
                    type: 'number',
                    description: '仅在 webview_bridge 下生效。页面 load 后额外等待的毫秒数；适用于正文未及时渲染出来的页面。建议从 1000-3000ms 开始，正文缺失时可自动增大后重试'
                },
                startIndex: {
                    type: 'number',
                    description: '分页读取的起始字符索引（0-based）。当上次调用的响应提示内容被截断时，使用此参数从截断位置继续读取'
                }
            },
            required: ['url']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'clone_repository',
        description: `克隆/下载远程 Git 仓库到本地。通过平台 zip 下载 API 获取整个仓库代码并解压，无需本地安装 git。

支持平台：GitHub、Gitee、GitLab、Bitbucket

使用场景：
- 用户提供了一个仓库 URL，需要获取其完整源码
- 需要参考某个开源项目的代码结构
- 下载示例项目或模板项目

注意：
- 仓库 zip 大小限制 50MB
- 默认尝试 main 分支，失败后自动回退到 master
- 支持 sparse_paths 只下载指定子目录`,
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '仓库 URL，如 https://github.com/owner/repo'
                },
                branch: {
                    type: 'string',
                    description: '分支名称（默认 main，失败自动回退 master）',
                    default: 'main'
                },
                target_dir: {
                    type: 'string',
                    description: '目标目录路径（相对项目根或绝对路径，默认为项目根下以仓库名命名的目录）'
                },
                sparse_paths: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '仅下载指定子目录（稀疏检出），如 ["src", "docs"]'
                }
            },
            required: ['url']
        },
        agents: ["mainAgent"]
    },
    {
        name: "web_search",
        description: `搜索网络以获取最新信息。使用 DuckDuckGo 搜索引擎，返回搜索结果列表（标题、摘要、链接）。
适用场景：
- 查找最新的技术文档、库版本信息、API 参考
- 搜索错误信息的解决方案
- 获取项目、产品、工具的最新状态
- 查找教程、指南和示例代码
- 在不知道确切 URL 时先搜索再用 fetch 获取详情
注意：搜索结果仅包含标题和摘要，如需完整内容请使用 fetch 工具访问结果中的链接。`,
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: '搜索关键词，建议使用具体、有针对性的搜索词以获得更好的结果'
                },
                maxResults: {
                    type: 'number',
                    description: '返回的最大结果数量',
                    default: 10
                }
            },
            required: ['query']
        },
        agents: ["mainAgent"]
    },
];
