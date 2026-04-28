import { ToolUseResult } from "./tools";
import { AilyHost } from '../core/host';

interface LibraryInfo {
    name: string;
    path: string;
    readmeAiPath?: string;
}

interface BoardInfo {
    name: string;
    path: string;
}

interface CreateProjectResult {
    projectOpened: boolean;
    projectPath?: string;
    projectName?: string;
    board?: BoardInfo;
    libraries?: LibraryInfo[];
    message?: string;
}

/**
 * 收集项目信息（开发板、已安装的库及其 readme_ai.md 路径）
 */
function collectProjectInfo(projectPath: string, projectName: string): CreateProjectResult {
    const result: CreateProjectResult = {
        projectOpened: true,
        projectPath,
        projectName
    };

    try {
        const ailyProjectPath = window["path"].join(projectPath, 'node_modules', '@aily-project');

        if (!AilyHost.get().fs.existsSync(ailyProjectPath)) {
            result.message = `项目 "${projectName}" 创建成功！项目依赖目录尚未就绪。`;
            return result;
        }

        const items = AilyHost.get().fs.readdirSync(ailyProjectPath);
        const libraries: LibraryInfo[] = [];
        let board: BoardInfo | undefined;

        for (const item of items) {
            const itemPath = window["path"].join(ailyProjectPath, item);

            try {
                if (!AilyHost.get().fs.isDirectory(itemPath)) continue;
            } catch {
                continue;
            }

            const simplifiedPath = `{projectPath}/@aily-project/${item}`;

            if (item.startsWith('board-')) {
                board = { name: item, path: simplifiedPath };
            } else if (item.startsWith('lib-')) {
                const libInfo: LibraryInfo = { name: item, path: simplifiedPath };
                const readmePath = window["path"].join(itemPath, 'readme_ai.md');
                if (AilyHost.get().fs.existsSync(readmePath)) {
                    libInfo.readmeAiPath = `${simplifiedPath}/readme_ai.md`;
                }
                libraries.push(libInfo);
            }
        }

        if (board) result.board = board;
        if (libraries.length > 0) result.libraries = libraries;

        const boardSummary = board ? `开发板: ${board.name}` : '未安装开发板';
        const libCount = libraries.length;
        const libsWithReadme = libraries.filter(lib => lib.readmeAiPath).length;

        result.message = `项目 "${projectName}" 创建成功！\n${boardSummary}\n已安装 ${libCount} 个库${libsWithReadme > 0 ? `，其中 ${libsWithReadme} 个包含 readme_ai.md 文档，可使用 analyze_library_blocks 分析没有 readme_ai.md 文档的库` : ''}`;
    } catch (e) {
        console.warn('收集项目信息失败:', e);
        result.message = `项目 "${projectName}" 创建成功！（获取详细信息时出错: ${e.message}）`;
    }

    return result;
}

export async function newProjectTool(prjRootPath: string, toolArgs: any, prjService: any, configService: any): Promise<ToolUseResult> {
    let is_error = false;
    let toolResult: string;

    try {
        if (!prjService) {
            throw new Error('项目服务不可用，无法创建项目');
        }
        if (!configService) {
            throw new Error('配置服务不可用，无法获取开发板信息');
        }

        // 判断toolArgs.board是否是JSON字符串
        let boardInfo;
        let boardName;
        try {
            boardInfo = JSON.parse(toolArgs.board);
            boardName = boardInfo.name;
        } catch {
            // 如果解析失败，说明不是JSON字符串，直接使用原值
            boardName = toolArgs.board;

            // 如果boardName没有前缀，自动添加 @aily-project/ 前缀
            if (!boardName.startsWith('@aily-project/')) {
                boardName = `@aily-project/${boardName}`;
            }
        }

        // 优先使用 boardDict（原始 ConfigService），降级到 boardList 搜索（IConfigProvider 适配器）
        if (configService.boardDict) {
            boardInfo = configService.boardDict[boardName] || null;
        } else {
            const boardList = configService.boardList || [];
            boardInfo = boardList.find((b: any) => b.name === boardName) || null;
        }
        if (!boardInfo) {
            throw new Error(`未找到开发板信息: ${toolArgs.board}`);
        }

        const prjName = prjService.generateUniqueProjectName(prjRootPath);
        await prjService.projectNew({
            name: prjName,
            path: prjRootPath,
            board: boardInfo
        });

        const projectPath = window["path"].join(prjRootPath, prjName);
        const result = collectProjectInfo(projectPath, prjName);
        toolResult = JSON.stringify(result, null, 2);
    } catch (e) {
        console.warn('创建项目失败:', e);
        toolResult = `创建项目失败: ${e.message}，请务必使用正确的开发板名称或 JSON 格式的开发板信息。如：@aily-project/board-arduino_uno`;
        is_error = true;
    }

    const toolResults = {
        is_error,
        content: toolResult
    };
    return toolResults;
}