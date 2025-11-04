import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";
import { injectTodoReminder } from "./todoWriteTool";


interface GetContextInput {
    info_type?: 'all' | 'project' | 'platform' | 'system' | 'editingMode';
}

interface ProjectInfo {
    path: string;
    name?: string;
    rootFolder?: string;
    opened?: boolean;
    appDataPath?: string;
    blocklylibrariesPath?: string;
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
    readme?: string;
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

// - **blocklylibrariesPath**: Blockly 库路径（如果存在，这是全局的Blockly库路径，用于存放Blockly工具本身的库文件）
        result.readme = `
## 上下文信息字段说明

### project (项目信息)
- **path**: 当前项目的相对路径（存放当前项目的依赖库，在node_modules目录中，如已安装的board、libraries、用户配置等）
- **name**: 项目名称（从 package.json 读取）
- **rootFolder**: 项目根文件夹名称
- **opened**: 是否有项目被打开
- **appDataPath**: 应用数据存储路径（包含SDK文件、编译器工具等，boards.json libraries.json通常会缓存到此路径）
- **dependencies**: 项目依赖包（从 package.json 读取）
- **boardDependencies**: 开发板相关依赖（从 package.json 读取）

### editingMode (编辑模式)
- **mode**: 当前编辑模式
  - 'blockly': 积木编程模式
  - 'code': 代码编程模式
  - 'unknown': 未知模式
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
            blocklylibrariesPath: appDataPath ? window['path'].join(appDataPath, 'libraries') : ''
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