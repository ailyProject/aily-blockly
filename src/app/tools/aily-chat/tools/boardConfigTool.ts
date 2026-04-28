import { ToolUseResult } from "./tools";

interface GetBoardConfigInput {
    /** 不需要参数，自动获取当前开发板的配置 */
}

interface SetBoardConfigInput {
    /** 配置项键名，如 UploadSpeed, FlashMode, FlashSize, PartitionScheme 等 */
    config_key: string;
    /** 配置项的值（对应选项的 data 字段） */
    config_value: string;
}

/**
 * 获取当前开发板的编译/烧录配置选项
 *
 * 根据当前开发板类型（ESP32/STM32/nRF5），返回可配置项及其可选值和当前选中值
 */
export async function getBoardConfigTool(
    projectService: any,
    _input: GetBoardConfigInput
): Promise<ToolUseResult> {
    if (!projectService.currentProjectPath) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: '当前没有打开的项目，请先创建或打开一个项目'
            })
        };
    }

    const boardConfig = projectService.currentBoardConfig;
    if (!boardConfig) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: '无法获取当前开发板配置信息'
            })
        };
    }

    const core: string = boardConfig['core'] || '';
    const boardType: string = boardConfig['type'] || '';
    const boardDescription: string = boardConfig['description'] || '';

    // 从 type 中提取 board 标识（如 esp32:esp32:esp32s3 → esp32s3）
    const typeParts = boardType.split(':');
    const boardIdent = typeParts[typeParts.length - 1];

    try {
        let configMenu: any[] | null = null;
        let configType = '';

        if (core.indexOf('esp32') > -1) {
            configType = 'ESP32';
            configMenu = await projectService.updateEsp32ConfigMenu(boardIdent);
        } else if (core.indexOf('stm32') > -1 && boardDescription.indexOf('Series') > -1) {
            configType = 'STM32';
            configMenu = await projectService.updateStm32ConfigMenu(boardIdent);
        } else if (core.indexOf('nRF5') > -1) {
            configType = 'nRF5';
            configMenu = await projectService.updateNrf5ConfigMenu(boardIdent);
        }

        if (!configMenu) {
            return {
                is_error: false,
                content: JSON.stringify({
                    success: true,
                    message: `当前开发板 "${boardDescription}" 没有额外的编译/烧录配置选项`,
                    board: boardDescription,
                    core: core,
                    config_items: []
                })
            };
        }

        // 获取当前项目配置
        let currentProjectConfig: any = {};
        try {
            currentProjectConfig = await projectService.getProjectConfig();
        } catch { /* 忽略 */ }

        // 将菜单数据转换为工具友好的格式
        const configItems: any[] = [];
        for (const menuItem of configMenu) {
            if (menuItem.sep) continue; // 跳过分隔符

            const item: any = {
                name: menuItem.name,
                options: []
            };

            if (menuItem.children && menuItem.children.length > 0) {
                // 从 menuItem.name 中提取 key（如 ESP32.UPLOAD_SPEED → UploadSpeed）
                const configKey = menuItem.children[0]?.key || '';
                item.config_key = configKey;
                item.current_value = currentProjectConfig[configKey] || null;

                item.options = menuItem.children.map((child: any) => ({
                    name: child.name,
                    value: child.data,
                    selected: child.check === true
                }));
            }

            configItems.push(item);
        }

        return {
            is_error: false,
            content: JSON.stringify({
                success: true,
                board: boardDescription,
                core: core,
                config_type: configType,
                config_items: configItems
            })
        };
    } catch (error: any) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: `获取开发板配置失败: ${error.message || String(error)}`
            })
        };
    }
}

/**
 * 设置当前开发板的编译/烧录配置项
 *
 * 修改 package.json 中的 projectConfig 来更新配置，并触发预编译
 */
export async function setBoardConfigTool(
    projectService: any,
    builderService: any,
    input: SetBoardConfigInput
): Promise<ToolUseResult> {
    const { config_key, config_value } = input;

    if (!config_key || config_value === undefined || config_value === null) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: '缺少必填参数 config_key 和 config_value'
            })
        };
    }

    if (!projectService.currentProjectPath) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: '当前没有打开的项目，请先创建或打开一个项目'
            })
        };
    }

    try {
        // 读取并更新 package.json 中的 projectConfig
        const packageJson = await projectService.getPackageJson();
        packageJson['projectConfig'] = packageJson['projectConfig'] || {};

        const oldValue = packageJson['projectConfig'][config_key];
        packageJson['projectConfig'][config_key] = config_value;

        await projectService.setPackageJson(packageJson);

        // 如果是 STM32 的 pnum 配置变更，处理引脚配置同步
        const boardConfig = projectService.currentBoardConfig;
        if (boardConfig && boardConfig['core']?.indexOf('stm32') > -1 &&
            boardConfig['description']?.indexOf('Series') > -1 &&
            config_key === 'pnum') {
            // 构造 subItem 兼容对象用于比较引脚配置
            try {
                const boardType = boardConfig['type'] || '';
                const typeParts = boardType.split(':');
                const boardIdent = typeParts[typeParts.length - 1];
                const stm32Config = await projectService.getStm32BoardConfig(boardIdent);
                if (stm32Config?.board) {
                    const matchedItem = stm32Config.board.find((item: any) => item.data === config_value);
                    if (matchedItem) {
                        projectService.compareStm32PinConfig(matchedItem);
                    }
                }
            } catch (e) {
                console.warn('STM32 引脚配置同步失败:', e);
            }
        }

        // 触发预编译操作：配置变更后自动触发预编译
        if (builderService?.triggerPreprocess) {
            builderService.triggerPreprocess('config-changed');
        }

        return {
            is_error: false,
            content: JSON.stringify({
                success: true,
                message: `配置项 "${config_key}" 已更新为 "${config_value}"`,
                config_key,
                old_value: oldValue || null,
                new_value: config_value
            })
        };
    } catch (error: any) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: `设置配置项失败: ${error.message || String(error)}`
            })
        };
    }
}
