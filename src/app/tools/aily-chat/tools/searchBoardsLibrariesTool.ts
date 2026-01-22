import { injectTodoReminder } from "./todoWriteTool";
import { ConfigService } from '../../../services/config.service';

// ==================== 新索引格式接口（boards-index.json / libraries-index.json）====================
interface NewBoardItem {
    name: string;
    displayName: string;
    brand: string;
    type: 'board' | 'series';
    mcu?: string;
    architecture: string;
    cores: number;
    frequency: number;
    frequencyUnit: string;
    flash: number;
    sram: number;
    psram: number;
    connectivity: string[];
    interfaces: string[];
    gpio?: {
        digital: number;
        analog: number;
        pwm: number;
    };
    voltage: number;
    core: string;
    features?: string[];
    tags: string[];
    keywords?: string[];
    description?: string;
    [key: string]: any;
}

interface NewLibraryItem {
    name: string;
    displayName: string;
    category: string;
    subcategory?: string;
    supportedCores: string[];
    communication: string[];
    voltage: number[];
    hardwareType: string[];
    compatibleHardware: string[];
    functions?: string[];
    tags: string[];
    keywords?: string[];
    description?: string;
    author?: string;
    [key: string]: any;
}

// ==================== 旧索引格式接口（boards.json / libraries.json）====================
interface OldBoardItem {
    name: string;
    nickname?: string;
    description?: string;
    keywords?: string[];
    brand?: string;
    type?: string;
}

interface OldLibraryItem {
    name: string;
    nickname?: string;
    description?: string;
    keywords?: string[];
    author?: string;
    compatibility?: {
        core?: string[];
    };
}

// ==================== 通用类型 ====================
type BoardItem = NewBoardItem | OldBoardItem;
type LibraryItem = NewLibraryItem | OldLibraryItem;

interface StructuredFilters {
    // 通用文本搜索（兼容旧格式）
    keywords?: string | string[];
    
    // 开发板筛选
    flash?: string;
    sram?: string;
    frequency?: string;
    cores?: string;
    architecture?: string;
    connectivity?: string[];
    interfaces?: string[];
    brand?: string;
    voltage?: string;
    
    // 库筛选
    category?: string;
    hardwareType?: string[];
    supportedCores?: string[];
    communication?: string[];
}

// ==================== 格式检测工具 ====================
/**
 * 检测是否为新格式的开发板数据
 */
function isNewBoardFormat(item: any): item is NewBoardItem {
    return item && 
           typeof item.displayName === 'string' && 
           typeof item.architecture === 'string' &&
           typeof item.flash === 'number' &&
           Array.isArray(item.connectivity);
}

/**
 * 检测是否为新格式的库数据
 */
function isNewLibraryFormat(item: any): item is NewLibraryItem {
    return item && 
           typeof item.displayName === 'string' && 
           typeof item.category === 'string' &&
           Array.isArray(item.supportedCores) &&
           Array.isArray(item.communication);
}

/**
 * 检测数组是否为新格式
 */
function detectDataFormat(items: any[]): 'new' | 'old' {
    if (!items || items.length === 0) return 'old';
    const sample = items[0];
    // 新格式有 displayName 和结构化字段
    if (sample.displayName && (sample.architecture || sample.category)) {
        return 'new';
    }
    // 旧格式有 nickname
    if (sample.nickname !== undefined) {
        return 'old';
    }
    return 'old';
}

/**
 * 搜索开发板和库工具 - 支持结构化索引的高级搜索
 * 
 * 基于新的 boards-index.json 和 libraries-index.json 格式，支持：
 * - 文本模糊搜索（keywords > displayName > description > tags）
 * - 结构化精确筛选（硬件规格、接口、分类等）
 * - 数值范围查询（Flash、SRAM、频率等）
 * - 多条件组合查询（AND/OR逻辑）
 * 
 * @example
 * // 简单文本搜索
 * searchBoardsLibraries({ query: "温度传感器" })
 * 
 * // 结构化查询：Flash>4MB且支持WiFi和摄像头的ESP32开发板
 * searchBoardsLibraries({ 
 *   type: "boards",
 *   filters: { flash: ">4096", connectivity: ["wifi"], interfaces: ["camera"], architecture: "xtensa-lx7" }
 * })
 * 
 * // 库查询：支持ESP32的I2C温度传感器库
 * searchBoardsLibraries({
 *   type: "libraries",
 *   filters: { category: "sensor", hardwareType: ["temperature"], communication: ["i2c"], supportedCores: ["esp32:esp32"] }
 * })
 */
export const searchBoardsLibrariesTool = {
    name: 'search_boards_libraries',
    description: `专门用于搜索开发板和库的增强型工具，支持结构化查询和文本搜索。

**🔥 新功能 - 结构化筛选：**
- ✅ 硬件规格数值比较（Flash>4MB、频率>100MHz、SRAM>=512KB）
- ✅ 接口/连接方式精确匹配（WiFi、BLE、I2C、SPI、Camera等）
- ✅ 分类体系筛选（传感器类型、通信协议、支持内核）
- ✅ 多条件组合（同时满足多个条件）

**📋 文本搜索（保留）：**
- ✅ 支持多关键词（数组或逗号分隔）
- ✅ 智能分词和模糊匹配
- ✅ 按匹配度排序

**使用场景示例：**

1️⃣ **简单搜索**（文本模糊匹配）
   - "esp32 wifi" - 查找ESP32 WiFi相关
   - "温度传感器" - 查找温度传感器库

2️⃣ **精确硬件查询**（开发板）
   - Flash>4MB且支持WiFi: filters: { flash: ">4096", connectivity: ["wifi"] }
   - 双核ESP32: filters: { architecture: "xtensa-lx7", cores: ">=2" }
   - 带摄像头接口: filters: { interfaces: ["camera"] }

3️⃣ **库精确查询**
   - I2C温度传感器: filters: { category: "sensor", hardwareType: ["temperature"], communication: ["i2c"] }
   - ESP32可用PWM库: filters: { supportedCores: ["esp32:esp32"], communication: ["pwm"] }

**数值比较语法：**
- ">4096" (大于4096)
- ">=1024" (大于等于1024)
- "<512" (小于512)
- "240" (等于240)

**注意：**
- filters 参数优先级高于 query（结构化查询更精确）
- 可以同时使用 query 和 filters 组合查询
- 返回结果默认限制在前50条最相关匹配`,
    
    parameters: {
        type: 'object',
        properties: {
            query: {
                oneOf: [
                    {
                        type: 'string',
                        description: '文本搜索关键词，支持中英文。可以是单个关键词或逗号/空格分隔的多个关键词。例如：esp32, "温度传感器, 湿度", "servo OLED"'
                    },
                    {
                        type: 'array',
                        items: {
                            type: 'string'
                        },
                        description: '搜索关键词数组。例如：["esp32", "wifi"], ["temperature", "sensor"]'
                    }
                ],
                description: '文本搜索关键词。支持字符串（单个或逗号/空格分隔）或字符串数组。忽略大小写，支持模糊匹配。'
            },
            type: {
                type: 'string',
                enum: ['boards', 'libraries', 'both'],
                description: '搜索类型：boards(仅开发板), libraries(仅库), both(同时搜索)。默认为 both'
            },
            filters: {
                type: 'object',
                description: '筛选条件（支持文本搜索和结构化查询）',
                properties: {
                    // 通用文本搜索
                    keywords: {
                        oneOf: [
                            { type: 'string', description: '搜索关键词，空格分隔多个词' },
                            { type: 'array', items: { type: 'string' }, description: '搜索关键词数组' }
                        ],
                        description: '文本搜索关键词（兼容旧格式）。例如: "wifi esp32" 或 ["wifi", "esp32", "arduino"]'
                    },
                    // 开发板筛选
                    flash: {
                        type: 'string',
                        description: 'Flash大小筛选(KB)。支持: ">4096", ">=1024", "<512", "256"'
                    },
                    sram: {
                        type: 'string',
                        description: 'SRAM大小筛选(KB)。支持: ">512", ">=256", "<128"'
                    },
                    frequency: {
                        type: 'string',
                        description: '主频筛选(MHz)。支持: ">100", ">=240", "16"'
                    },
                    cores: {
                        type: 'string',
                        description: '核心数筛选。支持: ">=2", "1"'
                    },
                    architecture: {
                        type: 'string',
                        description: '架构筛选。例如: "xtensa-lx7", "avr", "arm-cortex-m4"'
                    },
                    connectivity: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '连接方式数组（AND逻辑）。例如: ["wifi", "ble"]'
                    },
                    interfaces: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '接口数组（AND逻辑）。例如: ["i2c", "spi", "camera"]'
                    },
                    brand: {
                        type: 'string',
                        description: '品牌筛选。例如: "Arduino", "Espressif", "OpenJumper"'
                    },
                    voltage: {
                        type: 'string',
                        description: '工作电压筛选。例如: "3.3", "5"'
                    },
                    // 库筛选
                    category: {
                        type: 'string',
                        description: '库分类筛选。例如: "sensor", "motor", "display", "communication"'
                    },
                    hardwareType: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '硬件类型数组（OR逻辑）。例如: ["temperature", "humidity"]'
                    },
                    supportedCores: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '支持内核数组（OR逻辑）。例如: ["esp32:esp32", "arduino:avr"]'
                    },
                    communication: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '通信协议数组（AND逻辑）。例如: ["i2c"], ["spi", "gpio"]'
                    }
                }
            },
            maxResults: {
                type: 'number',
                description: '最大返回结果数，默认50'
            }
        },
        required: []
    },
    
    handler: async (
        params: { 
            query?: string | string[]; 
            type?: 'boards' | 'libraries' | 'both';
            filters?: StructuredFilters | string;
            maxResults?: number;
        },
        configService: ConfigService
    ) => {
        const { query, type = 'both', maxResults = 50 } = params;
        
        // 处理 filters 参数：可能是字符串（LLM 传入的 JSON 字符串）或对象
        let filters: StructuredFilters | undefined = undefined;
        if (params.filters) {
            if (typeof params.filters === 'string') {
                // 尝试解析 JSON 字符串
                const trimmed = params.filters.trim();
                if (trimmed && trimmed !== '{}' && trimmed !== 'null' && trimmed !== 'undefined') {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed && typeof parsed === 'object' && Object.keys(parsed).length > 0) {
                            filters = parsed as StructuredFilters;
                        }
                    } catch (e) {
                        console.warn('Failed to parse filters string:', trimmed);
                    }
                }
            } else if (typeof params.filters === 'object' && Object.keys(params.filters).length > 0) {
                filters = params.filters as StructuredFilters;
            }
        }
        
        // 处理文本查询参数（来源：query 参数 或 filters.keywords）
        let queryList: string[] = [];
        
        // 辅助函数：解析关键词（字符串或数组）
        const parseKeywords = (input: string | string[]): string[] => {
            if (Array.isArray(input)) {
                return input.map(q => String(q).trim()).filter(q => q);
            }
            if (typeof input === 'string') {
                const trimmed = input.trim();
                if (trimmed.length === 0) return [];
                
                // 尝试解析 JSON 数组字符串
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (Array.isArray(parsed)) {
                            return parsed.map(q => String(q).trim()).filter(q => q);
                        }
                    } catch {
                        // JSON 解析失败，当作普通字符串处理
                    }
                }
                
                // 按分隔符拆分
                return trimmed.split(/[,，]/).flatMap(part => 
                    part.trim().split(/\s+/)
                ).filter(q => q);
            }
            return [];
        };
        
        // 优先从 filters.keywords 获取关键词（推荐方式）
        if (filters?.keywords) {
            queryList = parseKeywords(filters.keywords);
        }
        
        // 如果 filters.keywords 为空，再从 query 参数获取（兼容旧方式）
        if (queryList.length === 0 && query) {
            queryList = parseKeywords(query);
        }
        
        // 验证：至少需要 keywords 或其他筛选条件之一
        const hasOtherFilters = filters && Object.keys(filters).some(k => k !== 'keywords' && filters[k as keyof StructuredFilters]);
        if (queryList.length === 0 && !hasOtherFilters) {
            const toolResult = {
                is_error: true,
                content: '请提供搜索关键词(filters.keywords)或筛选条件(filters.*)'
            };
            return injectTodoReminder(toolResult, 'search_boards_libraries');
        }
        
        // 转换为小写用于匹配
        const queryListLower = queryList.map(q => q.toLowerCase());

        let results: Array<{
            source: 'board' | 'library';
            name: string;
            displayName: string;
            description: string;
            score: number;
            matchedFields: string[];
            matchedQueries: string[];
            metadata?: any;
        }> = [];
        
        let dataFormat: 'new' | 'old' = 'old';

        try {
            // 搜索开发板
            if (type === 'boards' || type === 'both') {
                // 优先使用新格式索引 (boardIndex)，不存在则降级到旧格式 (boardList)
                const newBoardsData = configService.boardIndex;
                const oldBoardsData = configService.boardList;
                
                if (newBoardsData && newBoardsData.length > 0) {
                    // 使用新格式搜索（支持结构化筛选）
                    dataFormat = 'new';
                    results.push(...searchInNewBoards(newBoardsData as NewBoardItem[], queryListLower, filters, oldBoardsData as OldBoardItem[]));
                } else if (oldBoardsData && oldBoardsData.length > 0) {
                    // 降级到旧格式搜索（将 filters 转换为文本搜索）
                    const fallbackQueries = convertFiltersToQueries(filters, 'boards');
                    const combinedQueries = [...queryListLower, ...fallbackQueries];
                    results.push(...searchInOldBoards(oldBoardsData as OldBoardItem[], combinedQueries));
                }
            }

            // 搜索库
            if (type === 'libraries' || type === 'both') {
                // 优先使用新格式索引 (libraryIndex)，不存在则降级到旧格式 (libraryList)
                const newLibrariesData = configService.libraryIndex;
                const oldLibrariesData = configService.libraryList;
                
                // 调试日志
                console.log('[SearchTool] 库搜索数据源诊断:', {
                    newLibrariesData_length: newLibrariesData?.length || 0,
                    oldLibrariesData_length: oldLibrariesData?.length || 0,
                    newLibrariesData_sample: newLibrariesData?.[0] ? {
                        name: newLibrariesData[0].name,
                        displayName: newLibrariesData[0].displayName,
                        category: newLibrariesData[0].category,
                    } : null
                });
                
                if (newLibrariesData && newLibrariesData.length > 0) {
                    // 使用新格式搜索（支持结构化筛选）
                    console.log('[SearchTool] ✅ 使用新格式搜索库');
                    dataFormat = 'new';
                    results.push(...searchInNewLibraries(newLibrariesData as NewLibraryItem[], queryListLower, filters, oldLibrariesData as OldLibraryItem[]));
                } else if (oldLibrariesData && oldLibrariesData.length > 0) {
                    // 降级到旧格式搜索（将 filters 转换为文本搜索）
                    console.log('[SearchTool] ⚠️ 降级到旧格式搜索库');
                    const fallbackQueries = convertFiltersToQueries(filters, 'libraries');
                    const combinedQueries = [...queryListLower, ...fallbackQueries];
                    results.push(...searchInOldLibraries(oldLibrariesData as OldLibraryItem[], combinedQueries));
                }
            }

            // 按分数排序并限制结果数
            results.sort((a, b) => b.score - a.score);
            results = results.slice(0, maxResults);

            if (results.length === 0) {
                const queryDisplay = queryList.length > 0 ? queryList.join(', ') : '结构化筛选';
                let hint = '建议：尝试使用更通用的关键词或调整筛选条件';
                if (dataFormat === 'old' && filters) {
                    hint = '⚠️ 当前使用旧格式数据，结构化筛选已转换为文本搜索。建议升级到新索引格式以获得精确匹配。';
                }
                const toolResult = {
                    is_error: false,
                    content: `未找到与 "${queryDisplay}" 匹配的结果\n\n搜索范围: ${type === 'both' ? '开发板和库' : type === 'boards' ? '开发板' : '库'}\n${hint}`
                };
                return injectTodoReminder(toolResult, 'search_boards_libraries');
            }

            // 格式化输出
            const queryDisplay = queryList.length > 0 ? `关键词: "${queryList.join(', ')}"` : '结构化筛选';
            const filterDisplay = filters ? `\n筛选条件: ${JSON.stringify(filters, null, 2)}` : '';
            const formatNotice = dataFormat === 'old' && filters ? '\n⚠️ 注意：使用旧格式数据，结构化筛选已转为文本搜索\n' : '';
            
            let resultContent = `找到 ${results.length} 个匹配项（${queryDisplay}）${filterDisplay}${formatNotice}\n`;
            resultContent += `搜索范围: ${type === 'both' ? '开发板和库' : type === 'boards' ? '开发板' : '库'}\n`;
            resultContent += `数据格式: ${dataFormat === 'new' ? '新索引（结构化）' : '旧索引（文本）'}\n\n`;

            results.forEach((item, index) => {
                resultContent += `[${index + 1}]\n`;
                resultContent += `name: ${item.name}\n`;
                resultContent += `displayName: ${item.displayName}\n`;
                resultContent += `description: ${item.description}\n`;
                
                // 显示关键硬件信息（仅新格式有 metadata）
                if (item.metadata) {
                    if (item.source === 'board' && item.metadata.architecture) {
                        resultContent += `架构: ${item.metadata.architecture}, 主频: ${item.metadata.frequency}${item.metadata.frequencyUnit}\n`;
                        resultContent += `Flash: ${item.metadata.flash}KB, SRAM: ${item.metadata.sram}KB\n`;
                        if (item.metadata.connectivity && item.metadata.connectivity.length > 0) {
                            resultContent += `连接: ${item.metadata.connectivity.join(', ')}\n`;
                        }
                    } else if (item.source === 'library' && item.metadata.category) {
                        resultContent += `分类: ${item.metadata.category}\n`;
                        if (item.metadata.communication && item.metadata.communication.length > 0) {
                            resultContent += `通信: ${item.metadata.communication.join(', ')}\n`;
                        }
                    }
                }
                resultContent += `\n`;
            });

            const toolResult = {
                is_error: false,
                content: resultContent,
                metadata: {
                    totalMatches: results.length,
                    query: queryList,
                    filters: filters,
                    searchType: type,
                    dataFormat: dataFormat,
                    results: results.map(r => ({
                        source: r.source,
                        name: r.name,
                        displayName: r.displayName,
                        description: r.description,
                        matchedQueries: r.matchedQueries,
                        metadata: r.metadata
                    }))
                }
            };
            return injectTodoReminder(toolResult, 'search_boards_libraries');

        } catch (error) {
            const toolResult = {
                is_error: true,
                content: `搜索失败: ${error instanceof Error ? error.message : String(error)}`
            };
            return injectTodoReminder(toolResult, 'search_boards_libraries');
        }
    }
};

// ==================== 工具函数 ====================

/**
 * 将结构化筛选条件转换为文本搜索关键词（用于旧格式降级）
 */
function convertFiltersToQueries(filters: StructuredFilters | undefined, type: 'boards' | 'libraries'): string[] {
    if (!filters) return [];
    
    const queries: string[] = [];
    
    if (type === 'boards') {
        // 开发板筛选转换
        if (filters.architecture) {
            queries.push(filters.architecture.toLowerCase());
            // 常见架构别名
            if (filters.architecture.includes('xtensa')) queries.push('esp32');
            if (filters.architecture === 'avr') queries.push('arduino');
        }
        if (filters.connectivity) {
            queries.push(...filters.connectivity.map(c => c.toLowerCase()));
        }
        if (filters.interfaces) {
            queries.push(...filters.interfaces.map(i => i.toLowerCase()));
        }
        if (filters.brand) {
            queries.push(filters.brand.toLowerCase());
        }
    } else {
        // 库筛选转换
        if (filters.category) {
            queries.push(filters.category.toLowerCase());
        }
        if (filters.hardwareType) {
            queries.push(...filters.hardwareType.map(h => h.toLowerCase()));
        }
        if (filters.communication) {
            queries.push(...filters.communication.map(c => c.toLowerCase()));
        }
        if (filters.supportedCores) {
            // 从 core 字符串中提取关键词
            for (const core of filters.supportedCores) {
                const parts = core.toLowerCase().split(':');
                queries.push(...parts.filter(p => p));
            }
        }
    }
    
    return queries;
}

/**
 * 数值比较函数 - 支持 >, >=, <, <=, =, != 等比较操作符
 * @param value 要比较的数值
 * @param condition 条件字符串（如 ">30"）或条件数组（如 [">30"]）
 */
function compareNumeric(value: number, condition: string | string[]): boolean {
    // 如果 condition 是数组，取第一个元素
    let conditionStr: string;
    if (Array.isArray(condition)) {
        if (condition.length === 0) return true;
        conditionStr = String(condition[0]);
    } else if (typeof condition === 'string') {
        conditionStr = condition;
    } else {
        // 其他类型，尝试转换为字符串
        conditionStr = String(condition);
    }
    
    const match = conditionStr.match(/^([<>=!]+)?(\d+(?:\.\d+)?)$/);
    if (!match) return true;
    
    const [, op, numStr] = match;
    const num = parseFloat(numStr);
    
    switch (op) {
        case '>': return value > num;
        case '>=': return value >= num;
        case '<': return value < num;
        case '<=': return value <= num;
        case '!=': return value !== num;
        case '=':
        case '==':
        default: return value === num;
    }
}

// ==================== 新格式搜索函数 ====================

/**
 * 在新格式开发板数组中搜索匹配项 - 支持文本搜索和结构化筛选
 */
function searchInNewBoards(
    boards: NewBoardItem[], 
    queryList: string[],
    filters?: StructuredFilters,
    oldBoardsData?: OldBoardItem[]
): Array<{
    source: 'board' | 'library';
    name: string;
    displayName: string;
    description: string;
    score: number;
    matchedFields: string[];
    matchedQueries: string[];
    metadata?: any;
}> {
    const results: Array<{
        source: 'board' | 'library';
        name: string;
        displayName: string;
        description: string;
        score: number;
        matchedFields: string[];
        matchedQueries: string[];
        metadata?: any;
    }> = [];

    for (const board of boards) {
        let totalScore = 0;
        const matchedFields: string[] = [];
        const matchedQueries: string[] = [];
        let passedFilters = true;

        // 1. 应用结构化筛选（如果提供）
        if (filters) {
            // Flash 筛选
            if (filters.flash && !compareNumeric(board.flash, filters.flash)) {
                passedFilters = false;
            }
            
            // SRAM 筛选
            if (filters.sram && !compareNumeric(board.sram, filters.sram)) {
                passedFilters = false;
            }
            
            // 频率筛选
            if (filters.frequency && !compareNumeric(board.frequency, filters.frequency)) {
                passedFilters = false;
            }
            
            // 核心数筛选
            if (filters.cores && !compareNumeric(board.cores, filters.cores)) {
                passedFilters = false;
            }
            
            // 架构筛选
            if (filters.architecture && board.architecture !== filters.architecture) {
                passedFilters = false;
            }
            
            // 连接方式筛选（AND逻辑 - 必须全部包含）
            if (filters.connectivity) {
                for (const conn of filters.connectivity) {
                    if (!board.connectivity.includes(conn)) {
                        passedFilters = false;
                        break;
                    }
                }
            }
            
            // 接口筛选（AND逻辑 - 必须全部包含）
            if (filters.interfaces) {
                for (const iface of filters.interfaces) {
                    if (!board.interfaces.includes(iface)) {
                        passedFilters = false;
                        break;
                    }
                }
            }
            
            // 品牌筛选
            if (filters.brand && board.brand.toLowerCase() !== filters.brand.toLowerCase()) {
                passedFilters = false;
            }
            
            // 电压筛选
            if (filters.voltage && board.voltage !== parseFloat(filters.voltage)) {
                passedFilters = false;
            }
            
            if (!passedFilters) {
                continue;
            }
            
            // 结构化筛选通过，加基础分
            totalScore += 50;
            matchedFields.push('structured_filters');
        }

        // 2. 文本关键词匹配（如果提供）
        // 选型器设计：宽泛匹配，返回所有相关选项，让LLM做最终选择
        if (queryList.length > 0) {
            for (const query of queryList) {
                let queryScore = 0;
                let queryMatched = false;

                // 优先级1: keywords（权重: 20）
                if (board.keywords) {
                    for (const keyword of board.keywords) {
                        const keywordLower = keyword.toLowerCase();
                        if (keywordLower === query) {
                            queryScore += 20;
                            queryMatched = true;
                        } else if (matchesWordBoundary(keywordLower, query)) {
                            queryScore += 15;
                            queryMatched = true;
                        } else if (keywordLower.includes(query)) {
                            queryScore += 10;
                            queryMatched = true;
                        }
                    }
                    if (queryMatched && !matchedFields.includes('keywords')) {
                        matchedFields.push('keywords');
                    }
                }

                // 优先级2: displayName（权重: 18）
                const displayNameLower = board.displayName.toLowerCase();
                if (displayNameLower === query) {
                    queryScore += 18;
                    queryMatched = true;
                } else if (matchesWordBoundary(displayNameLower, query)) {
                    queryScore += 12;
                    queryMatched = true;
                } else if (displayNameLower.includes(query)) {
                    queryScore += 8;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('displayName')) {
                    matchedFields.push('displayName');
                }

                // 优先级3: name（权重: 15）
                const nameLower = board.name.toLowerCase();
                if (nameLower === query) {
                    queryScore += 15;
                    queryMatched = true;
                } else if (matchesWordBoundary(nameLower, query)) {
                    queryScore += 10;
                    queryMatched = true;
                } else if (nameLower.includes(query)) {
                    queryScore += 6;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('name')) {
                    matchedFields.push('name');
                }

                // 优先级4: tags（权重: 12）
                if (board.tags) {
                    for (const tag of board.tags) {
                        const tagLower = tag.toLowerCase();
                        if (tagLower === query) {
                            queryScore += 12;
                            queryMatched = true;
                        } else if (matchesWordBoundary(tagLower, query)) {
                            queryScore += 9;
                            queryMatched = true;
                        } else if (tagLower.includes(query)) {
                            queryScore += 6;
                            queryMatched = true;
                        }
                    }
                    if (queryMatched && !matchedFields.includes('tags')) {
                        matchedFields.push('tags');
                    }
                }

                // 优先级5: architecture/mcu（权重: 10）
                const archLower = board.architecture.toLowerCase();
                if (archLower === query) {
                    queryScore += 10;
                    queryMatched = true;
                    if (!matchedFields.includes('architecture')) {
                        matchedFields.push('architecture');
                    }
                } else if (archLower.includes(query)) {
                    queryScore += 6;
                    queryMatched = true;
                    if (!matchedFields.includes('architecture')) {
                        matchedFields.push('architecture');
                    }
                }
                if (board.mcu) {
                    const mcuLower = board.mcu.toLowerCase();
                    if (mcuLower === query) {
                        queryScore += 10;
                        queryMatched = true;
                        if (!matchedFields.includes('mcu')) {
                            matchedFields.push('mcu');
                        }
                    } else if (mcuLower.includes(query)) {
                        queryScore += 6;
                        queryMatched = true;
                        if (!matchedFields.includes('mcu')) {
                            matchedFields.push('mcu');
                        }
                    }
                }

                // 优先级6: description（权重: 5）
                if (board.description) {
                    const descLower = board.description.toLowerCase();
                    if (matchesWordBoundary(descLower, query)) {
                        queryScore += 5;
                        queryMatched = true;
                    } else if (descLower.includes(query)) {
                        queryScore += 3;
                        queryMatched = true;
                    }
                    if (queryMatched && !matchedFields.includes('description')) {
                        matchedFields.push('description');
                    }
                }

                // 优先级7: connectivity/interfaces（权重: 8）- 对选型很重要
                for (const conn of board.connectivity) {
                    if (conn.toLowerCase() === query) {
                        queryScore += 8;
                        queryMatched = true;
                        if (!matchedFields.includes('connectivity')) {
                            matchedFields.push('connectivity');
                        }
                    }
                }
                for (const iface of board.interfaces) {
                    if (iface.toLowerCase() === query) {
                        queryScore += 8;
                        queryMatched = true;
                        if (!matchedFields.includes('interfaces')) {
                            matchedFields.push('interfaces');
                        }
                    }
                }

                // 优先级8: brand（权重: 6）
                const brandLower = board.brand.toLowerCase();
                if (brandLower === query) {
                    queryScore += 6;
                    queryMatched = true;
                } else if (brandLower.includes(query)) {
                    queryScore += 3;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('brand')) {
                    matchedFields.push('brand');
                }

                if (queryMatched) {
                    totalScore += queryScore;
                    matchedQueries.push(query);
                }
            }
        }

        // 简化的筛选逻辑（选型器设计：宽进严出）
        const queryCount = queryList.length;
        const matchedCount = matchedQueries.length;
        
        // 唯一门槛：必须有匹配（关键词匹配或结构化筛选通过）
        if (matchedCount === 0 && !(filters && passedFilters)) {
            continue;
        }
        
        // 匹配多个关键词时给予加分（更相关的排在前面）
        if (queryCount > 1 && matchedCount > 1) {
            // 匹配所有关键词：1.5倍加分
            if (matchedCount === queryCount) {
                totalScore *= 1.5;
            }
            // 匹配部分关键词：按比例加分
            else {
                totalScore *= (1 + 0.2 * (matchedCount - 1));
            }
        }

        // 如果有匹配，添加到结果
        if (totalScore > 0 || (filters && passedFilters)) {
            // 从旧数据中查找description（如果新数据中没有）
            let description = (board as any).description;
            if (!description && oldBoardsData) {
                const oldBoard = oldBoardsData.find(ob => ob.name === board.name);
                description = oldBoard?.description;
            }
            description = description || `${board.brand} ${board.displayName}`;
            
            results.push({
                source: 'board',
                name: board.name,
                displayName: board.displayName,
                description: description,
                score: totalScore,
                matchedFields,
                matchedQueries,
                metadata: {
                    architecture: board.architecture,
                    mcu: board.mcu,
                    frequency: board.frequency,
                    frequencyUnit: board.frequencyUnit,
                    flash: board.flash,
                    sram: board.sram,
                    psram: board.psram,
                    connectivity: board.connectivity,
                    interfaces: board.interfaces,
                    brand: board.brand,
                    core: board.core
                }
            });
        }
    }

    return results;
}

/**
 * 在新格式库数组中搜索匹配项 - 支持文本搜索和结构化筛选
 */
function searchInNewLibraries(
    libraries: NewLibraryItem[], 
    queryList: string[],
    filters?: StructuredFilters,
    oldLibrariesData?: OldLibraryItem[]
): Array<{
    source: 'board' | 'library';
    name: string;
    displayName: string;
    description: string;
    score: number;
    matchedFields: string[];
    matchedQueries: string[];
    metadata?: any;
}> {
    const results: Array<{
        source: 'board' | 'library';
        name: string;
        displayName: string;
        description: string;
        score: number;
        matchedFields: string[];
        matchedQueries: string[];
        metadata?: any;
    }> = [];

    for (const lib of libraries) {
        let totalScore = 0;
        const matchedFields: string[] = [];
        const matchedQueries: string[] = [];
        let passedFilters = true;

        // 1. 应用结构化筛选（如果提供）
        if (filters) {
            // 分类筛选
            if (filters.category && lib.category !== filters.category) {
                passedFilters = false;
            }
            
            // 硬件类型筛选（OR逻辑 - 匹配任一即可）
            if (filters.hardwareType && filters.hardwareType.length > 0) {
                const hasMatch = filters.hardwareType.some(type => 
                    lib.hardwareType.includes(type)
                );
                if (!hasMatch) {
                    passedFilters = false;
                }
            }
            
            // 支持内核筛选（OR逻辑 - 匹配任一即可）
            if (filters.supportedCores && filters.supportedCores.length > 0) {
                const hasMatch = filters.supportedCores.some(core =>  
                    lib.supportedCores.includes(core)
                );
                if (!hasMatch) {
                    passedFilters = false;
                }
            }
            
            // 通信协议筛选（AND逻辑 - 必须全部包含）
            if (filters.communication) {
                for (const comm of filters.communication) {
                    if (!lib.communication.includes(comm)) {
                        passedFilters = false;
                        break;
                    }
                }
            }
            
            if (!passedFilters) {
                continue;
            }
            
            // 结构化筛选通过，加基础分
            totalScore += 50;
            matchedFields.push('structured_filters');
        }

        // 2. 文本关键词匹配（如果提供）
        // 选型器设计：宽泛匹配，返回所有相关选项，让LLM做最终选择
        if (queryList.length > 0) {
            for (const query of queryList) {
                let queryScore = 0;
                let queryMatched = false;

                // 优先级1: keywords（权重: 20）
                if (lib.keywords) {
                    for (const keyword of lib.keywords) {
                        const keywordLower = keyword.toLowerCase();
                        if (keywordLower === query) {
                            queryScore += 20;
                            queryMatched = true;
                        } else if (matchesWordBoundary(keywordLower, query)) {
                            queryScore += 15;
                            queryMatched = true;
                        } else if (keywordLower.includes(query)) {
                            queryScore += 10;
                            queryMatched = true;
                        }
                    }
                    if (queryMatched && !matchedFields.includes('keywords')) {
                        matchedFields.push('keywords');
                    }
                }

                // 优先级2: tags（权重: 18）
                for (const tag of lib.tags) {
                    const tagLower = tag.toLowerCase();
                    if (tagLower === query) {
                        queryScore += 18;
                        queryMatched = true;
                    } else if (matchesWordBoundary(tagLower, query)) {
                        queryScore += 12;
                        queryMatched = true;
                    } else if (tagLower.includes(query)) {
                        queryScore += 8;
                        queryMatched = true;
                    }
                }
                if (queryMatched && !matchedFields.includes('tags')) {
                    matchedFields.push('tags');
                }

                // 优先级3: displayName（权重: 15）
                const displayNameLower = lib.displayName.toLowerCase();
                if (displayNameLower === query) {
                    queryScore += 15;
                    queryMatched = true;
                } else if (matchesWordBoundary(displayNameLower, query)) {
                    queryScore += 10;
                    queryMatched = true;
                } else if (displayNameLower.includes(query)) {
                    queryScore += 7;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('displayName')) {
                    matchedFields.push('displayName');
                }

                // 优先级4: name（权重: 15）
                const nameLower = lib.name.toLowerCase();
                if (nameLower === query) {
                    queryScore += 15;
                    queryMatched = true;
                } else if (matchesWordBoundary(nameLower, query)) {
                    queryScore += 10;
                    queryMatched = true;
                } else if (nameLower.includes(query)) {
                    queryScore += 6;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('name')) {
                    matchedFields.push('name');
                }
                
                // 优先级5: hardwareType（权重: 15 - 这是最具体的分类）
                for (const hwType of lib.hardwareType) {
                    const hwTypeLower = hwType.toLowerCase();
                    if (hwTypeLower === query) {
                        queryScore += 15;
                        queryMatched = true;
                    } else if (hwTypeLower.includes(query)) {
                        queryScore += 12;
                        queryMatched = true;
                    }
                    if (queryMatched && !matchedFields.includes('hardwareType')) {
                        matchedFields.push('hardwareType');
                    }
                }

                // 优先级6: description（权重: 5）
                if (lib.description) {
                    const descLower = lib.description.toLowerCase();
                    if (matchesWordBoundary(descLower, query)) {
                        queryScore += 5;
                        queryMatched = true;
                    } else if (descLower.includes(query)) {
                        queryScore += 3;
                        queryMatched = true;
                    }
                    if (queryMatched && !matchedFields.includes('description')) {
                        matchedFields.push('description');
                    }
                }

                // 优先级7: category（权重: 8）
                const categoryLower = lib.category.toLowerCase();
                if (categoryLower === query) {
                    queryScore += 8;
                    queryMatched = true;
                    if (!matchedFields.includes('category')) {
                        matchedFields.push('category');
                    }
                }

                // 优先级8: communication（权重: 8）
                for (const comm of lib.communication) {
                    if (comm.toLowerCase() === query) {
                        queryScore += 8;
                        queryMatched = true;
                        if (!matchedFields.includes('communication')) {
                            matchedFields.push('communication');
                        }
                    }
                }

                // 优先级9: supportedCores（权重: 6）
                for (const core of lib.supportedCores) {
                    const coreLower = core.toLowerCase();
                    if (coreLower === query || coreLower.includes(query)) {
                        queryScore += 6;
                        queryMatched = true;
                    }
                }
                if (queryMatched && !matchedFields.includes('supportedCores')) {
                    matchedFields.push('supportedCores');
                }

                // 优先级10: compatibleHardware（权重: 6）
                for (const hw of lib.compatibleHardware) {
                    if (hw.toLowerCase().includes(query)) {
                        queryScore += 6;
                        queryMatched = true;
                        if (!matchedFields.includes('compatibleHardware')) {
                            matchedFields.push('compatibleHardware');
                        }
                    }
                }

                if (queryMatched) {
                    totalScore += queryScore;
                    matchedQueries.push(query);
                }
            }
        }

        // 简化的筛选逻辑（选型器设计：宽进严出）
        const queryCount = queryList.length;
        const matchedCount = matchedQueries.length;
        
        // 唯一门槛：必须有匹配（关键词匹配或结构化筛选通过）
        if (matchedCount === 0 && !(filters && passedFilters)) {
            continue;
        }
        
        // 匹配多个关键词时给予加分（更相关的排在前面）
        if (queryCount > 1 && matchedCount > 1) {
            // 匹配所有关键词：1.5倍加分
            if (matchedCount === queryCount) {
                totalScore *= 1.5;
            }
            // 匹配部分关键词：按比例加分
            else {
                totalScore *= (1 + 0.2 * (matchedCount - 1));
            }
        }

        // 如果有匹配，添加到结果
        if (totalScore > 0 || (filters && passedFilters)) {
            // 从旧数据中查找description（如果新数据中没有）
            let description = (lib as any).description;
            if (!description && oldLibrariesData) {
                const oldLib = oldLibrariesData.find(ol => ol.name === lib.name);
                description = oldLib?.description;
            }
            description = description || lib.displayName;
            
            results.push({
                source: 'library',
                name: lib.name,
                displayName: lib.displayName,
                description: description,
                score: totalScore,
                matchedFields,
                matchedQueries,
                metadata: {
                    category: lib.category,
                    subcategory: lib.subcategory,
                    hardwareType: lib.hardwareType,
                    supportedCores: lib.supportedCores,
                    communication: lib.communication,
                    voltage: lib.voltage,
                    compatibleHardware: lib.compatibleHardware
                }
            });
        }
    }

    return results;
}

// ==================== 旧格式搜索函数（降级兼容）====================

/**
 * 在旧格式开发板数组中搜索匹配项 - 仅支持文本搜索
 */
function searchInOldBoards(
    boards: OldBoardItem[], 
    queryList: string[]
): Array<{
    source: 'board' | 'library';
    name: string;
    displayName: string;
    description: string;
    score: number;
    matchedFields: string[];
    matchedQueries: string[];
    metadata?: any;
}> {
    const results: Array<{
        source: 'board' | 'library';
        name: string;
        displayName: string;
        description: string;
        score: number;
        matchedFields: string[];
        matchedQueries: string[];
        metadata?: any;
    }> = [];

    for (const board of boards) {
        let totalScore = 0;
        const matchedFields: string[] = [];
        const matchedQueries: string[] = [];

        if (queryList.length === 0) continue;

        for (const query of queryList) {
            let queryScore = 0;
            let queryMatched = false;

            // 1. keywords（权重: 20）
            if (board.keywords) {
                for (const keyword of board.keywords) {
                    const keywordLower = keyword.toLowerCase();
                    if (keywordLower === query) {
                        queryScore += 20;
                        queryMatched = true;
                    } else if (matchesWordBoundary(keywordLower, query)) {
                        queryScore += 15;
                        queryMatched = true;
                    } else if (keywordLower.includes(query)) {
                        queryScore += 10;
                        queryMatched = true;
                    }
                }
                if (queryMatched && !matchedFields.includes('keywords')) {
                    matchedFields.push('keywords');
                }
            }

            // 2. nickname（权重: 18）
            if (board.nickname) {
                const nicknameLower = board.nickname.toLowerCase();
                if (nicknameLower === query) {
                    queryScore += 18;
                    queryMatched = true;
                } else if (matchesWordBoundary(nicknameLower, query)) {
                    queryScore += 12;
                    queryMatched = true;
                } else if (nicknameLower.includes(query)) {
                    queryScore += 8;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('nickname')) {
                    matchedFields.push('nickname');
                }
            }

            // 3. description（权重: 10）
            if (board.description) {
                const descLower = board.description.toLowerCase();
                if (matchesWordBoundary(descLower, query)) {
                    queryScore += 9;
                    queryMatched = true;
                } else if (descLower.includes(query)) {
                    queryScore += 5;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('description')) {
                    matchedFields.push('description');
                }
            }

            // 4. brand（权重: 6）
            if (board.brand) {
                const brandLower = board.brand.toLowerCase();
                if (brandLower === query) {
                    queryScore += 6;
                    queryMatched = true;
                } else if (brandLower.includes(query)) {
                    queryScore += 3;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('brand')) {
                    matchedFields.push('brand');
                }
            }

            // 5. name（精确匹配，权重: 8）
            const nameLower = board.name.toLowerCase();
            if (matchesWordBoundary(nameLower, query)) {
                queryScore += 8;
                queryMatched = true;
                if (!matchedFields.includes('name')) {
                    matchedFields.push('name');
                }
            }

            if (queryMatched) {
                totalScore += queryScore;
                matchedQueries.push(query);
            }
        }

        // 多关键词匹配逻辑（OR）
        const queryCount = queryList.length;
        const matchedCount = matchedQueries.length;
        
        // 匹配所有关键词时给予额外加分
        if (queryCount > 1 && matchedCount === queryCount) {
            totalScore *= 1.5;
        }
        // 匹配多个关键词时也给予加分
        else if (queryCount > 1 && matchedCount > 1) {
            totalScore *= (1 + 0.2 * (matchedCount - 1));
        }
        
        // 最低分数门槛：过滤低相关性结果
        const minScoreThreshold = matchedCount > 0 ? matchedCount * 10 : 10;
        if (totalScore < minScoreThreshold) {
            continue;
        }

        if (totalScore > 0) {
            results.push({
                source: 'board',
                name: board.name,
                displayName: board.nickname || board.name,
                description: board.description,
                score: totalScore,
                matchedFields,
                matchedQueries,
                metadata: undefined  // 旧格式没有结构化 metadata
            });
        }
    }

    return results;
}

/**
 * 在旧格式库数组中搜索匹配项 - 仅支持文本搜索
 */
function searchInOldLibraries(
    libraries: OldLibraryItem[], 
    queryList: string[]
): Array<{
    source: 'board' | 'library';
    name: string;
    displayName: string;
    description: string;
    score: number;
    matchedFields: string[];
    matchedQueries: string[];
    metadata?: any;
}> {
    const results: Array<{
        source: 'board' | 'library';
        name: string;
        displayName: string;
        description: string;
        score: number;
        matchedFields: string[];
        matchedQueries: string[];
        metadata?: any;
    }> = [];

    for (const lib of libraries) {
        let totalScore = 0;
        const matchedFields: string[] = [];
        const matchedQueries: string[] = [];

        if (queryList.length === 0) continue;

        for (const query of queryList) {
            let queryScore = 0;
            let queryMatched = false;

            // 1. keywords（权重: 20）
            if (lib.keywords) {
                for (const keyword of lib.keywords) {
                    const keywordLower = keyword.toLowerCase();
                    if (keywordLower === query) {
                        queryScore += 20;
                        queryMatched = true;
                    } else if (matchesWordBoundary(keywordLower, query)) {
                        queryScore += 15;
                        queryMatched = true;
                    } else if (keywordLower.includes(query)) {
                        queryScore += 10;
                        queryMatched = true;
                    }
                }
                if (queryMatched && !matchedFields.includes('keywords')) {
                    matchedFields.push('keywords');
                }
            }

            // 2. nickname（权重: 18）
            if (lib.nickname) {
                const nicknameLower = lib.nickname.toLowerCase();
                if (nicknameLower === query) {
                    queryScore += 18;
                    queryMatched = true;
                } else if (matchesWordBoundary(nicknameLower, query)) {
                    queryScore += 12;
                    queryMatched = true;
                } else if (nicknameLower.includes(query)) {
                    queryScore += 8;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('nickname')) {
                    matchedFields.push('nickname');
                }
            }

            // 3. description（权重: 10）
            if (lib.description) {
                const descLower = lib.description.toLowerCase();
                if (matchesWordBoundary(descLower, query)) {
                    queryScore += 9;
                    queryMatched = true;
                } else if (descLower.includes(query)) {
                    queryScore += 5;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('description')) {
                    matchedFields.push('description');
                }
            }

            // 4. compatibility.core（权重: 7）
            if (lib.compatibility?.core) {
                for (const core of lib.compatibility.core) {
                    const coreLower = core.toLowerCase();
                    if (coreLower === query) {
                        queryScore += 10;
                        queryMatched = true;
                    } else if (coreLower.includes(query)) {
                        queryScore += 5;
                        queryMatched = true;
                    }
                }
                if (queryMatched && !matchedFields.includes('core')) {
                    matchedFields.push('core');
                }
            }

            // 5. author（权重: 4）
            if (lib.author) {
                const authorLower = lib.author.toLowerCase();
                if (authorLower === query) {
                    queryScore += 6;
                    queryMatched = true;
                } else if (authorLower.includes(query)) {
                    queryScore += 3;
                    queryMatched = true;
                }
                if (queryMatched && !matchedFields.includes('author')) {
                    matchedFields.push('author');
                }
            }

            // 6. name（精确匹配，权重: 8）
            const nameLower = lib.name.toLowerCase();
            if (matchesWordBoundary(nameLower, query)) {
                queryScore += 8;
                queryMatched = true;
                if (!matchedFields.includes('name')) {
                    matchedFields.push('name');
                }
            }

            if (queryMatched) {
                totalScore += queryScore;
                matchedQueries.push(query);
            }
        }

        // 多关键词匹配逻辑（OR）
        const queryCount = queryList.length;
        const matchedCount = matchedQueries.length;
        
        // 匹配所有关键词时给予额外加分
        if (queryCount > 1 && matchedCount === queryCount) {
            totalScore *= 1.5;
        }
        // 匹配多个关键词时也给予加分
        else if (queryCount > 1 && matchedCount > 1) {
            totalScore *= (1 + 0.2 * (matchedCount - 1));
        }
        
        // 最低分数门槛：过滤低相关性结果
        const minScoreThreshold = matchedCount > 0 ? matchedCount * 10 : 10;
        if (totalScore < minScoreThreshold) {
            continue;
        }

        if (totalScore > 0) {
            results.push({
                source: 'library',
                name: lib.name,
                displayName: lib.nickname || lib.name,
                description: lib.description,
                score: totalScore,
                matchedFields,
                matchedQueries,
                metadata: undefined  // 旧格式没有结构化 metadata
            });
        }
    }

    return results;
}

/**
 * 单词边界匹配 - 检查query是否作为独立单词出现在text中
 */
function matchesWordBoundary(text: string, query: string): boolean {
    const delimiters = /[\s\-_\/@:.,;()\[\]{}，。！？；：、""''【】《》（）]/;
    
    let index = 0;
    while ((index = text.indexOf(query, index)) !== -1) {
        const beforeOk = index === 0 || delimiters.test(text[index - 1]);
        const afterIndex = index + query.length;
        const afterOk = afterIndex === text.length || delimiters.test(text[afterIndex]);
        
        if (beforeOk && afterOk) {
            return true;
        }
        
        index++;
    }
    
    return false;
}
