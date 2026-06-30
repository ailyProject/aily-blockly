export const PROJECT_RUNTIME_TOOL_DEFINITIONS = [
    {
        name: 'build_project',
        description: `编译当前项目，检测代码是否能正常编译通过。用于代码编写完成后验证语法和链接是否正确。编译耗时较长（可能数十秒到数分钟），请仅在需要验证时调用。

如果编译出现异常（如缓存损坏、切换开发板后残留旧缓存），可设置 clear_cache=true 在编译前清除缓存。`,
        input_schema: {
            type: 'object',
            properties: {
                preprocess_only: {
                    type: 'boolean',
                    description: '是否仅做预编译检查（更快但不生成完整产物，且为异步操作不会返回编译结果）',
                    default: false
                },
                clear_cache: {
                    type: 'boolean',
                    description: '编译前是否清除编译缓存（解决缓存损坏或切换开发板后的残留问题）',
                    default: false
                }
            },
            required: []
        },
        agents: ["mainAgent"]
    },
    {
        name: 'reload_project',
        description: `重新加载当前项目。在修改了库相关的JS文件（如块定义、生成器等）后调用，使修改生效。会先保存项目再重新加载。`,
        input_schema: {
            type: 'object',
            properties: {},
            required: []
        },
        agents: ["mainAgent"]
    },
    {
        name: 'switch_board',
        description: `在当前项目中切换开发板。需要提供新的开发板包名称（如 "@aily-project/board-esp32_devkitc"）。
切换过程会自动卸载当前开发板包、安装新开发板包、更新项目配置并重新加载项目。

注意：
- 切换开发板会重置编译缓存
- 项目中非开发板相关的依赖库会被保留
- 如果不确定开发板名称，可先使用 search_boards_libraries 工具搜索`,
        input_schema: {
            type: 'object',
            properties: {
                board_name: {
                    type: 'string',
                    description: '开发板包名称，如 "@aily-project/board-esp32_devkitc"、"@aily-project/board-arduino_uno"'
                },
                board_version: {
                    type: 'string',
                    description: '开发板包版本号（可选，不指定则使用最新版）'
                }
            },
            required: ['board_name']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'get_board_config',
        description: `获取当前开发板的编译/烧录配置选项及其当前值。

返回信息包括：
- 当前开发板名称和类型
- 所有可配置项及其可选值（如上传速度、Flash模式、Flash大小、分区方案等）
- 每个配置项的当前选中值

支持的开发板配置：
- **ESP32**: 上传速度(UploadSpeed)、上传模式(UploadMode)、Flash模式(FlashMode)、Flash大小(FlashSize)、分区方案(PartitionScheme)、CDC启动(CDCOnBoot)、PSRAM
- **STM32**: 开发板型号(pnum)、USB配置(usb)
- **nRF5**: SoftDevice

如果当前开发板没有额外配置选项（如 Arduino UNO），会返回空列表。`,
        input_schema: {
            type: 'object',
            properties: {},
            required: []
        },
        agents: ["mainAgent"]
    },
    {
        name: 'set_board_config',
        description: `修改当前开发板的编译/烧录配置项。需先通过 get_board_config 工具获取可用的配置项和可选值。

使用方式：
1. 先调用 get_board_config 获取当前配置和可选值
2. 根据返回的 config_key 和 options 中的 value，调用此工具设置

示例：
- 设置ESP32上传速度: set_board_config({ config_key: "UploadSpeed", config_value: "921600" })
- 设置Flash大小: set_board_config({ config_key: "FlashSize", config_value: "16M" })
- 设置分区方案: set_board_config({ config_key: "PartitionScheme", config_value: "default" })

注意：配置变更后会自动触发预编译检查。`,
        input_schema: {
            type: 'object',
            properties: {
                config_key: {
                    type: 'string',
                    description: '配置项键名（从 get_board_config 返回的 config_key），如 UploadSpeed, FlashMode, FlashSize, PartitionScheme 等'
                },
                config_value: {
                    type: 'string',
                    description: '配置项的值（从 get_board_config 返回的 options 中的 value），如 "921600", "qio", "16M"'
                }
            },
            required: ['config_key', 'config_value']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'memory',
        description: `持久化记忆工具 — 管理 /memories 下的用户、会话和仓库记忆文件。

三层作用域：
- **/memories/**: 用户级记忆，跨工作区与会话持久化。
- **/memories/session/**: 当前会话记忆，仅作用于当前对话。
- **/memories/repo/**: 当前仓库记忆，记录项目约定、结构与已验证事实。

支持的操作：view/create/str_replace/insert/delete/rename。

不要把 instruction 文件或项目根 aily.md 当成 memory tool 的存储位置。`,
        input_schema: {
            type: 'object',
            properties: {
                command: {
                    type: 'string',
                    enum: ['view', 'create', 'str_replace', 'insert', 'delete', 'rename'],
                    description: '操作命令: view=查看, create=创建, str_replace=精确替换, insert=按行插入, delete=删除, rename=重命名'
                },
                path: {
                    type: 'string',
                    description: 'memory 路径，必须使用 /memories/* 语义，例如 /memories/debugging.md、/memories/session/plan.md、/memories/repo/project-rules.md'
                },
                file_text: {
                    type: 'string',
                    description: 'create 时写入的新文件内容'
                },
                view_range: {
                    type: 'array',
                    description: 'view 文件时可选的 1-based [startLine, endLine] 行范围',
                    items: { type: 'number' },
                    minItems: 2,
                    maxItems: 2
                },
                old_str: {
                    type: 'string',
                    description: 'str_replace 时要精确匹配一次的旧文本'
                },
                new_str: {
                    type: 'string',
                    description: 'str_replace 时的新文本'
                },
                insert_line: {
                    type: 'number',
                    description: 'insert 时的 0-based 行号；0 表示插入到文件开头'
                },
                insert_text: {
                    type: 'string',
                    description: 'insert 时要插入的文本'
                },
                old_path: {
                    type: 'string',
                    description: 'rename 时的原始 memory 路径'
                },
                new_path: {
                    type: 'string',
                    description: 'rename 时的新 memory 路径；禁止跨 scope 重命名'
                }
            },
            required: ['command']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'resolve_memory_file_uri',
        description: `将 /memories 路径解析为当前用户、会话或仓库记忆在本机上的真实文件 URI。

    仅用于把 /memories/* 逻辑路径映射到真实文件 URI；它不读取或修改文件内容。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '必须以 /memories/ 开头的 memory 路径，例如 /memories/session/plan.md 或 /memories/repo/project-rules.md'
                }
            },
            required: ['path']
        },
        agents: ["mainAgent"]
    },
    {
        name: 'get_errors',
        description: `获取当前项目或指定文件的错误诊断信息。整合 lint 错误和编译错误，一次性返回所有已知问题。

数据来源：
1. **Lint 错误**: JSON/JS 文件的语法检查
2. **编译错误**: 上次 build_project 的编译结果

适合场景：
- 编辑文件后快速检查是否引入错误
- 编译失败后分析具体错误原因
- 修复错误前先了解全部问题再一次性修复

注意：编译错误来自上次 build_project 的缓存结果，如果代码已修改建议重新编译。`,
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: '要检查的文件路径（可选，不指定则检查整个项目关键文件）'
                },
                include_lint: {
                    type: 'boolean',
                    description: '是否包含 lint 错误',
                    default: true
                },
                include_build: {
                    type: 'boolean',
                    description: '是否包含上次编译错误',
                    default: true
                }
            },
            required: []
        },
        agents: ["mainAgent"]
    },
];
