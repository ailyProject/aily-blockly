/**
 * Aily Tool System - Core exports
 */

export type { IAilyTool, ToolContext, ToolSchema, ToolUseResult, ToolExecutionCallbacks } from './tool-types';
export { ToolRegistry } from './tool-registry';

// 工具审批系统
export {
  toolRequiresApproval,
  addToolRequiringApproval,
  removeToolApprovalRequirement,
  registerToolApprovalCallback,
  unregisterToolApprovalCallback,
  approveToolForSession,
  enableSessionSafeMode,
  clearSessionApprovals,
  isReadOnlyCommand,
  isDestructiveOperation,
  isDestructiveCommand,
} from './tool-approval';
export type { ToolApprovalRequest, ToolApprovalResult, ToolApprovalCallback } from './tool-approval';

// Skills 系统
export type { IAilySkill, SkillMetadata, SkillOrigin, SkillSearchResult } from './skill-types';
export { SkillRegistry } from './skill-registry';

// 宿主环境接口
export type {
  IAilyHostAPI,
  IFileSystem, IFileStat, IDirent,
  IPathUtils,
  ITerminal,
  IDialog, IDialogResult,
  IPlatform,
  IProjectProvider,
  IAuthProvider,
  IConfigProvider,
  IBuildProvider,
  INotificationProvider,
  IEnvProvider,
  IShellUtils,
  IEditorProvider, IConnectionGraphProvider,
  IMcpProvider, IMcpToolDef,
} from './host-api';
export { AILY_HOST_TOKEN } from './host-api-token';
