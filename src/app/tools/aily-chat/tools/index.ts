// 文件操作工具索引
export { listDirectoryTool } from './listDirectoryTool';
export { readFileTool } from './readFileTool';
export { createFileTool } from './createFileTool';
export { createFolderTool } from './createFolderTool';
export { editFileTool } from './editFileTool';
export { editAbiFileTool } from './editAbiFileTool';
export { deleteFileTool } from './deleteFileTool';
export { deleteFolderTool } from './deleteFolderTool';
export { checkExistsTool } from './checkExistsTool';
export { getDirectoryTreeTool } from './getDirectoryTreeTool';
export { grepTool } from './grepTool';

// Blockly编辑工具索引
export { 
  smartBlockTool, 
  connectBlocksTool, 
  createCodeStructureTool, 
  configureBlockTool, 
  // variableManagerTool, 
  // findBlockTool,
  deleteBlockTool,
  getWorkspaceOverviewTool, // 新增工具
  queryBlockDefinitionTool,
  // getBlockConnectionCompatibilityTool,
  // 新增：智能块分析和推荐工具
  analyzeLibraryBlocksTool,
  // intelligentBlockSequenceTool,
  verifyBlockExistenceTool
} from './editBlockTool';

// 其他工具
export { newProjectTool } from './createProjectTool';
export { executeCommandTool } from './executeCommandTool';
export { askApprovalTool } from './askApprovalTool';
export { askUserTool, registerAskUserCallback, unregisterAskUserCallback } from './askUserTool';
export type { AskUserArgs, AskUserQuestion, AskUserOption, AskUserAnswer, AskUserFullResponse } from './askUserTool';
export { getContextTool } from './getContextTool';
export { getProjectInfoTool } from './getProjectInfoTool';
export { fetchTool, FetchToolService } from './fetchTool';
export { cloneRepositoryTool } from './cloneRepositoryTool';
export { webSearchTool, WebSearchToolService } from './webSearchTool';
export { todoWriteTool, injectTodoReminder } from './todoWriteTool';
export { replaceStringInFileTool, multiReplaceStringInFileTool } from './replaceStringTool';
export { memoryTool, getMemoryPromptSnippet } from './memoryTool';
export { getErrorsTool, setLastBuildErrors, clearLastBuildErrors } from './getErrorsTool';
export { startBackgroundCommandTool, getTerminalOutputTool, killTerminalTool, listTerminalSessionsTool, cleanupAllTerminalSessions } from './terminalSessionTool';
export { registerSubagent, getRegisteredSubagents, getSubagentDefinition, buildRunSubagentDescription, buildRunSubagentSchema, validateRunSubagentArgs } from './runSubagentTool';
export { syncAbsFileHandler } from './syncAbsFileTool';
export { absVersionControlHandler } from './absVersionControlTool';
export { getAbsSyntaxTool } from './getAbsSyntaxTool';

// Skill 工具
export { loadSkillHandler, LOAD_SKILL_SCHEMA } from './loadSkillTool';
// export { manageSkillsHandler, MANAGE_SKILLS_SCHEMA } from './manageSkillsTool'; // TODO: Skills Hub 后续完善
// export { reloadAbiJsonTool, reloadAbiJsonToolSimple, reloadAbiJsonToolDirect, ReloadAbiJsonToolService } from './reloadAbiJsonTool';

// 安全服务
export * from '../services/security.service';
export * from '../services/command-security.service';
export * from '../services/audit-log.service';
