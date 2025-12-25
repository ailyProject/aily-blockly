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
        description: `读取指定文件的内容。支持完整读取或按行/字节范围读取，自动处理大文件。

**读取模式：**
1. **完整读取**（默认）：读取整个文件（文件需小于 maxSize）
2. **按行范围读取**：指定起始行号和行数（行号从1开始）
3. **按字节范围读取**：指定起始字节位置和字节数（推荐用于大文件，优先级最高）

**大文件处理：**
- 默认限制 1MB，超过限制需指定范围读取或增加 maxSize
- 检测到超长行会发出警告
- 字节范围读取使用流式读取，不会一次性加载整个文件

**使用场景：**
- 小文件（<1MB）：直接完整读取
- 大文件：使用字节范围读取 (startByte + byteCount)
- 已知行号：使用行范围读取 (startLine + lineCount)
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
        description: `专门用于搜索开发板(boards.json)和库(libraries.json)的高效工具。

**使用场景：**
1. 查找特定功能的库（如"温度传感器"、"舵机"、"OLED"）
2. 查找支持特定芯片的开发板（如"esp32"、"arduino"）
3. 查找作者或品牌相关的硬件（如"adafruit"、"seeed"）

**注意：**
- 返回结果默认限制在前50条最相关匹配
- 使用此工具而非通用grep工具可以获得更精确、更快速的结果
- 多关键词搜索时，匹配任一关键词即可返回结果（OR逻辑）

**示例：**
查找 ESP32 开发板：
\`\`\`json
{
  "query": "esp32",
  "type": "boards"
}
\`\`\`

查找舵机控制库：
\`\`\`json
{
  "query": "servo",
  "type": "libraries"
}
\`\`\``,
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'array',
                    items: {
                        type: 'string'
                    },
                    description: '搜索关键词数组。例如：["esp32", "wifi"], ["temperature", "sensor"]'
                },
                type: {
                    type: 'string',
                    enum: ['boards', 'libraries'],
                    description: '搜索类型：boards(仅开发板), libraries(仅库)。默认为 boards',
                    default: 'boards'
                },
                maxResults: {
                    type: 'number',
                    description: '最大返回结果数，默认50',
                    default: 50
                }
            },
            required: ['query']
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
    {
        name: "smart_block_tool",
        description: `智能块创建、配置Blockly工作区中的块。<system-reminder>使用工具前必须确保已经读取了将要使用的block所属库的Readme</system-reminder>。
基本语法:
基本语法
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
        description: `块连接工具。连接两个及以上Blockly块，支持三种连接类型：next（顺序连接）、input（输入连接）、statement（语句连接）。

⚠️ **重要**：连接语义说明
- containerBlock: **容器块/父块** (提供连接点的块，如arduino_setup、if_else、repeat等)
- contentBlock: **内容块/子块** (要被连接的块，如digital_write、delay等)
- 例如：将digital_write放入arduino_setup中
  - containerBlock: "arduino_setup_id0" (容器)  
  - contentBlock: "digital_write_id1" (内容)
  - connectionType: "statement"
  - inputName: "input_statement"

常见错误：不要混淆容器和内容的关系！`,
        input_schema: {
            type: 'object',
            properties: {
                containerBlock: {
                    type: 'string',
                    description: '🔳 容器块ID（父块，提供连接点的块，如arduino_setup、if_else、repeat等容器类型块）'
                },
                contentBlock: {
                    type: 'string', 
                    description: '📦 内容块ID（子块，要被放入容器的块，如digital_write、delay、sensor_read等功能块）'
                },
                connectionType: {
                    type: 'string',
                    enum: ['next', 'input', 'statement'],
                    description: '连接类型：statement=语句连接（推荐，用于将功能块放入容器块），input=输入连接（用于参数值），next=顺序连接（用于按顺序排列）'
                },
                inputName: {
                    type: 'string',
                    description: '输入端口名称（statement连接时指定容器的哪个端口，如"input_statement"、"DO"、"ELSE"等，不指定时自动检测）'
                }
            },
            required: ['containerBlock', 'contentBlock', 'connectionType']
        }
    },
    {
        name: "create_code_structure_tool", 
        description: `动态结构创建工具，使用动态结构处理器创建任意复杂的代码块结构，支持自定义块组合和连接规则。
注意事项:
- 使用工具前必须确保已经读取了使用的block所属库的Readme
- 建议分步生成代码，如：全局变量-初始化-loop-回调函数。
- 不要一次性生成超过10个block的代码块结构。

基本语法:
\`\`\`json
{
  "structure": "结构名称",
  "config": {
    "structureDefinition": {
      "rootBlock": {...},
      "additionalBlocks": [...],
      "connectionRules": [...]
    }
  },
  "insertPosition": "workspace", // 插入位置类型（"workspace" | "after" | "before" | "input" | "statement" | "append"）
  "targetBlock": "容器块ID", // 目标容器块ID（当 insertPosition 不为 "workspace" 时必需）
  "targetInput": "目标输入名称", // 目标输入名称（当 insertPosition 为 "input" 或 "statement" 时可选）
  "position": {"x": 100, "y": 100} // 坐标位置（当 insertPosition 为 "workspace" 时使用）

}
\`\`\`
示例:
添加到Arduino Setup
\`\`\`json
{
  "structure": "init-code",
  "config": {
    "structureDefinition": {
      "rootBlock": {
        "type": "serial_begin",
        "id": "serial_init",
        "fields": {"SERIAL": "Serial", "SPEED": "9600"}
      },
      "additionalBlocks": [
        {
          "type": "base_pin_mode",
          "id": "pin_setup",
          "inputs": {
            "PIN": {"block": {"type": "math_number", "fields": {"NUM": "13"}}},
            "MODE": {"block": {"type": "base_pin_mode_option", "fields": {"MODE": "OUTPUT"}}}
          }
        }
      ],
      "connectionRules": [
        {
          "source": "serial_init",
          "target": "pin_setup",
          "connectionType": "next"
        }
      ]
    }
  },
  "insertPosition": "statement",
  "targetBlock": "arduino_setup_id"
}
\`\`\`
`,
        input_schema: {
            type: 'object',
            properties: {
                structure: {
                    type: 'string',
                    description: '结构名称（任意字符串，用于日志和元数据）'
                },
                config: {
                    type: 'object',
                    properties: {
                        structureDefinition: {
                            type: 'object',
                            properties: {
                                rootBlock: {
                                    type: 'object',
                                    description: '根块配置'
                                },
                                additionalBlocks: {
                                    type: 'array',
                                    items: { type: 'object' },
                                    description: '附加块配置数组'
                                },
                                connectionRules: {
                                    type: 'array',
                                    items: {
                                        type: 'object',
                                        properties: {
                                            source: { type: 'string', description: '输出块引用' },
                                            target: { type: 'string', description: '接收块引用' },
                                            inputName: { type: 'string', description: '接收块的输入名称' },
                                            connectionType: { 
                                                type: 'string', 
                                                enum: ['next', 'input', 'statement'],
                                                description: '连接类型' 
                                            }
                                        },
                                        required: ['source', 'target']
                                    },
                                    description: '块连接规则'
                                }
                            },
                            required: ['rootBlock'],
                            description: '动态结构定义'
                        }
                    },
                    required: ['structureDefinition'],
                    description: '结构配置'
                },
                position: {
                    type: 'object',
                    properties: {
                        x: { type: 'number', description: 'X坐标' },
                        y: { type: 'number', description: 'Y坐标' }
                    },
                    description: '结构在工作区中的位置'
                },
                insertPosition: {
                    type: 'string',
                    enum: ['workspace', 'after', 'before', 'input', 'statement', 'append'],
                    description: '插入位置：workspace=独立放置，after=目标块后，before=目标块前，input=目标块输入，statement=statement连接（用于hat块），append=追加到工作区'
                },
                targetBlock: {
                    type: 'string',
                    description: '目标容器块ID（当insertPosition不是workspace时必需）'
                },
                targetInput: {
                    type: 'string',
                    description: '目标输入名（当insertPosition是input时必需）'
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
        description: `块删除工具，如果使用connect_blocks_tool重新连接能解决则优先使用块连接工具。通过块ID删除工作区中的指定块。支持两种删除模式：普通删除（只删除指定块，保留连接的块，推荐使用）和级联删除（删除整个块树，包括所有连接的子块）。`,
        input_schema: {
            type: 'object',
            properties: {
                blockId: {
                    type: 'string',
                    description: '要删除的块的ID'
                },
                cascade: {
                    type: 'boolean',
                    description: '是否级联删除连接的块。false=只删除指定块，true=删除整个块树',
                    default: false
                }
            },
            required: ['blockId']
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
        description: `分析指定库的块定义和使用模式，在库对应的readme不存在或者描述不准确的情况下使用这个工具来补充和完善库的文档说明。深入解析库文件，提取块定义、生成器逻辑、工具箱配置等信息，生成完整的库知识图谱。`,
        input_schema: {
            type: 'object',
            properties: {
                libraryNames: {
                    type: 'array',
                    items: { type: 'string' },
                    description: '要分析的库名称列表，如 ["@aily-project/lib-blinker", "@aily-project/lib-sensor"]'
                },
                analysisDepth: {
                    type: 'string',
                    enum: ['basic', 'detailed', 'full'],
                    default: 'detailed',
                    description: '分析深度：basic(基本信息)、detailed(详细信息)、full(完整关系图)'
                },
                includeExamples: {
                    type: 'boolean',
                    default: true,
                    description: '是否包含使用示例'
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
    }
]
