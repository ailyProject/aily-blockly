import { LEGACY_DEFERRED_TOOL_GROUPS, getLegacyDeferredTools } from './tool-discovery';
import { FOUNDATIONAL_TOOL_DEFINITIONS } from './foundational-tool-definitions';
import { WORKSPACE_TOOL_DEFINITIONS } from './workspace-tool-definitions';
import { DISCOVERY_TOOL_DEFINITIONS } from './discovery-tool-definitions';
import { BLOCKLY_TOOL_DEFINITIONS } from './blockly-tool-definitions';
import { PROJECT_RUNTIME_TOOL_DEFINITIONS } from './project-runtime-tool-definitions';
import { SAVE_ARCH_TOOL } from './architecture-tool-definition';

export const toolParamNames = [
    "command"
] as const;

export type ToolParamName = (typeof toolParamNames)[number];

export const TOOL_CATALOG = [
    ...FOUNDATIONAL_TOOL_DEFINITIONS,
    ...WORKSPACE_TOOL_DEFINITIONS,
    ...DISCOVERY_TOOL_DEFINITIONS,
    ...BLOCKLY_TOOL_DEFINITIONS,
    ...PROJECT_RUNTIME_TOOL_DEFINITIONS,
    SAVE_ARCH_TOOL,
];

const TOOL_CATALOG_BY_NAME = new Map(
  TOOL_CATALOG.map(tool => [tool.name, tool] as const),
);

export function findToolCatalogEntry(name: string): any | undefined {
  return TOOL_CATALOG_BY_NAME.get(name);
}

/**
 * 生成 deferred 工具列表文本（注入到规则中，告知 LLM 可用的延迟工具）
 * 参考 Copilot 的 <availableDeferredTools> 系统提示词段
 * @param agentName 当前 agent 名称，过滤工具的 agents 字段
 * @param excludeTools 配置中禁用的工具名称集合
 */
export function getDeferredToolsListing(agentName?: string, excludeTools?: Set<string>): string {
  const lines: string[] = [];
  for (const group of LEGACY_DEFERRED_TOOL_GROUPS) {
    const filteredTools = group.tools.filter(toolName => {
      if (excludeTools?.has(toolName)) return false;
      if (agentName) {
        const toolDef = findToolCatalogEntry(toolName);
        if (toolDef?.agents && !toolDef.agents.includes(agentName)) return false;
      }
      return true;
    });
    if (filteredTools.length === 0) continue;
    lines.push(`- ${group.name}: ${filteredTools.join(', ')}（${group.brief}）`);
  }
  if (lines.length === 0) return '';
  return `<availableTools>\n以下工具可通过 legacy search_available_tools 按需加载后使用：\n${lines.join('\n')}\n调用 search_available_tools 时传入关键词或工具名即可加载对应工具的完整定义。\n</availableTools>`;
}

/**
 * 搜索 deferred 工具（供 search_available_tools 元工具使用）
 * @param query 搜索关键词
 * @param allTools 全部工具定义数组
 * @param agentName 当前 agent 名称，过滤工具的 agents 字段
 * @param excludeTools 配置中禁用的工具名称集合
 */
export function searchDeferredTools(query: string, allTools: any[] = TOOL_CATALOG, agentName?: string, excludeTools?: Set<string>): any[] {
  const q = query.toLowerCase();
  let deferredTools = getLegacyDeferredTools(allTools);

  if (agentName) {
    deferredTools = deferredTools.filter(tool => !tool.agents || tool.agents.includes(agentName));
  }
  if (excludeTools && excludeTools.size > 0) {
    deferredTools = deferredTools.filter(tool => !excludeTools.has(tool.name));
  }

  const exactMatch = deferredTools.filter(tool => tool.name === q);
  if (exactMatch.length > 0) return exactMatch;

  const groupMatch = LEGACY_DEFERRED_TOOL_GROUPS.find(group =>
    group.name.toLowerCase().includes(q) || group.brief.toLowerCase().includes(q)
  );
  if (groupMatch) {
    return deferredTools.filter(tool => groupMatch.tools.includes(tool.name));
  }

  return deferredTools.filter(tool =>
    tool.name.toLowerCase().includes(q) ||
    (tool.description && tool.description.toLowerCase().includes(q))
  );
}
