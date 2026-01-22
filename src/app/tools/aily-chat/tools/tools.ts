import { json } from "stream/consumers";

export const toolParamNames = [
    "command"
] as const;

export type ToolParamName = (typeof toolParamNames)[number];

// export interface ToolUse {
//     type: "tool_use"
//     name: ToolName
// }

export interface ToolUseResult {
    is_error: boolean;
    content: string;
    details?: string;
    metadata?: any; // 添加 metadata 支持
}

export const TOOLS = [
    {
        name: 'create_project',
        description: '创建一个新项目，返回项目路径。需要提供使用的开发板（如 "@aily-project/board-arduino_uno", "@aily-project/board-arduino_uno_r4_minima"），传入的开发板名称以`https://blockly.diandeng.tech/boards.json`中的内容为准。',
        input_schema: {
            type: 'object',
            properties: {
                board: { type: 'string', description: '开发板名称' },
            },
            required: ['board']
        }
    },
    {
        name: 'execute_command',
        description: `执行系统CLI命令。用于执行系统操作或运行特定命令来完成用户任务中的任何步骤。支持命令链，优先使用相对命令和路径以保持终端一致性。`,
        input_schema: {
            type: 'object',
            properties: {
                command: { type: 'string', description: '执行的命令' },
                cwd: { type: 'string', description: '工作目录，可选' }
            },
            required: ['command']
        }
    },
    {
        name: "get_context",
        description: `获取当前的环境上下文信息，包括项目路径、当前平台、系统环境等。可以指定获取特定类型的上下文信息。`,
        input_schema: {
            type: 'object',
            properties: {
                info_type: {
                    type: 'string',
                    description: '要获取的上下文信息类型',
                    enum: ['all', 'project', 'platform', 'system'],
                    default: 'all'
                }
            },
            required: ['info_type']
        }
    },
    // {
    //     name: "list_directory",
    //     description: `列出指定目录的内容，包括文件和文件夹信息。返回每个项目的名称、类型、大小和修改时间。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要列出内容的目录路径'
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
    {
        name: "read_file",
        description: `读取指定文件的内容。支持完整读取或按行/字节范围读取，自动处理大文件和单行文件。

**读取模式：**
1. **完整读取**（默认）：读取整个文件（文件需小于 maxSize）
2. **按行范围读取**：指定起始行号和行数（行号从1开始）
3. **按字节范围读取**：指定起始字节位置和字节数（推荐用于大文件，优先级最高）

**自动优化（内部处理，无需手动配置）：**
- 单行大文件（如压缩JSON）：自动转换行范围为字节范围读取
- 超长行检测：自动选择最优读取策略
- 多行文件指定行范围时：自动计算等效字节范围，选择覆盖更大的方式

**大文件处理：**
- 默认限制 1MB，超过限制需指定范围读取或增加 maxSize
- 字节范围读取使用流式读取，不会一次性加载整个文件

**使用场景：**
- 小文件（<1MB）：直接完整读取
- 大文件：使用字节范围读取 (startByte + byteCount)
- 已知行号：使用行范围读取 (startLine + lineCount)，工具会自动优化
- **库readme或文档**：完整读取
- 搜索内容：使用 grep_tool 工具

**注意：**
- 行号从 1 开始计数
- 字节位置从 0 开始计数
- 字节范围读取优先级最高`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要读取的文件完整路径'
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式',
                    default: 'utf-8'
                },
                startLine: {
                    type: 'number',
                    description: '起始行号（从1开始）。指定后按行范围读取',
                    minimum: 1
                },
                lineCount: {
                    type: 'number',
                    description: '要读取的行数。不指定则读到文件末尾（或达到 maxSize 限制）',
                    minimum: 1
                },
                startByte: {
                    type: 'number',
                    description: '起始字节位置（从0开始）。指定后按字节范围读取（优先级最高，推荐用于大文件）',
                    minimum: 0
                },
                byteCount: {
                    type: 'number',
                    description: '要读取的字节数。不指定则读到文件末尾（或达到 maxSize 限制）',
                    minimum: 1
                },
                maxSize: {
                    type: 'number',
                    description: '最大读取大小（字节）。默认 1MB (1048576)。超过此大小需使用范围读取',
                    default: 1048576,
                    minimum: 1024
                }
            },
            required: ['path']
        }
    },
    {
        name: "create_file",
        description: `创建新文件并写入内容，需文件完整路径。如果目录不存在会自动创建。可选择是否覆盖已存在的文件。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要创建的文件完整路径'
                },
                content: {
                    type: 'string',
                    description: '文件内容',
                    default: ''
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式',
                    default: 'utf-8'
                },
                overwrite: {
                    type: 'boolean',
                    description: '是否覆盖已存在的文件',
                    default: false
                }
            },
            required: ['path']
        }
    },
    {
        name: "create_folder",
        description: `创建新文件夹。支持递归创建多级目录。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要创建的文件夹路径'
                },
                recursive: {
                    type: 'boolean',
                    description: '是否递归创建父目录',
                    default: true
                }
            },
            required: ['path']
        }
    },
    {
        name: "edit_file",
        description: `编辑文件工具 - 支持多种编辑模式（推荐使用 String Replace 模式以获得最佳安全性）

**编辑模式：**
1. **String Replace**（推荐）：替换文件中的特定字符串，自动检测多匹配防止意外修改
2. **Whole File**：替换整个文件内容
3. **Line-based**：在指定行插入或替换指定行范围
4. **Append**：追加内容到文件末尾

使用示例：

// 替换文件中的特定字符串（最安全的方式）
editFileTool({
  path: "/path/to/file.ts",
  oldString: "const value = 123;",
  newString: "const value = 456;",
  replaceMode: "string"
});

// 替换整个文件
editFileTool({
  path: "/path/to/file.txt",
  content: 'new file content',
  replaceMode: "whole"
});

// 在第5行插入内容
editFileTool({
  path: "/path/to/file.txt", 
  content: 'new line content',
  insertLine: 5
});

// 替换第3-5行的内容
editFileTool({
  path: "/path/to/file.txt",
  content: 'multi-line\nreplacement\ncontent',
  replaceStartLine: 3,
  replaceEndLine: 5
});

// 追加到文件末尾
editFileTool({
  path: "/path/to/file.txt",
  content: 'append content'
});

**String Replace 模式优势：**
- 自动检测并拒绝多个匹配（防止意外修改错误位置）
- 支持创建新文件（oldString 为空）
- 提供精确的行号和修改信息
- 自动检测文件编码

**重要：**
- 不支持编辑 .ipynb 文件
- String Replace 模式要求字符串在文件中唯一匹配
- 建议在 oldString 中包含 3-5 行上下文以确保唯一性`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要编辑的文件路径（支持相对路径和绝对路径）'
                },
                oldString: {
                    type: 'string',
                    description: '要替换的原字符串（String Replace 模式）。为空时创建新文件。必须在文件中唯一匹配，建议包含 3-5 行上下文'
                },
                newString: {
                    type: 'string',
                    description: '替换后的新字符串（String Replace 模式）。与 oldString 配合使用'
                },
                content: {
                    type: 'string',
                    description: '要写入的内容（其他模式使用）。Whole File 模式下是完整文件内容；Line-based 和 Append 模式下是要插入/追加的内容'
                },
                encoding: {
                    type: 'string',
                    description: '文件编码格式。不指定时自动检测（UTF-8 优先）',
                    default: 'utf-8'
                },
                createIfNotExists: {
                    type: 'boolean',
                    description: '文件不存在时是否创建（仅用于非 String Replace 模式）',
                    default: false
                },
                insertLine: {
                    type: 'number',
                    description: '插入行号（从1开始，Line-based 模式）。在指定行插入 content 的内容'
                },
                replaceStartLine: {
                    type: 'number',
                    description: '替换起始行号（从1开始，Line-based 模式）。替换从此行开始的内容'
                },
                replaceEndLine: {
                    type: 'number',
                    description: '替换结束行号（从1开始，Line-based 模式）。与 replaceStartLine 配合可替换多行。不指定则只替换起始行'
                },
                replaceMode: {
                    type: 'string',
                    enum: ['string', 'whole', 'line', 'append'],
                    description: '编辑模式：string=字符串替换（推荐，最安全），whole=替换整个文件，line=行级操作（需配合 insertLine/replaceStartLine），append=追加到末尾',
                    default: 'string'
                }
            },
            required: ['path']
        }
    },
    {
        name: "delete_file",
        description: `删除指定文件。可选择是否在删除前创建备份。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要删除的文件路径'
                },
                createBackup: {
                    type: 'boolean',
                    description: '删除前是否创建备份',
                    default: true
                }
            },
            required: ['path']
        }
    },
    {
        name: "delete_folder",
        description: `删除指定文件夹及其内容。可选择是否在删除前创建备份。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要删除的文件夹路径'
                },
                createBackup: {
                    type: 'boolean',
                    description: '删除前是否创建备份',
                    default: true
                },
                recursive: {
                    type: 'boolean',
                    description: '是否递归删除',
                    default: true
                }
            },
            required: ['path']
        }
    },
    // {
    //     name: "check_exists",
    //     description: `检查指定路径的文件或文件夹是否存在，返回详细信息包括类型、大小、修改时间等。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要检查的路径'
    //             },
    //             type: {
    //                 type: 'string',
    //                 description: '期望的类型：file(文件)、folder(文件夹)或any(任意类型)',
    //                 enum: ['file', 'folder', 'any'],
    //                 default: 'any'
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
    // {
    //     name: "get_directory_tree",
    //     description: `获取指定目录的树状结构，可控制遍历深度和是否包含文件。适合了解项目结构。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             path: {
    //                 type: 'string',
    //                 description: '要获取树状结构的目录路径'
    //             },
    //             maxDepth: {
    //                 type: 'number',
    //                 description: '最大遍历深度',
    //                 default: 3
    //             },
    //             includeFiles: {
    //                 type: 'boolean',
    //                 description: '是否包含文件（false时只显示文件夹）',
    //                 default: true
    //             }
    //         },
    //         required: ['path']
    //     }
    // },
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
                        // 通用文本搜索
                        keywords: {
                            oneOf: [
                                { type: 'string', description: '搜索关键词，空格分隔多个词' },
                                { type: 'array', items: { type: 'string' }, description: '搜索关键词数组' }
                            ],
                            description: '文本搜索关键词（OR逻辑：匹配任意一个关键词即可返回）。例如: "wifi esp32" 或 ["wifi", "esp32", "arduino"] 会返回包含wifi或esp32或arduino的所有结果，匹配越多分数越高'
                        },
                        // 开发板筛选
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
                        // 库筛选
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
        }
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
        }
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
        }
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
                // ignoreCase: {
                //     type: 'boolean',
                //     description: '是否忽略大小写',
                //     default: true
                // },
                // wholeWord: {
                //     type: 'boolean',
                //     description: '是否全词匹配（仅在 isRegex=false 时有效）。启用后只匹配完整单词，避免部分匹配。使用正则表达式时此参数无效，需手动在模式中添加 \\b 边界符',
                //     default: false
                // }
            },
            required: ['pattern']
        }
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
        }
    },
    {
        name: "fetch",
        description: `获取网络上的信息和资源，支持HTTP/HTTPS请求，能够处理大文件下载。支持多种请求方法和响应类型。注意：非必要时请避免使用此工具，以减少外部依赖和网络请求。`,
        input_schema: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '要请求的URL地址'
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
                maxSize: {
                    type: 'number',
                    description: '最大文件大小（字节）',
                    default: 52428800
                },
                responseType: {
                    type: 'string',
                    description: '响应类型',
                    enum: ['text', 'json', 'blob', 'arraybuffer'],
                    default: 'text'
                }
            },
            required: ['url']
        }
    },
    // {
    //     name: "reload_abi_json",
    //     description: `重新加载 project.abi 数据到 Blockly 工作区。可以从文件加载或直接提供 JSON 数据。适用于需要刷新 Blockly 块数据的场景。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             projectPath: {
    //                 type: 'string',
    //                 description: '项目路径，如果不提供将使用当前项目路径'
    //             },
    //             jsonData: {
    //                 type: 'object',
    //                 description: '直接提供.abi文件的内容'
    //             }
    //         },
    //         required: []
    //     }
    // },
    // {
    //     name: "edit_abi_file",
    //     description: `编辑ABI文件工具。支持多种编辑模式：1) 替换整个文件内容（默认）；2) 在指定行插入内容；3) 替换指定行或行范围；4) 追加到文件末尾。自动查找当前路径下的.abi文件，如果不存在会自动创建。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             content: {
    //                 type: 'string',
    //                 description: '要写入的内容。替换模式下必须是有效的JSON格式；插入/替换模式下可以是任意文本内容'
    //             },
    //             insertLine: {
    //                 type: 'number',
    //                 description: '插入行号（从1开始）。指定此参数时会在该行插入内容'
    //             },
    //             replaceStartLine: {
    //                 type: 'number',
    //                 description: '替换起始行号（从1开始）。指定此参数时会替换指定行的内容'
    //             },
    //             replaceEndLine: {
    //                 type: 'number',
    //                 description: '替换结束行号（从1开始）。与replaceStartLine配合使用，可替换多行内容。如不指定则只替换起始行'
    //             },
    //             replaceMode: {
    //                 type: 'boolean',
    //                 description: '是否替换整个文件内容。true=替换整个文件（默认），false=执行其他操作（插入、替换行、追加）',
    //                 default: true
    //             }
    //         },
    //         required: ['content']
    //     }
    // },
    // =============================================================================
    // 原子化块操作工具（推荐用于复杂结构）
    // =============================================================================
//     {
//         name: "create_single_block",
//         description: `创建单个 Blockly 块，支持 inputs 嵌套、动态块配置和创建时直接连接。<system-reminder>使用前需读取对应库的 Readme</system-reminder>

// **特性**：shadow 块嵌套 | extraState 配置 | 创建时直接连接（可选）| 返回块 ID

// **关键示例**：
// \`\`\`json
// // 创建并直接连接到 arduino_setup
// {"type": "serial_begin", "fields": {"SERIAL": "Serial", "SPEED": "9600"}, "connect": {"action": "put_into", "target": "arduino_setup"}}

// // 创建 math_number 并设为 delay 的 TIME 输入
// {"type": "math_number", "fields": {"NUM": 1000}, "connect": {"action": "set_as_input", "target": "delay_id", "input": "TIME"}}

// // 动态块（需指定 extraState）
// {"type": "controls_if", "extraState": {"elseIfCount": 1, "hasElse": true}}

// // 带输入的块
// {"type": "io_digitalwrite", "inputs": {"PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}}}}
// \`\`\``,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 type: { 
//                     type: 'string', 
//                     description: '块类型，如 serial_begin, io_digitalwrite, text_join 等' 
//                 },
//                 fields: { 
//                     type: 'object', 
//                     description: '块字段值，如 {SERIAL: "Serial", SPEED: "9600"}' 
//                 },
//                 inputs: {
//                     type: 'object',
//                     description: '块输入配置。每个输入可以是: {"shadow": {"type": "块类型", "fields": {...}}} 或 {"blockId": "已存在的块ID"}',
//                     additionalProperties: {
//                         type: 'object',
//                         properties: {
//                             shadow: {
//                                 type: 'object',
//                                 properties: {
//                                     type: { type: 'string', description: 'shadow块类型' },
//                                     fields: { type: 'object', description: 'shadow块字段' }
//                                 },
//                                 required: ['type']
//                             },
//                             blockId: { type: 'string', description: '已存在的块ID' }
//                         }
//                     }
//                 },
//                 extraState: {
//                     type: 'object',
//                     description: '动态块的额外状态配置。text_join/lists_create_with 用 {itemCount: N}; controls_if 用 {elseIfCount: N, hasElse: true}',
//                     properties: {
//                         itemCount: { type: 'number', description: 'text_join/lists_create_with 的输入数量' },
//                         elseIfCount: { type: 'number', description: 'controls_if 的 else if 分支数量' },
//                         hasElse: { type: 'boolean', description: 'controls_if 是否有 else 分支' }
//                     }
//                 },
//                 position: {
//                     type: 'object',
//                     properties: {
//                         x: { type: 'number', description: 'X坐标' },
//                         y: { type: 'number', description: 'Y坐标' }
//                     },
//                     description: '可选，块的位置'
//                 },
//                 connect: {
//                     type: 'object',
//                     description: '可选，创建后立即连接到目标块（参考 connect_blocks_simple）',
//                     properties: {
//                         action: {
//                             type: 'string',
//                             enum: ['put_into', 'chain_after', 'set_as_input'],
//                             description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
//                         },
//                         target: {
//                             type: 'string',
//                             description: '目标块 ID 或类型名（如 "arduino_setup", "arduino_loop"）'
//                         },
//                         input: {
//                             type: 'string',
//                             description: '目标输入名（可选，会自动检测）'
//                         },
//                         moveWithChain: {
//                             type: 'boolean',
//                             description: '是否将块后面连接的块一起移动（默认 false）',
//                             default: false
//                         }
//                     },
//                     required: ['action', 'target']
//                 }
//             },
//             required: ['type']
//         }
//     },
//     {
//         name: "connect_blocks_simple",
//         description: `【原子化工具-推荐】连接两个 Blockly 块，使用直观的语义。

// **连接动作**：
// | action | 说明 | 适用块类型 |
// |--------|------|-----------|
// | put_into | 放入容器的语句输入 | 语句块 → 容器块 |
// | chain_after | 链接到块后面 | 语句块 → 语句块 |
// | set_as_input | 设为值输入 | 值块 → 任意块 |

// **moveWithChain 选项**：
// - true（默认）：移动块时，将其后面连接的所有块一起移动
// - false：只移动单个块，原来连接在其后面的块会保持在原位置并自动重连

// **示例**：
// \`\`\`json
// // 将 serial_begin 放入 arduino_setup
// {"block": "serial_begin_id", "action": "put_into", "target": "arduino_setup_id"}

// // 将 delay 链接到 serial_println 后面
// {"block": "delay_id", "action": "chain_after", "target": "serial_println_id"}

// // 将 math_number 设为 delay 的 TIME 输入
// {"block": "math_number_id", "action": "set_as_input", "target": "delay_id", "input": "TIME"}

// // 只移动单个块（不带后面连接的块）
// {"block": "some_block_id", "action": "chain_after", "target": "target_id", "moveWithChain": false}
// \`\`\`

// **与 connect_blocks_tool 的区别**：
// - 语义更清晰：put_into/chain_after/set_as_input
// - 自动检测输入名（input 参数可选）
// - 支持 moveWithChain 选项控制是否移动整个块链
// - 更详细的错误提示`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 block: { 
//                     type: 'string', 
//                     description: '要操作的块 ID（来自 create_single_block 的返回值）' 
//                 },
//                 action: {
//                     type: 'string',
//                     enum: ['put_into', 'chain_after', 'set_as_input'],
//                     description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值输入'
//                 },
//                 target: { 
//                     type: 'string', 
//                     description: '目标块 ID' 
//                 },
//                 input: { 
//                     type: 'string', 
//                     description: '目标输入名（可选，会自动检测）' 
//                 },
//                 moveWithChain: {
//                     type: 'boolean',
//                     description: '是否将块后面连接的块一起移动（默认 false）。设为 false 时只移动单个块，原来在其后的块会自动重连',
//                     default: false
//                 }
//             },
//             required: ['block', 'action', 'target']
//         }
//     },
//     {
//         name: "set_block_field",
//         description: `【原子化工具】设置块的字段值。用于修改已创建块的字段。

// **示例**：
// \`\`\`json
// {"blockId": "abc123", "fieldName": "SPEED", "value": "115200"}
// {"blockId": "abc123", "fieldName": "VAR", "value": {"name": "myVar"}}
// \`\`\``,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockId: { type: 'string', description: '块 ID' },
//                 fieldName: { type: 'string', description: '字段名' },
//                 value: { description: '字段值（字符串、数字或变量对象）' }
//             },
//             required: ['blockId', 'fieldName', 'value']
//         }
//     },
//     {
//         name: "set_block_input",
//         description: `【原子化工具】将块连接到另一个块的指定输入。支持两种模式：连接已存在的块，或创建新块并连接。

// **模式1：连接已存在的块**（使用 sourceBlockId）
// \`\`\`json
// {"blockId": "if_block_id", "inputName": "IF0", "sourceBlockId": "condition_block_id"}
// \`\`\`

// **模式2：创建新块并连接**（使用 newBlock）
// \`\`\`json
// {
//   "blockId": "delay_block_id",
//   "inputName": "TIME",
//   "newBlock": {"type": "math_number", "fields": {"NUM": "1000"}}
// }
// \`\`\`

// **创建 shadow 块并连接**：
// \`\`\`json
// {
//   "blockId": "io_digitalwrite_id",
//   "inputName": "PIN",
//   "newBlock": {"type": "io_pin_digi", "fields": {"PIN": "13"}, "shadow": true}
// }
// \`\`\`

// **注意**：sourceBlockId 和 newBlock 必须二选一，不能同时提供`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockId: { type: 'string', description: '目标块 ID' },
//                 inputName: { type: 'string', description: '输入名称' },
//                 sourceBlockId: { type: 'string', description: '要连接的已存在块 ID（与 newBlock 二选一）' },
//                 newBlock: {
//                     type: 'object',
//                     description: '要创建并连接的新块配置（与 sourceBlockId 二选一）',
//                     properties: {
//                         type: { type: 'string', description: '块类型' },
//                         fields: { type: 'object', description: '块字段值' },
//                         shadow: { type: 'boolean', description: '是否作为 shadow 块', default: false }
//                     },
//                     required: ['type']
//                 }
//             },
//             required: ['blockId', 'inputName']
//         }
//     },
//     {
//         name: "get_workspace_blocks",
//         description: `【原子化工具】获取工作区当前的所有块列表。

// **用途**：
// - 查看已创建的块和它们的 ID
// - 检查哪些块有空输入需要填充
// - 分析块之间的连接关系

// **返回信息**：
// - 每个块的 ID、类型、是否为根块
// - 空输入列表（提示需要连接）
// - 块按类型分组统计`,
//         input_schema: {
//             type: 'object',
//             properties: {}
//         }
//     },
//     {
//         name: "batch_create_blocks",
//         description: `批量创建块并建立连接，一次调用完成整个结构。<system-reminder>使用前需读取对应库的 Readme</system-reminder>

// **核心特性**：扁平化 blocks+connections 数组 | 使用临时ID（如 "b1"）引用 | 一次调用完成多块创建和连接

// **示例**（DHT温度读取+LED控制）：
// \`\`\`json
// {
//   "blocks": [
//     {"id": "b1", "type": "dht_init", "fields": {"VAR": {"name": "dht"}}},
//     {"id": "b2", "type": "controls_if", "extraState": {"hasElse": true}},
//     {"id": "b3", "type": "logic_compare", "fields": {"OP": "GT"}},
//     {"id": "b4", "type": "dht_read_temperature", "fields": {"VAR": {"name": "dht"}}},
//     {"id": "b5", "type": "math_number", "fields": {"NUM": 30}}
//   ],
//   "connections": [
//     {"block": "b1", "action": "put_into", "target": "arduino_setup"},
//     {"block": "b2", "action": "put_into", "target": "arduino_loop"},
//     {"block": "b3", "action": "set_as_input", "target": "b2", "input": "IF0"},
//     {"block": "b4", "action": "set_as_input", "target": "b3", "input": "A"},
//     {"block": "b5", "action": "set_as_input", "target": "b3", "input": "B"}
//   ]
// }
// \`\`\`

// **块类型与动作**：
// - **语句块**（io_digitalwrite, dht_init, controls_if）：用 put_into（放入容器）或 chain_after（垂直堆叠）
// - **值块**（math_number, dht_read_temperature, logic_compare）：用 set_as_input（设为输入）

// **关键规则**：
// 1. chain_after 不支持 input 参数！放入 controls_if 的 DO0/ELSE 用 put_into
// 2. 临时ID 仅单次调用有效，跨调用需用返回的真实ID
// 3. inputs 配置：shadow块 | 嵌套块 | blockRef 引用
// 4. target 支持：临时ID（"b1"）| 类型名（"arduino_setup"）| 真实ID`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blocks: {
//                     type: 'array',
//                     description: '要创建的块列表（扁平化数组）',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             id: { type: 'string', description: '临时ID，用于 connections 中引用（如 "b1", "b2"）' },
//                             type: { type: 'string', description: '块类型（如 "dht_init", "controls_if"）' },
//                             fields: { type: 'object', description: '块字段值' },
//                             inputs: { 
//                                 type: 'object', 
//                                 description: '输入配置，支持 shadow 块或 blockRef 引用'
//                             },
//                             extraState: { type: 'object', description: '动态块的额外状态（如 controls_if 的 {hasElse: true}）' }
//                         },
//                         required: ['id', 'type']
//                     }
//                 },
//                 connections: {
//                     type: 'array',
//                     description: '连接规则列表',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             block: { type: 'string', description: '要操作的块（临时ID）' },
//                             action: { 
//                                 type: 'string', 
//                                 enum: ['put_into', 'chain_after', 'set_as_input'],
//                                 description: 'put_into=放入容器, chain_after=链接到后面, set_as_input=设为值'
//                             },
//                             target: { type: 'string', description: '目标块（临时ID 或 已存在块的真实ID）' },
//                             input: { type: 'string', description: '目标输入名（可选，会自动检测）' }
//                         },
//                         required: ['block', 'action', 'target']
//                     }
//                 },
//                 position: {
//                     type: 'object',
//                     properties: {
//                         x: { type: 'number' },
//                         y: { type: 'number' }
//                     },
//                     description: '起始位置（可选）'
//                 }
//             },
//             required: ['blocks', 'connections']
//         }
//     },
    // =============================================================================
    // 原有块操作工具（保持兼容）
    // =============================================================================
    {
        name: "smart_block_tool",
        description: `智能块创建Blockly工作区中的块，一次只能创建一个块。<system-reminder>使用工具前必须确保已经读取了将要使用的block所属库的Readme。注意：当需要创建3个以上的块或嵌套超过2层时，推荐使用create_code_structure_tool创建。</system-reminder>
基本语法:
\`\`\`json
{
  "type": "块类型",
  "position": {"x": 数字, "y": 数字}, // 可选
  "fields": {"字段名": "字段值"},
  "inputs": {"输入名": "块ID或配置"}, // 可选
  "parentConnection": {
    "blockId": "父块ID",
    "connectionType": "next|input|statement",
    "inputName": "输入名，如ARDUINO_SETUP"
  } // 父块连接配置（可选）
}
\`\`\`
示例:
创建数字块
\`\`\`json
{
  "type": "math_number",
  "fields": {"NUM": "123"}
}
\`\`\`
创建变量块
\`\`\`json
{
  "type": "variable_define",
  "fields": {
    "VAR": "sensor_value",
    "TYPE": "int"
  },
  "inputs": {
    "VALUE": {"block": {"type": "math_number", "fields": {"NUM": "0"}}}
  }
}
\`\`\`
创建Arduino数字输出
\`\`\`json
{
  "type": "io_digitalwrite",
  "inputs": {
    "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
    "STATE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
  }
}
\`\`\`
创建串口打印
\`\`\`json
{
  "type": "serial_println",
  "fields": {"SERIAL": "Serial"},
  "inputs": {
    "VAR": {"block": {"type": "text", "fields": {"TEXT": "Hello"}}}
  }
}
\`\`\`
`,
        input_schema: {
            type: 'object',
            properties: {
                type: {
                    type: 'string',
                    description: '块类型，如 logic_boolean、controls_if、math_number 等'
                },
                position: {
                    type: 'object',
                    properties: {
                        x: { type: 'number', description: 'X坐标' },
                        y: { type: 'number', description: 'Y坐标' }
                    },
                    description: '块在工作区中的位置（可选）'
                },
                fields: {
                    type: 'object',
                    description: '块的字段配置，如布尔值、数字值、变量名等'
                },
                inputs: {
                    type: 'object',
                    description: '块的输入配置，连接其他块'
                },
                parentConnection: {
                    type: 'object',
                    properties: {
                        blockId: { type: 'string', description: '父块ID' },
                        connectionType: { type: 'string', description: '连接类型' },
                        inputName: { type: 'string', description: '输入名称' }
                    },
                    description: '父块连接配置（可选）。不提供时创建独立块，适用于全局变量、函数定义等顶级代码块'
                }
            },
            required: ['type']
        }
    },
    {
        name: "connect_blocks_tool",
        description: `块连接工具，通过修改连接关系移动Blockly块，但不会新建块，支持四种连接类型：next（顺序连接）、input（输入连接）、statement（语句连接）、disconnect（断开连接变独立块）。

⚠️ **重要**：连接语义说明
- containerBlock: **容器块/父块** (提供连接点的块，如arduino_setup、if_else、repeat等)
- contentBlock: **内容块/子块** (要被连接的块，如digital_write、delay等)
- 例如：将digital_write放入arduino_setup中
  - containerBlock: "arduino_setup_id0" (容器)  
  - contentBlock: "digital_write_id1" (内容)
  - connectionType: "statement"
  - inputName: "input_statement"

🔓 **断开连接（变独立块）**：
- 使用 connectionType: "disconnect" 将块从父块断开，变成工作区中的独立块
- moveChain: false（默认）- 只断开指定块，后续块保持在原位置
- moveChain: true - 断开整个块链，包括后续所有块一起变成独立块

常见错误：不要混淆容器和内容的关系！`,
        input_schema: {
            type: 'object',
            properties: {
                containerBlock: {
                    type: 'string',
                    description: '🔳 容器块ID（父块，提供连接点的块，如arduino_setup、if_else、repeat等容器类型块）。disconnect模式时可省略'
                },
                contentBlock: {
                    type: 'string', 
                    description: '📦 内容块ID（子块，要被放入容器的块，或要断开连接的块）'
                },
                connectionType: {
                    type: 'string',
                    enum: ['next', 'input', 'statement', 'disconnect'],
                    description: '连接类型：statement=语句连接（推荐），input=输入连接，next=顺序连接，disconnect=断开连接变独立块'
                },
                inputName: {
                    type: 'string',
                    description: '输入端口名称（statement连接时指定容器的哪个端口，如"input_statement"、"DO"、"ELSE"等，不指定时自动检测）'
                },
                moveChain: {
                    type: 'boolean',
                    description: '是否移动整个块链。false=只移动/断开单个块，后续块保持或重连；true（默认）=移动/断开整个块链',
                    default: true
                }
            },
            required: ['contentBlock', 'connectionType']
        }
    },
    {
        name: "create_code_structure_tool", 
        description: `动态结构创建工具，创建包含多个块的代码结构并连接到工作区。

**注意事项**:
- 使用工具前必须确保已读取使用的 block 所属库的 Readme
- 建议分步生成代码：全局变量 → 初始化 → loop → 回调函数
- 不要一次性生成超过 10 个 block 的代码块结构

**参数说明**:
- \`structureDefinition\`: 定义要创建的块（rootBlock + additionalBlocks）
- \`connectionRules\`: 定义所有块之间的连接（包括新创建的块之间，以及新块与工作区已有块之间）

**示例: 在 Arduino Setup 中添加初始化代码**
\`\`\`json
{
  "structure": "init-code",
  "config": {
    "structureDefinition": {
      "rootBlock": {
        "type": "control_if",
        "id": "if_check",
        "extraState": {"hasElse": true},
        "inputs": {
          "IF0": {"block": {"type": "logic_compare", "id": "logic_compare_id", "fields": {"OP": "GT"}, ...}},
          "DO0": {"block": {"type": "io_digitalwrite", "id": "green_led_on", "inputs": {...}}},
          "ELSE": {}
        }
      },
      "additionalBlocks": [
        {
          "type": "io_digitalwrite",
          "id": "red_led_on",
          "inputs": {
            "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
            "MODE": {"shadow": {"type": "io_state", "fields": {"STATE": "HIGH"}}}
          }
        },
        {
          "type": "io_digitalwrite",
          "id": "red_led_off",
          "inputs": {
            "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
            "MODE": {"shadow": {"type": "io_state", "fields": {"STATE": "LOW"}}}
          }
        }
      ]
    }
  },
  "connectionRules": [
    {"source": "arduino_setup_id", "target": "if_check", "connectionType": "statement", "inputName": "ARDUINO_SETUP"},
    {"source": "green_led_on", "target": "red_led_on", "connectionType": "next"},
    {"source": "if_check", "target": "red_led_off", "connectionType": "statement", "inputName": "ELSE"}
  ]
}
\`\`\`
`,
        input_schema: {
            type: 'object',
            properties: {
                structure: {
                    type: 'string',
                    description: '结构名称（用于日志和调试）'
                },
                config: {
                    type: 'object',
                    properties: {
                        structureDefinition: {
                            type: 'object',
                            properties: {
                                rootBlock: {
                                    type: 'object',
                                    description: '根块配置（必须包含 type 和 id）'
                                },
                                additionalBlocks: {
                                    type: 'array',
                                    items: { type: 'object' },
                                    description: '附加块配置数组'
                                }
                            },
                            required: ['rootBlock'],
                            description: '动态结构定义（仅定义要创建的块）'
                        }
                    },
                    required: ['structureDefinition'],
                    description: '结构配置对象'
                },
                connectionRules: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            source: { type: 'string', description: '源块的 id（可以是新创建的块 id，也可以是工作区已有块的 id）' },
                            target: { type: 'string', description: '目标块的 id（可以是新创建的块 id，也可以是工作区已有块的 id）' },
                            inputName: { type: 'string', description: 'statement/input 连接时指定输入名称' },
                            connectionType: { 
                                type: 'string', 
                                enum: ['next', 'input', 'statement'],
                                description: 'next=source.nextConnection→target.previousConnection，statement=source.getInput(inputName).connection→target.previousConnection，input=source.getInput(inputName).connection→target.outputConnection' 
                            }
                        },
                        required: ['source', 'target', 'connectionType']
                    },
                    description: '块之间的连接规则（统一定义所有连接，包括新块之间和新块与已有块之间）'
                },
                position: {
                    type: 'object',
                    properties: {
                        x: { type: 'number', description: 'X坐标' },
                        y: { type: 'number', description: 'Y坐标' }
                    },
                    description: '结构在工作区中的坐标位置'
                }
            },
            required: ['structure']
        }
    },
    {
        name: "configure_block_tool",
        description: `用途：修改已存在 Blockly 块的字段值与动态结构（extraState），用于调整块的显示/配置但不创建或删除块。

主要能力：
- 更新字段（field_dropdown、field_input、field_number、field_checkbox、text 等）。
- 修改动态结构（如 controls_if 的 else/elseif 分支、text_join 或 lists_create_with 的项目数）。
- 支持通过 blockId 精准定位或通过 blockType 查找第一个匹配块。

前提条件：
- 目标块必须已存在于工作区。
- 必须提供有效的 blockId 或 blockType。
- 字段修改需提供非空的 fields 对象；结构修改需提供 extraState 对象。

限制与注意：
- 不用于创建新块（请使用 smart_block_tool）。
- 不用于删除块或改变块之间的连接关系（请使用 delete_block_tool / connect_blocks_tool）。
- 修改前请确保理解目标块的字段名与 extraState 结构，错误参数可能导致操作失败。

**extraState 使用示例：**
为 controls_if 块添加 1 个 else if 和 1 个 else 分支：
\`\`\`json
{
  "blockId": "if_block_id",
  "extraState": {
    "elseIfCount": 1,
    "hasElse": true
  }
}
\`\`\`

**必须提供完整的参数结构，空参数会导致工具执行失败。**`,
        input_schema: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要配置的块ID（blockId 和 blockType 至少提供一个）'
                },
                blockType: {
                    type: 'string',
                    description: '块类型，当未提供 blockId 时使用（会找到第一个匹配类型的块）'
                },
                fields: {
                    type: 'object',
                    description: '要更新的字段值对象。格式：{"字段名": "字段值"}。字段名需要参考对应库的文档。',
                    additionalProperties: {
                        oneOf: [
                            { type: 'string' },
                            { type: 'number' },
                            { type: 'boolean' }
                        ]
                    }
                },
                extraState: {
                    type: 'object',
                    description: '动态块结构配置对象。用于修改支持动态输入的块结构，如 controls_if 的分支数量。',
                    properties: {
                        elseIfCount: {
                            type: 'number',
                            description: 'else if 分支数量（适用于 controls_if, controls_ifelse）',
                            minimum: 0,
                            maximum: 20
                        },
                        hasElse: {
                            type: 'boolean',
                            description: '是否包含 else 分支（适用于 controls_if）'
                        },
                        itemCount: {
                            type: 'number',
                            description: '项目数量（适用于 text_join, lists_create_with 等）',
                            minimum: 1,
                            maximum: 50
                        }
                    },
                    additionalProperties: true
                }
            },
            anyOf: [
                { 
                    allOf: [
                        { anyOf: [{ required: ['blockId'] }, { required: ['blockType'] }] },
                        { anyOf: [{ required: ['fields'] }, { required: ['extraState'] }] }
                    ]
                }
            ]
        }
    },
    // {
    //     name: "variable_manager_tool",
    //     description: `变量管理工具。创建、删除、重命名工作区中的变量。支持不同类型的变量和作用域管理。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             operation: {
    //                 type: 'string',
    //                 enum: ['create', 'delete', 'rename', 'list'],
    //                 description: '操作类型：create=创建，delete=删除，rename=重命名，list=列出所有变量'
    //             },
    //             variableName: {
    //                 type: 'string',
    //                 description: '变量名（create、delete、rename时必需）'
    //             },
    //             newName: {
    //                 type: 'string',
    //                 description: '新变量名（rename时必需）'
    //             },
    //             variableType: {
    //                 type: 'string',
    //                 description: '变量类型，如String、Number、Boolean等',
    //                 default: 'String'
    //             }
    //         },
    //         required: ['operation']
    //     }
    // },
    // {
    //     name: "find_block_tool",
    //     description: `块查找工具。在工作区中查找特定的块，支持多种查找条件：块类型、字段值、位置等。返回匹配的块信息。`,
    //     input_schema: {
    //         type: 'object', 
    //         properties: {
    //             criteria: {
    //                 type: 'object',
    //                 properties: {
    //                     type: { type: 'string', description: '块类型' },
    //                     fields: { type: 'object', description: '字段值匹配' },
    //                     position: { 
    //                         type: 'object',
    //                         properties: {
    //                             x: { type: 'number' },
    //                             y: { type: 'number' },
    //                             tolerance: { type: 'number', description: '位置容差' }
    //                         },
    //                         description: '位置匹配'
    //                     },
    //                     connected: { type: 'boolean', description: '是否已连接' }
    //                 },
    //                 description: '查找条件'
    //             },
    //             limit: {
    //                 type: 'number',
    //                 description: '返回结果数量限制',
    //                 default: 10
    //             },
    //             includeMetadata: {
    //                 type: 'boolean',
    //                 description: '是否包含详细元数据',
    //                 default: false
    //             }
    //         },
    //         required: ['criteria']
    //     }
    // },
    {
        name: "delete_block_tool",
        description: `块删除工具，支持删除单个或多个块。
**注意**：严禁直接进行删除操作，避免删除后重新创建相同代码块的操作，确保每次删除都是经过深思熟虑的决定。
**注意**：优先使用块创建工具及连接工具修复代码结构。

**功能特点**：
- 支持单个块ID或多个块ID数组输入
- 智能删除：只删除指定块，保留连接的块并自动重连
- 删除后自动重连前后块（如果可能）

**示例**：
\`\`\`json
// 删除单个块
{"blockIds": "block_id_123"}

// 删除多个块
{"blockIds": ["block_id_1", "block_id_2", "block_id_3"]}
\`\`\`

**注意**：被删除块的前后块会尝试自动重连，连接的子块会保留。`,
        input_schema: {
            type: 'object',
            properties: {
                blockIds: {
                    oneOf: [
                        { type: 'string', description: '单个要删除的块ID' },
                        { type: 'array', items: { type: 'string' }, description: '要删除的块ID数组' }
                    ],
                    description: '要删除的块ID，支持单个字符串或字符串数组'
                }
            },
            required: ['blockIds']
        }
    },
    {
        name: "get_workspace_overview_tool",
        description: `工作区全览分析工具。提供工作区的完整分析，包括结构分析、代码生成、复杂度评估、连接关系和树状结构展示。支持多种输出格式：JSON、Markdown、详细报告和控制台输出。`,
        input_schema: {
            type: 'object',
            properties: {
                outputFormat: {
                    type: 'string',
                    enum: ['json', 'markdown', 'detailed', 'console'],
                    description: '输出格式',
                    default: 'console'
                },
                includeCode: {
                    type: 'boolean',
                    description: '是否包含生成的C++代码',
                    default: true
                },
                includeStructure: {
                    type: 'boolean',
                    description: '是否包含结构分析',
                    default: true
                },
                includeConnections: {
                    type: 'boolean',
                    description: '是否包含连接关系分析',
                    default: true
                },
                includeComplexity: {
                    type: 'boolean',
                    description: '是否包含复杂度分析',
                    default: true
                },
                maxDepth: {
                    type: 'number',
                    description: '树状结构的最大深度',
                    default: 10
                },
                showDetails: {
                    type: 'boolean',
                    description: '是否显示详细信息',
                    default: false
                }
            },
            required: []
        }
    },
//     {
//         name: "queryBlockDefinitionTool",
//         description: `查询项目中所有库的块定义信息。
        
// ## 功能特点
// - **动态扫描**: 自动扫描当前项目的 node_modules/@aily-project/lib-* 目录中的 block.json 文件
// - **缓存优化**: 内置缓存机制，避免重复文件读取
// - **灵活查询**: 支持按块类型、块ID或关键词进行过滤查询
// - **兼容性分析**: 可查询特定块的连接类型和兼容性信息

// ## 使用场景
// - 查找可用的块类型和定义
// - 分析块之间的连接兼容性
// - 获取块的输入输出配置信息
// - 调试块连接问题

// ## 查询选项
// - **blockType**: 按特定块类型筛选
// - **searchKeyword**: 按关键词搜索块ID或描述
// - **includeInputs**: 是否包含输入配置详情
// - **includeOutputs**: 是否包含输出配置详情
// - **compatibilityCheck**: 检查与指定块的兼容性`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blockType: {
//                     type: 'string',
//                     description: '要查询的特定块类型（可选，用于筛选）'
//                 },
//                 library: {
//                     type: 'string',
//                     description: '要查询的特定库名（可选，用于筛选）'
//                 },
//                 connectionType: {
//                     type: 'string',
//                     enum: ['input_statement', 'input_value', 'previousStatement', 'nextStatement', 'output'],
//                     description: '要查询的连接类型（可选）'
//                 },
//                 refresh: {
//                     type: 'boolean',
//                     description: '是否强制刷新缓存',
//                     default: false
//                 },
//                 useRealData: {
//                     type: 'boolean',
//                     description: '是否使用真实数据（需要文件读取）',
//                     default: false
//                 },
//                 scanFiles: {
//                     type: 'boolean',
//                     description: '是否扫描实际文件系统',
//                     default: true
//                 }
//             },
//             required: []
//         }
//     },
//     {
//         name: "getBlockConnectionCompatibilityTool",
//         description: `分析块之间的连接兼容性，帮助解决块连接问题。

// ## 功能特点
// - **连接类型分析**: 详细分析输入输出的连接类型（value、statement等）
// - **兼容性检查**: 检查两个块之间是否可以连接
// - **连接建议**: 为连接失败提供解决方案和替代连接方式
// - **类型映射**: 显示Blockly连接类型的详细信息

// ## 使用场景
// - 调试块连接失败问题
// - 查找可连接的块类型
// - 分析连接类型不匹配的原因
// - 获取连接建议和替代方案

// ## 分析维度
// - **输入类型分析**: 分析目标块可接受的输入类型
// - **输出类型分析**: 分析源块的输出类型
// - **类型兼容性**: 检查类型是否匹配
// - **连接建议**: 提供连接方案`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 sourceBlockType: {
//                     type: 'string',
//                     description: '源块类型（要连接出去的块）'
//                 },
//                 targetBlockType: {
//                     type: 'string',
//                     description: '目标块类型（要连接到的块）'
//                 },
//                 library: {
//                     type: 'string',
//                     description: '库名（可选，用于筛选特定库）'
//                 }
//             },
//             required: ['sourceBlockType', 'targetBlockType']
//         }
//     },
    {
        name: "todo_write_tool",
        description: `Creates and manages todo items for task tracking and progress management in the current session.
Use this tool to create and manage todo items for tracking tasks and progress. This tool provides comprehensive todo management:

## When to Use This Tool

Use this tool proactively in these scenarios:

1. **Complex multi-step tasks** - When a task requires 3 or more distinct steps or actions
2. **Non-trivial and complex tasks** - Tasks that require careful planning or multiple operations
3. **User explicitly requests todo list** - When the user directly asks you to use the todo list
4. **User provides multiple tasks** - When users provide a list of things to be done (numbered or comma-separated)
5. **After receiving new instructions** - Immediately capture user requirements as todos
6. **When you start working on a task** - Mark it as in_progress BEFORE beginning work. Ideally you should only have one todo as in_progress at a time
7. **After completing a task** - Mark it as completed and add any new follow-up tasks discovered during implementation

## When NOT to Use This Tool

Skip using this tool when:
1. There is only a single, straightforward task
2. The task is trivial and tracking it provides no organizational benefit
3. The task can be completed in less than 3 trivial steps
4. The task is purely conversational or informational

## Task States and Management

1. **Task States**: Use these states to track progress:
   - pending: Task not yet started
   - in_progress: Currently working on (limit to ONE task at a time)
   - completed: Task finished successfully

2. **Task Management**:
   - Update task status in real-time as you work
   - Mark tasks complete IMMEDIATELY after finishing (don't batch completions)
   - Only have ONE task in_progress at any time
   - Complete current tasks before starting new ones
   - Remove tasks that are no longer relevant from the list entirely

3. **Task Completion Requirements**:
   - ONLY mark a task as completed when you have FULLY accomplished it
   - If you encounter errors, blockers, or cannot finish, keep the task as in_progress
   - When blocked, create a new task describing what needs to be resolved
   - Never mark a task as completed if:
     - Tests are failing
     - Implementation is partial
     - You encountered unresolved errors
     - You couldn't find necessary files or dependencies

4. **Task Breakdown**:
   - Create specific, actionable items
   - Break complex tasks into smaller, manageable steps
   - Use clear, descriptive task names

## Tool Capabilities

- **Create new todos**: Add tasks with content, priority, and status
- **Update existing todos**: Modify any aspect of a todo (status, priority, content)
- **Delete todos**: Remove completed or irrelevant tasks
- **Batch operations**: Update multiple todos in a single operation
- **Clear all todos**: Reset the entire todo list

When in doubt, use this tool. Being proactive with task management demonstrates attentiveness and ensures you complete all requirements successfully.

请求参数
## 必填字段
- \`operation\`: 操作类型 (add|list|update|toggle|delete|query|stats|clear|optimize)

## 操作特定必填字段
- **add**: \`content\` - 任务内容
- **update**: \`todos\` - 任务数组
- **toggle/delete**: \`id\` - 任务ID
- **query**: \`query\` - 查询条件对象

## 可选字段
- \`priority\`: 优先级 (high|medium|low)，默认 'medium'
- \`tags\`: 标签数组

示例:
## 添加单个任务 (add)
\`\`\`json
{
  "operation": "add",
  "content": "完成项目文档",
  "priority": "high",
  "status": "pending",
}
\`\`\`

## 批量添加任务 (batch_add)
\`\`\`json
{
  "operation": "batch_add",
  "todos": [
    {
      "content": "任务1内容",
      "priority": "medium",
      "status": "pending"
    },
    {
      "content": "任务2内容",
      "priority": "low",
      "status": "in_progress"
    }
  ]
}
\`\`\`

## 批量更新任务 (update)
\`\`\`json
{
  "operation": "update",
  "todos": [
    {
      "id": "任务ID",
      "content": "更新后的任务内容",
      "status": "in_progress",
      "priority": "high",
      "tags": ["标签1", "标签2"]
    }
  ]
}
\`\`\`

## 查看任务列表 (list)
\`\`\`json
{
  "operation": "list"
}
\`\`\`

## 切换任务状态 (toggle)
\`\`\`json
{
  "operation": "toggle",
  "id": "任务ID"
}
\`\`\`
状态循环：\`pending\` → \`in_progress\` → \`completed\`
`,
        input_schema: {
            type: 'object',
            properties: {
                operation: {
                    type: 'string',
                    enum: ['add', 'batch_add', 'list', 'update', 'toggle', 'delete', 'query', 'stats', 'clear', 'optimize'],
                    description: '操作类型'
                },
                sessionId: {
                    type: 'string',
                    description: '会话ID，默认为default',
                    default: 'default'
                },
                content: {
                    type: 'string',
                    description: '任务内容（add操作必需）'
                },
                priority: {
                    type: 'string',
                    enum: ['high', 'medium', 'low'],
                    description: '任务优先级，默认为medium',
                    default: 'medium'
                },
                status: {
                    type: 'string',
                    enum: ['pending', 'in_progress', 'completed'],
                    description: '任务状态，默认为pending',
                    default: 'pending'
                },
                tags: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '任务标签数组'
                },
                estimatedHours: {
                    type: 'number',
                    description: '预估工时'
                },
                id: {
                    type: 'string',
                    description: '任务ID（toggle/delete操作必需）'
                },
                todos: {
                    type: 'array',
                    description: '任务数组（update/batch_add操作使用）',
                    items: {
                        type: 'object',
                        properties: {
                            id: {
                                type: 'string',
                                description: '任务唯一标识符'
                            },
                            content: {
                                type: 'string',
                                description: '任务内容描述'
                            },
                            status: {
                                type: 'string',
                                enum: ['pending', 'in_progress', 'completed'],
                                description: '任务状态'
                            },
                            priority: {
                                type: 'string',
                                enum: ['high', 'medium', 'low'],
                                description: '任务优先级'
                            },
                            tags: {
                                type: 'array',
                                items: { type: 'string' },
                                description: '任务标签'
                            },
                            estimatedHours: {
                                type: 'number',
                                description: '预估工时'
                            }
                        },
                        required: ['content']
                    }
                },
                query: {
                    type: 'object',
                    description: '查询条件（query操作使用）',
                    properties: {
                        status: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['pending', 'in_progress', 'completed']
                            },
                            description: '状态筛选'
                        },
                        priority: {
                            type: 'array',
                            items: {
                                type: 'string',
                                enum: ['high', 'medium', 'low']
                            },
                            description: '优先级筛选'
                        },
                        contentMatch: {
                            type: 'string',
                            description: '内容关键词搜索'
                        },
                        tags: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '标签筛选'
                        }
                    }
                }
            },
            required: ['operation']
        }
    },
    {
        name: 'analyze_library_blocks',
        description: `分析指定库的块定义，生成类似 readme.md 格式的块定义文档。优先使用read_file工具读取库readme，当库对应的 readme 不存在或描述不准确时，使用此工具补充和完善库的文档说明。`,
        input_schema: {
            type: 'object',
            properties: {
                libraryNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要分析的库名称列表，如 ["@aily-project/lib-blinker", "@aily-project/lib-sensor"]'
                }
            },
            required: ['libraryNames']
        }
    },
    {
        name: 'verify_block_existence',
        description: `验证指定块是否存在于指定库中。快速检查块的可用性，避免使用不存在的块类型。`,
        input_schema: {
            type: 'object',
            properties: {
                blockTypes: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要验证的块类型列表，如 ["blinker_run", "sensor_read_temperature"]'
                },
                libraryNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要搜索的库名称列表，如 ["@aily-project/lib-blinker"]'
                },
                includeAlternatives: {
                    type: 'boolean',
                    default: true,
                    description: '如果块不存在，是否建议替代方案'
                }
            },
            required: ['blockTypes', 'libraryNames']
        }
    }
    // =============================================================================
    // 扁平化块创建工具（推荐）
    // =============================================================================
//     {
//         name: "flat_create_blocks",
//         description: `【推荐】扁平化批量创建 Blockly 块 - 支持智能拆分嵌套结构
// <system-reminder>使用工具前必须确保已经读取了将要使用的block所属库的Readme。
// **注意事项**：
// - 一个block(id)包含的块(type)严禁超过5个，超过请分多次创建。
// - 严禁一次性生成全部代码块，建议分多次调用，每次创建少量块。
// - 创建代码步骤：全局变量 → 初始化（arduino_setup）→ 主循环（arduino_loop）→ 回调函数</system-reminder>

// 🧠 **智能拆分功能**：
// - 工具会自动检测嵌套结构（如 controls_ifelse 中的 inputs.IF0.block）
// - 自动将嵌套块提取为独立块并生成连接规则
// - 即使 JSON 结构有轻微错误也能正确处理

// **块定义格式**（与 smart_block_tool 相同）:
// \`\`\`json
// {
//   "id": "b1",
//   "type": "io_digitalwrite",
//   "inputs": {
//     "PIN": {"shadow": {"type": "io_pin_digi", "fields": {"PIN": "13"}}},
//     "STATE": { "shadow": { "type": "io_state", "fields": {"STATE": "HIGH"}}}
//   }
// }
// \`\`\`

// **连接格式**:
// - \`"b1 -> arduino_setup"\` - 语句块放入容器（自动检测 input_statement）
// - \`"b1 -> b2:next"\` - 顺序连接（b1 接在 b2 后面）
// - \`"b3 -> b2:VALUE"\` - 值输入连接（b3 连接到 b2 的 VALUE 输入）
// - \`"b1 -> if_block:DO0"\` - 语句输入连接（b1 放入 if 块的第一个执行分支）
// - 不提供连接规则的块将成为工作区中的独立块

// ⚠️ **重要：输入名称是扁平的，不支持嵌套路径！**
// - ✅ 正确: \`"b1 -> if_block:DO0"\`, \`"b2 -> if_block:DO1"\`, \`"b3 -> if_block:ELSE"\`
// - ❌ 错误: \`"b1 -> if_block:ELSE:IF0:DO0"\`（不支持嵌套路径）

// **controls_ifelse 输入名称规则**（extraState: {elseIfCount: N}）:
// - IF0/DO0: 第一个 if 条件和执行体
// - IF1/DO1, IF2/DO2...: else if 分支（按 elseIfCount 数量）
// - ELSE: else 分支执行体

// **示例 - 温度读取+串口打印**:
// \`\`\`json
// {
//   "blocks": [
//     {"id": "b1", "type": "dht_begin", "fields": {"VAR": "dht", "PIN": "2", "TYPE": "DHT11"}},
//     {"id": "b2", "type": "serial_begin", "fields": {"SERIAL": "Serial", "SPEED": "9600"}},
//     {"id": "b3", "type": "dht_read_temperature", "fields": {"VAR": "dht"}},
//     {"id": "b4", "type": "serial_println", "fields": {"SERIAL": "Serial"}}},
//     {"id": "b5", "type": "delay_ms", "inputs": {"TIME": {"shadow": {"type": "math_number", "fields": {"NUM": "2000"}}}}}
//   ],
//   "connections": [
//     "b1 -> arduino_setup",
//     "b2 -> b1:next",
//     "b3 -> arduino_loop",
//     "b3 -> b4:VAR",
//     "b4 -> b3:next",
//     "b5 -> b4:next"
//   ]
// }
// \`\`\`

// **动态块 extra**: \`controls_if\`: {"elseIfCount": N, "hasElse": true}, \`text_join/lists_create_with\`: {"itemCount": N}`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 blocks: {
//                     type: 'array',
//                     description: '块定义数组，格式与 smart_block_tool 完全相同',
//                     items: {
//                         type: 'object',
//                         properties: {
//                             id: { type: 'string', description: '临时ID（如 "b1", "b2"）' },
//                             type: { type: 'string', description: '块类型' },
//                             fields: { type: 'object', description: '字段值' },
//                             inputs: { type: 'object', description: '输入配置，与 smart_block_tool 格式相同' },
//                             extra: { type: 'object', description: '动态块配置: itemCount, elseIfCount, hasElse' }
//                         },
//                         required: ['id', 'type']
//                     }
//                 },
//                 connections: {
//                     type: 'array',
//                     description: '连接规则: "源ID -> 目标ID" 或 "源ID -> 目标ID:输入名"。不提供连接规则的块将成为独立块',
//                     items: { type: 'string' }
//                 }
//             },
//             required: ['blocks']
//         }
//     }
    // =============================================================================
    // DSL 块创建工具
    // =============================================================================
//     {
//         name: 'dsl_create_blocks',
//         description: `使用 YAML-Like DSL 语法创建 Blockly 块 - 最简洁的块创建方式

// **语法格式**：
// \`\`\`yaml
// setup:
//   - 块类型 参数1 参数2 ...
//   - 变量 = 块类型 参数...

// loop:
//   - 块类型 参数...
//   - if 条件:
//       - 块类型 参数...
//     else:
//       - 块类型 参数...
// \`\`\`

// **核心规则**：
// 1. \`setup:\` 和 \`loop:\` 定义代码区域
// 2. \`-\` 开头表示一个块
// 3. 参数按顺序自动映射到字段
// 4. \`变量 = 块类型\` 用于赋值/引用
// 5. 缩进表示嵌套（语句输入）

// **示例1 - 基础串口**：
// \`\`\`yaml
// setup:
//   - serial_begin Serial 9600

// loop:
//   - serial_println Serial "Hello"
//   - time_delay 1000
// \`\`\`

// **示例2 - DHT 温度传感器**：
// \`\`\`yaml
// setup:
//   - serial_begin Serial 9600
//   - dht_init dht DHT22 2

// loop:
//   - temp = dht_read_temperature dht
//   - serial_println Serial temp
//   - time_delay 2000
// \`\`\`

// **示例3 - 条件判断**：
// \`\`\`yaml
// setup:
//   - dht_init dht DHT22 2

// loop:
//   - temp = dht_read_temperature dht
//   - if temp > 30:
//       - io_digitalwrite 13 HIGH
//     else:
//       - io_digitalwrite 13 LOW
//   - time_delay 1000
// \`\`\`

// **示例4 - 带回调的块**：
// \`\`\`yaml
// setup:
//   - mqtt_connect broker="192.168.1.1" port=1883:
//       on_connect:
//         - mqtt_subscribe "sensor/data"
//       on_message:
//         - serial_println Serial $payload

// loop:
//   - mqtt_loop
//   - time_delay 100
// \`\`\`

// **常用块类型**：
// | 块类型 | 参数 | 说明 |
// |--------|------|------|
// | serial_begin | Serial 波特率 | 初始化串口 |
// | serial_println | Serial 内容 | 串口打印 |
// | dht_init | 变量名 类型 引脚 | 初始化 DHT |
// | dht_read_temperature | 变量名 | 读取温度 |
// | io_digitalwrite | 引脚 状态 | 数字输出 |
// | io_digitalread | 引脚 | 数字输入 |
// | time_delay | 毫秒 | 延时 |

// **操作符**：
// - 比较: \`==\`, \`!=\`, \`<\`, \`>\`, \`<=\`, \`>=\`
// - 逻辑: \`&&\`, \`||\`, \`and\`, \`or\`

// **优势**：
// - 📉 体积比 JSON 减少 75%
// - ✅ 无需管理 ID 和连接
// - ✅ 顺序书写 = 顺序执行
// - ✅ 接近自然语言`,
//         input_schema: {
//             type: 'object',
//             properties: {
//                 code: {
//                     type: 'string',
//                     description: 'YAML-Like DSL 代码'
//                 }
//             },
//             required: ['code']
//         }
    // },
    // {
    //     name: 'arduino_syntax_check',
    //     description: `检查Arduino代码的语法正确性。用于验证生成的Arduino代码是否有语法错误，特别是检测未声明的变量。`,
    //     input_schema: {
    //         type: 'object',
    //         properties: {
    //             code: {
    //                 type: 'string',
    //                 description: 'Arduino C++代码内容'
    //             },
    //             timeout: {
    //                 type: 'number',
    //                 default: 3000,
    //                 description: '检查超时时间（毫秒）'
    //             },
    //             enableWarnings: {
    //                 type: 'boolean',
    //                 default: true,
    //                 description: '是否启用警告检查'
    //             }
    //         },
    //         required: ['code']
    //     }
    // }
]
