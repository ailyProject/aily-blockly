/**
 * manage_skills — 技能管理工具（Hub 搜索/安装/卸载/更新）
 *
 * 面向 LLM 的技能包管理器，类似 npm 对于 node_modules 的角色。
 * 支持从 Skills Hub 搜索、安装、卸载、列出已安装技能。
 */

import { SkillRegistry } from '../core/skill-registry';
import type { SkillHubEntry } from '../core/skill-types';

export type ManageSkillsAction =
  | 'search_hub'
  | 'install'
  | 'uninstall'
  | 'list_installed'
  | 'list_available';

export interface ManageSkillsArgs {
  /** 操作类型 */
  action: ManageSkillsAction;
  /** 搜索关键词或 skill 名称 */
  query?: string;
  /** Hub 下载 URL（install 时使用） */
  download_url?: string;
  /** 安装范围 */
  scope?: 'global' | 'project';
}

export interface ManageSkillsResult {
  is_error: boolean;
  content: string;
}

/**
 * manage_skills 工具主函数。
 */
export async function manageSkillsHandler(
  args: ManageSkillsArgs,
  projectRoot?: string,
): Promise<ManageSkillsResult> {
  switch (args.action) {
    case 'list_available':
      return listAvailable();

    case 'list_installed':
      return listInstalled();

    case 'search_hub':
      return await searchHub(args.query || '');

    case 'install':
      return await installSkill(args, projectRoot);

    case 'uninstall':
      return uninstallSkill(args.query || '');

    default:
      return {
        is_error: true,
        content: `未知操作: ${args.action}。支持的操作: search_hub, install, uninstall, list_installed, list_available`,
      };
  }
}

function listAvailable(): ManageSkillsResult {
  const skills = SkillRegistry.getAll();
  if (skills.length === 0) {
    return { is_error: false, content: '当前无已注册的技能。' };
  }

  const lines = skills.map(s => {
    const scope = s.origin.type === 'global' ? '全局'
      : s.origin.type === 'project' ? '项目'
      : s.origin.type === 'hub' ? 'Hub'
      : s.origin.type === 'url' ? 'URL'
      : '内置';
    const auto = s.metadata.autoActivate ? ' [自动激活]' : '';
    const ver = s.metadata.version ? ` v${s.metadata.version}` : '';
    return `- **${s.metadata.name}**${ver} (${scope})${auto}: ${s.metadata.description}`;
  });

  return {
    is_error: false,
    content: `已注册的技能 (${skills.length}):\n${lines.join('\n')}`,
  };
}

function listInstalled(): ManageSkillsResult {
  const records = SkillRegistry.getInstalledRecords();
  if (records.length === 0) {
    return { is_error: false, content: '当前无从 Hub 安装的技能。' };
  }

  const lines = records.map(r => {
    const date = new Date(r.installedAt).toLocaleDateString();
    return `- **${r.name}** v${r.version} (${r.scope}) — 安装于 ${date}`;
  });

  return {
    is_error: false,
    content: `已安装的 Hub 技能 (${records.length}):\n${lines.join('\n')}`,
  };
}

async function searchHub(query: string): Promise<ManageSkillsResult> {
  if (!query) {
    return { is_error: true, content: '请提供搜索关键词' };
  }

  const fetchFn = async (url: string): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  };

  try {
    const results = await SkillRegistry.searchHub(query, fetchFn);
    if (results.length === 0) {
      return { is_error: false, content: `Hub 中未找到匹配 "${query}" 的技能。` };
    }

    const lines = results.map((r: SkillHubEntry) => {
      const downloads = r.downloads ? ` (${r.downloads} 下载)` : '';
      return `- **${r.name}** v${r.version}${downloads}: ${r.description}`;
    });

    return {
      is_error: false,
      content: `Hub 搜索结果 (${results.length}):\n${lines.join('\n')}\n\n使用 manage_skills(action: "install", query: "skill-name", download_url: "...") 安装。`,
    };
  } catch (e: any) {
    return {
      is_error: true,
      content: `Skills Hub 搜索失败: ${e.message || e}`,
    };
  }
}

async function installSkill(
  args: ManageSkillsArgs,
  projectRoot?: string,
): Promise<ManageSkillsResult> {
  const name = args.query || '';
  const downloadUrl = args.download_url || '';

  if (!name) {
    return { is_error: true, content: '请提供要安装的技能名称（query）' };
  }
  if (!downloadUrl) {
    return {
      is_error: true,
      content: '请提供下载 URL（download_url）。先使用 search_hub 搜索获取下载链接。',
    };
  }

  const fetchFn = async (url: string): Promise<string> => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  };

  const entry: SkillHubEntry = {
    name,
    description: '',
    version: '1.0.0',
    tags: [],
    author: '',
    downloadUrl,
    scope: args.scope || 'global',
  };

  const skill = await SkillRegistry.installFromHub(entry, fetchFn, projectRoot);
  if (!skill) {
    return { is_error: true, content: `安装技能 "${name}" 失败` };
  }

  return {
    is_error: false,
    content: `已成功安装技能 "${skill.metadata.name}" (${entry.scope})。使用 load_skill 加载其内容。`,
  };
}

function uninstallSkill(name: string): ManageSkillsResult {
  if (!name) {
    return { is_error: true, content: '请提供要卸载的技能名称' };
  }

  const success = SkillRegistry.uninstall(name);
  if (!success) {
    return {
      is_error: true,
      content: `卸载技能 "${name}" 失败（可能不存在或为内置技能）`,
    };
  }

  return { is_error: false, content: `已卸载技能 "${name}"` };
}

// ============================
// 工具 Schema 定义
// ============================

export const MANAGE_SKILLS_SCHEMA = {
  name: 'manage_skills',
  description: '管理技能：搜索/安装/卸载/列出技能。当用户提到安装技能、查找最佳实践、管理领域知识包时使用。',
  input_schema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['search_hub', 'install', 'uninstall', 'list_installed', 'list_available'],
        description: '操作类型',
      },
      query: {
        type: 'string',
        description: '搜索关键词或技能名称',
      },
      download_url: {
        type: 'string',
        description: '技能包下载 URL（install 时需要）',
      },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: '安装范围：global 全局 / project 项目级',
      },
    },
    required: ['action'],
  },
  agents: ['mainAgent'],
};
