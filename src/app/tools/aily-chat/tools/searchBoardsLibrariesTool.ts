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
                
                if (newLibrariesData && newLibrariesData.length > 0) {
                    dataFormat = 'new';
                    results.push(...searchInNewLibraries(newLibrariesData as NewLibraryItem[], queryListLower, filters, oldLibrariesData as OldLibraryItem[]));
                } else if (oldLibrariesData && oldLibrariesData.length > 0) {
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
                // 始终显示description（新格式从旧数据关联获取）
                if (item.description) {
                    resultContent += `description: ${item.description}\n`;
                }
                
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

// ==================== 共享类型与通用评分函数 ====================

/** 搜索结果项 */
interface SearchResultItem {
    source: 'board' | 'library';
    name: string;
    displayName: string;
    description: string;
    score: number;
    matchedFields: string[];
    matchedQueries: string[];
    metadata?: any;
}

/** 单词边界匹配 - 检查 query 是否作为独立单词出现在 text 中 */
function matchesWordBoundary(text: string, query: string): boolean {
    const delimiters = /[\s\-_\/@:.,;()\[\]{}，。！？；：、""''【】《》（）]/;
    let index = 0;
    while ((index = text.indexOf(query, index)) !== -1) {
        const beforeOk = index === 0 || delimiters.test(text[index - 1]);
        const afterIndex = index + query.length;
        const afterOk = afterIndex === text.length || delimiters.test(text[afterIndex]);
        if (beforeOk && afterOk) return true;
        index++;
    }
    return false;
}

/**
 * 单字段文本评分 - 3 级匹配 (精确 → 词边界 → 包含)
 * @param weights [精确匹配分, 词边界匹配分, 包含匹配分]
 */
function scoreTextField(text: string, query: string, weights: [number, number, number]): number {
    const textLower = text.toLowerCase();
    if (textLower === query) return weights[0];
    if (weights[1] > 0 && matchesWordBoundary(textLower, query)) return weights[1];
    if (weights[2] > 0 && textLower.includes(query)) return weights[2];
    return 0;
}

/** 数组字段文本评分 - 对数组中每个元素评分并累加 */
function scoreArrayField(items: string[], query: string, weights: [number, number, number]): number {
    let total = 0;
    for (const item of items) total += scoreTextField(item, query, weights);
    return total;
}

/** 数组字段精确匹配评分 - 仅 toLowerCase() === query */
function scoreArrayExact(items: string[], query: string, weight: number): number {
    let total = 0;
    for (const item of items) {
        if (item.toLowerCase() === query) total += weight;
    }
    return total;
}

/** 多关键词加分计算 */
function applyMultiKeywordBonus(totalScore: number, queryCount: number, matchedCount: number): number {
    if (queryCount > 1 && matchedCount > 1) {
        return matchedCount === queryCount
            ? totalScore * 1.5
            : totalScore * (1 + 0.2 * (matchedCount - 1));
    }
    return totalScore;
}

/** 大小写不敏感的数组包含检查 */
function arrayIncludesCI(arr: string[], value: string): boolean {
    const lv = value.toLowerCase();
    return arr.some(item => item.toLowerCase() === lv);
}

// ==================== 字段评分配置 ====================

/** 字段评分配置项 */
interface FieldScoreConfig {
    name: string;
    getValue: (item: any) => string | string[] | undefined;
    /** [精确, 词边界, 包含] */
    weights: [number, number, number];
    /** 数组字段仅精确匹配 */
    exactOnly?: boolean;
}

/**
 * 通用文本评分引擎 - 根据字段配置对条目进行评分
 * 返回的 totalScore 不含多关键词加分，由调用方决定何时应用
 */
function scoreItemByFields(
    item: any,
    queryList: string[],
    fieldConfigs: FieldScoreConfig[]
): { totalScore: number; matchedFields: string[]; matchedQueries: string[] } {
    let totalScore = 0;
    const matchedFields: string[] = [];
    const matchedQueries: string[] = [];

    for (const query of queryList) {
        let queryScore = 0;
        let queryMatched = false;

        for (const config of fieldConfigs) {
            const value = config.getValue(item);
            if (value == null) continue;

            let fieldScore: number;
            if (Array.isArray(value)) {
                fieldScore = config.exactOnly
                    ? scoreArrayExact(value, query, config.weights[0])
                    : scoreArrayField(value, query, config.weights);
            } else {
                fieldScore = scoreTextField(String(value), query, config.weights);
            }

            if (fieldScore > 0) {
                queryScore += fieldScore;
                queryMatched = true;
                if (!matchedFields.includes(config.name)) matchedFields.push(config.name);
            }
        }

        if (queryMatched) {
            totalScore += queryScore;
            matchedQueries.push(query);
        }
    }

    return { totalScore, matchedFields, matchedQueries };
}

// ---- 新格式开发板字段配置 ----
const NEW_BOARD_FIELDS: FieldScoreConfig[] = [
    { name: 'keywords',     getValue: (b: NewBoardItem) => b.keywords,     weights: [20, 15, 10] },
    { name: 'displayName',  getValue: (b: NewBoardItem) => b.displayName,  weights: [18, 12, 8] },
    { name: 'name',         getValue: (b: NewBoardItem) => b.name,         weights: [15, 10, 6] },
    { name: 'tags',         getValue: (b: NewBoardItem) => b.tags,         weights: [12, 9, 6] },
    { name: 'architecture', getValue: (b: NewBoardItem) => b.architecture, weights: [10, 6, 6] },
    { name: 'mcu',          getValue: (b: NewBoardItem) => b.mcu,          weights: [10, 6, 6] },
    { name: 'description',  getValue: (b: NewBoardItem) => b.description,  weights: [5, 5, 3] },
    { name: 'connectivity', getValue: (b: NewBoardItem) => b.connectivity, weights: [8, 0, 0], exactOnly: true },
    { name: 'interfaces',   getValue: (b: NewBoardItem) => b.interfaces,   weights: [8, 0, 0], exactOnly: true },
    { name: 'brand',        getValue: (b: NewBoardItem) => b.brand,        weights: [6, 3, 3] },
];

// ---- 新格式库字段配置 ----
const NEW_LIBRARY_FIELDS: FieldScoreConfig[] = [
    { name: 'keywords',           getValue: (l: NewLibraryItem) => l.keywords,           weights: [20, 15, 10] },
    { name: 'tags',               getValue: (l: NewLibraryItem) => l.tags,               weights: [18, 12, 8] },
    { name: 'displayName',        getValue: (l: NewLibraryItem) => l.displayName,        weights: [15, 10, 7] },
    { name: 'name',               getValue: (l: NewLibraryItem) => l.name,               weights: [15, 10, 6] },
    { name: 'hardwareType',       getValue: (l: NewLibraryItem) => l.hardwareType,       weights: [15, 12, 12] },
    { name: 'description',        getValue: (l: NewLibraryItem) => l.description,        weights: [5, 5, 3] },
    { name: 'category',           getValue: (l: NewLibraryItem) => l.category,           weights: [8, 0, 0] },
    { name: 'communication',      getValue: (l: NewLibraryItem) => l.communication,      weights: [8, 0, 0], exactOnly: true },
    { name: 'supportedCores',     getValue: (l: NewLibraryItem) => l.supportedCores,     weights: [6, 6, 6] },
    { name: 'compatibleHardware', getValue: (l: NewLibraryItem) => l.compatibleHardware, weights: [6, 6, 6] },
];

// ---- 旧格式开发板字段配置 ----
const OLD_BOARD_FIELDS: FieldScoreConfig[] = [
    { name: 'keywords',    getValue: (b: OldBoardItem) => b.keywords,    weights: [20, 15, 10] },
    { name: 'nickname',    getValue: (b: OldBoardItem) => b.nickname,    weights: [18, 12, 8] },
    { name: 'description', getValue: (b: OldBoardItem) => b.description, weights: [9, 9, 5] },
    { name: 'brand',       getValue: (b: OldBoardItem) => b.brand,       weights: [6, 3, 3] },
    { name: 'name',        getValue: (b: OldBoardItem) => b.name,        weights: [8, 8, 0] },
];

// ---- 旧格式库字段配置 ----
const OLD_LIBRARY_FIELDS: FieldScoreConfig[] = [
    { name: 'keywords',    getValue: (l: OldLibraryItem) => l.keywords,             weights: [20, 15, 10] },
    { name: 'nickname',    getValue: (l: OldLibraryItem) => l.nickname,             weights: [18, 12, 8] },
    { name: 'description', getValue: (l: OldLibraryItem) => l.description,          weights: [9, 9, 5] },
    { name: 'core',        getValue: (l: OldLibraryItem) => l.compatibility?.core,  weights: [10, 5, 5] },
    { name: 'author',      getValue: (l: OldLibraryItem) => l.author,               weights: [6, 3, 3] },
    { name: 'name',        getValue: (l: OldLibraryItem) => l.name,                 weights: [8, 8, 0] },
];

// ==================== 结构化筛选函数（大小写不敏感）====================

/** 新格式开发板结构化筛选 */
function passNewBoardFilters(board: NewBoardItem, filters: StructuredFilters): boolean {
    if (filters.flash && !compareNumeric(board.flash, filters.flash)) return false;
    if (filters.sram && !compareNumeric(board.sram, filters.sram)) return false;
    if (filters.frequency && !compareNumeric(board.frequency, filters.frequency)) return false;
    if (filters.cores && !compareNumeric(board.cores, filters.cores)) return false;
    if (filters.architecture && board.architecture.toLowerCase() !== filters.architecture.toLowerCase()) return false;
    if (filters.connectivity) {
        for (const conn of filters.connectivity) {
            if (!arrayIncludesCI(board.connectivity, conn)) return false;
        }
    }
    if (filters.interfaces) {
        for (const iface of filters.interfaces) {
            if (!arrayIncludesCI(board.interfaces, iface)) return false;
        }
    }
    if (filters.brand && board.brand.toLowerCase() !== filters.brand.toLowerCase()) return false;
    if (filters.voltage && board.voltage !== parseFloat(filters.voltage)) return false;
    return true;
}

/** 新格式库结构化筛选 */
function passNewLibraryFilters(lib: NewLibraryItem, filters: StructuredFilters): boolean {
    if (filters.category && lib.category.toLowerCase() !== filters.category.toLowerCase()) return false;
    if (filters.hardwareType && filters.hardwareType.length > 0) {
        if (!filters.hardwareType.some(type => arrayIncludesCI(lib.hardwareType, type))) return false;
    }
    if (filters.supportedCores && filters.supportedCores.length > 0) {
        if (!filters.supportedCores.some(core => arrayIncludesCI(lib.supportedCores, core))) return false;
    }
    if (filters.communication) {
        for (const comm of filters.communication) {
            if (!arrayIncludesCI(lib.communication, comm)) return false;
        }
    }
    return true;
}

// ==================== 搜索函数（新格式 + 旧格式降级）====================

/** 从旧数据中查找 description（处理新旧格式 name 差异） */
function findOldDescription<T extends { name: string; description?: string }>(
    name: string, oldData?: T[]
): string | undefined {
    if (!oldData) return undefined;
    const old = oldData.find(o =>
        o.name === name ||
        o.name === `@aily-project/${name}` ||
        o.name.endsWith(`/${name}`)
    );
    return old?.description;
}

/** 在新格式开发板数组中搜索 - 支持结构化筛选 + 文本搜索 */
function searchInNewBoards(
    boards: NewBoardItem[],
    queryList: string[],
    filters?: StructuredFilters,
    oldBoardsData?: OldBoardItem[]
): SearchResultItem[] {
    const results: SearchResultItem[] = [];

    for (const board of boards) {
        // 1. 结构化筛选
        if (filters && !passNewBoardFilters(board, filters)) continue;

        // 2. 文本评分
        const { totalScore: textScore, matchedFields, matchedQueries } =
            scoreItemByFields(board, queryList, NEW_BOARD_FIELDS);

        // 筛选通过时加基础分
        let totalScore = textScore;
        if (filters) {
            totalScore += 50;
            matchedFields.unshift('structured_filters');
        }

        // 3. 门槛：至少有关键词匹配或结构化筛选通过
        if (matchedQueries.length === 0 && !filters) continue;

        // 4. 多关键词加分（含 filters 基础分一起加成）
        totalScore = applyMultiKeywordBonus(totalScore, queryList.length, matchedQueries.length);
        if (totalScore <= 0 && !filters) continue;

        // 5. 构建结果
        const description = board.description
            || findOldDescription(board.name, oldBoardsData)
            || `${board.brand} ${board.displayName}`;

        results.push({
            source: 'board', name: board.name, displayName: board.displayName,
            description, score: totalScore, matchedFields, matchedQueries,
            metadata: {
                architecture: board.architecture, mcu: board.mcu,
                frequency: board.frequency, frequencyUnit: board.frequencyUnit,
                flash: board.flash, sram: board.sram, psram: board.psram,
                connectivity: board.connectivity, interfaces: board.interfaces,
                brand: board.brand, core: board.core
            }
        });
    }

    return results;
}

/** 在新格式库数组中搜索 - 支持结构化筛选 + 文本搜索 */
function searchInNewLibraries(
    libraries: NewLibraryItem[],
    queryList: string[],
    filters?: StructuredFilters,
    oldLibrariesData?: OldLibraryItem[]
): SearchResultItem[] {
    const results: SearchResultItem[] = [];

    for (const lib of libraries) {
        // 1. 结构化筛选
        if (filters && !passNewLibraryFilters(lib, filters)) continue;

        // 2. 文本评分
        const { totalScore: textScore, matchedFields, matchedQueries } =
            scoreItemByFields(lib, queryList, NEW_LIBRARY_FIELDS);

        let totalScore = textScore;
        if (filters) {
            totalScore += 50;
            matchedFields.unshift('structured_filters');
        }

        // 3. 门槛
        if (matchedQueries.length === 0 && !filters) continue;

        // 4. 多关键词加分
        totalScore = applyMultiKeywordBonus(totalScore, queryList.length, matchedQueries.length);
        if (totalScore <= 0 && !filters) continue;

        // 5. 构建结果
        const description = (lib as any).description
            || findOldDescription(lib.name, oldLibrariesData)
            || lib.displayName;

        results.push({
            source: 'library', name: lib.name, displayName: lib.displayName,
            description, score: totalScore, matchedFields, matchedQueries,
            metadata: {
                category: lib.category, subcategory: lib.subcategory,
                hardwareType: lib.hardwareType, supportedCores: lib.supportedCores,
                communication: lib.communication, voltage: lib.voltage,
                compatibleHardware: lib.compatibleHardware
            }
        });
    }

    return results;
}

// ==================== 旧格式搜索函数（降级兼容）====================

/** 在旧格式开发板数组中搜索 - 仅文本搜索 */
function searchInOldBoards(boards: OldBoardItem[], queryList: string[]): SearchResultItem[] {
    const results: SearchResultItem[] = [];
    if (queryList.length === 0) return results;

    for (const board of boards) {
        const { totalScore: raw, matchedFields, matchedQueries } =
            scoreItemByFields(board, queryList, OLD_BOARD_FIELDS);

        const totalScore = applyMultiKeywordBonus(raw, queryList.length, matchedQueries.length);

        // 最低分数门槛
        const minThreshold = matchedQueries.length > 0 ? matchedQueries.length * 10 : 10;
        if (totalScore < minThreshold) continue;

        if (totalScore > 0) {
            results.push({
                source: 'board', name: board.name,
                displayName: board.nickname || board.name,
                description: board.description,
                score: totalScore, matchedFields, matchedQueries,
                metadata: undefined
            });
        }
    }

    return results;
}

/** 在旧格式库数组中搜索 - 仅文本搜索 */
function searchInOldLibraries(libraries: OldLibraryItem[], queryList: string[]): SearchResultItem[] {
    const results: SearchResultItem[] = [];
    if (queryList.length === 0) return results;

    for (const lib of libraries) {
        const { totalScore: raw, matchedFields, matchedQueries } =
            scoreItemByFields(lib, queryList, OLD_LIBRARY_FIELDS);

        const totalScore = applyMultiKeywordBonus(raw, queryList.length, matchedQueries.length);

        const minThreshold = matchedQueries.length > 0 ? matchedQueries.length * 10 : 10;
        if (totalScore < minThreshold) continue;

        if (totalScore > 0) {
            results.push({
                source: 'library', name: lib.name,
                displayName: lib.nickname || lib.name,
                description: lib.description,
                score: totalScore, matchedFields, matchedQueries,
                metadata: undefined
            });
        }
    }

    return results;
}
