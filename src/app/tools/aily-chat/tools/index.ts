// Blockly 领域工具索引
export { getProjectInfoTool } from './getProjectInfoTool';
export { syncAbsFileHandler } from './syncAbsFileTool';
export { getAbsSyntaxTool } from './getAbsSyntaxTool';

// 仍有 UI 消费者的工具（保留运行时函数/类型/服务）
export { executeCommandTool } from './executeCommandTool';
export type { AskUserArgs, AskUserQuestion, AskUserOption, AskUserAnswer, AskUserFullResponse } from '../core/ask-user';
export { collectDiagnostics, setLastBuildErrors, clearLastBuildErrors } from '../core/diagnostics';

// 安全服务
export * from '../services/security.service';
export * from '../services/command-security.service';
export * from '../services/audit-log.service';
