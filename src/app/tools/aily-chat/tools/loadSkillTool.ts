/**
 * load_skill — 领域技能的激活/卸载工具
 *
 * 当 LLM 需要特定领域的最佳实践时调用此工具。
 *
 * 工作流程（激活）：
 * 1. 在 skills 索引中搜索匹配的 skill
 * 2. 在 SkillRegistry 中标记为激活
 * 3. 激活后的 skill 内容通过 getMessagesWithSkillsInjection() 作为独立 user 消息瞬态注入
 * 4. 返回激活确认和 skill 摘要
 *
 * 工作流程（卸载）：
 * 1. 从 SkillRegistry 中移除激活标记
 * 2. 后续请求不再注入该 skill 内容
 *
 * 与 auto-activate skills 的区别：
 * - auto-activate: 会话开始时自动激活，不可卸载
 * - agent 激活: 通过此工具激活，可通过 action: "unload" 卸载
 */

import { SkillRegistry } from '../core/skill-registry';

export interface LoadSkillArgs {
  /** 技能名称或搜索关键词 */
  query: string;
  /** 操作类型：load（默认）或 unload */
  action?: 'load' | 'unload';
  /** 直接从 URL 加载 skill（一次性使用） */
  url?: string;
}

export interface LoadSkillResult {
  is_error: boolean;
  content: string;
  metadata?: { activatedSkills?: string[] };
}

/**
 * load_skill 工具主函数。
 */
export async function loadSkillHandler(
  args: LoadSkillArgs,
): Promise<LoadSkillResult> {
  console.log(`[load_skill] Received args: ${JSON.stringify(args)}`);
  // 卸载操作
  if (args.action === 'unload') {
    return handleUnload(args.query);
  }

  // URL 直接加载
  if (args.url) {
    return await loadFromUrl(args.url);
  }

  // 本地搜索 & 激活
  const query = args.query || '';
  if (!query) {
    return {
      is_error: false,
      content: `请提供技能名称或关键词。\n${SkillRegistry.getSkillsListing()}`,
    };
  }

  const results = SkillRegistry.searchSkills(query);
  if (results.length === 0) {
    const listing = SkillRegistry.getSkillsListing();
    return {
      is_error: false,
      content: `未找到匹配 "${query}" 的技能。${listing ? `\n${listing}` : '\n当前无可用技能。'}`,
    };
  }

  // 激活匹配的 skills
  const activated: string[] = [];
  const summaries: string[] = [];

  for (const { skill, matchType } of results) {
    if (SkillRegistry.activateSkill(skill.metadata.name)) {
      activated.push(skill.metadata.name);

      // 列出附属资源文件
      const resources = SkillRegistry.listSkillResources(skill.metadata.name);
      const resourceSection = resources.length > 0
        ? `\n  资源文件: ${resources.join(', ')}`
        : '';

      summaries.push(
        `- **${skill.metadata.name}** (${matchType} match): ${skill.metadata.description}${resourceSection}`
      );
    }
  }

  if (activated.length === 0) {
    return {
      is_error: false,
      content: `找到 ${results.length} 个匹配技能但激活失败。`,
    };
  }

  const activeList = SkillRegistry.getActivatedSkillNames();

  return {
    is_error: false,
    content: [
      `已激活 ${activated.length} 个技能（内容将作为独立消息注入到后续请求中）：`,
      ...summaries,
      '',
      `当前活跃技能: ${activeList.join(', ')}`,
      `如需卸载，使用 load_skill({query: "技能名", action: "unload"})`,
    ].join('\n'),
    metadata: { activatedSkills: activated },
  };
}

function handleUnload(query: string): LoadSkillResult {
  if (!query) {
    return { is_error: true, content: '请提供要卸载的技能名称。' };
  }

  if (SkillRegistry.deactivateSkill(query)) {
    const activeList = SkillRegistry.getActivatedSkillNames();
    return {
      is_error: false,
      content: `已卸载技能 "${query}"。当前活跃技能: ${activeList.length > 0 ? activeList.join(', ') : '(无)'}`,
    };
  }

  // 检查是否是 auto-activate 的
  const skill = SkillRegistry.get(query);
  if (skill?.metadata.autoActivate) {
    return {
      is_error: false,
      content: `技能 "${query}" 是自动激活技能，不可卸载。`,
    };
  }

  return {
    is_error: false,
    content: `技能 "${query}" 未找到或未激活。`,
  };
}

async function loadFromUrl(url: string): Promise<LoadSkillResult> {
  try {
    const fetchFn = async (fetchUrl: string): Promise<string> => {
      const response = await fetch(fetchUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return await response.text();
    };

    const skill = await SkillRegistry.loadFromUrl(url, fetchFn);
    if (!skill) {
      return { is_error: true, content: `从 URL 加载技能失败: ${url}` };
    }

    SkillRegistry.activateSkill(skill.metadata.name);

    return {
      is_error: false,
      content: `已从 URL 加载并激活技能 "${skill.metadata.name}"（内容将持久注入到后续请求中）。`,
      metadata: { activatedSkills: [skill.metadata.name] },
    };
  } catch (e: any) {
    return {
      is_error: true,
      content: `从 URL 加载技能失败: ${e.message || e}`,
    };
  }
}

// ============================
// 工具 Schema 定义
// ============================

export const LOAD_SKILL_SCHEMA = {
  name: 'load_skill',
  description: `激活或卸载领域技能。激活后的技能内容会持久注入到每轮请求中，直到卸载。
- load_skill({query: "abs-syntax"}) — 激活 ABS 语法参考技能
- load_skill({query: "abs-syntax", action: "unload"}) — 卸载技能`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '技能名称或搜索关键词（如 "blockly"、"wiring"、"abs-syntax"）',
      },
      action: {
        type: 'string',
        enum: ['load', 'unload'],
        description: '操作类型：load（激活，默认）或 unload（卸载）',
      },
      url: {
        type: 'string',
        description: '直接从 URL 加载 SKILL.md 文件（一次性使用，不安装）',
      },
    },
    required: ['query'],
  },
  agents: ['mainAgent'],
};
