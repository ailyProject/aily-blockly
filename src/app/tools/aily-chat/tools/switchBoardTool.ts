import { ToolUseResult } from "./tools";

interface SwitchBoardInput {
    /** 开发板包名称，如 "@aily-project/board-esp32_devkitc" */
    board_name: string;
    /** 开发板包版本（可选，不指定使用最新版） */
    board_version?: string;
}

/**
 * 切换开发板工具 - 在当前项目中切换到指定开发板
 *
 * 流程：卸载当前开发板包 → 安装新开发板包 → 合并项目配置 → 重新加载项目
 */
export async function switchBoardTool(
    projectService: any,
    input: SwitchBoardInput
): Promise<ToolUseResult> {
    const { board_name, board_version } = input;

    if (!board_name) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: '缺少必填参数 board_name（开发板包名称）'
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
        // 获取当前开发板信息（用于对比）
        let currentBoard = '';
        try {
            currentBoard = await projectService.getBoardModule();
        } catch { /* 忽略 */ }

        if (currentBoard === board_name) {
            return {
                is_error: false,
                content: JSON.stringify({
                    success: true,
                    message: `当前项目已在使用开发板 "${board_name}"，无需切换`
                })
            };
        }

        // 调用切换开发板，如果未指定版本则使用 'latest'
        await projectService.changeBoard({
            name: board_name,
            version: board_version || 'latest'
        });

        return {
            is_error: false,
            content: JSON.stringify({
                success: true,
                message: `开发板已成功切换为 "${board_name}"`,
                previous_board: currentBoard || undefined
            }),
            metadata: { boardChanged: true }
        };
    } catch (error: any) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: `切换开发板失败: ${error.message || String(error)}`
            })
        };
    }
}
