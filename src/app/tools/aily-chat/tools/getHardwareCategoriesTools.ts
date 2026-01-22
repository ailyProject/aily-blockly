import { injectTodoReminder } from "./todoWriteTool";
import { ConfigService } from '../../../services/config.service';

/**
 * 获取硬件分类工具 - 用于引导式选型
 * 
 * 返回开发板或库的分类信息，帮助LLM了解可用选项，实现分步引导选型流程。
 * 
 * @example
 * // 获取库的分类（sensor, motor, display...）
 * getHardwareCategories({ type: 'libraries', dimension: 'category' })
 * 
 * // 获取开发板的品牌分类
 * getHardwareCategories({ type: 'boards', dimension: 'brand' })
 * 
 * // 获取传感器库的具体类型
 * getHardwareCategories({ type: 'libraries', dimension: 'hardwareType' })
 */
export const getHardwareCategoriesTool = {
    name: 'get_hardware_categories',
    description: `获取开发板或库的分类信息，用于引导式选型流程。

**使用场景：**
在进行硬件选型前，先了解有哪些可用分类，然后再使用 search_boards_libraries 进行精确搜索。

**开发板分类维度：**
- brand: 品牌（Arduino, Espressif, OpenJumper, Seeed, DFRobot...）
- architecture: 架构（avr, xtensa-lx6, xtensa-lx7, riscv, arm-cortex-m4...）
- connectivity: 连接方式（wifi, ble, bluetooth-classic, zigbee...）

**库分类维度：**
- category: 主分类（sensor, motor, display, communication, audio...）
- hardwareType: 硬件类型（temperature, humidity, led, oled, touch, stepper...）
- communication: 通信协议（i2c, spi, uart, gpio, pwm...）

**引导流程示例：**
1. 用户说"我想做温湿度计"
2. 先调用此工具获取 sensor 类库的 hardwareType 分类
3. 发现有 temperature, humidity 等类型
4. 再调用 search_boards_libraries 精确搜索这些类型的库
5. 同时获取开发板分类，推荐合适的开发板`,

    parameters: {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: ['boards', 'libraries'],
                description: '获取分类的类型：boards(开发板) 或 libraries(库)'
            },
            dimension: {
                type: 'string',
                description: `分类维度：
- 开发板：architecture(架构), connectivity(连接方式), interfaces(接口类型), tags(用途标签)
- 库：category(主分类), hardwareType(硬件类型), communication(通信协议)`
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

    handler: async (
        params: {
            type: 'boards' | 'libraries';
            dimension: string;
            filterBy?: {
                category?: string;
                architecture?: string;
                connectivity?: string[];
                tags?: string[];
            };
        },
        configService: ConfigService
    ) => {
        const { type, dimension, filterBy } = params;

        try {
            if (type === 'boards') {
                return await getBoardCategories(configService, dimension, filterBy);
            } else {
                return await getLibraryCategories(configService, dimension, filterBy);
            }
        } catch (error) {
            const toolResult = {
                is_error: true,
                content: `获取分类失败: ${error instanceof Error ? error.message : String(error)}`
            };
            return injectTodoReminder(toolResult, 'get_hardware_categories');
        }
    }
};

/**
 * 获取开发板分类
 */
async function getBoardCategories(
    configService: ConfigService,
    dimension: string,
    filterBy?: { architecture?: string; connectivity?: string[]; tags?: string[] }
) {
    // 优先使用新格式数据
    let boards = configService.boardIndex || [];
    
    if (boards.length === 0) {
        // 降级到旧格式
        const oldBoards = configService.boardList || [];
        if (oldBoards.length === 0) {
            const toolResult = {
                is_error: false,
                content: '暂无开发板数据'
            };
            return injectTodoReminder(toolResult, 'get_hardware_categories');
        }
        
        const toolResult = {
            is_error: false,
            content: `旧格式数据不支持 ${dimension} 维度分类，请升级到新索引格式`
        };
        return injectTodoReminder(toolResult, 'get_hardware_categories');
    }

    // 新格式处理
    // 应用预过滤
    if (filterBy) {
        if (filterBy.architecture) {
            boards = boards.filter((b: any) => 
                b.architecture?.toLowerCase() === filterBy.architecture!.toLowerCase()
            );
        }
        if (filterBy.connectivity && filterBy.connectivity.length > 0) {
            boards = boards.filter((b: any) => 
                filterBy.connectivity!.some(conn => 
                    (b.connectivity || []).includes(conn.toLowerCase())
                )
            );
        }
        if (filterBy.tags && filterBy.tags.length > 0) {
            boards = boards.filter((b: any) => 
                filterBy.tags!.some(tag => 
                    (b.tags || []).some((t: string) => t.toLowerCase().includes(tag.toLowerCase()))
                )
            );
        }
    }

    const categoryCount = new Map<string, number>();

    for (const board of boards) {
        let values: string[] = [];

        switch (dimension) {
            case 'architecture':
                values = [(board as any).architecture || 'Unknown'];
                break;
            case 'connectivity':
                values = (board as any).connectivity || [];
                break;
            case 'interfaces':
                values = (board as any).interfaces || [];
                break;
            case 'tags':
                values = (board as any).tags || [];
                break;
            default:
                values = ['Unknown'];
        }

        for (const value of values) {
            if (value) {
                categoryCount.set(value, (categoryCount.get(value) || 0) + 1);
            }
        }
    }

    const categories = Array.from(categoryCount.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    const toolResult = {
        is_error: false,
        content: formatCategoriesOutput('boards', dimension, categories, boards.length, filterBy),
        metadata: { type: 'boards', dimension, categories, total: boards.length, filterBy, dataFormat: 'new' }
    };
    return injectTodoReminder(toolResult, 'get_hardware_categories');
}

/**
 * 获取库分类
 */
async function getLibraryCategories(
    configService: ConfigService,
    dimension: string,
    filterBy?: { category?: string }
) {
    // 优先使用新格式数据
    let libraries = configService.libraryIndex || [];

    if (libraries.length === 0) {
        // 降级到旧格式
        const oldLibraries = configService.libraryList || [];
        if (oldLibraries.length === 0) {
            const toolResult = {
                is_error: false,
                content: '暂无库数据'
            };
            return injectTodoReminder(toolResult, 'get_hardware_categories');
        }

        const toolResult = {
            is_error: false,
            content: `旧格式数据不支持 ${dimension} 维度分类，请升级到新索引格式`
        };
        return injectTodoReminder(toolResult, 'get_hardware_categories');
    }

    // 新格式处理
    // 应用预过滤
    if (filterBy?.category) {
        libraries = libraries.filter((lib: any) => 
            lib.category?.toLowerCase() === filterBy.category!.toLowerCase()
        );
    }

    const categoryCount = new Map<string, number>();

    for (const lib of libraries) {
        let values: string[] = [];

        switch (dimension) {
            case 'category':
                values = [(lib as any).category || 'Unknown'];
                break;
            case 'hardwareType':
                values = (lib as any).hardwareType || [];
                break;
            case 'communication':
                values = (lib as any).communication || [];
                break;
            case 'supportedCores':
                values = (lib as any).supportedCores || [];
                break;
            default:
                values = ['Unknown'];
        }

        for (const value of values) {
            if (value) {
                categoryCount.set(value, (categoryCount.get(value) || 0) + 1);
            }
        }
    }

    const categories = Array.from(categoryCount.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count);

    const toolResult = {
        is_error: false,
        content: formatCategoriesOutput('libraries', dimension, categories, libraries.length, filterBy),
        metadata: { type: 'libraries', dimension, categories, total: libraries.length, filterBy, dataFormat: 'new' }
    };
    return injectTodoReminder(toolResult, 'get_hardware_categories');
}

/**
 * 格式化分类输出
 */
function formatCategoriesOutput(
    type: 'boards' | 'libraries',
    dimension: string,
    categories: Array<{ name: string; count: number }>,
    total: number,
    filterBy?: any
): string {
    const typeLabel = type === 'boards' ? '开发板' : '库';
    const dimensionLabels: Record<string, string> = {
        architecture: '架构',
        connectivity: '连接方式',
        interfaces: '接口类型',
        tags: '用途标签',
        category: '主分类',
        hardwareType: '硬件类型',
        communication: '通信协议',
        supportedCores: '支持内核'
    };
    const dimensionLabel = dimensionLabels[dimension] || dimension;

    let output = `## ${typeLabel}${dimensionLabel}分类\n\n`;
    
    if (filterBy && Object.keys(filterBy).length > 0) {
        output += `**筛选条件:** ${JSON.stringify(filterBy)}\n`;
    }
    output += `**总数:** ${total} 个${typeLabel}\n`;
    output += `**分类数:** ${categories.length} 个\n\n`;

    output += `| ${dimensionLabel} | 数量 |\n`;
    output += `|---|---|\n`;
    
    for (const cat of categories) {
        output += `| ${cat.name} | ${cat.count} |\n`;
    }

    output += `\n**使用提示:** 使用 search_boards_libraries 工具可按这些分类进行精确搜索`;

    return output;
}
