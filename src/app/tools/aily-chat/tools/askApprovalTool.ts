import { ToolUseResult } from "./tools";

export async function askApprovalTool(toolArgs: any): Promise<ToolUseResult> {
    let toolResult = null;
    let is_error = false;

    try {
        // Extract message from toolArgs
        const { message } = toolArgs;
        
        // 使用confirm对话框获取用户确认
        const userConfirmed = window.confirm(message || "请确认是否继续？");
        if (userConfirmed) {
            toolResult = "用户已确认操作。";
        } else {
            toolResult = "用户已取消操作。";
        }
    } catch (error) {
        is_error = true;
        toolResult = {
            error: `Error in askApprovalTool: ${error instanceof Error ? error.message : String(error)}`
        };
    }
    // Return the result
    return {
        content: toolResult,
        is_error
    };
}