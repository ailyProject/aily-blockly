import { ToolUseResult } from "./tools";
import { CmdService } from "../../../services/cmd.service";


export async function executeCommandTool(cmdService: CmdService, data: any): Promise<ToolUseResult> {
    let toolResult = null;
    let is_error = false;

    try {
        if (!data || !data.command) {
            toolResult = "执行command命令失败: 缺少必要的参数 'command'";
            is_error = true;
            return {
                is_error,
                content: toolResult
            };
        }

        console.log('Executing command:', data.command, 'in directory:', data.cwd);

        if (!data.cwd) {
            toolResult = "执行command命令失败: 当前未打开项目";
            is_error = true;
            return {
                is_error,
                content: toolResult
            };
        }

        // 使用 Promise 包装 Observable 来等待命令执行完成
        const result = await new Promise<string>((resolve, reject) => {
            let output = '';
            
            cmdService.run(data.command, data.cwd, false).subscribe({
                next: (data) => {
                    console.log(`Command output received:`, data);

                    // 正确处理CmdOutput对象，提取data字段
                    let textOutput = '';
                    if (data && data.data) {
                        textOutput = data.data;
                    } else if (data && data.error) {
                        textOutput = data.error;
                    } else {
                        textOutput = JSON.stringify(data);
                    }
                    console.log(`Command output: ${textOutput}`);
                    output += textOutput;
                },
                error: (err) => {
                    console.error(`Command error: ${err}`);
                    is_error = true;
                    reject(err);
                },
                complete: () => {
                    console.log('Command execution completed');
                    resolve(output);
                }
            });
        });

        toolResult = result || '命令执行完成';
        
    } catch (e) {
        console.error('执行command命令失败:', e);
        toolResult = `执行command命令失败: ${e.message}`;
        is_error = true;
    } finally {
        console.log('executeCommandTool result:', toolResult, 'is_error:', is_error);
        return {
            is_error,
            content: toolResult
        };
    }
}