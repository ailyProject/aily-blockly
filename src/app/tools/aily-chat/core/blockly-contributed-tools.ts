/*---------------------------------------------------------------------------------------------
 *  Blockly contributed tools — domain-specific tool definitions for aily-blockly.
 *
 *  Migrated from aily-lex to aily-blockly following the core principle:
 *  "lex is an agent runtime, not a repository for IDE domain knowledge."
 *
 *  These tool definitions (prompt, schema, invoke handlers) are owned by the
 *  aily-blockly team. Changes here do NOT require an aily-lex release.
 *  If a tool can work across hosts (CLI/web/blockly) without blockly-specific
 *  semantics, it belongs in aily-lex core tools instead of this provider.
 *
 *  Usage:
 *    import { createBlocklyToolProvider } from '../core/blockly-contributed-tools';
 *
 *    const hostAPI = this._buildExternalHostAPI();
 *    const toolProvider = createBlocklyToolProvider(hostAPI);
 *    agent.registerContributedTools(toolProvider);
 *--------------------------------------------------------------------------------------------*/

import type { IToolContribution, IHostToolProvider, ToolResultContent } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';
import {
  normalizeChatAgentRuntimeMode,
  type ChatAgentRuntimeMode,
  type ChatAgentRuntimeModeSource,
} from './chat-agent-runtime-mode';

// ---- 复用已有工具实现 ----
import { appendLegacyHostContributions, invokeLegacyHostExternalTool, isLegacyHostExternalToolName } from './blockly-legacy-host-tools';
import {
  appendBlocklyWorkspaceContributions,
  createBlocklyWorkspaceHandlers,
  type BlocklyWorkspaceToolOverrides,
} from './blockly-workspace-tools';
import {
  appendBlocklyDiscoveryContributions,
  appendBlocklyProjectContributions,
  createBlocklyProjectDiscoveryHandlers,
} from './blockly-project-discovery-tools';
import {
  error,
  type InvokeHandler,
} from './blockly-contributed-tool-runtime';
import { createBlocklyPlaceholderHandlers } from './blockly-placeholder-host-tools';

export const BLOCKLY_LEX_DEFERRED_GROUPS = [
  { id: 'blockly-library-discovery', label: '硬件/库工具', description: '开发板、库搜索与库定义分析' },
  { id: 'blockly-project-management', label: '项目管理', description: '项目创建、切板、构建与配置' },
  { id: 'blockly-architecture', label: '架构文档', description: '低频架构图持久化工具' },
] as const;

function createDeferred(group: typeof BLOCKLY_LEX_DEFERRED_GROUPS[number]['id'], reason: string) {
  return { group, reason };
}

// makeSchematicContribution removed — schematic tools are now individual external tools
// with per-tool agentScope (from tools.ts 'agents' field), managed by lex runtime resolution.

// ---------------------------------------------------------------------------
// Schematic / External Tools — Phase 1.3: unified into contributed provider
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Invoke Handlers
// ---------------------------------------------------------------------------

type BlocklyToolProviderOverrides = BlocklyWorkspaceToolOverrides;

export interface BlocklyToolProviderOptions extends BlocklyWorkspaceToolOverrides {
  readonly runtimeMode?: ChatAgentRuntimeMode;
  readonly onRuntimeModeSelected?: (
    mode: Exclude<ChatAgentRuntimeMode, 'unbound'>,
    source: ChatAgentRuntimeModeSource,
    reason?: string,
  ) => void | Promise<void>;
}

function createHandlers(runtimeMode: ChatAgentRuntimeMode, options?: BlocklyToolProviderOptions): Record<string, InvokeHandler> {
  const handlers: Record<string, InvokeHandler> = {
    ...createBlocklyProjectDiscoveryHandlers(),
    ...createBlocklyPlaceholderHandlers(),
  };

  if (runtimeMode === 'unbound' && options?.onRuntimeModeSelected) {
    handlers['selectRuntimeMode'] = async (input) => {
      const mode = normalizeChatAgentRuntimeMode(input['mode'], 'unbound');
      if (mode !== 'coder' && mode !== 'blockly') {
        return error('selectRuntimeMode requires mode to be "coder" or "blockly".');
      }

      const confirmed = input['confirmed'] === true;
      const source: ChatAgentRuntimeModeSource = confirmed ? 'router_confirmed' : 'user_selected';
      const reason = typeof input['reason'] === 'string' ? input['reason'].trim() : '';
      await options.onRuntimeModeSelected?.(mode, source, reason || undefined);
      return {
        content: [{
          type: 'text',
          text: `Runtime mode selected: ${mode}. Source: ${source}. The host will rebuild the agent with the ${mode} prompt and tool surface before the next user turn.`,
        }],
      };
    };
  }

  if (runtimeMode === 'blockly') {
    Object.assign(handlers, createBlocklyWorkspaceHandlers(options));
  }

  return handlers;
}

function appendProjectContributions(contributions: IToolContribution[], hostAPI: IExternalHostAPI): void {
  appendBlocklyProjectContributions(contributions, hostAPI, createDeferred);
}

function appendDiscoveryContributions(contributions: IToolContribution[], hostAPI: IExternalHostAPI): void {
  appendBlocklyDiscoveryContributions(contributions, hostAPI, createDeferred);
}

function collectBlocklyContributions(hostAPI: IExternalHostAPI, runtimeMode: ChatAgentRuntimeMode): IToolContribution[] {
  const contributions: IToolContribution[] = [];

  appendProjectContributions(contributions, hostAPI);
  appendDiscoveryContributions(contributions, hostAPI);

  if (runtimeMode === 'blockly') {
    appendBlocklyWorkspaceContributions(contributions, hostAPI, createDeferred);
    appendLegacyHostContributions(contributions, hostAPI);
  }

  return contributions;
}

function appendRuntimeModeContribution(
  contributions: IToolContribution[],
  runtimeMode: ChatAgentRuntimeMode,
  options?: BlocklyToolProviderOptions,
): void {
  if (runtimeMode !== 'unbound' || !options?.onRuntimeModeSelected) {
    return;
  }

  contributions.push({
    name: 'selectRuntimeMode',
    toolSet: 'runtime-routing',
    description: 'Select coder or blockly runtime mode after user confirmation',
    prompt: `Use this tool only after the user explicitly confirms whether this session should continue in coder mode or blockly mode.
- Choose "coder" for source-code projects, C/C++ edits, build/debug tasks, and src/main.cpp workflows.
- Choose "blockly" for ABS/Blockly visual programming, project.abs workflows, block generation, or syncAbs work.
Set confirmed=true when the user made the choice in response to your runtime selection question.`,
    inputSchema: {
      type: 'object',
      properties: {
        mode: {
          type: 'string',
          enum: ['coder', 'blockly'],
          description: 'Runtime mode selected by the user or by an unambiguous request.',
        },
        confirmed: {
          type: 'boolean',
          description: 'True when the user explicitly confirmed this runtime choice.',
        },
        reason: {
          type: 'string',
          description: 'Short reason for the selected runtime mode.',
        },
      },
      required: ['mode'],
    },
    annotations: { readOnly: false },
    runtimeModes: ['unbound'],
    agentScope: ['main'],
  });
}

// ---------------------------------------------------------------------------
// Provider Factory
// ---------------------------------------------------------------------------

/**
 * Create an IHostToolProvider for aily-blockly based on its external host API.
 *
 * Detects available capabilities and only contributes applicable tools.
 */
export function createBlocklyToolProvider(hostAPI: IExternalHostAPI, options?: BlocklyToolProviderOptions): IHostToolProvider {
  const runtimeMode = normalizeChatAgentRuntimeMode(options?.runtimeMode, 'blockly');
  const contributions = collectBlocklyContributions(hostAPI, runtimeMode);
  appendRuntimeModeContribution(contributions, runtimeMode, options);
  const handlers = createHandlers(runtimeMode, options);

  return {
    contributeTools(): IToolContribution[] {
      return contributions;
    },

    async invoke(toolName: string, input: unknown, signal?: AbortSignal, invocationContext?: {
      sessionId?: string;
      toolCallId?: string;
      trace?: { turnId?: string };
      signal?: AbortSignal;
      cwd?: string;
      host?: { getExtension<T>(id: string): T | undefined };
      emitEvent?: (event: unknown) => void;
    }): Promise<ToolResultContent> {
      // External tools call handlers directly; no blockly-side runtime registry remains here.
      if (runtimeMode === 'blockly' && isLegacyHostExternalToolName(toolName)) {
        return invokeLegacyHostExternalTool(toolName, input as Record<string, unknown>, invocationContext);
      }

      const handler = handlers[toolName];
      if (!handler) {
        return error(`Unknown contributed tool: ${toolName}`);
      }
      try {
        return await handler(input as Record<string, unknown>, hostAPI, {
          ...invocationContext,
          signal,
        });
      } catch (err) {
        return error(`${toolName} error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
