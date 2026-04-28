import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";
import { AilyHost } from '../core/host';

interface GetProjectInfoInput {
    include_readme?: boolean; // 是否包含readme_ai.md路径，默认true
}

interface BoardInfo {
    name: string; // 如 board-arduino_uno
    path: string; // 如 {projectPath}/@aily-project/board-arduino_uno
}

interface LibraryInfo {
    name: string; // 如 lib-core-io
    path: string; // 如 {projectPath}/@aily-project/lib-core-io
    readmePath?: string; // readme_ai.md 文件路径（如果存在）
}

interface GetProjectInfoResult {
    projectOpened: boolean;
    projectPath?: string;
    projectName?: string;
    board?: BoardInfo;
    libraries?: LibraryInfo[];
    message?: string;
}

/**
 * 获取当前项目信息工具
 * 如果项目已创建，返回当前项目使用的开发板及库
 * 如果库中包含readme_ai.md则同时输出这个文件的路径
 */
export async function getProjectInfoTool(prjService: ProjectService, input: GetProjectInfoInput): Promise<ToolUseResult> {
    const { include_readme = true } = input;
    const result: GetProjectInfoResult = {
        projectOpened: false
    };

    let is_error = false;

    try {
        const currentProjectPath = prjService.currentProjectPath === prjService.projectRootPath 
            ? "" 
            : prjService.currentProjectPath;

        // 检查项目是否已打开
        if (!currentProjectPath) {
            result.projectOpened = false;
            result.message = "当前没有打开的项目。请先创建或打开一个项目。";
            
            return {
                is_error: false,
                content: JSON.stringify(result, null, 2)
            };
        }

        result.projectOpened = true;
        result.projectPath = currentProjectPath;

        // 尝试读取项目名称
        try {
            const packageJsonPath = window["path"].join(currentProjectPath, 'package.json');
            if (AilyHost.get().fs.existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(AilyHost.get().fs.readFileSync(packageJsonPath, 'utf8'));
                result.projectName = packageJson.name;
            }
        } catch (e) {
            console.warn('读取package.json失败:', e);
        }

        // 获取 node_modules/@aily-project 目录下的内容
        const ailyProjectPath = window["path"].join(currentProjectPath, 'node_modules', '@aily-project');
        
        // 调试：输出路径信息
        // console.log('[getProjectInfoTool] 检查依赖目录:', ailyProjectPath);
        
        if (!AilyHost.get().fs.existsSync(ailyProjectPath)) {
            result.message = "项目依赖目录不存在，可能需要先安装依赖。";
            // console.log('[getProjectInfoTool] 依赖目录不存在');
            return {
                is_error: false,
                content: JSON.stringify(result, null, 2)
            };
        }

        // 读取目录内容
        const items = AilyHost.get().fs.readdirSync(ailyProjectPath);
        // console.log('[getProjectInfoTool] 目录内容:', items);
        
        const libraries: LibraryInfo[] = [];
        let board: BoardInfo | undefined;

        for (const item of items) {
            const itemPath = window["path"].join(ailyProjectPath, item);
            
            // 检查是否是目录
            try {
                const isDir = AilyHost.get().fs.isDirectory(itemPath);
                if (!isDir) {
                    // console.log(`[getProjectInfoTool] 跳过非目录项: ${item}`);
                    continue;
                }
            } catch (e) {
                // console.log(`[getProjectInfoTool] 无法获取状态: ${item}`, e);
                continue;
            }

            // 简化路径表示：{projectPath}/@aily-project/{name}
            const simplifiedPath = `{projectPath}/node_modules/@aily-project/${item}`;

            // 判断是开发板还是库
            if (item.startsWith('board-')) {
                // 这是开发板
                // console.log(`[getProjectInfoTool] 发现开发板: ${item}`);
                board = {
                    name: item,
                    path: simplifiedPath
                };
            } else if (item.startsWith('lib-')) {
                // 这是库
                // console.log(`[getProjectInfoTool] 发现库: ${item}`);
                const libInfo: LibraryInfo = {
                    name: item,
                    path: simplifiedPath
                };

                // 检查是否存在 readme_ai.md
                if (include_readme) {
                    const readmePath = window["path"].join(itemPath, 'readme_ai.md');
                    if (AilyHost.get().fs.existsSync(readmePath)) {
                        libInfo.readmePath = `${simplifiedPath}/readme_ai.md`;
                    }
                }

                libraries.push(libInfo);
            }
        }

        if (board) {
            result.board = board;
        }

        if (libraries.length > 0) {
            result.libraries = libraries;
        }

        // 生成摘要信息
        const boardSummary = board ? `开发板: ${board.name}` : '未安装开发板';
        const libCount = libraries.length;
        const libsWithReadme = libraries.filter(lib => lib.readmePath).length;
        
        result.message = `${boardSummary}\n已安装 ${libCount} 个库${libsWithReadme > 0 ? `，其中 ${libsWithReadme} 个包含 readme_ai.md 文档，可使用 analyze_library_blocks 分析没有 readme_ai.md 文档的库` : ''}`;

    } catch (error) {
        console.warn('获取项目信息失败:', error);
        is_error = true;
        return {
            is_error,
            content: `获取项目信息失败: ${error.message || error}`
        };
    }

    const toolResult = {
        is_error,
        content: JSON.stringify(result, null, 2)
    };
    return toolResult;
}
