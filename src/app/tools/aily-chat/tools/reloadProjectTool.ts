import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";

export async function reloadProjectTool(
    projectService: ProjectService,
    args: any
): Promise<ToolUseResult> {
    try {
        // 先保存项目
        const saveResult = await projectService.save();
        if (!saveResult.success) {
            return {
                is_error: true,
                content: JSON.stringify({
                    success: false,
                    error: '项目保存失败: ' + (saveResult.error || '未知错误')
                })
            };
        }

        // 给一点时间让保存完成，然后重新加载
        await new Promise(resolve => setTimeout(resolve, 100));
        await projectService.projectOpen();

        return {
            is_error: false,
            content: JSON.stringify({
                success: true,
                message: '项目已重新加载'
            })
        };
    } catch (error) {
        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                error: '重新加载项目失败: ' + (error.message || '未知错误')
            })
        };
    }
}
