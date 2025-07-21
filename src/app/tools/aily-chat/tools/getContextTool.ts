import { ToolUseResult } from "./tools";
import { ProjectService } from "../../../services/project.service";


interface GetContextInput {
    info_type?: 'all' | 'project' | 'platform' | 'system' | 'editingMode';
}

interface ProjectInfo {
    path: string;
    name?: string;
    rootFolder?: string;
    opened?: boolean;
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
    } catch (error) {
        console.error('Error getting context information:', error);
    }

    return {
        is_error,
        content: JSON.stringify(result, null, 2)
    }
}

async function getProjectInfo(projectService): Promise<ProjectInfo> {
    try {
        const prjRootPath = projectService.projectRootPath;
        const currentProjectPath = projectService.currentProjectPath === projectService.projectRootPath ? "" : projectService.currentProjectPath;

        // Basic result with path
        const result: ProjectInfo = {
            path: currentProjectPath || '',
            rootFolder: prjRootPath || '',
            opened: !!currentProjectPath,
            appDataPath: window['appDataPath'] || '',
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
        console.error('Error getting project info:', error);
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
        console.error('Error determining editing mode:', error);
        return { mode: 'unknown' };
    }
}