/**
 * Aily Tool System - Core exports
 */

export type { IAilyTool, ToolContext, ToolSchema, ToolUseResult, ToolExecutionCallbacks } from './tool-types';

// 工具审批系统
export { generateApprovalMessage } from '../helpers/tool-approval-ui';
export type { ToolApprovalRequest, ToolApprovalResult, ToolApprovalCallback } from '../helpers/tool-approval-ui';

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
export type { AuthQuotaSummary, AuthSnapshot } from './auth-snapshot';
export { AILY_HOST_TOKEN } from './host-api-token';
