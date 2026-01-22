import { ToolUseResult } from "./tools";
import { injectTodoReminder } from "./todoWriteTool";
import { normalizePath } from "../services/security.service";

/**
 * 检查 ripgrep 是否可用
 */
let ripgrepAvailable: boolean | null = null;
async function checkRipgrepAvailable(): Promise<boolean> {
    if (ripgrepAvailable !== null) {
        return ripgrepAvailable;
    }
    
    try {
        // ripgrep API 在 window.electronAPI.ripgrep 下
        const electronAPI = (window as any).electronAPI;
        if (electronAPI?.ripgrep && typeof electronAPI.ripgrep.isRipgrepAvailable === 'function') {
            ripgrepAvailable = await electronAPI.ripgrep.isRipgrepAvailable();
            // console.log('Ripgrep 可用性检测:', ripgrepAvailable);
            return ripgrepAvailable;
        }
    } catch (error) {
        console.warn('检测 ripgrep 失败:', error);
    }
    
    ripgrepAvailable = false;
    return false;
}

/**
 * 使用 ripgrep 进行搜索（高性能）
 */
async function searchWithRipgrep(
    pattern: string,
    searchPath: string,
    include?: string,
    isRegex: boolean = true,
    ignoreCase: boolean = true,
    wholeWord: boolean = false
): Promise<{ numFiles: number, filenames: string[], durationMs: number } | null> {
    try {
        const electronAPI = (window as any).electronAPI;
        if (!electronAPI?.ripgrep || typeof electronAPI.ripgrep.searchFiles !== 'function') {
            return null;
        }
        
        const result = await electronAPI.ripgrep.searchFiles({
            pattern,
            path: searchPath,
            include,
            isRegex,
            maxResults: 50,
            ignoreCase,
            wholeWord
        });
        
        if (!result.success) {
            console.warn('Ripgrep 搜索失败:', result.error);
            return null;
        }
        
        return {
            numFiles: result.numFiles,
            filenames: result.filenames,
            durationMs: result.durationMs
        };
    } catch (error) {
        console.warn('Ripgrep 搜索错误:', error);
        return null;
    }
}

/**
 * 递归搜索文件内容
 * @param searchPath 搜索路径
 * @param pattern 搜索模式（正则表达式字符串或普通文本）
 * @param includePattern 文件包含模式（glob格式，如 "*.js", "*.{ts,tsx}"）
 * @param isRegex 是否为正则表达式
 * @param maxResults 最大结果数
 * @returns 匹配的文件路径数组
 */
function searchFilesRecursive(
    searchPath: string,
    pattern: string,
    includePattern?: string,
    isRegex: boolean = true,
    maxResults: number = 50,
    ignoreCase: boolean = true,
    wholeWord: boolean = false
): { filenames: string[], numFiles: number } {
    const matchedFiles: string[] = [];
    const visited = new Set<string>();
    
    // 编译搜索正则表达式
    let searchRegex: RegExp;
    try {
        const flags = ignoreCase ? 'i' : '';
        if (isRegex) {
            searchRegex = new RegExp(pattern, flags);
        } else {
            // 如果不是正则表达式，进行转义并创建普通文本搜索
            const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // 如果启用 wholeWord，添加单词边界
            const finalPattern = wholeWord ? `\\b${escapedPattern}\\b` : escapedPattern;
            searchRegex = new RegExp(finalPattern, flags);
        }
    } catch (error: any) {
        throw new Error(`无效的搜索模式 "${pattern}": ${error.message}。${isRegex ? '如果使用正则表达式，请确保语法正确。如需匹配特殊字符，请设置 isRegex=false' : ''}`);
    }
    
    // 解析文件包含模式
    let includeRegex: RegExp | null = null;
    if (includePattern) {
        // 将 glob 模式转换为正则表达式
        // 支持 "*.js", "*.{ts,tsx}" 等格式
        const globToRegex = (glob: string): string => {
            return glob
                .replace(/\./g, '\\.')  // 转义点号
                .replace(/\*\*/g, '.*')  // ** 匹配任意路径
                .replace(/\*/g, '[^/\\\\]*')  // * 匹配文件名部分
                .replace(/\{([^}]+)\}/g, (_, group) => `(${group.replace(/,/g, '|')})`)  // {a,b} 转为 (a|b)
                .replace(/\?/g, '.');  // ? 匹配单个字符
        };
        
        const regexPattern = globToRegex(includePattern);
        includeRegex = new RegExp(regexPattern + '$', 'i');
    }
    
    // 递归搜索目录
    function searchDirectory(dirPath: string, depth: number = 0): void {
        // 限制递归深度，防止无限递归
        if (depth > 20 || matchedFiles.length >= maxResults) {
            return;
        }
        
        // 防止循环引用
        const realPath = window['fs'].realpathSync ? window['fs'].realpathSync(dirPath) : dirPath;
        if (visited.has(realPath)) {
            return;
        }
        visited.add(realPath);
        
        try {
            const entries = window['fs'].readDirSync(dirPath);
            
            for (const entry of entries) {
                if (matchedFiles.length >= maxResults) {
                    break;
                }
                
                const fullPath = window['path'].join(dirPath, entry.name);
                
                // 跳过常见的需要忽略的目录
                const skipDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'out', 'coverage'];
                if (skipDirs.includes(entry.name)) {
                    continue;
                }
                
                try {
                    const stats = window['fs'].statSync(fullPath);
                    
                    if (stats.isDirectory()) {
                        // 递归搜索子目录
                        searchDirectory(fullPath, depth + 1);
                    } else if (stats.isFile()) {
                        // 检查文件是否匹配包含模式
                        if (includeRegex && !includeRegex.test(fullPath)) {
                            continue;
                        }
                        
                        // 读取文件内容并搜索
                        try {
                            const content = window['fs'].readFileSync(fullPath, 'utf-8');
                            if (searchRegex.test(content)) {
                                matchedFiles.push(fullPath);
                            }
                        } catch (readError) {
                            // 忽略无法读取的文件（如二进制文件）
                            console.debug(`无法读取文件: ${fullPath}`, readError);
                        }
                    }
                } catch (statError) {
                    // 忽略无法访问的文件
                    console.debug(`无法访问: ${fullPath}`, statError);
                }
            }
        } catch (error) {
            // 忽略无法读取的目录
            console.debug(`无法读取目录: ${dirPath}`, error);
        }
    }
    
    // 开始搜索
    searchDirectory(searchPath);
    
    // 按修改时间排序（最新的在前）
    try {
        matchedFiles.sort((a, b) => {
            try {
                const statsA = window['fs'].statSync(a);
                const statsB = window['fs'].statSync(b);
                const timeComparison = statsB.mtime.getTime() - statsA.mtime.getTime();
                
                if (timeComparison === 0) {
                    // 时间相同时按文件名排序
                    return a.localeCompare(b);
                }
                
                return timeComparison;
            } catch {
                return a.localeCompare(b);
            }
        });
    } catch (error) {
        // 排序失败时保持原顺序
        console.debug('文件排序失败', error);
    }
    
    return {
        filenames: matchedFiles,
        numFiles: matchedFiles.length
    };
}

/**
 * Grep 搜索工具 - 在文件内容中搜索指定模式
 * @param params 参数
 * @returns 工具执行结果
 */
export async function grepTool(
    params: {
        pattern: string;
        path?: string;
        include?: string;
        isRegex?: boolean;
        returnContent?: boolean;
        contextLines?: number;
        maxLineLength?: number;
        maxResults?: number;
        ignoreCase?: boolean;
        wholeWord?: boolean;
    }
): Promise<ToolUseResult> {
    const startTime = Date.now();
    
    try {
        let { 
            pattern, 
            path, 
            include, 
            isRegex = true,
            returnContent = false,
            contextLines = 0,
            maxLineLength = 500,
            maxResults = 50,
            ignoreCase = true,
            wholeWord = false
        } = params;
        
        // 验证搜索模式
        if (!pattern || pattern.trim() === '') {
            const toolResult = {
                is_error: true,
                content: '搜索模式不能为空'
            };
            return injectTodoReminder(toolResult, 'grepTool');
        }
        
        // 默认使用当前工作目录
        let searchPath = path || '';
        
        // 如果未提供路径，尝试获取当前项目路径
        if (!searchPath) {
            // 可以从全局上下文获取项目路径
            if (window['prjService'] && window['prjService'].project && window['prjService'].project.path) {
                searchPath = window['prjService'].project.path;
            } else {
                const toolResult = {
                    is_error: true,
                    content: '未提供搜索路径，且无法获取当前项目路径'
                };
                return injectTodoReminder(toolResult, 'grepTool');
            }
        }
        
        // 路径规范化
        searchPath = normalizePath(searchPath);
        
        // console.log(`搜索文件内容: pattern="${pattern}", path="${searchPath}", include="${include || 'all'}"`);
        
        // 验证路径是否存在
        if (!window['fs'].existsSync(searchPath)) {
            const toolResult = {
                is_error: true,
                content: `搜索路径不存在: ${searchPath}`
            };
            return injectTodoReminder(toolResult, 'grepTool');
        }
        
        // 检查是否为目录
        const isDirectory = window['fs'].isDirectory(searchPath);
        if (!isDirectory) {
            const toolResult = {
                is_error: true,
                content: `搜索路径不是目录: ${searchPath}`
            };
            return injectTodoReminder(toolResult, 'grepTool');
        }
        
        // 首先检查 ripgrep 是否可用
        const ripgrepReady = await checkRipgrepAvailable();
        
        // 如果需要返回内容，使用 searchContent
        if (returnContent && ripgrepReady) {
            // console.log('使用 ripgrep searchContent 返回匹配内容');
            
            try {
                const electronAPI = (window as any).electronAPI;
                
                // 🆕 动态调整策略：先用较小的 maxLineLength 试探性搜索
                let effectiveMaxLineLength = Math.min(Math.max(100, maxLineLength || 500), 2000);
                let effectiveMaxResults = maxResults;
                
                // 如果 maxLineLength 过小（<300），可能漏掉关键内容，自动提高到 500
                if (effectiveMaxLineLength < 300) {
                    console.warn(`maxLineLength 太小 (${effectiveMaxLineLength})，自动调整到 500 以避免遗漏关键内容`);
                    effectiveMaxLineLength = 500;
                }
                
                // 如果 maxLineLength 过大（>1000），减少 maxResults 防止数据过载
                if (effectiveMaxLineLength > 1000) {
                    effectiveMaxResults = Math.min(maxResults, 10);
                    console.warn(`maxLineLength 较大 (${effectiveMaxLineLength})，降低 maxResults 到 ${effectiveMaxResults} 防止数据过载`);
                }
                
                const result = await electronAPI.ripgrep.searchContent({
                    pattern,
                    path: searchPath,
                    include,
                    isRegex,
                    maxResults: effectiveMaxResults,
                    ignoreCase,
                    contextLines: Math.min(Math.max(0, contextLines || 0), 5), // 限制0-5
                    maxLineLength: effectiveMaxLineLength
                });
                
                const durationMs = Date.now() - startTime;
                
                if (!result.success) {
                    console.warn('Ripgrep searchContent 失败:', result.error);
                    const toolResult = {
                        is_error: true,
                        content: `搜索失败: ${result.error}`
                    };
                    return injectTodoReminder(toolResult, 'grepTool');
                }
                
                // 构建返回内容
                if (result.numMatches === 0) {
                    const toolResult = {
                        is_error: false,
                        content: `未找到匹配的内容\n搜索模式: ${pattern}\n搜索路径: ${searchPath}${include ? `\n文件过滤: ${include}` : ''}`
                    };
                    return injectTodoReminder(toolResult, 'grepTool');
                }
                
                // 🆕 数据量控制：最大 20KB 硬性限制
                const MAX_CONTENT_SIZE = 20 * 1024; // 20KB
                let resultContent = `找到 ${result.numMatches} 个匹配项\n`;
                resultContent += `搜索模式: ${pattern}\n`;
                resultContent += `搜索路径: ${searchPath}\n`;
                if (include) {
                    resultContent += `文件过滤: ${include}\n`;
                }
                resultContent += `耗时: ${result.durationMs}ms (使用 ripgrep)\n`;
                resultContent += `每行最大长度: ${effectiveMaxLineLength} 字符\n\n`;
                
                // 按文件分组显示匹配内容
                const byFile: { [file: string]: typeof result.matches } = {};
                result.matches.forEach((match: any) => {
                    if (!byFile[match.file]) {
                        byFile[match.file] = [];
                    }
                    byFile[match.file].push(match);
                });
                
                let needContent = true;
                let warnContent = '';
                let truncated = false;
                let displayedMatches = 0;
                let currentSize = new Blob([resultContent]).size;
                
                for (const [file, matches] of Object.entries(byFile)) {
                    const fileHeader = `━━━ 文件: ${file} (${matches.length} 个匹配) ━━━\n`;
                    const headerSize = new Blob([fileHeader]).size;
                    
                    // 检查添加文件头后是否超过限制
                    if (currentSize + headerSize > MAX_CONTENT_SIZE) {
                        truncated = true;
                        break;
                    }
                    
                    resultContent += fileHeader;
                    currentSize += headerSize;
                    
                    for (const [matchIndex, match] of matches.entries()) {
                        const matchLine = `  [${displayedMatches + 1}] 行 ${match.line}:\n      ${match.content}\n`;
                        const matchSize = new Blob([matchLine]).size;
                        
                        // 检查添加匹配内容后是否超过限制
                        if (currentSize + matchSize > MAX_CONTENT_SIZE) {
                            truncated = true;
                            break;
                        }
                        
                        resultContent += matchLine;
                        currentSize += matchSize;
                        displayedMatches++;
                    }
                    
                    if (truncated) {
                        break;
                    }
                    
                    resultContent += '\n';
                    currentSize += 1;
                }
                
                // 添加截断警告
                if (truncated) {
                    warnContent += `\n⚠️ 数据已截断（超过 ${MAX_CONTENT_SIZE / 1024}KB 限制）\n`;
                    // warnContent += `已显示: ${displayedMatches}/${result.numMatches} 个匹配\n`;
                    warnContent += `建议：使用更精确的搜索模式或增加文件过滤条件（include 参数）`;
                    needContent = false;
                } else if (result.numMatches >= effectiveMaxResults) {
                    warnContent += resultContent;
                    warnContent += `\n⚠️ 结果已截断（达到最大结果数 ${effectiveMaxResults}）\n`;
                    warnContent += `建议：使用更具体的搜索模式或文件过滤`;
                    needContent = false;
                }

                // 日志输出实际大小
                const finalSize = new Blob([resultContent]).size;
                // console.log(`searchContent 完成: ${displayedMatches}/${result.numMatches} 个匹配, 数据大小: ${(finalSize / 1024).toFixed(2)}KB, 耗时 ${result.durationMs}ms`);

                const toolResult = {
                    is_error: false,
                    content: needContent ? resultContent : warnContent,
                    metadata: {
                        numMatches: result.numMatches,
                        displayedMatches,
                        truncated,
                        contentSizeKB: parseFloat((finalSize / 1024).toFixed(2)),
                        durationMs: result.durationMs,
                        pattern,
                        searchPath,
                        include,
                        mode: 'content'
                    }
                };
                return injectTodoReminder(toolResult, 'grepTool');
            } catch (error: any) {
                console.warn('searchContent 失败:', error);
                // 降级到文件名模式
                // console.log('降级到文件名搜索模式');
            }
        }
        
        // 使用文件名模式 (原有逻辑)
        const MAX_RESULTS = maxResults || 100;
        let searchResult: { numFiles: number, filenames: string[], durationMs?: number } | null = null;
        let usingRipgrep = false;
        
        if (ripgrepReady) {
            // console.log('使用 ripgrep 进行文件名搜索');
            searchResult = await searchWithRipgrep(pattern, searchPath, include, isRegex, ignoreCase, wholeWord);
            if (searchResult) {
                usingRipgrep = true;
                // console.log(`Ripgrep 搜索完成: 找到 ${searchResult.numFiles} 个文件, 耗时 ${searchResult.durationMs}ms`);
            }
        }
        
        // 如果 ripgrep 不可用或失败，使用纯 TypeScript 实现作为后备
        if (!searchResult) {
            // if (ripgrepReady) {
            //     console.log('Ripgrep 搜索失败，回退到纯 TypeScript 实现');
            // } else {
            //     console.log('Ripgrep 不可用，使用纯 TypeScript 实现');
            // }
            
            const jsResult = searchFilesRecursive(
                searchPath,
                pattern,
                include,
                isRegex,
                MAX_RESULTS,
                ignoreCase,
                wholeWord
            );
            
            searchResult = {
                numFiles: jsResult.numFiles,
                filenames: jsResult.filenames
            };
        }
        
        const { filenames, numFiles } = searchResult;
        const durationMs = searchResult.durationMs || (Date.now() - startTime);
        
        // 构建结果内容
        let resultContent = '';
        
        if (numFiles === 0) {
            resultContent = `未找到匹配的文件\n搜索模式: ${pattern}\n搜索路径: ${searchPath}`;
            if (include) {
                resultContent += `\n文件过滤: ${include}`;
            }
        } else {
            resultContent = `找到 ${numFiles} 个文件包含模式 "${pattern}"\n`;
            resultContent += `搜索路径: ${searchPath}\n`;
            if (include) {
                resultContent += `文件过滤: ${include}\n`;
            }
            resultContent += `耗时: ${durationMs}ms`;
            if (usingRipgrep) {
                resultContent += ` (使用 ripgrep)`;
            }
            resultContent += `\n\n`;
            
            // 显示文件列表
            const displayFiles = filenames.slice(0, MAX_RESULTS);
            resultContent += displayFiles.join('\n');
            
            if (numFiles > MAX_RESULTS) {
                resultContent += `\n\n(结果已截断，仅显示前 ${MAX_RESULTS} 个结果。请使用更具体的搜索模式或文件过滤)`;
            }
        }
        
        const toolResult = {
            is_error: false,
            content: resultContent,
            metadata: {
                numFiles,
                filenames,
                durationMs,
                pattern,
                searchPath,
                include
            }
        };
        
        return injectTodoReminder(toolResult, 'grepTool');
    } catch (error: any) {
        console.warn("Grep搜索失败:", error);
        
        let errorMessage = `搜索失败: ${error.message}`;
        if (error.code) {
            errorMessage += `\n错误代码: ${error.code}`;
        }
        
        const toolResult = {
            is_error: true,
            content: errorMessage
        };
        return injectTodoReminder(toolResult, 'grepTool');
    }
}
