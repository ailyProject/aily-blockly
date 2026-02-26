import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";
import { injectTodoReminder } from "./todoWriteTool";
import { getWorkspaceOverviewTool } from "./editBlockTool";


interface GetContextInput {
    info_type?: 'all' | 'project' | 'platform' | 'system' | 'editingMode';
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

interface ProjectInfo {
    opened: boolean;
    projectPath?: string;
    name?: string;
    board?: BoardInfo;
    installedLibraries?: LibraryInfo[];
    appDataPath?: string;
}

interface PlatformInfo {
    type: string;
    version: string;
    nodeVersion?: string;
    browser?: string;
}

interface SystemInfo {
    hostname: string;
    platform: string;
    arch: string;
    cpus: number;
    memory: string;
    username?: string;
}

interface EditingMode {
    mode: 'blockly' | 'code' | 'unknown';
}

interface GetContextResult {
    project?: ProjectInfo;
    platform?: PlatformInfo;
    system?: SystemInfo;
    editingMode?: EditingMode;
    workspaceOverview?: string;
    cppCode?: string;
    warn?: string;
}

/**
 * Get context tool implementation for retrieving environment context information
 */
export async function getContextTool(prjService: ProjectService, input: GetContextInput): Promise<ToolUseResult> {
    const { info_type = 'all' } = input;
    const result: GetContextResult = {};

    let is_error = false;

    try {
        // Only include requested information types
        if (info_type === 'all' || info_type === 'project') {
            result.project = await getProjectInfo(prjService);
        }

        if (info_type === 'all' || info_type === 'editingMode') {
            result.editingMode = getEditingMode();
        }

        // 🔍 如果项目被打开且处于blockly编辑模式，获取工作区概览
        if ((info_type === 'all' || info_type === 'project') && result.project?.opened) {
            // 需要检查编辑模式，如果还没获取则先获取
            const editingMode = result.editingMode || getEditingMode();
            
            if (editingMode.mode === 'blockly' || editingMode.mode === 'unknown') {
                try {
                    // console.log('📊 项目已打开且处于Blockly模式，获取工作区概览...');
                    const workspaceInfo = await getWorkspaceOverviewInfo();
                    result.workspaceOverview = workspaceInfo.overview;
                    result.cppCode = workspaceInfo.cppCode;
                    // console.log('✅ 工作区概览获取成功');
                } catch (error) {
                    // console.warn('⚠️ 获取工作区概览失败:', error);
                    result.workspaceOverview = '⚠️ 工作区概览获取失败';
                }
            } else {
                // console.log(`ℹ️ 当前编辑模式为 ${editingMode.mode}，跳过工作区概览获取`);
            }
        }

        if (!result.project?.opened) {
            result.warn = `当前没有打开的项目，如果需要创建或打开项目，必须先征求用户同意再进行操作。`;
        }
    } catch (error) {
        console.warn('Error getting context information:', error);
    }

    const toolResult = {
        is_error,
        content: JSON.stringify(result, null, 2)
    };
    return injectTodoReminder(toolResult, 'getContextTool');
}

/**
 * 获取工作区概览信息（参考editBlockTool中的实现）
 */
async function getWorkspaceOverviewInfo(includeCode = true, includeTree = true): Promise<{
    overview: string;
    cppCode: string;
    isError: boolean;
}> {
    try {
        // console.log('📊 获取工作区概览...');
        const overviewResult = await getWorkspaceOverviewTool({
            includeCode,
            includeTree,
            format: 'text',
            groupBy: 'structure'
        });
        
        let overview = '';
        let cppCode = '';
        
        if (!overviewResult.is_error) {
            overview = overviewResult.content;
            // 尝试提取C++代码部分
            const codeMatch = overview.match(/```cpp([\s\S]*?)```/);
            if (codeMatch) {
                cppCode = codeMatch[1].trim();
            }
            
            // 🔧 如果概览中包含变量信息，添加到开头
            // if (overview.includes('📝 变量列表:')) {
            //     console.log('✅ 工作区概览包含变量信息');
            // } else {
            //     console.log('ℹ️ 工作区概览中无变量信息');
            // }
            
            return { overview, cppCode, isError: false };
        } else {
            console.warn('⚠️ 获取工作区概览失败:', overviewResult.content);
            overview = '⚠️ 工作区概览获取失败，但操作成功';
            return { overview, cppCode: '', isError: true };
        }
    } catch (error) {
        console.warn('❌ 获取工作区概览出错:', error);
        return { 
            overview: '❌ 工作区概览获取出错', 
            cppCode: '', 
            isError: true 
        };
    }
}

async function getProjectInfo(projectService): Promise<ProjectInfo> {
    try {
        const currentProjectPath = projectService.currentProjectPath === projectService.projectRootPath 
            ? "" 
            : projectService.currentProjectPath;

        const appDataPath = window['path'].getAppDataPath() || '';
        
        // 基础结果
        const result: ProjectInfo = {
            opened: !!currentProjectPath,
            appDataPath: appDataPath
        };

        // 如果没有打开项目，直接返回
        if (!currentProjectPath) {
            return result;
        }

        result.projectPath = currentProjectPath;

        // 尝试读取项目名称
        try {
            const packageJsonPath = window["path"].join(currentProjectPath, 'package.json');
            if (window['fs'].existsSync(packageJsonPath)) {
                const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
                result.name = packageJson.name;
            }
        } catch (e) {
            console.warn('读取package.json失败:', e);
        }

        // 获取 node_modules/@aily-project 目录下的内容
        const ailyProjectPath = window["path"].join(currentProjectPath, 'node_modules', '@aily-project');
        
        if (window['fs'].existsSync(ailyProjectPath)) {
            // 读取目录内容
            const items = window['fs'].readdirSync(ailyProjectPath);
            const libraries: LibraryInfo[] = [];
            let board: BoardInfo | undefined;

            for (const item of items) {
                const itemPath = window["path"].join(ailyProjectPath, item);
                
                // 检查是否是目录
                try {
                    const isDir = window['fs'].isDirectory(itemPath);
                    if (!isDir) continue;
                } catch (e) {
                    continue;
                }

                // 简化路径表示：{projectPath}/node_modules/@aily-project/{name}
                const simplifiedPath = `{projectPath}/node_modules/@aily-project/${item}`;

                // 判断是开发板还是库
                if (item.startsWith('board-')) {
                    board = { 
                        name: item,
                        path: simplifiedPath
                    };
                } else if (item.startsWith('lib-')) {
                    const libInfo: LibraryInfo = { 
                        name: item,
                        path: simplifiedPath
                    };
                    
                    // 检查是否存在 readme_ai.md
                    const readmePath = window["path"].join(itemPath, 'readme_ai.md');
                    if (window['fs'].existsSync(readmePath)) {
                        libInfo.readmePath = `${simplifiedPath}/readme_ai.md`;
                    }

                    libraries.push(libInfo);
                }
            }

            if (board) {
                result.board = board;
            }

            if (libraries.length > 0) {
                result.installedLibraries = libraries;
            }
        }

        return result;
    } catch (error) {
        console.warn('Error getting project info:', error);
        return { opened: false };
    }
}

function getEditingMode(): { mode: 'blockly' | 'code' | 'unknown' } {
    try {
        // Make sure we're in a browser environment
        if (typeof window !== 'undefined' && window.location) {
            const path = window.location.pathname;

            if (path.includes('/main/blockly-editor')) {
                return { mode: 'blockly' };
            } else if (path.includes('/main/code-editor')) {
                return { mode: 'code' };
            }
        }

        return { mode: 'unknown' };
    } catch (error) {
        console.warn('Error determining editing mode:', error);
        return { mode: 'unknown' };
    }
}