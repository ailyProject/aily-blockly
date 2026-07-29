import { MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE } from '../core/agent-identifiers';

export const WORKSPACE_TOOL_DEFINITIONS = [
    {
        name: 'read_file',
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
- **不要读取命令输出路径**：如果其他工具返回了 processId、outputSessionId 或 outputFilePath，请改用 command_status / command_tail / command_read / command_search，或在项目日志场景使用 log_tool

**注意：**
- 行号从 1 开始计数
- 字节位置从 0 开始计数
- 字节范围读取优先级最高
- 不要把终端输出文件或瞬时 \`.log\` 路径当作普通源码/文档文件交给本工具`,
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
        },
        agents: [MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE]
    },
    {
        name: 'create_file',
        description: '创建新文件并写入内容，需文件完整路径。如果目录不存在会自动创建。可选择是否覆盖已存在的文件。',
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
        },
        agents: [MAIN_AGENT_TYPE]
    },
    {
        name: 'create_folder',
        description: '创建新文件夹。支持递归创建多级目录。',
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
        },
        agents: [MAIN_AGENT_TYPE]
    },
    {
        name: 'edit_file',
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
        },
        agents: [MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE]
    },
    {
        name: 'replace_string_in_file',
        description: `精确替换文件中的一段字符串。要求 old_string 在文件中唯一匹配（不允许多个匹配，确保精确修改）。

这是编辑文件最安全的方式：
- 自动检测并拒绝多匹配（防止意外修改错误位置）
- 建议在 old_string 中包含 3-5 行上下文以确保唯一性
- 当 old_string 为空时，创建新文件并写入 new_string
- 自动 lint 检测（JSON/JS 文件）

适合场景：单个小改动、修改函数、修复 bug、调整配置项`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要编辑的文件路径'
                },
                old_string: {
                    type: 'string',
                    description: '要替换的原字符串。必须在文件中唯一匹配，建议包含 3-5 行上下文。为空时创建新文件'
                },
                new_string: {
                    type: 'string',
                    description: '替换后的新字符串'
                }
            },
            required: ['path', 'old_string', 'new_string']
        },
        agents: [MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE]
    },
    {
        name: 'multi_replace_string_in_file',
        description: `批量精确替换 — 在一次调用中对一个或多个文件执行多次字符串替换。每个替换操作按顺序执行。

适合场景：
- 需要同时修改多个文件
- 一个文件中需要修改多处不同位置
- 重构操作（如重命名变量、更新导入路径）

每个替换等同于单独调用 replace_string_in_file，均要求唯一匹配。
最多支持 50 个替换操作。`,
        input_schema: {
            type: 'object',
            properties: {
                replacements: {
                    type: 'array',
                    description: '替换操作列表',
                    items: {
                        type: 'object',
                        properties: {
                            path: { type: 'string', description: '文件路径' },
                            old_string: { type: 'string', description: '要替换的原字符串' },
                            new_string: { type: 'string', description: '替换后的新字符串' }
                        },
                        required: ['path', 'old_string', 'new_string']
                    }
                }
            },
            required: ['replacements']
        },
        agents: [MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE]
    },
    {
        name: 'delete_file',
        description: '删除指定文件。可选择是否在删除前创建备份。',
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
        },
        agents: [MAIN_AGENT_TYPE, SCHEMATIC_AGENT_TYPE]
    },
];
