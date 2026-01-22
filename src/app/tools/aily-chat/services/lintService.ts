/**
 * Lint 服务 - 用于检测 .json 和 .js 文件的语法错误
 * 在创建或编辑文件时自动进行 lint 检测
 */

export interface LintError {
    line: number;
    column: number;
    message: string;
    severity: 'error' | 'warning';
}

export interface LintResult {
    isValid: boolean;
    errors: LintError[];
    language: 'json' | 'javascript' | 'unknown';
    filePath: string;
}

/**
 * 判断文件是否需要 lint
 */
export function shouldLint(filePath: string): boolean {
    if (!filePath) return false;
    const ext = filePath.toLowerCase().split('.').pop();
    return ext === 'json' || ext === 'js';
}

/**
 * 获取文件类型
 */
export function getFileType(filePath: string): 'json' | 'javascript' | 'unknown' {
    if (!filePath) return 'unknown';
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext === 'json') return 'json';
    if (ext === 'js') return 'javascript';
    return 'unknown';
}

/**
 * Lint JSON 文件内容
 */
export function lintJson(content: string, filePath: string): LintResult {
    const result: LintResult = {
        isValid: true,
        errors: [],
        language: 'json',
        filePath
    };

    if (!content || content.trim() === '') {
        // 空内容认为是有效的（空 JSON 文件）
        return result;
    }

    try {
        JSON.parse(content);
    } catch (error: any) {
        result.isValid = false;
        
        // 尝试解析错误位置
        const errorInfo = parseJsonError(error.message, content);
        
        result.errors.push({
            line: errorInfo.line,
            column: errorInfo.column,
            message: errorInfo.message,
            severity: 'error'
        });
    }

    return result;
}

/**
 * 解析 JSON 错误信息，提取行号和列号
 */
function parseJsonError(errorMessage: string, content: string): { line: number; column: number; message: string } {
    // 默认值
    let line = 1;
    let column = 1;
    let message = errorMessage;

    // 尝试从错误信息中提取位置
    // 常见格式: "Unexpected token } in JSON at position 123"
    const positionMatch = errorMessage.match(/at position (\d+)/i);
    if (positionMatch) {
        const position = parseInt(positionMatch[1], 10);
        const { line: l, column: c } = getLineAndColumn(content, position);
        line = l;
        column = c;
    }

    // 另一种格式: "Unexpected end of JSON input"
    // 这种情况下，错误在文件末尾
    if (errorMessage.includes('Unexpected end')) {
        const lines = content.split('\n');
        line = lines.length;
        column = (lines[lines.length - 1] || '').length + 1;
    }

    return { line, column, message };
}

/**
 * 根据字符位置计算行号和列号
 */
function getLineAndColumn(content: string, position: number): { line: number; column: number } {
    const lines = content.substring(0, position).split('\n');
    const line = lines.length;
    const column = (lines[lines.length - 1] || '').length + 1;
    return { line, column };
}

/**
 * Lint JavaScript 文件内容
 * 使用浏览器内置的解析能力或简单的语法检查
 */
export function lintJavaScript(content: string, filePath: string): LintResult {
    const result: LintResult = {
        isValid: true,
        errors: [],
        language: 'javascript',
        filePath
    };

    if (!content || content.trim() === '') {
        return result;
    }

    try {
        // 方法1: 使用 Function 构造器检查语法（不执行代码）
        // 这是浏览器环境中最可靠的方式
        new Function(content);
    } catch (error: any) {
        result.isValid = false;
        
        // 解析 JavaScript 语法错误
        const errorInfo = parseJavaScriptError(error, content);
        
        result.errors.push({
            line: errorInfo.line,
            column: errorInfo.column,
            message: errorInfo.message,
            severity: 'error'
        });
    }

    return result;
}

/**
 * 解析 JavaScript 语法错误
 */
function parseJavaScriptError(error: Error, content: string): { line: number; column: number; message: string } {
    let line = 1;
    let column = 1;
    let message = error.message || 'JavaScript syntax error';

    // SyntaxError 通常包含行号信息
    // 格式可能是: "SyntaxError: Unexpected token } (line 5)"
    // 或: "SyntaxError: Unexpected token '}'"
    
    // 尝试从 stack 中提取位置
    if (error.stack) {
        // Chrome/V8 格式: "SyntaxError: Unexpected token } at <anonymous>:5:10"
        const stackMatch = error.stack.match(/<anonymous>:(\d+):(\d+)/);
        if (stackMatch) {
            line = parseInt(stackMatch[1], 10);
            column = parseInt(stackMatch[2], 10);
            // Function 构造器会自动添加包装代码，需要调整行号
            // 通常需要减去 2 行（function anonymous() {\n 和 \n}）
            line = Math.max(1, line - 2);
        }
    }

    // 尝试从错误消息中提取行号
    const lineMatch = message.match(/line (\d+)/i);
    if (lineMatch) {
        line = parseInt(lineMatch[1], 10);
    }

    return { line, column, message };
}

/**
 * 对文件内容进行 Lint 检测
 * @param content 文件内容
 * @param filePath 文件路径（用于判断文件类型）
 * @returns Lint 结果
 */
export function lintContent(content: string, filePath: string): LintResult | null {
    if (!shouldLint(filePath)) {
        return null;
    }

    const fileType = getFileType(filePath);
    
    switch (fileType) {
        case 'json':
            return lintJson(content, filePath);
        case 'javascript':
            return lintJavaScript(content, filePath);
        default:
            return null;
    }
}

/**
 * 格式化 Lint 结果为用户友好的错误信息
 */
export function formatLintErrors(lintResult: LintResult): string {
    if (lintResult.isValid || lintResult.errors.length === 0) {
        return '';
    }

    const langName = lintResult.language === 'json' ? 'JSON' : 'JavaScript';
    const lines: string[] = [
        `\n⚠️ ${langName} Syntax Error Detected:`
    ];

    lintResult.errors.forEach((error, index) => {
        const locationInfo = error.line > 0 
            ? `Line ${error.line}${error.column > 1 ? `, Column ${error.column}` : ''}`
            : 'Location unknown';
        
        lines.push(`  ${index + 1}. [${error.severity === 'error' ? 'Error' : 'Warning'}] ${locationInfo}`);
        lines.push(`     ${error.message}`);
    });

    lines.push('');
    lines.push('💡 Suggestion: Please fix the syntax errors above and try again.');

    return lines.join('\n');
}

/**
 * 执行 Lint 检测并返回格式化的错误信息
 * 这是供其他工具调用的便捷方法
 * @param content 文件内容
 * @param filePath 文件路径
 * @returns 如果有错误返回格式化的错误信息，否则返回空字符串
 */
export function lintAndFormat(content: string, filePath: string): string {
    const lintResult = lintContent(content, filePath);
    
    if (!lintResult) {
        return ''; // 不需要 lint 的文件类型
    }

    return formatLintErrors(lintResult);
}

/**
 * 检测文件是否有语法错误
 * @returns true 如果有错误，false 如果没有错误或不需要检测
 */
export function hasLintErrors(content: string, filePath: string): boolean {
    const lintResult = lintContent(content, filePath);
    return lintResult ? !lintResult.isValid : false;
}
