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
export { getContextTool } from './getContextTool';
export { fetchTool, FetchToolService } from './fetchTool';
export { todoWriteTool } from './todoWriteTool';
// export { reloadAbiJsonTool, reloadAbiJsonToolSimple, reloadAbiJsonToolDirect, ReloadAbiJsonToolService } from './reloadAbiJsonTool';
