/**
 * aily-chat 模块对外公共 API
 *
 * 外部模块（如 background-agent、blockly-editor）
 * 应统一从此入口导入，而 ** 不要 ** 直接引用 aily-chat 内部子路径。
 */

// ===== Services =====
export { ChatService } from './services/chat.service';
export type { ChatTextOptions } from './services/chat.service';
export { AilyChatConfigService } from './services/aily-chat-config.service';
export { ContextBudgetService } from './services/context-budget.service';
export { TiktokenService } from './services/tiktoken.service';
export { createSecurityContext } from './services/security.service';

// ===== Tool definitions & types =====
export { TOOLS } from './tools/tools';
export type { ToolUseResult } from './tools/tools';

// ===== Standalone tool functions (used by background-agent etc.) =====
export {
  generateConnectionGraphTool,
  getPinmapSummaryTool,
  validateConnectionGraphTool,
  getSensorPinmapCatalogTool,
  getProjectContextTool,
  generatePinmapTool,
  savePinmapTool,
  getCurrentSchematicTool,
  applySchematicTool,
} from './tools/connectionGraphTool';
export { getContextTool } from './tools/getContextTool';
export { getProjectInfoTool } from './tools/getProjectInfoTool';
export { readFileTool } from './tools/readFileTool';
export { createFileTool } from './tools/createFileTool';
export { editFileTool } from './tools/editFileTool';
export { deleteFileTool } from './tools/deleteFileTool';
export { deleteFolderTool } from './tools/deleteFolderTool';
export { createFolderTool } from './tools/createFolderTool';
export { listDirectoryTool } from './tools/listDirectoryTool';
export { getDirectoryTreeTool } from './tools/getDirectoryTreeTool';
export { grepTool } from './tools/grepTool';
export { default as globTool } from './tools/globTool';
export { getBoardParametersTool } from './tools/getBoardParametersTool';
export { fetchTool, FetchToolService } from './tools/fetchTool';

// ===== ABI ↔ ABS converter (used by blockly-editor) =====
export {
  convertAbiToAbs,
  convertAbiToAbsWithLineMap,
  convertBlockTreeToAbs,
  convertAbsToAbi,
  validateAbs,
  formatAbs,
} from './tools/abiAbsConverter';
export type { AbiToAbsOptions, AbsToAbiResult } from './tools/abiAbsConverter';
