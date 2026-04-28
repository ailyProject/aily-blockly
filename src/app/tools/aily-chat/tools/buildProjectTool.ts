import { ToolUseResult } from "./tools";
import { BuilderService } from "../../../services/builder.service";
import { setLastBuildErrors, clearLastBuildErrors } from './getErrorsTool';

interface BuildProjectInput {
    /** 是否仅做预编译检查（更快，但不生成完整产物） */
    preprocess_only?: boolean;
    /** 编译前是否清除编译缓存 */
    clear_cache?: boolean;
}

/** 清除 ANSI 转义码和 [ERROR] 等标签 */
function stripAnsi(str: string): string {
    return str
        .replace(/\u001b\[\d+(;\d+)*m/g, '')   // ANSI 颜色码
        .replace(/\[\d+(;\d+)*m/g, '')          // 无 ESC 前缀的残留
        .replace(/\[ERROR\]\s*/gi, '')          // [ERROR] 标签
        .replace(/\[WARNING\]\s*/gi, '');       // [WARNING] 标签
}

/** 将绝对路径简化为相对于 sketch 目录的短路径 */
function shortenPath(line: string): string {
    // 匹配 .temp/sketch/ 或 .temp\sketch\ 后的文件名部分
    return line.replace(/[A-Za-z]:[\\\/].*?[\\\/]\.temp[\\\/]sketch[\\\/]/g, '');
}

/**
 * 从编译器 stderr 输出中提取关键错误信息
 * 过滤掉冗长的编译命令行，只保留 error/warning 行和相关上下文
 */
function extractCompileErrors(fullStdErr: string): string {
    if (!fullStdErr) return '';

    // 先清除 ANSI 转义码
    const cleaned = stripAnsi(fullStdErr);
    const lines = cleaned.split('\n');
    const relevantLines: string[] = [];

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        // 保留 error / warning / note 行（GCC 格式: file:line:col: error/warning/note: message）
        if (/:\s*(error|warning|note|fatal error):/i.test(trimmed)) {
            relevantLines.push(shortenPath(trimmed));
            continue;
        }
        // 保留 FAILED 行（去掉冗长的命令参数）
        if (trimmed.startsWith('FAILED:')) {
            const brief = trimmed.match(/^FAILED:\s*\[code=\d+\]\s*\S+/);
            relevantLines.push(brief ? brief[0] : trimmed.substring(0, 80));
            continue;
        }
        // 保留 "Compilation failed" 等摘要行
        if (/^Compilation\s+(failed|error)/i.test(trimmed)) {
            relevantLines.push(trimmed);
            continue;
        }
        // 保留 "undefined reference" 链接错误
        if (/undefined reference/i.test(trimmed)) {
            relevantLines.push(shortenPath(trimmed));
            continue;
        }
    }

    // 限制返回长度，避免过长
    const result = relevantLines.join('\n');
    if (result.length > 3000) {
        return result.substring(0, 3000) + '\n... (错误信息已截断)';
    }
    return result;
}

/**
 * 编译项目工具 - 调用编译器检测代码能否正常编译
 */
export async function buildProjectTool(
    builderService: BuilderService,
    input: BuildProjectInput,
    projectPath?: string
): Promise<ToolUseResult> {
    const { preprocess_only = false, clear_cache = false } = input;

    try {
        // 清除编译缓存
        if (clear_cache && projectPath) {
            try {
                await builderService.clearCache(projectPath);
            } catch (e) {
                console.warn('清除编译缓存失败:', e);
            }
        }

        if (preprocess_only) {
            builderService.triggerPreprocess('llm_tool_call');
            return {
                is_error: false,
                content: JSON.stringify({
                    success: true,
                    message: '预编译已触发，请注意预编译为异步操作，不会立即返回编译结果。'
                })
            };
        }

        // 执行完整编译 - 成功时返回结果，失败时会 throw
        const result = await builderService.build();

        // 编译成功 → 清除缓存的编译错误
        clearLastBuildErrors();

        return {
            is_error: false,
            content: JSON.stringify({
                success: true,
                message: '编译成功，代码无语法或链接错误。',
                details: result?.text || undefined
            })
        };
    } catch (error: any) {
        // 从 error.buildResult 中提取详细的编译错误
        const buildResult = error?.buildResult;
        const fullStdErr = buildResult?.fullStdErr || '';
        const errorSummary = buildResult?.text || error?.message || String(error);

        // 提取关键错误信息
        const compileErrors = extractCompileErrors(fullStdErr);

        // 缓存编译错误供 get_errors 工具使用
        if (compileErrors) {
            setLastBuildErrors(compileErrors);
        }

        return {
            is_error: true,
            content: JSON.stringify({
                success: false,
                message: `编译失败: ${errorSummary}`,
                errors: compileErrors || undefined
            })
        };
    }
}
