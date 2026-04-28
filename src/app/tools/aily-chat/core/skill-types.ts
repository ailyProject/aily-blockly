/**
 * Aily Skill System - 核心类型定义
 *
 * Skills 是领域知识包，通过 SKILL.md 文件定义。
 * 格式遵循 Agent Skills 开放规范 (agentskills.io)：
 *   Required: name, description
 *   Optional: license, compatibility, metadata, allowed-tools
 * Aily 自定义扩展字段放在 metadata 下。
 */

export interface SkillMetadata {
  // ---- Agent Skills 规范标准字段 ----
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  allowedTools?: string;
  /** 规范扩展元数据 map，Aily 自定义字段也存放于此 */
  metadata?: Record<string, string>;

  // ---- 从 metadata 中提取的 Aily 扩展字段 ----
  version?: string;
  scope?: 'global' | 'project';
  agents?: string[];
  autoActivate?: boolean;
  tags?: string[];
  author?: string;
  sourceUrl?: string;
}

// ============================
// Skill 实体
// ============================

export interface IAilySkill {
  /** 解析后的元数据 */
  readonly metadata: SkillMetadata;
  /** 技能文件夹的绝对路径（URL 来源的为空字符串） */
  readonly folderPath: string;
  /** SKILL.md 文件绝对路径或 URL */
  readonly skillMdPath: string;
  /** 来源标记 */
  readonly origin: SkillOrigin;
  /** 延迟加载的 body 内容（首次 loadContent 后缓存） */
  content?: string;
}

// ============================
// Skill 来源
// ============================

export type SkillOrigin =
  | { type: 'builtin' }
  | { type: 'project'; projectRoot: string }
  | { type: 'global' }
  | { type: 'hub'; registryUrl: string; installedAt: number }
  | { type: 'url'; sourceUrl: string };

// ============================
// Skill 搜索结果
// ============================

export interface SkillSearchResult {
  skill: IAilySkill;
  matchType: 'exact' | 'tag' | 'fuzzy';
}

// ============================
// Skills Hub 相关类型（待完善）
// ============================

// TODO: Skills Hub 后续以 npm 包形式实现，以下类型暂保留
// export interface SkillHubEntry { ... }
// export interface SkillManifest { ... }
// export interface InstalledSkillRecord { ... }
