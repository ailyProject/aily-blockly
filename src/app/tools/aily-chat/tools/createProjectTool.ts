import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";

export async function newProjectTool(prjService: ProjectService, prjRootPath: string, toolArgs: any): Promise<ToolUseResult> {
    let toolResult = null;
    let is_error = false;

    try {
        const prjName = prjService.generateUniqueProjectName(prjRootPath)
        await prjService.projectNew({
            name: prjName,
            path: prjRootPath,
            board: JSON.parse(toolArgs.board)
        }, false);
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