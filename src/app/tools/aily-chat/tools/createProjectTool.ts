import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";
import { ConfigService } from '../../../services/config.service';

export async function newProjectTool(prjRootPath: string, toolArgs: any, prjService: ProjectService, configService: ConfigService): Promise<ToolUseResult> {
    let toolResult = null;
    let is_error = false;   
    
    try {
        // 判断toolArgs.board是否是JSON字符串
        let boardInfo;
        let boardName;
        try {
            boardInfo = JSON.parse(toolArgs.board);
            boardName = boardInfo.name;
        } catch {
            // 如果解析失败，说明不是JSON字符串，直接使用原值
            boardName = toolArgs.board;
        }

        boardInfo = configService.boardDict[boardName] || null;
        if (!boardInfo) {
            throw new Error(`未找到开发板信息: ${toolArgs.board}`);
        }

        console.log("使用的开发板信息:", boardInfo);

        const prjName = prjService.generateUniqueProjectName(prjRootPath)
        await prjService.projectNew({
            name: prjName,
            path: prjRootPath,
            board: boardInfo
        });
        toolResult = `项目 "${prjName}" 创建成功！项目路径为${prjRootPath}\\${prjName}`;
    } catch (e) {
        console.error('创建项目失败:', e);
        toolResult = `创建项目失败: ${e.message}`;
        is_error = true;
    } finally {
        return {
            is_error,
            content: toolResult
        };
    }
}