import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";
import { injectTodoReminder } from "./todoWriteTool";
import { getWorkspaceOverviewTool } from "./editBlockTool";


interface GetContextInput {
    info_type?: 'all' | 'project' | 'platform' | 'system' | 'editingMode';
}

interface ProjectInfo {
    path: string;
    name?: string;
    rootFolder?: string;
    opened?: boolean;
    appDataPath?: string;
    libraryConversionPath?: string;
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
    readme?: string;
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
        result.readme = `
## 上下文信息字段说明

### project (项目信息)
- **path**: 当前项目的相对路径（path/node_modules/@aily-project目录下存放当前项目的依赖库，如已安装的board、libraries、用户配置等）
- **name**: 项目名称（从 package.json 读取）
- **rootFolder**: 项目根文件夹名称
- **opened**: 是否有项目被打开
- **appDataPath**: 应用数据存储路径（包含SDK文件、编译器工具等，boards.json-开发板列表 libraries.json-库列表 等缓存到此路径）
- **libraryConversionPath**: 库转换存放路径（用于存放转换后的库文件）
- **dependencies**: 项目依赖包（从 package.json 读取）
- **boardDependencies**: 开发板相关依赖（从 package.json 读取）

### editingMode (编辑模式)
- **mode**: 当前编辑模式
  - 'blockly': 积木编程模式
  - 'code': 代码编程模式
  - 'unknown': 未知模式

### workspaceOverview (工作区概览) - 仅在项目打开且处于Blockly模式时提供
- **workspaceOverview**: Blockly工作区的完整概览，包含：
  - 工作区统计信息（块数量、连接数量等）
  - 块结构树状图
  - 变量列表
  - 代码生成信息
`;
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
        const prjRootPath = projectService.projectRootPath;
        const currentProjectPath = projectService.currentProjectPath === projectService.projectRootPath ? "" : projectService.currentProjectPath;

        const appDataPath = window['path'].getAppDataPath() || ''
        // Basic result with path
        const result: ProjectInfo = {
            path: currentProjectPath || '',
            rootFolder: prjRootPath || '',
            opened: !!currentProjectPath,
            appDataPath: appDataPath,
            // libraryConversionPath: appDataPath ? window['path'].join(appDataPath, 'libraries') : ''
            libraryConversionPath: !!currentProjectPath ? currentProjectPath : (appDataPath ? window['path'].join(appDataPath, 'libraries') : '')
        };

        // If current project path is empty, return early
        if (!currentProjectPath) {
            return result;
        }

        // Set root folder
        result.rootFolder = window["path"].basename(currentProjectPath);

        // Try to read package.json for name and dependencies
        const packageJsonPath = window["path"].join(currentProjectPath, 'package.json');

        if (window['fs'].existsSync(packageJsonPath)) {
            const packageJson = JSON.parse(window['fs'].readFileSync(packageJsonPath, 'utf8'));
            result.name = packageJson.name;

            // Add dependencies information
            // Note: You might want to update the ProjectInfo interface to include dependencies
            (result as any).dependencies = packageJson.dependencies || {};
            (result as any).boardDependencies = packageJson.boardDependencies || {};
        }

        return result;
    } catch (error) {
        console.warn('Error getting project info:', error);
        return { path: process.cwd() };
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