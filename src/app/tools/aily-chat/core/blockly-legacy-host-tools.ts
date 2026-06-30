import type { IToolContribution, ToolResultContent } from 'aily-lex/browser';
import type { IExternalHostAPI } from 'aily-lex/host/blockly';

import { AilyHost } from './host';
import { normalizeAgentIdentifiers } from './agent-identifiers';
import type { EditingTimelineWriter } from '../services/editing-timeline-recording-bridge';
import { LEGACY_HOST_EXTERNAL_TOOLS } from '../tools/legacy-host-tool-definitions';
import {
  generateConnectionGraphTool as generateSchematicHandler,
  getPinmapSummaryTool as getPinmapSummaryHandler,
  getSensorPinmapCatalogTool as getComponentCatalogHandler,
  getProjectContextTool as getProjectContextHandler,
  validateConnectionGraphTool as validateSchematicHandler,
  generatePinmapTool as generatePinmapHandler,
  savePinmapTool as savePinmapHandler,
  getCurrentSchematicTool as getCurrentSchematicHandler,
} from '../tools/connectionGraphTool';

const LEGACY_HOST_EXTERNAL_TOOL_NAMES = LEGACY_HOST_EXTERNAL_TOOLS.map(tool => tool.name);
const LEGACY_HOST_EXTERNAL_TOOL_NAME_SET = new Set<string>(LEGACY_HOST_EXTERNAL_TOOL_NAMES);
type RuntimeScopedToolContribution = IToolContribution & {
  readonly toolSet?: string;
  readonly runtimeModes?: readonly string[];
  readonly requiredCapabilities?: readonly string[];
};

function text(s: string): ToolResultContent {
  return { content: [{ type: 'text', text: s }] };
}

function error(s: string): ToolResultContent {
  return { content: [{ type: 'text', text: `Error: ${s}` }], isError: true };
}

function makeLegacyContribution(name: string): RuntimeScopedToolContribution | null {
  const legacy = LEGACY_HOST_EXTERNAL_TOOLS.find(tool => tool.name === name);
  if (!legacy) return null;

  return {
    name: legacy.name,
    toolSet: 'blockly-legacy',
    description: legacy.description || name,
    prompt: '',
    inputSchema: legacy.input_schema || { type: 'object', properties: {} },
    annotations: { readOnly: false },
    runtimeModes: ['blockly'],
    requiredCapabilities: ['runtime:blockly'],
    agentScope: legacy.agents?.length ? normalizeAgentIdentifiers(legacy.agents) : undefined,
    deferred: name === 'save_arch'
      ? { group: 'blockly-architecture', reason: '保存架构图属于低频主代理工具' }
      : undefined,
  };
}

export function appendLegacyHostContributions(
  contributions: IToolContribution[],
  hostAPI: IExternalHostAPI,
): void {
  if (hostAPI.connectionGraph) {
    for (const name of LEGACY_HOST_EXTERNAL_TOOL_NAMES) {
      if (name === 'save_arch') continue;
      const contribution = makeLegacyContribution(name);
      if (contribution) {
        contributions.push(contribution);
      }
    }
  }

  const saveArchContribution = makeLegacyContribution('save_arch');
  if (saveArchContribution) {
    contributions.push(saveArchContribution);
  }
}

export function isLegacyHostExternalToolName(toolName: string): boolean {
  return LEGACY_HOST_EXTERNAL_TOOL_NAME_SET.has(toolName);
}

export async function invokeLegacyHostExternalTool(
  toolName: string,
  input: Record<string, unknown>,
  invocationContext?: {
    toolCallId?: string;
    trace?: { turnId?: string };
    host?: { getExtension<T>(id: string): T | undefined };
  },
): Promise<ToolResultContent> {
  const host = AilyHost.get();
  const editingTimeline = invocationContext?.host?.getExtension<EditingTimelineWriter>('editingTimeline');

  if (toolName === 'save_arch') {
    return invokeSaveArch(input, host, {
      turnId: invocationContext?.trace?.turnId,
      toolCallId: invocationContext?.toolCallId,
      timelineWriter: editingTimeline,
    });
  }

  if (!host.connectionGraph) return error('连线图服务不可用');
  if (!host.project) return error('项目服务不可用');

  const cg = host.connectionGraph as any;
  const prj = host.project as any;
  const schematicInvocationContext = {
    turnId: invocationContext?.trace?.turnId,
    toolCallId: invocationContext?.toolCallId,
    timelineWriter: editingTimeline,
  };

  try {
    let result: any;
    switch (toolName) {
      case 'generate_schematic':
        cg.emitNotice?.({ title: 'AI生成中', text: '正在准备硬件组件引脚信息...', state: 'doing', showProgress: false });
        result = await generateSchematicHandler(cg, prj, input);
        break;
      case 'get_pinmap_summary':
        result = await getPinmapSummaryHandler(cg, prj, input);
        break;
      case 'get_component_catalog':
        result = await getComponentCatalogHandler(cg, prj, input);
        break;
      case 'get_project_context':
        cg.emitNotice?.({ title: 'AI生成中', text: '正在分析项目和组件信息...', state: 'doing', showProgress: false });
        result = await getProjectContextHandler(cg, prj, input || {});
        break;
      case 'validate_schematic':
        cg.emitNotice?.({ title: 'AI生成中', text: '正在验证并保存连线图...', state: 'doing', showProgress: false });
        result = await validateSchematicHandler(cg, prj, input, schematicInvocationContext);
        break;
      case 'get_current_schematic':
        result = await getCurrentSchematicHandler(cg, prj, input || {});
        break;
      case 'generate_pinmap':
        cg.emitNotice?.({ title: 'AI生成中', text: '正在生成引脚配置...', state: 'doing', showProgress: false });
        result = await generatePinmapHandler(cg, prj, input as any);
        break;
      case 'save_pinmap':
        cg.emitNotice?.({ title: 'AI生成中', text: '正在保存引脚配置...', state: 'doing', showProgress: false });
        result = await savePinmapHandler(cg, prj, input as any, schematicInvocationContext);
        break;
      default:
        return error(`Unknown external tool: ${toolName}`);
    }

    return result?.is_error
      ? error(result.content)
      : text(typeof result?.content === 'string' ? result.content : JSON.stringify(result?.content ?? ''));
  } catch (err) {
    return error(`${toolName} error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function invokeSaveArch(
  args: Record<string, unknown>,
  host: any,
  invocationContext?: {
    turnId?: string;
    toolCallId?: string;
    timelineWriter?: EditingTimelineWriter;
  },
): Promise<ToolResultContent> {
  if (!host?.fs || !host?.platform) return error('文件系统服务不可用');

  const code = String(args?.['code'] || '').trim();
  if (!code) return error('参数 code 不能为空');

  const content = `\`\`\`mermaid\n${code}\n\`\`\`\n`;
  const projectPath = host.project?.currentProjectPath || host.project?.projectRootPath;
  const rootPath = host.project?.projectRootPath;
  const isOrphan = !projectPath || (rootPath && projectPath === rootPath);
  const separator = host.platform.pathSeparator || '/';

  const writeArchFile = async (archPath: string) => {
    const existedBefore = host.fs.existsSync(archPath);
    const beforeContent = existedBefore ? host.fs.readFileSync(archPath, 'utf-8') : null;
    host.fs.writeFileSync(archPath, content);
    await invocationContext?.timelineWriter?.recordFileWrite({
      turnId: invocationContext.turnId,
      toolCallId: invocationContext.toolCallId,
      filePath: archPath,
      existedBefore,
      beforeContent,
      afterContent: content,
    });
  };

  try {
    if (projectPath && !isOrphan) {
      const archPath = projectPath + separator + 'arch.md';
      await writeArchFile(archPath);
      return text(`框架图已保存到 ${archPath}（已在对话中渲染，无需再次输出）`);
    }

    if (isOrphan && rootPath) {
      const chatHistoryDir = rootPath + separator + '.chat_history';
      if (!host.fs.existsSync(chatHistoryDir)) {
        host.fs.mkdirSync(chatHistoryDir, { recursive: true });
      }
      const archPath = chatHistoryDir + separator + 'arch.md';
      await writeArchFile(archPath);
      return text(`框架图已保存到 ${archPath}（已在对话中渲染，无需再次输出）`);
    }

    return error('无法确定保存路径：当前未打开项目');
  } catch (err: any) {
    return error(`保存框架图失败: ${err.message || err}`);
  }
}
